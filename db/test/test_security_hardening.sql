-- Security regression checks for 0019. Runs after migrations + seed and always rolls back.
\set ON_ERROR_STOP on
begin;

insert into tenants (id, slug, name)
values ('20000000-0000-4000-8000-000000000019', 'security-other', 'Security Other');

insert into users (id, email, full_name)
values
  ('20000000-0000-4000-8000-000000000020', 'suspended@security.example', 'Suspended Security User'),
  ('20000000-0000-4000-8000-000000000021', 'admin@security.example', 'Security Admin');

insert into tenant_memberships (tenant_id, user_id, role_id, status)
select '20000000-0000-4000-8000-000000000019', '20000000-0000-4000-8000-000000000020', id, 'suspended'
 from roles
 where key = 'viewer';

insert into tenant_memberships (tenant_id, user_id, role_id, status)
select '11111111-1111-1111-1111-111111111111', '20000000-0000-4000-8000-000000000021', id, 'active'
  from roles
 where key = 'admin';

set local role submitsense_app;
select set_config('app.tenant_id', '', true);
select set_config('app.user_id', '22222222-2222-2222-2222-222222222222', true);
select set_config('app.actor_type', 'human', true);

do $$
declare visible integer; cross_tenant integer;
begin
  select count(*) into visible from tenants;
  select count(*) into cross_tenant from tenants where id = '20000000-0000-4000-8000-000000000019';
  if visible <> 1 or cross_tenant <> 0 then
    raise exception 'FAIL security 1: tenant root visibility visible=% cross_tenant=%', visible, cross_tenant;
  end if;
  raise notice 'PASS security 1: user context resolves memberships without exposing other tenants';
end$$;

select set_config('app.user_id', '20000000-0000-4000-8000-000000000020', true);

do $$
declare visible integer;
begin
  select count(*) into visible from tenants;
  if visible <> 0 then
    raise exception 'FAIL security 1b: suspended membership exposed % tenant roots', visible;
  end if;
  raise notice 'PASS security 1b: suspended memberships cannot discover tenant roots';
end$$;

select set_config('app.user_id', '22222222-2222-2222-2222-222222222222', true);
select set_config('app.tenant_id', '11111111-1111-1111-1111-111111111111', true);

do $$
declare own_rows integer; cross_rows integer;
begin
  update tenants set name = name where id = '11111111-1111-1111-1111-111111111111';
  get diagnostics own_rows = row_count;
  update tenants set name = 'tampered' where id = '20000000-0000-4000-8000-000000000019';
  get diagnostics cross_rows = row_count;
  if own_rows <> 1 or cross_rows <> 0 then
    raise exception 'FAIL security 2: tenant root update own=% cross=%', own_rows, cross_rows;
  end if;
  raise notice 'PASS security 2: tenant root updates are tenant scoped';
end$$;

select set_config('app.user_id', '20000000-0000-4000-8000-000000000021', true);

do $$
begin
  begin
    perform 1 from app.create_tenant_invitation(
      '11111111-1111-1111-1111-111111111111',
      'owner-escalation@example.com',
      'Owner Escalation',
      'owner',
      '20000000-0000-4000-8000-000000000021',
      'owner-escalation-token',
      now() + interval '1 day'
    );
    raise exception 'FAIL invite security: non-owner created an owner invitation';
  exception when insufficient_privilege then
    if sqlerrm <> 'only tenant owners may invite an owner' then
      raise;
    end if;
    raise notice 'PASS invite security: DB function keeps owner invitations owner-only';
  end;
end$$;

select set_config('app.user_id', '22222222-2222-2222-2222-222222222222', true);

do $$
begin
  begin
    insert into tenants (slug, name) values ('runtime-created', 'Runtime Created');
    raise exception 'FAIL security 3a: runtime tenant insert was allowed';
  exception when insufficient_privilege then
    raise notice 'PASS security 3a: runtime tenant insert blocked';
  end;
  begin
    delete from tenants where id = '11111111-1111-1111-1111-111111111111';
    raise exception 'FAIL security 3b: runtime tenant delete was allowed';
  exception when insufficient_privilege then
    raise notice 'PASS security 3b: runtime tenant delete blocked';
  end;
end$$;

reset role;

