-- 0099_seed.sql
-- Seed: permissions, roles, role_permissions, plans (req f29) + a usable test tenant/project
-- fixture with fixed UUIDs (referenced by db/test/test_guardrails.sql).
-- Runs as the migration owner (bypasses RLS), so tenant-scoped inserts succeed without app context.

begin;

-- --- Permissions ------------------------------------------------------------
insert into permissions (key, description) values
  ('project.read',      'View projects'),
  ('project.manage',    'Create/edit/archive projects'),
  ('document.read',     'View documents'),
  ('document.upload',   'Upload documents'),
  ('register.read',     'View submittal register'),
  ('register.manage',   'Create/edit register items'),
  ('submittal.approve', 'Record human sign-off (human_approved)'),
  ('risk.review',       'Confirm/dismiss risk flags'),
  ('rfi.manage',        'Draft/review RFIs'),
  ('product.match',     'Manage vendor product matches'),
  ('vendor.manage',     'Manage vendors/catalogues/products'),
  ('package.manage',    'Assemble packages and exports'),
  ('integration.manage','Manage consultant-platform integrations'),
  ('billing.manage',    'Manage plan, subscription, invoices'),
  ('content.author',    'Author knowledge-base content'),
  ('member.manage',     'Manage tenant members and roles'),
  ('audit.read',        'Read the audit trail');

-- --- Roles ------------------------------------------------------------------
insert into roles (key, name, description) values
  ('owner',           'Owner',           'Full access including billing and members'),
  ('admin',           'Administrator',   'Full operational access'),
  ('project_manager', 'Project Manager', 'Manage projects, register, packages'),
  ('reviewer',        'Reviewer',        'Licensed human reviewer — may record sign-off'),
  ('contributor',     'Contributor',     'Prepare submittals and matches'),
  ('viewer',          'Viewer',          'Read-only'),
  ('billing_admin',   'Billing Admin',   'Billing only'),
  ('integration_admin','Integration Admin','Manage consultant-platform integrations');

-- --- Role -> permission mapping --------------------------------------------
-- owner + admin: every permission.
insert into role_permissions (role_id, permission_id)
select r.id, p.id from roles r cross join permissions p where r.key in ('owner', 'admin');

-- project_manager
insert into role_permissions (role_id, permission_id)
select r.id, p.id from roles r join permissions p on p.key in
  ('project.read','project.manage','document.read','document.upload','register.read',
   'register.manage','rfi.manage','product.match','vendor.manage','package.manage','audit.read')
where r.key = 'project_manager';

-- reviewer (the only non-admin role that can approve)
insert into role_permissions (role_id, permission_id)
select r.id, p.id from roles r join permissions p on p.key in
  ('project.read','document.read','register.read','register.manage','submittal.approve',
   'risk.review','rfi.manage','package.manage','audit.read')
where r.key = 'reviewer';

-- contributor
insert into role_permissions (role_id, permission_id)
select r.id, p.id from roles r join permissions p on p.key in
  ('project.read','document.read','document.upload','register.read','register.manage',
   'product.match','rfi.manage')
where r.key = 'contributor';

-- viewer
insert into role_permissions (role_id, permission_id)
select r.id, p.id from roles r join permissions p on p.key in
  ('project.read','document.read','register.read')
where r.key = 'viewer';

-- billing_admin
insert into role_permissions (role_id, permission_id)
select r.id, p.id from roles r join permissions p on p.key in ('billing.manage','audit.read')
where r.key = 'billing_admin';

-- integration_admin
insert into role_permissions (role_id, permission_id)
select r.id, p.id from roles r join permissions p on p.key in ('integration.manage','audit.read')
where r.key = 'integration_admin';

