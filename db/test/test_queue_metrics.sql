-- PB-07 queue-metric contract checks. DATABASE_URL is required for real-session checks.
\set ON_ERROR_STOP on

create or replace function pg_temp.metrics_assert(ok boolean, message text) returns void
language plpgsql as $$
begin
  if ok is not true then raise exception 'FAIL queue metrics: %', message; end if;
  raise notice 'PASS queue metrics: %', message;
end$$;

-- Separate sessions prove exclusivity and automatic release on disconnect.
\! sh -c 'psql "$DATABASE_URL" -XAtq -v ON_ERROR_STOP=1 -c "select pg_try_advisory_lock(1398096461, 7); select pg_sleep(2)" > /tmp/pb07-lock-a & sleep 0.25; psql "$DATABASE_URL" -XAtq -v ON_ERROR_STOP=1 -c "select pg_try_advisory_lock(1398096461, 7)" > /tmp/pb07-lock-b; wait; psql "$DATABASE_URL" -XAtq -v ON_ERROR_STOP=1 -c "select pg_try_advisory_lock(1398096461, 7)" > /tmp/pb07-lock-after'
\set lock_a `head -n 1 /tmp/pb07-lock-a`
\set lock_b `head -n 1 /tmp/pb07-lock-b`
\set lock_after `head -n 1 /tmp/pb07-lock-after`
select pg_temp.metrics_assert(:'lock_a' = 't' and :'lock_b' = 'f', 'only one database session acquires the advisory lock');
select pg_temp.metrics_assert(:'lock_after' = 't', 'disconnect automatically releases the advisory lock');

begin;

insert into processing_jobs
  (id, tenant_id, job_type, status, attempts, max_attempts, idempotency_key, created_at, next_attempt_at, lease_token, lease_expires_at)
values
  ('23000000-0000-4000-8000-000000000001', '11111111-1111-1111-1111-111111111111', 'product_rematch', 'queued',    0, 3, 'pb07-q-null',      now() - interval '12 minutes', null,                              null, null),
  ('23000000-0000-4000-8000-000000000002', '11111111-1111-1111-1111-111111111111', 'product_rematch', 'queued',    0, 3, 'pb07-q-due',       now() - interval '10 minutes', now() - interval '1 second',       null, null),
  ('23000000-0000-4000-8000-000000000003', '11111111-1111-1111-1111-111111111111', 'product_rematch', 'queued',    0, 3, 'pb07-q-future',    now() - interval '9 minutes',  now() + interval '1 hour',         null, null),
  ('23000000-0000-4000-8000-000000000004', '11111111-1111-1111-1111-111111111111', 'product_rematch', 'retrying',  1, 3, 'pb07-r-due',       now() - interval '8 minutes',  now() - interval '1 second',       null, null),
  ('23000000-0000-4000-8000-000000000005', '11111111-1111-1111-1111-111111111111', 'product_rematch', 'retrying',  1, 3, 'pb07-r-future',    now() - interval '7 minutes',  now() + interval '1 hour',         null, null),
  ('23000000-0000-4000-8000-000000000006', '11111111-1111-1111-1111-111111111111', 'product_rematch', 'running',   1, 3, 'pb07-run-expired', now() - interval '6 minutes',  null, '23000000-0000-4000-8000-000000000106', now() - interval '1 second'),
  ('23000000-0000-4000-8000-000000000007', '11111111-1111-1111-1111-111111111111', 'product_rematch', 'running',   1, 3, 'pb07-run-live',    now() - interval '5 minutes',  null, '23000000-0000-4000-8000-000000000107', now() + interval '1 hour'),
  ('23000000-0000-4000-8000-000000000008', '11111111-1111-1111-1111-111111111111', 'product_rematch', 'queued',    3, 3, 'pb07-exhausted',   now() - interval '4 minutes',  null,                              null, null),
  ('23000000-0000-4000-8000-000000000009', '11111111-1111-1111-1111-111111111111', 'unsupported_pb07','queued',   0, 3, 'pb07-unsupported', now() - interval '3 minutes',  null,                              null, null),
  ('23000000-0000-4000-8000-000000000010', '11111111-1111-1111-1111-111111111111', 'package_draft',  'queued',    0, 3, 'pb07-sync',        now() - interval '2 minutes',  null,                              null, null),
  ('23000000-0000-4000-8000-000000000011', '11111111-1111-1111-1111-111111111111', 'product_rematch', 'succeeded', 0, 3, 'pb07-succeeded',   now() - interval '1 minute',   null,                              null, null),
  ('23000000-0000-4000-8000-000000000012', '11111111-1111-1111-1111-111111111111', 'product_rematch', 'failed',    0, 3, 'pb07-failed',      now() - interval '1 minute',   null,                              null, null),
  ('23000000-0000-4000-8000-000000000013', '11111111-1111-1111-1111-111111111111', 'product_rematch', 'cancelled', 0, 3, 'pb07-cancelled',   now() - interval '1 minute',   null,                              null, null);

