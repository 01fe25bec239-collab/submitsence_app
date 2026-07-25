\set ON_ERROR_STOP on

create or replace function pg_temp.migration_control_assert(ok boolean, label text)
returns void
language plpgsql
as $$
begin
  if ok is not true then
    raise exception 'FAIL migration control: %', label;
  end if;
  raise notice 'PASS migration control: %', label;
end
$$;

select pg_temp.migration_control_assert(
  to_regnamespace('migration_control') is not null,
  'schema exists'
);
select pg_temp.migration_control_assert(
  (
    select array_agg(c.relname::text order by c.relname)
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'migration_control' and c.relkind in ('r', 'p')
  ) = array['migration_runs', 'schema_migrations'],
  'exactly the two Step-2 permanent tables exist'
);
select pg_temp.migration_control_assert(
  (
    select count(*)
      from pg_attribute a
     where a.attrelid = 'migration_control.schema_migrations'::regclass
       and a.attnum > 0 and not a.attisdropped
  ) = 13
  and (
    select count(*)
      from pg_attribute a
     where a.attrelid = 'migration_control.migration_runs'::regclass
       and a.attnum > 0 and not a.attisdropped
  ) = 14,
  'required column counts exist'
);
select pg_temp.migration_control_assert(
  (
    select array_agg(a.attname || ':' || format_type(a.atttypid, a.atttypmod) || ':' || a.attnotnull order by a.attnum)
      from pg_attribute a
     where a.attrelid = 'migration_control.schema_migrations'::regclass
       and a.attnum > 0 and not a.attisdropped
  ) = array[
    'migration_id:text:true',
    'ordinal:integer:true',
    'filename:text:true',
    'manifest_checksum_sha256:character(64):true',
    'applied_checksum_sha256:character(64):false',
    'lifecycle_phase:text:true',
    'operation_categories:text[]:true',
    'execution_mode:text:true',
    'applied_at:timestamp with time zone:true',
    'run_id:uuid:true',
    'baselined:boolean:true',
    'source_git_sha:text:true',
    'executor_image_digest:text:true'
  ],
  'schema_migrations column types and nullability match the contract'
);
select pg_temp.migration_control_assert(
  (
    select array_agg(a.attname || ':' || format_type(a.atttypid, a.atttypmod) || ':' || a.attnotnull order by a.attnum)
      from pg_attribute a
     where a.attrelid = 'migration_control.migration_runs'::regclass
       and a.attnum > 0 and not a.attisdropped
  ) = array[
    'event_id:bigint:true',
    'run_id:uuid:true',
    'migration_id:text:true',
    'event_sequence:integer:true',
    'event_type:text:true',
    'occurred_at:timestamp with time zone:true',
    'runner_id:text:false',
    'heartbeat_deadline:timestamp with time zone:false',
    'statement_ordinal:integer:false',
    'source_git_sha:text:false',
    'executor_image_digest:text:false',
    'sqlstate:text:false',
    'error_class:text:false',
    'metadata:jsonb:true'
  ],
  'migration_runs column types and nullability match the contract'
);

begin;

insert into migration_control.schema_migrations (
  migration_id,
  ordinal,
  filename,
  manifest_checksum_sha256,
  applied_checksum_sha256,
  lifecycle_phase,
  operation_categories,
  execution_mode,
  applied_at,
  run_id,
  baselined,
  source_git_sha,
  executor_image_digest
) values (
  '0001',
  1,
  '0001_extensions_helpers.sql',
  repeat('a', 64),
  repeat('a', 64),
  'expand',
  array['schema', 'security-policy'],
  'legacy-verbatim',
  clock_timestamp(),
  '10000000-0000-4000-8000-000000000001',
  false,
  repeat('b', 40),
  'sha256:' || repeat('c', 64)
);
select pg_temp.migration_control_assert(true, 'schema_migrations valid INSERT succeeds');