-- --- Plans ------------------------------------------------------------------
insert into plans (key, name, tier, price_cents, currency, billing_interval, features) values
  ('trial',        'Free Trial',   'trial',         0, 'AUD', 'month', '{"projects": 1}'),
  ('starter',      'Starter',      'starter',    9900, 'AUD', 'month', '{"projects": 3}'),
  ('professional', 'Professional', 'professional', 29900, 'AUD', 'month', '{"projects": 25}'),
  ('enterprise',   'Enterprise',   'enterprise',    0, 'AUD', 'month', '{"projects": null}');

-- --- Test fixture (fixed UUIDs; used by test_guardrails.sql) ----------------
insert into tenants (id, slug, name, legal_name, abn) values
  ('11111111-1111-1111-1111-111111111111', 'acme', 'Acme Fire & Mechanical',
   'Acme Fire & Mechanical Pty Ltd', '51824753556');

insert into users (id, email, full_name, kind) values
  ('22222222-2222-2222-2222-222222222222', 'owner@acme.example',    'Olivia Owner',    'human'),
  ('33333333-3333-3333-3333-333333333333', 'reviewer@acme.example', 'Riley Reviewer',  'human'),
  ('44444444-4444-4444-4444-444444444444', 'bot@submitsense.internal', 'Extraction Bot', 'service_account');

insert into tenant_memberships (tenant_id, user_id, role_id, is_owner)
select '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', r.id, true
from roles r where r.key = 'owner';
insert into tenant_memberships (tenant_id, user_id, role_id)
select '11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', r.id
from roles r where r.key = 'reviewer';

insert into projects (id, tenant_id, name, client_name, trade, status, created_by) values
  ('55555555-5555-5555-5555-555555555555', '11111111-1111-1111-1111-111111111111',
   'Northbridge Data Centre — Fire', 'BuildCo', 'fire_protection', 'active',
   '22222222-2222-2222-2222-222222222222');

insert into tenant_consents (tenant_id, learning_loop, decided_by, decided_at)
values ('11111111-1111-1111-1111-111111111111', 'opted_in',
        '22222222-2222-2222-2222-222222222222', now());

insert into tenant_subscriptions (tenant_id, plan_id, status, trial_ends_at)
select '11111111-1111-1111-1111-111111111111', p.id, 'trialing', now() + interval '14 days'
from plans p where p.key = 'trial';

-- A small register + vendor/product graph so example queries and the guard tests are runnable.
insert into worksections (id, tenant_id, project_id, code, title) values
  ('66666666-6666-6666-6666-666666666666', '11111111-1111-1111-1111-111111111111',
   '55555555-5555-5555-5555-555555555555', '0711', 'Fire hydrant and hose reel systems');
insert into clauses (id, tenant_id, worksection_id, clause_number, heading) values
  ('77777777-7777-7777-7777-777777777777', '11111111-1111-1111-1111-111111111111',
   '66666666-6666-6666-6666-666666666666', '3.2', 'Product data submission');
insert into submittal_requirements (id, tenant_id, project_id, worksection_id, clause_id, category, title) values
  ('88888888-8888-8888-8888-888888888888', '11111111-1111-1111-1111-111111111111',
   '55555555-5555-5555-5555-555555555555', '66666666-6666-6666-6666-666666666666',
   '77777777-7777-7777-7777-777777777777', 'product_data', 'Submit fire hydrant product data');
insert into register_items (id, tenant_id, project_id, requirement_id, title, status, responsible_user_id) values
  ('99999999-9999-9999-9999-999999999999', '11111111-1111-1111-1111-111111111111',
   '55555555-5555-5555-5555-555555555555', '88888888-8888-8888-8888-888888888888',
   'Fire hydrant product data submittal', 'draft', '33333333-3333-3333-3333-333333333333');

insert into vendors (id, tenant_id, name) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'Pyrotech Supplies');
insert into products (id, tenant_id, vendor_id, name, model_number) values
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '11111111-1111-1111-1111-111111111111',
   'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'FireGuard Hydrant DN65', 'FG-DN65');

commit;
