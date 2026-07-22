-- PB-05B PostgreSQL queue-ledger checks. Requires DATABASE_URL for the concurrency check.
\set ON_ERROR_STOP on

create or replace function pg_temp.queue_assert(ok boolean, message text) returns void
language plpgsql as $$
begin
  if ok is not true then raise exception 'FAIL queue ledger: %', message; end if;
  raise notice 'PASS queue ledger: %', message;
end$$;

-- Two independent sessions race for one committed row; exactly one may receive it.
delete from processing_jobs where id = '22000000-0000-4000-8000-000000000001';
insert into processing_jobs (id, tenant_id, job_type, idempotency_key)
values ('22000000-0000-4000-8000-000000000001', '11111111-1111-1111-1111-111111111111', 'pb05b_concurrent', 'pb05b-concurrent');
\! sh -c 'psql "$DATABASE_URL" -XAtq -v ON_ERROR_STOP=1 -c "select id from app.claim_next_job(array['\''pb05b_concurrent'\''], 900)" > /tmp/pb05b-claim-1 & psql "$DATABASE_URL" -XAtq -v ON_ERROR_STOP=1 -c "select id from app.claim_next_job(array['\''pb05b_concurrent'\''], 900)" > /tmp/pb05b-claim-2 & wait'
\set concurrent_claims `awk 'NF { count++ } END { print count + 0 }' /tmp/pb05b-claim-1 /tmp/pb05b-claim-2`
select pg_temp.queue_assert(:'concurrent_claims'::integer = 1, 'concurrent claimers cannot claim the same job');
delete from processing_jobs where id = '22000000-0000-4000-8000-000000000001';

begin;

-- A live lease is invisible to the claimer.
insert into processing_jobs (id, tenant_id, job_type, status, attempts, max_attempts, idempotency_key, lease_token, lease_expires_at)
values ('22000000-0000-4000-8000-000000000002', '11111111-1111-1111-1111-111111111111', 'pb05b_live', 'running', 1, 3,
        'pb05b-live', '22000000-0000-4000-8000-000000000102', clock_timestamp() + interval '5 minutes');
select pg_temp.queue_assert(not exists(select 1 from app.claim_next_job(array['pb05b_live'], 900)), 'a non-expired lease is not reclaimed');

-- Reclaim gives a new token; only that token can renew or finish.
insert into processing_jobs (id, tenant_id, job_type, status, attempts, max_attempts, idempotency_key, lease_token, lease_expires_at)
values ('22000000-0000-4000-8000-000000000003', '11111111-1111-1111-1111-111111111111', 'pb05b_reclaim', 'running', 1, 3,
        'pb05b-reclaim', '22000000-0000-4000-8000-000000000103', clock_timestamp() - interval '1 second');
create temp table reclaimed_job on commit drop as
select * from app.claim_next_job(array['pb05b_reclaim'], 900);
select pg_temp.queue_assert(
  (select id = '22000000-0000-4000-8000-000000000003' and lease_token <> '22000000-0000-4000-8000-000000000103' from reclaimed_job),
  'an expired lease is reclaimed with a new token'
);
select pg_temp.queue_assert(
  not exists(select 1 from app.heartbeat_processing_job('22000000-0000-4000-8000-000000000003', '22000000-0000-4000-8000-000000000103', 900)),
  'the old token cannot heartbeat after reclaim'
);
select pg_temp.queue_assert(
  app.complete_processing_job('22000000-0000-4000-8000-000000000003', '22000000-0000-4000-8000-000000000103', '{"stale":true}') = false,
  'the old token cannot mark success after reclaim'
);
select pg_temp.queue_assert(
  not exists(select 1 from app.fail_processing_job('22000000-0000-4000-8000-000000000003', '22000000-0000-4000-8000-000000000103', 'stale failure')),
  'the old token cannot mark failure or retrying after reclaim'
);
select pg_temp.queue_assert(
  app.complete_processing_job(
    '22000000-0000-4000-8000-000000000003',
    (select lease_token from reclaimed_job),
    '{"winner":true}'
  ),
  'the new token can complete'
);
select pg_temp.queue_assert(
  (select status = 'succeeded' and worker_output->>'winner' = 'true' and lease_token is null
     from processing_jobs where id = '22000000-0000-4000-8000-000000000003'),
  'fenced success clears the lease and persists output'
);