do $$
begin
  begin
    update migration_control.schema_migrations set filename = filename where migration_id = '0001';
    raise exception 'UPDATE unexpectedly succeeded';
  exception when sqlstate '55000' then
    if sqlerrm <> 'migration control rows are immutable' then raise; end if;
  end;
  raise notice 'PASS migration control: schema_migrations UPDATE is rejected';
end
$$;

do $$
begin
  begin
    delete from migration_control.schema_migrations where migration_id = '0001';
    raise exception 'DELETE unexpectedly succeeded';
  exception when sqlstate '55000' then
    if sqlerrm <> 'migration control rows are immutable' then raise; end if;
  end;
  raise notice 'PASS migration control: schema_migrations DELETE is rejected';
end
$$;

insert into migration_control.migration_runs (
  run_id,
  migration_id,
  event_sequence,
  event_type,
  metadata
) values (
  '20000000-0000-4000-8000-000000000001',
  '0001',
  1,
  'started',
  '{}'::jsonb
);
select pg_temp.migration_control_assert(true, 'migration_runs valid INSERT succeeds');

do $$
begin
  begin
    update migration_control.migration_runs
       set metadata = metadata
     where run_id = '20000000-0000-4000-8000-000000000001';
    raise exception 'UPDATE unexpectedly succeeded';
  exception when sqlstate '55000' then
    if sqlerrm <> 'migration control rows are immutable' then raise; end if;
  end;
  raise notice 'PASS migration control: migration_runs UPDATE is rejected';
end
$$;

do $$
begin
  begin
    delete from migration_control.migration_runs
     where run_id = '20000000-0000-4000-8000-000000000001';
    raise exception 'DELETE unexpectedly succeeded';
  exception when sqlstate '55000' then
    if sqlerrm <> 'migration control rows are immutable' then raise; end if;
  end;
  raise notice 'PASS migration control: migration_runs DELETE is rejected';
end
$$;

do $$
begin
  begin
    insert into migration_control.migration_runs (
      run_id, migration_id, event_sequence, event_type, metadata
    ) values (
      '20000000-0000-4000-8000-000000000001', '0001', 1, 'heartbeat', '{}'::jsonb
    );
    raise exception 'duplicate run sequence unexpectedly succeeded';
  exception when unique_violation then null;
  end;
  raise notice 'PASS migration control: duplicate run event sequence is rejected';
end
$$;

do $$
declare
  test_case record;
begin
  for test_case in
    select *
      from (values
        ('invalid lifecycle phase', 'cleanup', array['schema']::text[], 'legacy-verbatim', repeat('a', 64), false),
        ('invalid operation category', 'expand', array['ddl']::text[], 'legacy-verbatim', repeat('a', 64), false),
        ('duplicate operation categories', 'expand', array['schema', 'schema']::text[], 'legacy-verbatim', repeat('a', 64), false),
        ('non-canonical operation category order', 'expand', array['security-policy', 'schema']::text[], 'legacy-verbatim', repeat('a', 64), false),
        ('invalid execution mode', 'expand', array['schema']::text[], 'autocommit', repeat('a', 64), false),
        ('invalid SHA-256', 'expand', array['schema']::text[], 'legacy-verbatim', 'NOT-A-SHA', false),
        ('invalid non-baselined null checksum', 'expand', array['schema']::text[], 'legacy-verbatim', null, false),
        ('invalid baselined observed checksum', 'expand', array['schema']::text[], 'legacy-verbatim', repeat('a', 64), true)
      ) as cases(label, phase, categories, mode, applied_checksum, baselined)
  loop
    begin
      insert into migration_control.schema_migrations (
        migration_id,
        ordinal,
        filename,
        manifest_checksum_sha256,
        applied_checksum_sha256,
        lifecycle_phase,
        operation_categories,
        execution_mode,
        applied_at,
        run_id,
        baselined,
        source_git_sha,
        executor_image_digest
      ) values (
        '0002',
        2,
        '0002_enums.sql',
        case when test_case.label = 'invalid SHA-256' then test_case.applied_checksum else repeat('a', 64) end,
        test_case.applied_checksum,
        test_case.phase,
        test_case.categories,
        test_case.mode,
        clock_timestamp(),
        '10000000-0000-4000-8000-000000000002',
        test_case.baselined,
        repeat('b', 40),
        'sha256:' || repeat('c', 64)
      );
      raise exception '% unexpectedly succeeded', test_case.label;
    exception when check_violation then null;
    end;
    raise notice 'PASS migration control: % is rejected', test_case.label;
  end loop;
