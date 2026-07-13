-- 0016_job_claim.sql
-- Background worker queue dispatch (B6-B7 ingestion/matching workers). The runtime role
-- `submitsense_app` has no BYPASSRLS and every processing_jobs row is tenant-isolated, so a poller
-- cannot see queued jobs across tenants. This SECURITY DEFINER claimer bypasses RLS only for the
-- narrow "pick the next job" step (mirroring the webhook tenant resolvers in 0015), returns the
-- job's TRUSTED tenant_id, and atomically flips it to 'running' under FOR UPDATE SKIP LOCKED so
-- concurrent workers never grab the same job. The worker then re-enters normal tenant scope
-- (SET LOCAL app.tenant_id = returned tenant_id, app.actor_type = 'system') to do the work and
-- mark the outcome, where RLS + the human-approval guard still fully apply.

begin;

create or replace function app.claim_next_job(p_job_types text[] default null)
  returns table (id uuid, tenant_id uuid, job_type text, document_id uuid, worker_output jsonb)
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
begin
  return query
  update processing_jobs j
     set status = 'running', started_at = now(), attempts = attempts + 1, updated_at = now()
   where j.id = (
     select jj.id
       from processing_jobs jj
      where jj.status in ('queued', 'retrying')
        and jj.attempts < jj.max_attempts
        and (p_job_types is null or jj.job_type = any (p_job_types))
      order by jj.created_at
      for update skip locked
      limit 1
   )
  returning j.id, j.tenant_id, j.job_type, j.document_id, j.worker_output;
end$$;

grant execute on function app.claim_next_job(text[]) to submitsense_app;

commit;
