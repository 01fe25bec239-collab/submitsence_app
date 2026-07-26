-- 0022_queue_ledger_hardening.down.sql — restore the 0017 queue ledger.
begin;

drop trigger if exists trg_guard_processing_job_lease on processing_jobs;
drop function if exists app.guard_processing_job_lease();
drop function if exists app.claim_next_job(text[], integer);
drop function if exists app.heartbeat_processing_job(uuid, uuid, integer);
drop function if exists app.complete_processing_job(uuid, uuid, jsonb);
drop function if exists app.fail_processing_job(uuid, uuid, text);

create or replace function app.claim_next_job(p_job_types text[] default null)
  returns table (id uuid, tenant_id uuid, job_type text, document_id uuid, worker_output jsonb)
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
begin
  update processing_jobs j
     set status = 'succeeded', finished_at = now(), last_error = null, error_details = null, updated_at = now()
   where j.status = 'running' and j.started_at < now() - interval '15 minutes'
     and (
       exists (select 1 from package_versions pv where pv.generation_job_id = j.id and pv.status = 'ready')
       or exists (select 1 from exports e where e.id::text = j.worker_output->>'exportId' and e.status = 'ready' and e.output_document_id is not null)
     );

  update package_versions pv
     set status = 'failed', error_message = 'Worker lease expired on the final attempt'
    from processing_jobs j
   where pv.generation_job_id = j.id
     and j.status = 'running' and j.started_at < now() - interval '15 minutes'
     and j.attempts >= j.max_attempts and pv.status <> 'ready';

  update exports e
     set status = 'failed', error_message = 'Worker lease expired on the final attempt', updated_at = now()
    from processing_jobs j
   where e.id::text = j.worker_output->>'exportId'
     and j.status = 'running' and j.started_at < now() - interval '15 minutes'
     and j.attempts >= j.max_attempts and e.status <> 'ready';

  update packages p
     set status = case when p.output_document_id is null then 'draft'::package_status else 'ready'::package_status end
    from processing_jobs j
   where p.id::text = j.worker_output->>'packageId'
     and j.status = 'running' and j.started_at < now() - interval '15 minutes'
     and j.attempts >= j.max_attempts;

  update processing_jobs
     set status = case when attempts < max_attempts then 'retrying'::job_status else 'failed'::job_status end,
         last_error = 'Worker lease expired before completion',
         finished_at = case when attempts < max_attempts then null else now() end,
         updated_at = now()
   where status = 'running' and started_at < now() - interval '15 minutes';

  return query
  update processing_jobs j
     set status = 'running', started_at = now(), attempts = attempts + 1, updated_at = now()
   where j.id = (
     select jj.id from processing_jobs jj
      where jj.status in ('queued', 'retrying') and jj.attempts < jj.max_attempts
        and (p_job_types is null or jj.job_type = any (p_job_types))
      order by jj.created_at for update skip locked limit 1
   )
  returning j.id, j.tenant_id, j.job_type, j.document_id, j.worker_output;
end$$;

grant execute on function app.claim_next_job(text[]) to submitsense_app;

drop index if exists idx_processing_jobs_global_claim;
alter table processing_jobs
  drop column if exists next_attempt_at,
  drop column if exists lease_expires_at,
  drop column if exists lease_token;

commit;
