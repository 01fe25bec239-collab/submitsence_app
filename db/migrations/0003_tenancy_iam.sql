-- 0003_tenancy_iam.sql
-- Tenants, global user identities, RBAC catalog, tenant + project membership.
-- Tenant-owned tables carry tenant_id directly (NFR1) so the generic RLS policy in 0013 applies.

begin;

-- --- Tenants (root of every tenant-owned graph) ----------------------------
create table tenants (
  id           uuid primary key default gen_random_uuid(),
  slug         citext not null unique,
  name         text   not null,
  legal_name   text,
  abn          text,                                  -- Australian Business Number (11 digits, stored as text)
  status       text   not null default 'active'
                 check (status in ('active', 'suspended', 'closed')),
  data_region  text   not null default 'ap-southeast-2',  -- NFR4 Australian residency default (Sydney)
  settings     jsonb  not null default '{}'::jsonb,
  archived_at  timestamptz,                           -- req f28 soft archive over hard delete
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint chk_tenant_abn check (abn is null or abn ~ '^[0-9]{11}$')
);
-- Referenced compositely by children as (tenant_id) -> tenants(id); PK already unique.

-- --- Users (platform-global identity; joined to tenants via membership) -----
create table users (
  id            uuid primary key default gen_random_uuid(),
  email         citext not null unique,
  cognito_sub   text unique,                           -- AWS Cognito subject; links identity to this row (null for service accounts)
  full_name     text   not null,
  kind          user_kind not null default 'human',   -- guards human_approved (0006): only 'human' may approve
  status        text   not null default 'active'
                  check (status in ('active', 'invited', 'suspended', 'deactivated')),
  last_login_at timestamptz,
  deleted_at    timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- --- RBAC catalog (system-defined; seeded in 0099) --------------------------
create table roles (
  id          uuid primary key default gen_random_uuid(),
  key         text not null unique,                   -- e.g. 'owner', 'reviewer'
  name        text not null,
  description text,
  is_system   boolean not null default true
);

create table permissions (
  id          uuid primary key default gen_random_uuid(),
  key         text not null unique,                   -- e.g. 'submittal.approve'
  description text
);

create table role_permissions (
  role_id       uuid not null references roles(id)       on delete cascade,
  permission_id uuid not null references permissions(id) on delete cascade,
  primary key (role_id, permission_id)
);

-- --- Tenant membership ------------------------------------------------------
create table tenant_memberships (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references tenants(id) on delete cascade,
  user_id    uuid not null references users(id)   on delete cascade,
  role_id    uuid not null references roles(id)   on delete restrict,
  is_owner   boolean not null default false,
  status     text not null default 'active'
               check (status in ('active', 'invited', 'suspended')),
  invited_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, user_id)
);
create index idx_memberships_user on tenant_memberships (user_id);
create index idx_memberships_tenant on tenant_memberships (tenant_id);

-- --- Project-level access (req f1 "project-level access tables") -------------
-- (projects table is created in 0004; this join is created there to satisfy the FK order.)

commit;
