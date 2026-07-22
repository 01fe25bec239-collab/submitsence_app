-- 0022_queue_ledger_hardening.sql
-- PB-05B: explicit leases, fenced completion, heartbeats, and bounded delayed retries.

begin;

alter table processing_jobs
  add column if not exists lease_token uuid,
  add column if not exists lease_expires_at timestamptz,
  add column if not exists next_attempt_at timestamptz;

-- Existing retry rows are immediately eligible. Existing running work gets a full transitional
-- lease; the guard below prevents a pre-0022 worker from completing it without its token.
update processing_jobs
   set next_attempt_at = coalesce(next_attempt_at, now())
 where status = 'retrying';

update processing_jobs
   set lease_token = coalesce(lease_token, gen_random_uuid()),
       lease_expires_at = coalesce(lease_expires_at, now() + interval '15 minutes')
 where status = 'running';

create index if not exists idx_processing_jobs_global_claim
  on processing_jobs (status, job_type, next_attempt_at, lease_expires_at, created_at, id)
  where status in ('queued', 'retrying', 'running') and attempts < max_attempts;

-- Direct updates from a legacy or stale runtime worker cannot bypass fencing. The narrow
-- SECURITY DEFINER queue functions execute as the table owner and are the only runtime path past
-- this guard.
create or replace function app.guard_processing_job_lease() returns trigger
  language plpgsql
  set search_path = public, pg_temp
as $$
begin
  if old.status = 'running'
     and old.lease_token is not null
     and current_user <> pg_get_userbyid((select relowner from pg_class where oid = tg_relid))
  then
    raise exception 'processing job lease token required' using errcode = '42501';
  end if;
  return new;
end$$;

drop trigger if exists trg_guard_processing_job_lease on processing_jobs;
create trigger trg_guard_processing_job_lease
before update on processing_jobs
for each row execute function app.guard_processing_job_lease();

-- Keep the legacy signature during rolling deployment, but stop old workers claiming new work.
-- New workers use the two-argument overload below.
create or replace function app.claim_next_job(p_job_types text[] default null)
  returns table (id uuid, tenant_id uuid, job_type text, document_id uuid, worker_output jsonb)
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
begin
  return;
end$$;

create or replace function app.claim_next_job(p_job_types text[], p_lease_seconds integer)
  returns table (
    id uuid,
    tenant_id uuid,
    job_type text,
    document_id uuid,
    worker_output jsonb,
    lease_token uuid,
    lease_expires_at timestamptz
  )
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
begin
  if coalesce(cardinality(p_job_types), 0) = 0 then
    raise exception 'at least one configured job type is required' using errcode = '22023';
  end if;
  if p_lease_seconds < 30 or p_lease_seconds > 3600 then
    raise exception 'lease duration must be between 30 and 3600 seconds' using errcode = '22023';
  end if;

  -- A committed package/export artifact wins over crash recovery.
  update processing_jobs j
     set status = 'succeeded', finished_at = clock_timestamp(), last_error = null,
         error_details = null, lease_token = null, lease_expires_at = null,
         next_attempt_at = null, updated_at = clock_timestamp()
   where j.status = 'running' and j.lease_expires_at <= clock_timestamp()
     and (
       exists (select 1 from package_versions pv where pv.generation_job_id = j.id and pv.status = 'ready')
       or exists (
         select 1 from exports e
          where e.id::text = j.worker_output->>'exportId'
            and e.status = 'ready' and e.output_document_id is not null
       )
     );

  update package_versions pv
     set status = 'failed', error_message = 'Worker lease expired on the final attempt'
    from processing_jobs j
   where pv.generation_job_id = j.id
     and j.status = 'running' and j.lease_expires_at <= clock_timestamp()
     and j.attempts >= j.max_attempts and pv.status <> 'ready';

  update exports e
     set status = 'failed', error_message = 'Worker lease expired on the final attempt', updated_at = clock_timestamp()
    from processing_jobs j
   where e.id::text = j.worker_output->>'exportId'
     and j.status = 'running' and j.lease_expires_at <= clock_timestamp()
     and j.attempts >= j.max_attempts and e.status <> 'ready';

  update packages p
     set status = case when p.output_document_id is null then 'draft'::package_status else 'ready'::package_status end
    from processing_jobs j
   where p.id::text = j.worker_output->>'packageId'
     and j.status = 'running' and j.lease_expires_at <= clock_timestamp()
     and j.attempts >= j.max_attempts;

  -- Normalize rows that can never be claimed, including inconsistent queued/retrying history.
  update processing_jobs
     set status = 'failed',
         last_error = coalesce(last_error, 'Maximum attempts exhausted before claim'),
         finished_at = coalesce(finished_at, clock_timestamp()),
         lease_token = null, lease_expires_at = null, next_attempt_at = null,
         updated_at = clock_timestamp()
   where status in ('queued', 'retrying') and attempts >= max_attempts;

  update processing_jobs j
     set status = 'failed',
         last_error = coalesce(j.last_error, 'Worker lease expired on the final attempt'),
         finished_at = coalesce(j.finished_at, clock_timestamp()),
         lease_token = null, lease_expires_at = null, next_attempt_at = null,
         updated_at = clock_timestamp()
   where j.status = 'running' and j.lease_expires_at <= clock_timestamp() and j.attempts >= j.max_attempts;

  return query
  update processing_jobs j
     set status = 'running', started_at = clock_timestamp(), finished_at = null,
         attempts = j.attempts + 1,
         last_error = case when j.status = 'running' then 'Worker lease expired before completion' else j.last_error end,
         lease_token = gen_random_uuid(),
         lease_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds),
         next_attempt_at = null,
         updated_at = clock_timestamp()
   where j.id = (
     select jj.id
       from processing_jobs jj
      where jj.attempts < jj.max_attempts
        and jj.job_type = any (p_job_types)
        and (
          (jj.status = 'queued' and (jj.next_attempt_at is null or jj.next_attempt_at <= clock_timestamp()))
          or (jj.status = 'retrying' and jj.next_attempt_at <= clock_timestamp())
          or (jj.status = 'running' and jj.lease_expires_at <= clock_timestamp())
        )
      order by jj.created_at, jj.id
      for update skip locked
      limit 1
   )
  returning j.id, j.tenant_id, j.job_type, j.document_id, j.worker_output,
            j.lease_token, j.lease_expires_at;
