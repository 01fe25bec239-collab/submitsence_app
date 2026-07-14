begin;

drop index if exists uq_learning_active_risk_flag;

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

alter table products
  drop column manually_reviewed;

alter table risk_flags
  drop column is_active;

drop policy tenant_root_update on tenants;
drop policy tenant_root_read on tenants;
alter table tenants disable row level security;
grant insert, delete on tenants to submitsense_app;

commit;
