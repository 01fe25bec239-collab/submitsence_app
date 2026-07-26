-- 0023_queue_metrics.sql
-- PB-07: read-only, cross-tenant aggregates for the PostgreSQL worker queue.

begin;

create function app.processing_queue_metrics(p_job_types text[])
returns table (
  job_type text,
  queue_depth bigint,
  oldest_eligible_created_at timestamptz,
  observed_at timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with snapshot as (
    select statement_timestamp() as observed_at
  ), supplied as (
    select distinct unnest(p_job_types) as job_type
  )
  select supplied.job_type,
         count(j.id) as queue_depth,
         min(j.created_at) as oldest_eligible_created_at,
         snapshot.observed_at
    from supplied
    cross join snapshot
    left join processing_jobs j
      on j.job_type = supplied.job_type
     and j.attempts < j.max_attempts
     and (
       (j.status = 'queued' and (j.next_attempt_at is null or j.next_attempt_at <= snapshot.observed_at))
       or (j.status = 'retrying' and j.next_attempt_at <= snapshot.observed_at)
       or (j.status = 'running' and j.lease_expires_at <= snapshot.observed_at)
     )
   group by supplied.job_type, snapshot.observed_at
   order by supplied.job_type
$$;

revoke all on function app.processing_queue_metrics(text[]) from public;
grant execute on function app.processing_queue_metrics(text[]) to submitsense_app;

commit;