create temp table pb07_metrics on commit drop as
select * from app.processing_queue_metrics(array['product_rematch', 'package_generation']);

select pg_temp.metrics_assert(
  (select queue_depth = 4 from pb07_metrics where job_type = 'product_rematch'),
  'eligibility counts queued-null, queued-due, retrying-due, and expired-running only'
);
select pg_temp.metrics_assert(
  (select oldest_eligible_created_at = (select created_at from processing_jobs where id = '23000000-0000-4000-8000-000000000001')
     from pb07_metrics where job_type = 'product_rematch'),
  'oldest eligible created_at is selected'
);
select pg_temp.metrics_assert(
  (select queue_depth = 0 and oldest_eligible_created_at is null from pb07_metrics where job_type = 'package_generation'),
  'every supplied empty type returns an explicit zero row'
);
select pg_temp.metrics_assert(
  (select count(*) = 2 and count(distinct observed_at) = 1 from pb07_metrics),
  'one observed_at timestamp covers the complete aggregate snapshot'
);
select pg_temp.metrics_assert(
  (select p.proargnames[(p.pronargs + 1):array_length(p.proargnames, 1)] =
          array['job_type','queue_depth','oldest_eligible_created_at','observed_at']
     from pg_proc p where p.oid = 'app.processing_queue_metrics(text[])'::regprocedure),
  'function exposes aggregate fields only'
);
select pg_temp.metrics_assert(not has_function_privilege('public', 'app.processing_queue_metrics(text[])', 'execute'), 'PUBLIC cannot execute');
select pg_temp.metrics_assert(has_function_privilege('submitsense_app', 'app.processing_queue_metrics(text[])', 'execute'), 'submitsense_app can execute');
select pg_temp.metrics_assert(
  exists(select 1 from pg_proc p where p.oid = 'app.processing_queue_metrics(text[])'::regprocedure
    and p.prosecdef and p.provolatile = 's' and p.proconfig @> array['search_path=public, pg_temp']),
  'function is STABLE SECURITY DEFINER with a pinned search_path'
);
select pg_temp.metrics_assert(
  exists(
    select 1 from pg_proc p join pg_language l on l.oid = p.prolang
     where p.oid = 'app.processing_queue_metrics(text[])'::regprocedure
       and l.lanname = 'sql'
       and p.proowner = (select relowner from pg_class where oid = 'processing_jobs'::regclass)
       and p.prosrc !~* '\m(insert|update|delete)\M|for[[:space:]]+update|skip[[:space:]]+locked'
  ),
  'migration owner owns one pure SQL aggregate with no DML or claims'
);

-- SECURITY DEFINER aggregates across tenant RLS while returning no row identity.
insert into tenants (id, slug, name) values ('23000000-0000-4000-8000-000000000100', 'pb07-other', 'PB-07 Other');
insert into processing_jobs (id, tenant_id, job_type, idempotency_key)
values ('23000000-0000-4000-8000-000000000101', '23000000-0000-4000-8000-000000000100', 'product_rematch', 'pb07-other');
set local role submitsense_app;
select set_config('app.tenant_id', '11111111-1111-1111-1111-111111111111', true);
select pg_temp.metrics_assert(
  (select queue_depth = 5 from app.processing_queue_metrics(array['product_rematch'])),
  'SECURITY DEFINER aggregate includes eligible work across tenant RLS'
);
reset role;

