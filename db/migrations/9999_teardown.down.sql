-- 9999_teardown.down.sql
-- Baseline rollback (req f30). Drops every object created by 0001-0099 so the schema can be
-- rebuilt from scratch. Extensions and cluster roles used elsewhere are left in place.
-- NOT for routine production rollback — see db/README.md "Rollback strategy" for the go-forward
-- convention (paired down migrations per change once past this baseline).

begin;

-- Grants revoked implicitly by dropping the objects. Drop tables (FK order handled by CASCADE).
do $$
declare r record;
begin
  for r in select tablename from pg_tables where schemaname = 'public'
  loop
    execute format('drop table if exists public.%I cascade', r.tablename);
  end loop;
end$$;

-- Drop enum types.
do $$
declare r record;
begin
  for r in
    select t.typname
    from pg_type t join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'public' and t.typtype = 'e'
  loop
    execute format('drop type if exists public.%I cascade', r.typname);
  end loop;
end$$;

-- Helper schema (functions live here).
drop schema if exists app cascade;

commit;

-- Roles are cluster-level; drop outside the txn and only if unused elsewhere.
drop role if exists submitsense_app;
drop role if exists submitsense_auditor;