do $$
declare membership_role text; membership_status text; owner_flag boolean;
begin
  perform 1 from app.create_tenant_invitation(
    '11111111-1111-1111-1111-111111111111',
    'new-owner@security.example',
    'New Security Owner',
    'owner',
    '22222222-2222-2222-2222-222222222222',
    'new-owner-token',
    now() + interval '1 day'
  );
  select r.key, tm.is_owner into membership_role, owner_flag
    from tenant_memberships tm
    join users u on u.id = tm.user_id
    join roles r on r.id = tm.role_id
   where tm.tenant_id = '11111111-1111-1111-1111-111111111111'
     and u.email = 'new-owner@security.example';
  if membership_role <> 'owner' or owner_flag is distinct from true then
    raise exception 'FAIL invite membership: new owner role=% is_owner=%', membership_role, owner_flag;
  end if;
  raise notice 'PASS invite membership: new owner invitations set owner membership state';

  perform 1 from app.accept_tenant_invitation(
    'new-owner-token',
    (select id from users where email = 'new-owner@security.example')
  );
  select r.key, tm.status, tm.is_owner into membership_role, membership_status, owner_flag
    from tenant_memberships tm
    join users u on u.id = tm.user_id
    join roles r on r.id = tm.role_id
   where tm.tenant_id = '11111111-1111-1111-1111-111111111111'
     and u.email = 'new-owner@security.example';
  if membership_role <> 'owner' or membership_status <> 'active' or owner_flag is distinct from true then
    raise exception 'FAIL invitation acceptance: pending owner role=% status=% is_owner=%', membership_role, membership_status, owner_flag;
  end if;
  raise notice 'PASS invitation acceptance: pending owner activates with consistent owner state';

  perform 1 from app.create_tenant_invitation(
    '11111111-1111-1111-1111-111111111111',
    'updated-invite@security.example',
    'Updated Invite',
    'viewer',
    '22222222-2222-2222-2222-222222222222',
    'updated-viewer-token',
    now() + interval '1 day'
  );
  perform 1 from app.create_tenant_invitation(
    '11111111-1111-1111-1111-111111111111',
    'updated-invite@security.example',
    'Updated Invite',
    'owner',
    '22222222-2222-2222-2222-222222222222',
    'updated-owner-token',
    now() + interval '1 day'
  );
  select r.key, tm.is_owner into membership_role, owner_flag
    from tenant_memberships tm
    join users u on u.id = tm.user_id
    join roles r on r.id = tm.role_id
   where tm.tenant_id = '11111111-1111-1111-1111-111111111111'
     and u.email = 'updated-invite@security.example';
  if membership_role <> 'owner' or owner_flag is distinct from true then
    raise exception 'FAIL invite membership: pending role update role=% is_owner=%', membership_role, owner_flag;
  end if;
  raise notice 'PASS invite membership: pending invitations update role and owner state together';
end$$;

select set_config('app.user_id', '20000000-0000-4000-8000-000000000021', true);

do $$
declare membership_role text; owner_flag boolean; dangerous_tokens integer;
begin
  begin
    perform 1 from app.create_tenant_invitation(
      '11111111-1111-1111-1111-111111111111',
      'owner@acme.example',
      'Olivia Owner',
      'viewer',
      '20000000-0000-4000-8000-000000000021',
      'active-owner-reinvite-token',
      now() + interval '1 day'
    );
    raise exception 'FAIL invite membership: active member invitation was created';
  exception when object_not_in_prerequisite_state then
    if sqlerrm <> 'user is already an active tenant member' then
      raise;
    end if;
  end;
  select r.key, tm.is_owner into membership_role, owner_flag
    from tenant_memberships tm
    join roles r on r.id = tm.role_id
   where tm.tenant_id = '11111111-1111-1111-1111-111111111111'
     and tm.user_id = '22222222-2222-2222-2222-222222222222';
  if membership_role <> 'owner' or owner_flag is distinct from true then
    raise exception 'FAIL invite membership: active owner was changed to role=% is_owner=%', membership_role, owner_flag;
  end if;
  select count(*) into dangerous_tokens from tenant_invitations where token_hash = 'active-owner-reinvite-token';
  if dangerous_tokens <> 0 then
    raise exception 'FAIL invite membership: active-member token was persisted';
  end if;
  raise notice 'PASS invite membership: active members cannot be re-invited';

  insert into tenant_invitations (tenant_id, email, role_id, invited_by, token_hash, expires_at)
  select '11111111-1111-1111-1111-111111111111', 'owner@acme.example', id,
         '20000000-0000-4000-8000-000000000021', 'legacy-owner-downgrade-token', now() + interval '1 day'
    from roles where key = 'viewer';
  perform 1 from app.accept_tenant_invitation(
    'legacy-owner-downgrade-token',
    '22222222-2222-2222-2222-222222222222'
  );
  select r.key, tm.is_owner into membership_role, owner_flag
    from tenant_memberships tm
    join roles r on r.id = tm.role_id
   where tm.tenant_id = '11111111-1111-1111-1111-111111111111'
     and tm.user_id = '22222222-2222-2222-2222-222222222222';
  if membership_role <> 'owner' or owner_flag is distinct from true then
    raise exception 'FAIL invitation acceptance: legacy token changed active owner to role=% is_owner=%', membership_role, owner_flag;
  end if;
  raise notice 'PASS invitation acceptance: legacy tokens cannot change active membership authority';
end$$;

select set_config('app.user_id', '22222222-2222-2222-2222-222222222222', true);

