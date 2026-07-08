-- 0012_integrations.sql
-- Consultant-platform integrations: Aconex/Procore connections, project mappings, sync jobs,
-- webhooks, and sync errors (req f25). Package-push and response-pull jobs share one table
-- discriminated by sync_job_type (ponytail: one table, not two near-identical ones).
-- SECRETS (NFR3): only a token_reference (pointer into AWS Secrets Manager / KMS) is stored,
-- never a raw OAuth token. There is no plaintext-secret column by design.

begin;

create table integration_connections (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references tenants(id) on delete cascade,
  provider            integration_provider not null,
  status              integration_status not null default 'connected',
  external_account_id text,
  display_name        text,
  scopes              text[] not null default '{}',
  token_reference     text,                            -- Secrets Manager ARN / KMS key ref; NOT the token
  token_expires_at    timestamptz,
  connected_by        uuid references users(id),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, provider, external_account_id)
);
create index idx_connections_tenant on integration_connections (tenant_id, provider);

create table external_project_mappings (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references tenants(id) on delete cascade,
  connection_id       uuid not null,
  project_id          uuid not null,
  external_project_id text not null,
  external_project_name text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (connection_id, external_project_id),
  foreign key (tenant_id, connection_id) references integration_connections (tenant_id, id) on delete cascade,
  foreign key (tenant_id, project_id)    references projects                (tenant_id, id) on delete cascade
);
create index idx_ext_mappings_project on external_project_mappings (tenant_id, project_id);

create table sync_jobs (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants(id) on delete cascade,
  connection_id   uuid not null,
  project_id      uuid,
  package_id      uuid,
  job_type        sync_job_type not null,              -- package_push | response_pull
  status          job_status not null default 'queued', -- reuses processing job_status enum
  attempts        integer not null default 0 check (attempts >= 0),
  max_attempts    integer not null default 5 check (max_attempts >= 1),
  idempotency_key text not null,
  external_ref    text,
  last_error      text,
  payload         jsonb not null default '{}'::jsonb,
  started_at      timestamptz,
  finished_at     timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (tenant_id, idempotency_key),
  foreign key (tenant_id, connection_id) references integration_connections (tenant_id, id) on delete cascade,
  foreign key (tenant_id, project_id)    references projects                (tenant_id, id) on delete set null,
  foreign key (tenant_id, package_id)    references packages                (tenant_id, id) on delete set null
);
create index idx_sync_jobs_status on sync_jobs (tenant_id, status) where status in ('queued', 'running', 'retrying');
create index idx_sync_jobs_connection on sync_jobs (tenant_id, connection_id);

create table webhook_events (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid references tenants(id) on delete cascade,   -- null until mapped to a tenant
  connection_id     uuid,
  provider          integration_provider not null,
  external_event_id text,
  event_type        text,
  status            webhook_status not null default 'received',
  payload           jsonb not null default '{}'::jsonb,
  received_at       timestamptz not null default now(),
  processed_at      timestamptz,
  created_at        timestamptz not null default now(),
  unique (connection_id, external_event_id),
  foreign key (tenant_id, connection_id) references integration_connections (tenant_id, id) on delete set null
);
create index idx_webhooks_status on webhook_events (status, received_at);

create table sync_errors (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references tenants(id) on delete cascade,
  connection_id    uuid,
  sync_job_id      uuid references sync_jobs(id) on delete cascade,
  webhook_event_id uuid references webhook_events(id) on delete cascade,
  error_code       text,
  message          text,
  details          jsonb not null default '{}'::jsonb,
  created_at       timestamptz not null default now(),
  foreign key (tenant_id, connection_id) references integration_connections (tenant_id, id) on delete cascade
);
create index idx_sync_errors_tenant on sync_errors (tenant_id, created_at);

commit;