end$$;

create or replace function app.heartbeat_processing_job(p_job_id uuid, p_lease_token uuid, p_lease_seconds integer)
  returns table (lease_expires_at timestamptz)
  language plpgsql
  security definer
  strict
  set search_path = public, pg_temp
as $$
begin
  if p_lease_seconds < 30 or p_lease_seconds > 3600 then
    raise exception 'lease duration must be between 30 and 3600 seconds' using errcode = '22023';
  end if;
  return query
  update processing_jobs j
     set lease_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds),
         updated_at = clock_timestamp()
   where j.id = p_job_id and j.status = 'running' and j.lease_token = p_lease_token
  returning j.lease_expires_at;
end$$;

create or replace function app.complete_processing_job(p_job_id uuid, p_lease_token uuid, p_worker_output jsonb)
  returns boolean
  language plpgsql
  security definer
  strict
  set search_path = public, pg_temp
as $$
declare updated_count integer;
begin
  update processing_jobs j
     set status = 'succeeded', finished_at = clock_timestamp(), last_error = null,
         error_details = null, updated_at = clock_timestamp(),
         worker_output = coalesce(j.worker_output, '{}'::jsonb) || p_worker_output,
         lease_token = null, lease_expires_at = null, next_attempt_at = null
   where j.id = p_job_id and j.status = 'running' and j.lease_token = p_lease_token;
  get diagnostics updated_count = row_count;
  return updated_count = 1;
end$$;

-- Deterministic backoff: 30s, 60s, 120s, 240s, 480s, then capped at 900s.
create or replace function app.fail_processing_job(p_job_id uuid, p_lease_token uuid, p_last_error text)
  returns table (status job_status, next_attempt_at timestamptz)
  language plpgsql
  security definer
  strict
  set search_path = public, pg_temp
as $$
begin
  return query
  update processing_jobs j
     set status = case when j.attempts < j.max_attempts then 'retrying'::job_status else 'failed'::job_status end,
         last_error = left(p_last_error, 500),
         finished_at = case when j.attempts < j.max_attempts then null else clock_timestamp() end,
         next_attempt_at = case when j.attempts < j.max_attempts then
           clock_timestamp() + make_interval(secs => least(900, 30 * (1 << least(greatest(j.attempts - 1, 0), 5))))
           else null end,
         lease_token = null, lease_expires_at = null, updated_at = clock_timestamp()
   where j.id = p_job_id and j.status = 'running' and j.lease_token = p_lease_token
  returning j.status, j.next_attempt_at;
end$$;

revoke all on function app.claim_next_job(text[]) from public;
revoke all on function app.claim_next_job(text[], integer) from public;
revoke all on function app.heartbeat_processing_job(uuid, uuid, integer) from public;
revoke all on function app.complete_processing_job(uuid, uuid, jsonb) from public;
revoke all on function app.fail_processing_job(uuid, uuid, text) from public;

grant execute on function app.claim_next_job(text[]) to submitsense_app;
grant execute on function app.claim_next_job(text[], integer) to submitsense_app;
grant execute on function app.heartbeat_processing_job(uuid, uuid, integer) to submitsense_app;
grant execute on function app.complete_processing_job(uuid, uuid, jsonb) to submitsense_app;
grant execute on function app.fail_processing_job(uuid, uuid, text) to submitsense_app;

commit;