-- No row is modified by the read-only aggregate.
create temp table pb07_before on commit drop as
select id, status, attempts, next_attempt_at, lease_token, lease_expires_at, updated_at
  from processing_jobs where id::text like '23000000-%';
select * from app.processing_queue_metrics(array['product_rematch']);
select pg_temp.metrics_assert(
  not exists(
    (select * from pb07_before except select id, status, attempts, next_attempt_at, lease_token, lease_expires_at, updated_at from processing_jobs where id::text like '23000000-%')
    union all
    (select id, status, attempts, next_attempt_at, lease_token, lease_expires_at, updated_at from processing_jobs where id::text like '23000000-%' except select * from pb07_before)
  ),
  'metrics query does not mutate processing_jobs'
);

set local enable_seqscan = off;
do $$
declare line text; plan text := '';
begin
  for line in execute $query$
    explain select id, created_at from processing_jobs
     where status in ('queued', 'retrying', 'running') and attempts < max_attempts
       and job_type = any(array['product_rematch'])
       and (
         (status = 'queued' and (next_attempt_at is null or next_attempt_at <= statement_timestamp()))
         or (status = 'retrying' and next_attempt_at <= statement_timestamp())
         or (status = 'running' and lease_expires_at <= statement_timestamp())
       )
  $query$ loop plan := plan || line; end loop;
  if position('idx_processing_jobs_global_claim' in plan) = 0 then
    raise exception 'FAIL queue metrics: global claim index unsuitable: %', plan;
  end if;
  raise notice 'PASS queue metrics: existing global claim index is suitable';
end$$;

do $$
declare claimed_id uuid; claimed_count integer := 0;
begin
  loop
    select id into claimed_id from app.claim_next_job(array['product_rematch'], 30);
    exit when claimed_id is null;
    claimed_count := claimed_count + 1;
  end loop;
  if claimed_count <> 5 then
    raise exception 'FAIL queue metrics: aggregate/claim parity expected 5, claimed %', claimed_count;
  end if;
  raise notice 'PASS queue metrics: QueueDepth exactly matches claim_next_job eligibility';
end$$;

rollback;

-- Runtime invocation succeeds in a READ ONLY transaction.
begin read only;
select pg_temp.metrics_assert(
  (select count(*) = 2 from app.processing_queue_metrics(array['product_rematch', 'package_generation'])),
  'function succeeds inside BEGIN READ ONLY'
);
rollback;

-- Holding the read-only metrics snapshot cannot block a claim/update in another session.
delete from processing_jobs where id = '23000000-0000-4000-8000-000000000200';
insert into processing_jobs (id, tenant_id, job_type, idempotency_key)
values ('23000000-0000-4000-8000-000000000200', '11111111-1111-1111-1111-111111111111', 'pb07_nonblocking', 'pb07-nonblocking');
\! sh -c 'psql "$DATABASE_URL" -XAtq -v ON_ERROR_STOP=1 -c "begin read only; select count(*) from app.processing_queue_metrics(array['\''pb07_nonblocking'\'']); select pg_sleep(2); rollback" > /tmp/pb07-reader & sleep 0.25; psql "$DATABASE_URL" -XAtq -v ON_ERROR_STOP=1 -c "set statement_timeout = '\''1s'\''; select id from app.claim_next_job(array['\''pb07_nonblocking'\''], 900)" > /tmp/pb07-claim; echo $? > /tmp/pb07-claim-exit; wait'
\set claim_exit `cat /tmp/pb07-claim-exit`
\set claimed_id `tail -n 1 /tmp/pb07-claim`
select pg_temp.metrics_assert(:'claim_exit'::integer = 0 and :'claimed_id' = '23000000-0000-4000-8000-000000000200', 'concurrent claim does not block on metrics snapshot');
delete from processing_jobs where id = '23000000-0000-4000-8000-000000000200';