do $$
begin
  begin
    perform 1 from app.create_tenant_invitation(
      '20000000-0000-4000-8000-000000000019',
      'cross-tenant-invite@example.com',
      'Cross Tenant Invite',
      'viewer',
      '22222222-2222-2222-2222-222222222222',
      'cross-tenant-token',
      now() + interval '1 day'
    );
    raise exception 'FAIL invite security: cross-tenant invitation context was allowed';
  exception when insufficient_privilege then
    if sqlerrm <> 'tenant-invitation actor context mismatch' then
      raise;
    end if;
    raise notice 'PASS invite security: DB function binds invitations to the active tenant';
  end;
  begin
    perform 1 from app.create_tenant_invitation(
      '11111111-1111-1111-1111-111111111111',
      'impersonated-invite@example.com',
      'Impersonated Invite',
      'viewer',
      '33333333-3333-3333-3333-333333333333',
      'impersonated-token',
      now() + interval '1 day'
    );
    raise exception 'FAIL invite security: impersonated inviter was allowed';
  exception when insufficient_privilege then
    if sqlerrm <> 'tenant-invitation actor context mismatch' then
      raise;
    end if;
    raise notice 'PASS invite security: DB function binds invitations to the active actor';
  end;
end$$;

do $$
begin
  begin
    perform 1 from app.create_service_account(
      '20000000-0000-4000-8000-000000000019',
      'cross-tenant-bot@example.com',
      'Cross Tenant Bot',
      'integration_admin',
      '22222222-2222-2222-2222-222222222222'
    );
    raise exception 'FAIL security 4a: cross-tenant service-account context was allowed';
  exception when insufficient_privilege then
    if sqlerrm <> 'service-account actor context mismatch' then
      raise;
    end if;
    raise notice 'PASS security 4a: DB function binds service accounts to the active tenant';
  end;
  begin
    perform 1 from app.create_service_account(
      '11111111-1111-1111-1111-111111111111',
      'impersonated-bot@example.com',
      'Impersonated Bot',
      'integration_admin',
      '33333333-3333-3333-3333-333333333333'
    );
    raise exception 'FAIL security 4b: impersonated service-account creator was allowed';
  exception when insufficient_privilege then
    if sqlerrm <> 'service-account actor context mismatch' then
      raise;
    end if;
    raise notice 'PASS security 4b: DB function binds service accounts to the active actor';
  end;
  begin
    perform 1 from app.create_service_account(
      '11111111-1111-1111-1111-111111111111',
      'privileged-bot@example.com',
      'Privileged Bot',
      'owner',
      '22222222-2222-2222-2222-222222222222'
    );
    raise exception 'FAIL security 4c: privileged service-account role was allowed';
  exception when insufficient_privilege then
    raise notice 'PASS security 4c: DB function restricts service accounts to integration_admin';
  end;
end$$;

do $$
declare reviewed boolean;
begin
  select manually_reviewed into reviewed from products
   where id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  if reviewed is distinct from false then
    raise exception 'FAIL security 5: extracted product default is not unreviewed';
  end if;
  raise notice 'PASS security 5: manual-review marker defaults safely';
end$$;

insert into risk_flags (
  id, tenant_id, project_id, register_item_id, risk_type, severity, summary,
  rule_key, risk_score, scoring_version
) values (
  '20000000-0000-4000-8000-000000000030',
  '11111111-1111-1111-1111-111111111111',
  '55555555-5555-5555-5555-555555555555',
  '99999999-9999-9999-9999-999999999999',
  'missing_evidence', 'medium', 'Learning uniqueness fixture',
  'security-learning-unique', 50, 'security-test'
);

insert into rejection_learning_events (
  id, tenant_id, risk_flag_id, register_item_id, consent_state, opted_out
) values (
  '20000000-0000-4000-8000-000000000031',
  '11111111-1111-1111-1111-111111111111',
  '20000000-0000-4000-8000-000000000030',
  '99999999-9999-9999-9999-999999999999',
  'opted_in', false
);

do $$
declare active_rows integer; historical_rows integer; index_rows integer;
begin
  select count(*) into index_rows
    from pg_indexes
   where schemaname = 'public' and indexname = 'uq_learning_active_risk_flag';
  if index_rows <> 1 then
    raise exception 'FAIL security 6a: active learning partial unique index is missing';
  end if;

  begin
    insert into rejection_learning_events (tenant_id, risk_flag_id, consent_state, opted_out)
    values (
      '11111111-1111-1111-1111-111111111111',
      '20000000-0000-4000-8000-000000000030',
      'opted_in', false
    );
    raise exception 'FAIL security 6b: duplicate active learning event was allowed';
  exception when unique_violation then
    null;
  end;

  insert into rejection_learning_events (tenant_id, risk_flag_id, consent_state, opted_out)
  values (
    '11111111-1111-1111-1111-111111111111',
    '20000000-0000-4000-8000-000000000030',
    'opted_in', true
  );

  select count(*) filter (where opted_out = false), count(*) filter (where opted_out = true)
    into active_rows, historical_rows
    from rejection_learning_events
   where tenant_id = '11111111-1111-1111-1111-111111111111'
     and risk_flag_id = '20000000-0000-4000-8000-000000000030';
  if active_rows <> 1 or historical_rows <> 1 then
    raise exception 'FAIL security 6c: learning active=% history=%', active_rows, historical_rows;
  end if;
  raise notice 'PASS security 6: one active learning event is enforced while opted-out history is retained';
end$$;

rollback;
