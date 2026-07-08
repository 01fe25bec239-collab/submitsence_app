-- 0004_projects_documents.sql
-- Projects (isolated work containers), project membership, documents (S3 metadata only),
-- and document-processing jobs. Composite (tenant_id, id) unique keys are added to every table
-- that a child references, so child FKs can pin tenant_id and make cross-tenant links impossible.

begin;

-- --- Projects (req f2) ------------------------------------------------------
create table projects (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references tenants(id) on delete cascade,
  name                text not null,
  client_name         text,
  site_address        text,
  trade               trade_package not null default 'other',
  status              project_status not null default 'draft',
  is_archived         boolean not null default false,          -- req f2 archived flag
  submission_deadline timestamptz,                             -- req f2 deadlines
  tender_close_at     timestamptz,
  created_by          uuid references users(id),
  archived_at         timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (tenant_id, id)                                       -- composite FK target
);
create index idx_projects_tenant on projects (tenant_id) where is_archived = false;
create index idx_projects_deadline on projects (tenant_id, submission_deadline)
  where is_archived = false and submission_deadline is not null;

-- --- Project-level access (req f1) ------------------------------------------
create table project_memberships (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references tenants(id) on delete cascade,
  project_id uuid not null,
  user_id    uuid not null references users(id) on delete cascade,
  role       project_role not null default 'contributor',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, user_id),
  foreign key (tenant_id, project_id) references projects (tenant_id, id) on delete cascade
);
create index idx_project_memberships_user on project_memberships (user_id);

-- --- Documents (req f3, f4) -------------------------------------------------
-- Binaries live in S3; PostgreSQL stores metadata only. No bytea payload column.
create table documents (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references tenants(id) on delete cascade,
  project_id       uuid,                                       -- null = tenant-level library (e.g. vendor catalogue)
  doc_type         document_type not null,
  title            text not null,
  original_filename text,
  -- S3 object reference + integrity metadata (req f4):
  storage_bucket   text not null,
  object_key       text not null,
  checksum_sha256  text check (checksum_sha256 is null or checksum_sha256 ~ '^[0-9a-f]{64}$'),
  mime_type        text,
  size_bytes       bigint check (size_bytes is null or size_bytes >= 0),
  s3_version_id    text,
  kms_key_arn      text,                                       -- KMS key reference (req f4); no plaintext secrets
  page_count       integer check (page_count is null or page_count >= 0),
  version          integer not null default 1,
  supersedes_document_id uuid references documents(id) on delete set null,
  uploaded_by      uuid references users(id),
  archived_at      timestamptz,                                -- req f28 soft delete
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (storage_bucket, object_key),
  unique (tenant_id, id),                                      -- composite FK target
  foreign key (tenant_id, project_id) references projects (tenant_id, id) on delete cascade
);
create index idx_documents_tenant_project on documents (tenant_id, project_id);
create index idx_documents_type on documents (tenant_id, doc_type);
create index idx_documents_checksum on documents (tenant_id, checksum_sha256);

-- --- Document-processing jobs (req f5) --------------------------------------
create table processing_jobs (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants(id) on delete cascade,
  document_id     uuid,
  job_type        text not null,                              -- e.g. 'ocr', 'extract_requirements', 'embed'
  status          job_status not null default 'queued',
  attempts        integer not null default 0 check (attempts >= 0),
  max_attempts    integer not null default 5 check (max_attempts >= 1),
  idempotency_key text not null,
  last_error      text,
  error_details   jsonb,
  worker_output   jsonb,                                       -- references to produced artifacts / output doc ids
  started_at      timestamptz,
  finished_at     timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (tenant_id, idempotency_key),                        -- dedupe / exactly-once submission
  foreign key (tenant_id, document_id) references documents (tenant_id, id) on delete cascade
);
create index idx_jobs_status on processing_jobs (tenant_id, status) where status in ('queued', 'running', 'retrying');
create index idx_jobs_document on processing_jobs (tenant_id, document_id);

commit;
