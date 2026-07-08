-- 0014_auth_support.sql
-- Auth-service support for Cognito mapping, invitations, service accounts, and auth audit.

begin;

-- One-time invite tokens. Store only a hash; the raw token is returned once to the mailer.
create table tenant_invitations (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  email       citext not null,
  role_id     uuid not null references roles(id) on delete restrict,
  invited_by  uuid not null references users(id),
  token_hash  text not null unique,
  expires_at  timestamptz not null,
  accepted_at timestamptz,
  revoked_at  timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  check (expires_at > created_at)
);
create unique index idx_tenant_invitations_active_email
  on tenant_invitations (tenant_id, email)
  where accepted_at is null and revoked_at is null;
create index idx_tenant_invitations_tenant on tenant_invitations (tenant_id, created_at);

create trigger trg_tenant_invitations_updated_at
  before update on tenant_invitations
  for each row execute function app.set_updated_at();

alter table tenant_invitations enable row level security;
create policy tenant_invitation_isolation on tenant_invitations
  using (tenant_id = app.current_tenant_id())
  with check (tenant_id = app.current_tenant_id());

grant select, insert, update on tenant_invitations to submitsense_app;

create or replace function app.auth_actor_has_permission(
  p_tenant_id uuid,
  p_actor_user_id uuid,
  p_permission_key text
) returns boolean
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from tenant_memberships tm
    join roles r on r.id = tm.role_id
    join role_permissions rp on rp.role_id = r.id
    join permissions p on p.id = rp.permission_id
    join users u on u.id = tm.user_id
    join tenants t on t.id = tm.tenant_id
    where tm.tenant_id = p_tenant_id
      and tm.user_id = p_actor_user_id
      and tm.status = 'active'
      and u.status = 'active'
      and t.status = 'active'
      and p.key = p_permission_key
  )
$$;

create or replace function app.resolve_cognito_principal(p_cognito_sub text)
returns table (
  id uuid,
  email citext,
  full_name text,
  kind user_kind,
  status text,
  cognito_sub text
)
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $$
  select u.id, u.email, u.full_name, u.kind, u.status, u.cognito_sub
  from users u
  where u.cognito_sub = p_cognito_sub
    and u.deleted_at is null
$$;

create or replace function app.link_cognito_user(
  p_cognito_sub text,
  p_email text,
  p_full_name text
) returns uuid
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
declare
  v_user users%rowtype;
begin
  if nullif(p_cognito_sub, '') is null or nullif(p_email, '') is null then
    raise exception 'cognito sub and email are required' using errcode = 'invalid_parameter_value';
  end if;

  select * into v_user from users where cognito_sub = p_cognito_sub for update;
  if found then
    update users
       set email = p_email::citext,
           full_name = coalesce(nullif(p_full_name, ''), full_name),
           status = 'active',
           updated_at = now()
     where id = v_user.id;
    return v_user.id;
  end if;

  select * into v_user from users where email = p_email::citext for update;
  if found then
    if v_user.cognito_sub is not null and v_user.cognito_sub <> p_cognito_sub then
      raise exception 'email is already linked to another Cognito subject' using errcode = 'unique_violation';
    end if;

    update users
       set cognito_sub = p_cognito_sub,
           full_name = coalesce(nullif(p_full_name, ''), full_name),
           status = 'active',
           updated_at = now()
     where id = v_user.id;
    return v_user.id;
  end if;

  insert into users (email, cognito_sub, full_name, kind, status)
  values (p_email::citext, p_cognito_sub, coalesce(nullif(p_full_name, ''), p_email), 'human', 'active')
  returning users.id into v_user.id;

  return v_user.id;
end$$;

create or replace function app.record_auth_login(p_user_id uuid) returns void
  language sql
  security definer
  set search_path = public, pg_temp
as $$
  update users set last_login_at = now(), updated_at = now() where id = p_user_id
$$;

create or replace function app.auth_audit(
  p_tenant_id uuid,
  p_actor_user_id uuid,
  p_actor_type text,
  p_action text,
  p_summary text,
  p_payload jsonb,
  p_ip_address inet,
  p_user_agent text,
  p_event_type audit_event_type
) returns uuid
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  insert into audit_events (
    tenant_id, event_type, actor_user_id, actor_type, action, summary,
    payload, ip_address, user_agent
  )
  values (
    p_tenant_id, coalesce(p_event_type, 'auth_sensitive'::audit_event_type), p_actor_user_id,
    coalesce(nullif(p_actor_type, ''), 'system'), p_action, p_summary,
    coalesce(p_payload, '{}'::jsonb), p_ip_address, p_user_agent
  )
  returning id into v_id;

  return v_id;
end$$;

