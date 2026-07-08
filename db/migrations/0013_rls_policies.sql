-- 0013_rls_policies.sql
-- Finalizer (runs after all tables exist): updated_at triggers, RLS policies, and grants.
-- RLS model: tables are ENABLE (not FORCE) ROW LEVEL SECURITY, so the migration/owner role bypasses
-- them (that is how seed + admin tasks work) while the runtime role `submitsense_app` — which owns
-- nothing and has no BYPASSRLS — is fully constrained. The app MUST connect as submitsense_app and
-- `SET LOCAL app.tenant_id/user_id/actor_type` per transaction. See docs/rls.md.

begin;

-- --- updated_at trigger on every table that has the column (DRY) -----------
do $$
declare r record;
begin
  for r in
    select c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
      and exists (select 1 from pg_attribute a
                  where a.attrelid = c.oid and a.attname = 'updated_at' and not a.attisdropped)
  loop
    execute format(
      'create trigger trg_set_updated_at before update on %I for each row execute function app.set_updated_at()',
      r.relname);
  end loop;
end$$;

-- --- Tenant isolation on every table that has a tenant_id column (DRY) ------
-- One identical policy everywhere means a new tenant table cannot be forgotten: rerun this block
-- style in future migrations for new tables. USING guards reads; WITH CHECK guards writes.
do $$
declare r record;
begin
  for r in
    select c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
      and exists (select 1 from pg_attribute a
                  where a.attrelid = c.oid and a.attname = 'tenant_id' and not a.attisdropped)
  loop
    execute format('alter table %I enable row level security', r.relname);
    execute format(
      'create policy tenant_isolation on %I using (tenant_id = app.current_tenant_id()) '
      || 'with check (tenant_id = app.current_tenant_id())',
      r.relname);
  end loop;
end$$;

-- --- Users: membership-gated visibility (users has no tenant_id) ------------
alter table users enable row level security;
create policy users_self_or_member on users
  using (
    id = app.current_user_id()
    or exists (select 1 from tenant_memberships m
               where m.user_id = users.id and m.tenant_id = app.current_tenant_id())
  );

-- --- Self-read for membership tables (needed to resolve which tenant to enter)
create policy membership_self on tenant_memberships
  for select using (user_id = app.current_user_id());
create policy project_membership_self on project_memberships
  for select using (user_id = app.current_user_id());

-- --- Auditor: read-only across all tenants' audit trail --------------------
create policy audit_auditor_read on audit_events
  for select to submitsense_auditor using (true);

-- --- Grants ----------------------------------------------------------------
grant usage on schema public to submitsense_app, submitsense_auditor;

-- Runtime app: full DML on tenant data (RLS still applies).
grant select, insert, update, delete on all tables in schema public to submitsense_app;

-- Global catalogs are read-only to the app (managed by admin/owner).
revoke insert, update, delete on
  plans, permissions, roles, role_permissions, knowledge_base_articles
  from submitsense_app;

-- Audit trail is append-only for the app (INSERT + SELECT only).
revoke update, delete, truncate on audit_events from submitsense_app;

-- Auditor: read the audit trail only.
grant select on audit_events to submitsense_auditor;

commit;