end
$$;

insert into migration_control.schema_migrations (
  migration_id,
  ordinal,
  filename,
  manifest_checksum_sha256,
  applied_checksum_sha256,
  lifecycle_phase,
  operation_categories,
  execution_mode,
  applied_at,
  run_id,
  baselined,
  source_git_sha,
  executor_image_digest
) values (
  '0002',
  2,
  '0002_enums.sql',
  repeat('d', 64),
  null,
  'expand',
  array['schema'],
  'legacy-verbatim',
  clock_timestamp(),
  '10000000-0000-4000-8000-000000000002',
  true,
  repeat('e', 40),
  'sha256:' || repeat('f', 64)
);
select pg_temp.migration_control_assert(true, 'valid baselined legacy null checksum succeeds');

do $$
declare
  test_case record;
begin
  for test_case in
    select *
      from (values
        ('invalid event type', 'unknown', '{}'::jsonb),
        ('invalid metadata shape', 'started', '[]'::jsonb),
        ('metadata rejects unconstrained keys', 'started', '{"sql":"select secret"}'::jsonb),
        ('metadata rejects free text in numeric fields', 'started', '{"duration_ms":"secret"}'::jsonb)
      ) as cases(label, event_type, metadata)
  loop
    begin
      insert into migration_control.migration_runs (
        run_id, migration_id, event_sequence, event_type, metadata
      ) values (
        '20000000-0000-4000-8000-000000000002',
        '0002',
        1,
        test_case.event_type,
        test_case.metadata
      );
      raise exception '% unexpectedly succeeded', test_case.label;
    exception when check_violation then null;
    end;
    raise notice 'PASS migration control: % is rejected', test_case.label;
  end loop;
end
$$;

-- Canonical order is accepted, proving the constraint discriminates on order
-- rather than rejecting multi-category rows outright.
insert into migration_control.schema_migrations (
  migration_id, ordinal, filename, manifest_checksum_sha256, applied_checksum_sha256,
  lifecycle_phase, operation_categories, execution_mode, applied_at, run_id,
  baselined, source_git_sha, executor_image_digest
) values (
  '0003', 3, '0003_tenancy_iam.sql', repeat('a', 64), repeat('a', 64),
  'expand', array['schema', 'security-policy'], 'legacy-verbatim', clock_timestamp(),
  '10000000-0000-4000-8000-000000000003', false, repeat('b', 40), 'sha256:' || repeat('c', 64)
);
select pg_temp.migration_control_assert(true, 'canonical operation category order is accepted');

do $$
declare
  target text;
begin
  foreach target in array array['schema_migrations', 'migration_runs'] loop
    begin
      execute format('truncate table migration_control.%I', target);
      raise exception 'TRUNCATE of % unexpectedly succeeded', target;
    exception when sqlstate '55000' then
      if sqlerrm <> 'migration control rows are immutable' then raise; end if;
    end;
    raise notice 'PASS migration control: % TRUNCATE is rejected', target;
  end loop;
end
$$;

rollback;

