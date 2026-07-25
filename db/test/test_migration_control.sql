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
select pg_temp.migration_control_assert(
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
  ),
  'submitsense_app has no control-schema or ledger privileges'
);
select pg_temp.migration_control_assert(
  (
    select count(*)
      from pg_trigger t
      join pg_class c on c.oid = t.tgrelid
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'migration_control'
       and not t.tgisinternal
       and t.tgenabled = 'A'
  ) = 2,
  'both mutation-rejection triggers are enabled always'
);

\set lock_exclusion `sh -c 'first="$(mktemp /tmp/pb10-lock-holder.XXXXXX)"; psql "$DATABASE_URL" -XAtq -v ON_ERROR_STOP=1 -c "select pg_advisory_lock(1398096461, 1); select pg_sleep(1)" > "$first" & holder=$!; sleep 0.2; result="$(psql "$DATABASE_URL" -XAtq -v ON_ERROR_STOP=1 -c "select pg_try_advisory_lock(1398096461, 1)")"; wait "$holder"; rm -f "$first"; test "$result" = f && echo 1 || echo 0'`
select pg_temp.migration_control_assert(
  :'lock_exclusion' = '1',
  'two sessions prove schema advisory-lock exclusion'
);

\set disconnect_release `sh -c 'first="$(mktemp /tmp/pb10-lock-disconnect.XXXXXX)"; PGAPPNAME=pb10-disconnect-holder psql "$DATABASE_URL" -XAtq -v ON_ERROR_STOP=1 -c "select pg_advisory_lock(1398096461, 1); select pg_sleep(10)" > "$first" 2>/dev/null & holder=$!; sleep 0.2; psql "$DATABASE_URL" -XAtq -v ON_ERROR_STOP=1 -c "select pg_terminate_backend(pid) from pg_stat_activity where application_name = '\''pb10-disconnect-holder'\''" >/dev/null; wait "$holder" 2>/dev/null || true; result="$(psql "$DATABASE_URL" -XAtq -v ON_ERROR_STOP=1 -c "select pg_try_advisory_lock(1398096461, 1)")"; rm -f "$first"; test "$result" = t && echo 1 || echo 0'`
select pg_temp.migration_control_assert(
  :'disconnect_release' = '1',
  'disconnecting a schema-lock holder releases the lock'
);
