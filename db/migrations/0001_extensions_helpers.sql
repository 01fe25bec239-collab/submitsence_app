-- 0001_extensions_helpers.sql
-- Extensions, roles, tenant-context helpers, and shared trigger functions.
-- Apply order: run migrations in ascending filename order on a blank PostgreSQL 17+ database.
-- Idempotent guards are used only for cluster-level objects (roles) so re-running on a
-- shared cluster does not fail; table DDL is intentionally NOT guarded (baseline migrations run once).

begin;

-- --- Extensions ------------------------------------------------------------
-- vector : product/spec embeddings (required, req f14).
-- citext : case-insensitive email + slug uniqueness without app-side lower() (native, req f1/f24).
-- pg_trgm: fuzzy indexes for vendor/product/content lookup (req f26 "vendor match search", content).
-- gen_random_uuid() and sha256() are core in PG13+/PG11+ respectively -> no pgcrypto needed.
create extension if not exists vector;
create extension if not exists citext;
create extension if not exists pg_trgm;

-- --- Application roles ------------------------------------------------------
-- submitsense_app : the role the runtime connects as. RLS APPLIES to it (it is not a table owner
--                   and has no BYPASSRLS). All per-request queries run here after SET app.tenant_id.
-- submitsense_auditor : read-only export of audit trail (req f26/h9 audit export).
-- The migration/owner role (whoever runs these files) owns the tables and therefore bypasses RLS,
-- which is why seed + migrations work without special handling. See docs/rls.md.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'submitsense_app') then
    create role submitsense_app nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'submitsense_auditor') then
    create role submitsense_auditor nologin;
  end if;
end$$;

-- --- Helper schema + tenant context ----------------------------------------
create schema if not exists app;

-- Per-request context is passed via GUCs the app sets each transaction:
--   SET LOCAL app.tenant_id  = '<uuid>';
--   SET LOCAL app.user_id    = '<uuid>';
--   SET LOCAL app.actor_type = 'human' | 'system';
-- The 'true' arg = missing_ok, so an unset GUC returns NULL instead of erroring.
create or replace function app.current_tenant_id() returns uuid
  language sql stable as $$
  select nullif(current_setting('app.tenant_id', true), '')::uuid
$$;

create or replace function app.current_user_id() returns uuid
  language sql stable as $$
  select nullif(current_setting('app.user_id', true), '')::uuid
$$;

create or replace function app.current_actor_type() returns text
  language sql stable as $$
  select coalesce(nullif(current_setting('app.actor_type', true), ''), 'system')
$$;

-- --- Shared trigger: maintain updated_at -----------------------------------
create or replace function app.set_updated_at() returns trigger
  language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end$$;

-- --- Shared trigger: block mutation (used to make audit append-only) --------
create or replace function app.forbid_mutation() returns trigger
  language plpgsql as $$
begin
  raise exception 'append-only table %: % is not permitted', tg_table_name, tg_op
    using errcode = '0LP01';
end$$;

grant usage on schema app to submitsense_app, submitsense_auditor;
grant execute on function app.current_tenant_id(), app.current_user_id(), app.current_actor_type()
  to submitsense_app, submitsense_auditor;

commit;