-- Heartbeat expiry moves forward without changing ownership.
insert into processing_jobs (id, tenant_id, job_type, idempotency_key)
values ('22000000-0000-4000-8000-000000000004', '11111111-1111-1111-1111-111111111111', 'pb05b_heartbeat', 'pb05b-heartbeat');
create temp table heartbeat_claim on commit drop as
select * from app.claim_next_job(array['pb05b_heartbeat'], 30);
create temp table heartbeat_result on commit drop as
select * from app.heartbeat_processing_job(
  '22000000-0000-4000-8000-000000000004',
  (select lease_token from heartbeat_claim),
  900
);
select pg_temp.queue_assert(
  (select r.lease_expires_at > c.lease_expires_at from heartbeat_result r cross join heartbeat_claim c),
  'heartbeat extends lease expiry'
);

-- Attempt one fails onto the 30-second deterministic retry schedule.
insert into processing_jobs (id, tenant_id, job_type, max_attempts, idempotency_key)
values ('22000000-0000-4000-8000-000000000005', '11111111-1111-1111-1111-111111111111', 'pb05b_retry', 2, 'pb05b-retry');
create temp table retry_claim on commit drop as
select * from app.claim_next_job(array['pb05b_retry'], 900);
create temp table retry_failure on commit drop as
select * from app.fail_processing_job(
  '22000000-0000-4000-8000-000000000005',
  (select lease_token from retry_claim),
  'temporary dependency failure'
);
select pg_temp.queue_assert(
  (select status = 'retrying' and next_attempt_at between clock_timestamp() + interval '25 seconds' and clock_timestamp() + interval '35 seconds' from retry_failure),
  'attempt one schedules a bounded 30-second retry'
);
select pg_temp.queue_assert(not exists(select 1 from app.claim_next_job(array['pb05b_retry'], 900)), 'retry is not claimable before next_attempt_at');
update processing_jobs set next_attempt_at = clock_timestamp() - interval '1 second'
 where id = '22000000-0000-4000-8000-000000000005';
create temp table final_claim on commit drop as
select * from app.claim_next_job(array['pb05b_retry'], 900);
select pg_temp.queue_assert((select attempts = 2 from processing_jobs where id = '22000000-0000-4000-8000-000000000005'), 'retry becomes claimable when due');
select * from app.fail_processing_job(
  '22000000-0000-4000-8000-000000000005',
  (select lease_token from final_claim),
  'final dependency failure'
);
select pg_temp.queue_assert(
  (select status = 'failed' and attempts = max_attempts and attempts = 2 and next_attempt_at is null and lease_token is null
     from processing_jobs where id = '22000000-0000-4000-8000-000000000005'),
  'attempts never exceed max_attempts and exhaustion becomes failed'
);
select pg_temp.queue_assert(not exists(select 1 from app.claim_next_job(array['pb05b_retry'], 900)), 'an exhausted job cannot be claimed again');

-- Pre-existing inconsistent nonterminal rows are normalized by claim maintenance.
insert into processing_jobs (id, tenant_id, job_type, status, attempts, max_attempts, idempotency_key, next_attempt_at)
values
  ('22000000-0000-4000-8000-000000000006', '11111111-1111-1111-1111-111111111111', 'pb05b_exhausted_q', 'queued', 3, 3, 'pb05b-exhausted-q', null),
  ('22000000-0000-4000-8000-000000000007', '11111111-1111-1111-1111-111111111111', 'pb05b_exhausted_r', 'retrying', 4, 4, 'pb05b-exhausted-r', clock_timestamp() - interval '1 hour');
select id from app.claim_next_job(array['pb05b_no_match'], 900);
select pg_temp.queue_assert(
  (select count(*) = 2 from processing_jobs where id in ('22000000-0000-4000-8000-000000000006', '22000000-0000-4000-8000-000000000007') and status = 'failed' and next_attempt_at is null),
  'already-exhausted queued and retrying rows are normalized'
);

-- A ready package artifact reconciles an expired job to success before reclamation.
insert into packages (id, tenant_id, project_id, name)
values ('22000000-0000-4000-8000-000000000013', '11111111-1111-1111-1111-111111111111',
        '55555555-5555-5555-5555-555555555555', 'PB-05B package');
