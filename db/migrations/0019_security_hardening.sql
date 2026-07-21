-- Tenant-root isolation, service-account least privilege, and manual/risk state markers.

begin;

alter table tenants enable row level security;

-- A user-context transaction must see its own tenants before app.tenant_id is selected.
create policy tenant_root_read on tenants
  for select to submitsense_app
  using (
    id = app.current_tenant_id()
    or exists (
      select 1
        from tenant_memberships m
       where m.tenant_id = tenants.id
         and m.user_id = app.current_user_id()
         and m.status = 'active'
    )
  );

create policy tenant_root_update on tenants
  for update to submitsense_app
  using (id = app.current_tenant_id())
  with check (id = app.current_tenant_id());

revoke insert, delete on tenants from submitsense_app;

alter table risk_flags
  add column is_active boolean not null default true;

alter table products
  add column manually_reviewed boolean not null default false;

-- Keep the newest consented event active for each risk flag. Older duplicates
-- remain available as history but are excluded from learning aggregates.
with ranked_learning_events as (
  select id,
         row_number() over (partition by tenant_id, risk_flag_id order by created_at desc, id desc) as position
    from rejection_learning_events
   where risk_flag_id is not null and opted_out = false
)
update rejection_learning_events event
   set opted_out = true
  from ranked_learning_events ranked
 where event.id = ranked.id and ranked.position > 1;

create unique index uq_learning_active_risk_flag
  on rejection_learning_events (tenant_id, risk_flag_id)
  where risk_flag_id is not null and opted_out = false;

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
  if p_tenant_id is distinct from app.current_tenant_id()
     or p_invited_by is distinct from app.current_user_id() then
    raise exception 'tenant-invitation actor context mismatch' using errcode = 'insufficient_privilege';
  end if;

  if not app.auth_actor_has_permission(p_tenant_id, p_invited_by, 'member.manage') then
    raise exception 'member.manage permission required' using errcode = 'insufficient_privilege';
  end if;

  if p_role_key = 'owner' and not exists (
    select 1
      from tenant_memberships
     where tenant_id = p_tenant_id
       and user_id = p_invited_by
       and is_owner
       and status = 'active'
  ) then
    raise exception 'only tenant owners may invite an owner' using errcode = 'insufficient_privilege';
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

  insert into tenant_memberships (tenant_id, user_id, role_id, is_owner, invited_by, status)
  values (p_tenant_id, invited_user_id, v_role_id, p_role_key = 'owner', p_invited_by, 'invited')
  on conflict (tenant_id, user_id) do update
    set role_id = excluded.role_id,
        is_owner = excluded.is_owner,
        invited_by = excluded.invited_by,
        status = 'invited',
        updated_at = now()
    where tenant_memberships.status <> 'active'
  returning id into membership_id;

  if membership_id is null then
    raise exception 'user is already an active tenant member' using errcode = 'object_not_in_prerequisite_state';
  end if;

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
  v_is_owner boolean;
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

  select key = 'owner' into v_is_owner from roles where id = v_inv.role_id;

  insert into tenant_memberships (tenant_id, user_id, role_id, is_owner, invited_by, status)
  values (v_inv.tenant_id, p_user_id, v_inv.role_id, v_is_owner, v_inv.invited_by, 'active')
  on conflict on constraint tenant_memberships_tenant_id_user_id_key do update
    set role_id = case when tenant_memberships.status = 'active' then tenant_memberships.role_id else excluded.role_id end,
        is_owner = case when tenant_memberships.status = 'active' then tenant_memberships.is_owner else excluded.is_owner end,
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
  v_role_key text := coalesce(nullif(p_role_key, ''), 'integration_admin');
begin
  if p_tenant_id is distinct from app.current_tenant_id()
     or p_created_by is distinct from app.current_user_id() then
    raise exception 'service-account actor context mismatch' using errcode = 'insufficient_privilege';
  end if;

  if not app.auth_actor_has_permission(p_tenant_id, p_created_by, 'integration.manage') then
    raise exception 'integration.manage permission required' using errcode = 'insufficient_privilege';
  end if;

  if v_role_key <> 'integration_admin' then
    raise exception 'service accounts require the integration_admin role' using errcode = 'insufficient_privilege';
  end if;

  select id into v_role_id from roles where key = v_role_key;
  if v_role_id is null then
    raise exception 'integration_admin role is not configured' using errcode = 'invalid_parameter_value';
  end if;

  insert into users (email, full_name, kind, status)
  values (p_email::citext, coalesce(nullif(p_full_name, ''), p_email), 'service_account', 'active')
  returning id into service_user_id;

  insert into tenant_memberships (tenant_id, user_id, role_id, status)
  values (p_tenant_id, service_user_id, v_role_id, 'active')
  returning id into membership_id;

  return next;
end$$;

commit;