select pg_temp.migration_control_assert(
  not exists (
    select 1
      from pg_namespace n,
      lateral aclexplode(coalesce(n.nspacl, acldefault('n', n.nspowner))) acl
     where n.nspname = 'migration_control' and acl.grantee = 0
  ),
  'PUBLIC has no control-schema privileges'
);
-- The runtime role is created by db/migrations/0001_extensions_helpers.sql, so a
-- bare control-schema install may legitimately predate it.
select pg_temp.migration_control_assert(
  to_regrole('submitsense_app') is null
  or (
    not has_schema_privilege('submitsense_app', 'migration_control', 'USAGE,CREATE')
    and not has_table_privilege(
      'submitsense_app',
      'migration_control.schema_migrations',
      'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
    )
    and not has_table_privilege(
      'submitsense_app',
      'migration_control.migration_runs',
      'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
    )
  ),
  'submitsense_app has no control-schema or ledger privileges'
);
-- tgtype 27 = ROW|BEFORE|DELETE|UPDATE, 34 = STATEMENT|BEFORE|TRUNCATE.
select pg_temp.migration_control_assert(
  (
    select array_agg(t.tgname || ':' || t.tgtype::text || ':' || t.tgenabled::text order by t.tgname)
      from pg_trigger t
      join pg_class c on c.oid = t.tgrelid
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'migration_control'
       and not t.tgisinternal
  ) = array[
    'migration_runs_reject_mutation:27:A',
    'migration_runs_reject_truncate:34:A',
    'schema_migrations_reject_mutation:27:A',
    'schema_migrations_reject_truncate:34:A'
  ],
  'all four mutation-rejection triggers are enabled always with the expected types'
);

-- Advisory-lock behaviour is proven by polling pg_locks for the real granted
-- lock rather than sleeping a fixed interval. Every path echoes 0 unless setup
-- actually happened, so a race fails the assertion instead of falsely passing.
\set lock_exclusion `out=$(mktemp); psql "$DATABASE_URL" -XAtq -c 'select pg_advisory_lock(1398096461, 1); select pg_sleep(10)' >"$out" 2>&1 & holder=$!; held=0; for attempt in $(seq 1 200); do n=$(psql "$DATABASE_URL" -XAtq -c "select count(*) from pg_locks where locktype = 'advisory' and classid = 1398096461::oid and objid = 1::oid and objsubid = 2 and granted"); if [ "$n" = 1 ]; then held=1; break; fi; sleep 0.05; done; if [ "$held" != 1 ]; then kill $holder 2>/dev/null; wait $holder 2>/dev/null; rm -f "$out"; echo 0; else probe=$(psql "$DATABASE_URL" -XAtq -c "select pg_try_advisory_lock(1398096461, 1)"); kill $holder 2>/dev/null; wait $holder 2>/dev/null; rm -f "$out"; if [ "$probe" = f ]; then echo 1; else echo 0; fi; fi`
select pg_temp.migration_control_assert(
  :'lock_exclusion' = '1',
  'a confirmed lock holder blocks a second session (nonblocking probe returns false)'
);

\set disconnect_release `out=$(mktemp); PGAPPNAME=pb10-disconnect-holder psql "$DATABASE_URL" -XAtq -c 'select pg_advisory_lock(1398096461, 1); select pg_sleep(30)' >"$out" 2>&1 & holder=$!; held=0; for attempt in $(seq 1 200); do n=$(psql "$DATABASE_URL" -XAtq -c "select count(*) from pg_locks l join pg_stat_activity a on a.pid = l.pid where l.locktype = 'advisory' and l.classid = 1398096461::oid and l.objid = 1::oid and l.objsubid = 2 and l.granted and a.application_name = 'pb10-disconnect-holder'"); if [ "$n" = 1 ]; then held=1; break; fi; sleep 0.05; done; if [ "$held" != 1 ]; then kill $holder 2>/dev/null; wait $holder 2>/dev/null; rm -f "$out"; echo 0; else killed=$(psql "$DATABASE_URL" -XAtq -c "select count(*) from (select pg_terminate_backend(a.pid) from pg_stat_activity a where a.application_name = 'pb10-disconnect-holder' and a.pid <> pg_backend_pid()) s"); wait $holder 2>/dev/null; rm -f "$out"; if [ "$killed" != 1 ]; then echo 0; else released=0; for attempt in $(seq 1 200); do probe=$(psql "$DATABASE_URL" -XAtq -c "select pg_try_advisory_lock(1398096461, 1)"); if [ "$probe" = t ]; then released=1; break; fi; sleep 0.05; done; echo $released; fi; fi`
select pg_temp.migration_control_assert(
  :'disconnect_release' = '1',
  'terminating exactly one confirmed holder releases the schema advisory lock'
);