insert into documents (id, tenant_id, project_id, doc_type, title, storage_bucket, object_key, checksum_sha256)
values ('22000000-0000-4000-8000-000000000008', '11111111-1111-1111-1111-111111111111',
        '55555555-5555-5555-5555-555555555555', 'generated_package', 'PB-05B committed output',
        'test-ap-southeast-2', 'pb05b/committed.pdf', repeat('b', 64));
insert into processing_jobs (id, tenant_id, job_type, status, attempts, max_attempts, idempotency_key, lease_token, lease_expires_at)
values ('22000000-0000-4000-8000-000000000009', '11111111-1111-1111-1111-111111111111', 'package_generation', 'running', 1, 3,
        'pb05b-artifact', '22000000-0000-4000-8000-000000000109', clock_timestamp() - interval '1 second');
insert into package_versions (id, tenant_id, package_id, version_number, generation_job_id, status, output_document_id, checksum_sha256)
values ('22000000-0000-4000-8000-000000000010', '11111111-1111-1111-1111-111111111111',
        '22000000-0000-4000-8000-000000000013', 1, '22000000-0000-4000-8000-000000000009',
        'ready', '22000000-0000-4000-8000-000000000008', repeat('b', 64));
select id from app.claim_next_job(array['pb05b_no_match'], 900);
select pg_temp.queue_assert(
  (select status = 'succeeded' and lease_token is null from processing_jobs where id = '22000000-0000-4000-8000-000000000009'),
  'committed package artifacts still reconcile to success'
);

-- SECURITY DEFINER may claim across tenants, while ordinary table reads remain tenant-isolated.
insert into tenants (id, slug, name)
values ('22000000-0000-4000-8000-000000000011', 'pb05b-other', 'PB-05B Other Tenant');
insert into processing_jobs (id, tenant_id, job_type, idempotency_key)
values ('22000000-0000-4000-8000-000000000012', '22000000-0000-4000-8000-000000000011', 'pb05b_cross_tenant', 'pb05b-cross-tenant');
set local role submitsense_app;
select set_config('app.tenant_id', '11111111-1111-1111-1111-111111111111', true);
do $$
declare claimed_tenant uuid; visible integer;
begin
  begin
    update processing_jobs set status = 'succeeded' where id = '22000000-0000-4000-8000-000000000002';
    raise exception 'FAIL queue ledger: legacy worker bypassed the lease guard';
  exception when insufficient_privilege then
    raise notice 'PASS queue ledger: legacy direct completion cannot bypass fencing';
  end;
  select tenant_id into claimed_tenant from app.claim_next_job(array['pb05b_cross_tenant'], 900);
  select count(*) into visible from processing_jobs where id = '22000000-0000-4000-8000-000000000012';
  if claimed_tenant <> '22000000-0000-4000-8000-000000000011' or visible <> 0 then
    raise exception 'FAIL queue ledger: SECURITY DEFINER/RLS claimed=% visible=%', claimed_tenant, visible;
  end if;
  raise notice 'PASS queue ledger: narrow SECURITY DEFINER claim preserves tenant RLS';
end$$;
reset role;

select pg_temp.queue_assert(
  exists(
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'app' and p.proname = 'claim_next_job' and p.prosecdef
       and p.proconfig @> array['search_path=public, pg_temp']
  ),
  'claim functions pin a safe search_path'
);

-- Force index scans and verify the active global query shape can use the partial index.
set local enable_seqscan = off;
do $$
declare line text; plan text := '';
begin
  for line in execute $query$
    explain select id from processing_jobs
     where status in ('queued', 'retrying', 'running') and attempts < max_attempts
       and job_type = any(array['pb05b_index'])
       and (
         (status = 'queued' and (next_attempt_at is null or next_attempt_at <= clock_timestamp()))
         or (status = 'retrying' and next_attempt_at <= clock_timestamp())
         or (status = 'running' and lease_expires_at <= clock_timestamp())
       )
     order by created_at, id limit 1
  $query$ loop
    plan := plan || line;
  end loop;
  if position('idx_processing_jobs_global_claim' in plan) = 0 then
    raise exception 'FAIL queue ledger: global claim index not used: %', plan;
  end if;
  raise notice 'PASS queue ledger: global partial claim index exists and is usable';
end$$;

rollback;