create or replace function app.create_tenant_invitation(
  p_tenant_id uuid,
  p_email text,
  p_full_name text,
  p_role_key text,
  p_invited_by uuid,
  p_token_hash text,
  p_expires_at timestamptz
) returns table (invitation_id uuid, invited_user_id uuid, membership_id uuid)
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
declare
  v_role_id uuid;
begin
  if not app.auth_actor_has_permission(p_tenant_id, p_invited_by, 'member.manage') then
    raise exception 'member.manage permission required' using errcode = 'insufficient_privilege';
  end if;

  select id into v_role_id from roles where key = p_role_key;
  if v_role_id is null then
    raise exception 'unknown role: %', p_role_key using errcode = 'invalid_parameter_value';
  end if;

  insert into users (email, full_name, kind, status)
  values (p_email::citext, coalesce(nullif(p_full_name, ''), p_email), 'human', 'invited')
  on conflict (email) do update
    set full_name = coalesce(nullif(excluded.full_name, ''), users.full_name),
        updated_at = now()
  returning id into invited_user_id;

  insert into tenant_memberships (tenant_id, user_id, role_id, invited_by, status)
  values (p_tenant_id, invited_user_id, v_role_id, p_invited_by, 'invited')
  on conflict (tenant_id, user_id) do update
    set role_id = excluded.role_id,
        invited_by = excluded.invited_by,
        status = case when tenant_memberships.status = 'active' then 'active' else 'invited' end,
        updated_at = now()
  returning id into membership_id;

  update tenant_invitations
     set revoked_at = now()
   where tenant_id = p_tenant_id
     and email = p_email::citext
     and accepted_at is null
     and revoked_at is null;

  insert into tenant_invitations (tenant_id, email, role_id, invited_by, token_hash, expires_at)
  values (p_tenant_id, p_email::citext, v_role_id, p_invited_by, p_token_hash, p_expires_at)
  returning id into invitation_id;

  return next;
end$$;

create or replace function app.accept_tenant_invitation(
  p_token_hash text,
  p_user_id uuid
) returns table (tenant_id uuid, membership_id uuid)
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
declare
  v_inv tenant_invitations%rowtype;
  v_user users%rowtype;
begin
  select * into v_inv
  from tenant_invitations
  where token_hash = p_token_hash
    and accepted_at is null
    and revoked_at is null
    and expires_at > now()
  for update;

  if not found then
    raise exception 'invalid or expired invitation' using errcode = 'invalid_authorization_specification';
  end if;

  select * into v_user from users where id = p_user_id and deleted_at is null for update;
  if not found or lower(v_user.email::text) <> lower(v_inv.email::text) then
    raise exception 'invitation does not match authenticated user' using errcode = 'insufficient_privilege';
  end if;

  insert into tenant_memberships (tenant_id, user_id, role_id, invited_by, status)
  values (v_inv.tenant_id, p_user_id, v_inv.role_id, v_inv.invited_by, 'active')
  on conflict (tenant_id, user_id) do update
    set role_id = excluded.role_id,
        status = 'active',
        updated_at = now()
  returning tenant_memberships.id into membership_id;

  update tenant_invitations set accepted_at = now() where id = v_inv.id;
  update users set status = 'active', updated_at = now() where id = p_user_id;

  tenant_id := v_inv.tenant_id;
  return next;
end$$;

create or replace function app.create_service_account(
  p_tenant_id uuid,
  p_email text,
  p_full_name text,
  p_role_key text,
  p_created_by uuid
) returns table (service_user_id uuid, membership_id uuid)
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
declare
  v_role_id uuid;
begin
  if not app.auth_actor_has_permission(p_tenant_id, p_created_by, 'integration.manage') then
    raise exception 'integration.manage permission required' using errcode = 'insufficient_privilege';
  end if;

  select id into v_role_id from roles where key = coalesce(nullif(p_role_key, ''), 'integration_admin');
  if v_role_id is null then
    raise exception 'unknown role: %', p_role_key using errcode = 'invalid_parameter_value';
  end if;

  insert into users (email, full_name, kind, status)
  values (p_email::citext, coalesce(nullif(p_full_name, ''), p_email), 'service_account', 'active')
  returning id into service_user_id;

  insert into tenant_memberships (tenant_id, user_id, role_id, status)
  values (p_tenant_id, service_user_id, v_role_id, 'active')
  returning id into membership_id;

  return next;
end$$;

grant execute on function
  app.auth_actor_has_permission(uuid, uuid, text),
  app.resolve_cognito_principal(text),
  app.link_cognito_user(text, text, text),
  app.record_auth_login(uuid),
  app.auth_audit(uuid, uuid, text, text, text, jsonb, inet, text, audit_event_type),
  app.create_tenant_invitation(uuid, text, text, text, uuid, text, timestamptz),
  app.accept_tenant_invitation(text, uuid),
  app.create_service_account(uuid, text, text, text, uuid)
to submitsense_app;

commit;
