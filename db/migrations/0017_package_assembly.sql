-- 0017_package_assembly.sql
-- A3 package assembly + D12 register/status tracking.

begin;

alter table tenants
  add column branding jsonb not null default '{}'::jsonb,
  add constraint chk_tenant_branding_object check (jsonb_typeof(branding) = 'object');

alter table packages
  add column cover_sheet jsonb not null default '{}'::jsonb,
  add column manual_notes text,
  add column current_version integer not null default 0 check (current_version >= 0),
  add constraint chk_package_cover_sheet_object check (jsonb_typeof(cover_sheet) = 'object');

alter table package_items
  add column included boolean not null default true,
  add column manual_notes text,
  add constraint uq_package_items_tenant_id unique (tenant_id, id);

alter table processing_jobs
  add constraint uq_processing_jobs_tenant_id unique (tenant_id, id);

alter table physical_deliverables
  add column due_date date,
  add column notes text,
  add column attachment_document_id uuid,
  add constraint fk_physical_attachment
    foreign key (tenant_id, attachment_document_id) references documents (tenant_id, id) on delete set null (attachment_document_id);

alter table register_items
  add column consultant_response_ref text,
  add column consultant_response_at timestamptz;

create table package_versions (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references tenants(id) on delete cascade,
  package_id         uuid not null,
  version_number     integer not null check (version_number > 0),
  generation_job_id  uuid,
  status             export_status not null default 'generating',
  output_document_id uuid,
  manifest           jsonb not null default '{}'::jsonb,
  checksum_sha256    text check (checksum_sha256 is null or checksum_sha256 ~ '^[0-9a-f]{64}$'),
  error_message      text,
  generated_by       uuid references users(id),
  created_at         timestamptz not null default now(),
  unique (tenant_id, id),
  unique (package_id, version_number),
  unique (generation_job_id),
  foreign key (tenant_id, package_id) references packages (tenant_id, id) on delete cascade,
  foreign key (tenant_id, generation_job_id) references processing_jobs (tenant_id, id) on delete set null (generation_job_id),
  foreign key (tenant_id, output_document_id) references documents (tenant_id, id) on delete restrict,
  constraint chk_package_version_manifest_object check (jsonb_typeof(manifest) = 'object'),
  constraint chk_ready_package_version_output check (status <> 'ready' or (output_document_id is not null and checksum_sha256 is not null))
);

create table package_item_documents (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants(id) on delete cascade,
  package_item_id uuid not null,
  document_id     uuid not null,
  doc_role        text not null default 'attachment',
  included        boolean not null default true,
  sequence        integer not null default 0,
  created_at      timestamptz not null default now(),
  unique (package_item_id, document_id),
  foreign key (tenant_id, package_item_id) references package_items (tenant_id, id) on delete cascade,
  foreign key (tenant_id, document_id) references documents (tenant_id, id) on delete cascade
);

alter table exports
  add column package_version_id uuid,
  add column metadata jsonb not null default '{}'::jsonb,
  add column error_message text,
  add constraint fk_export_package_version
    foreign key (tenant_id, package_version_id) references package_versions (tenant_id, id) on delete set null (package_version_id),
  add constraint chk_export_metadata_object check (jsonb_typeof(metadata) = 'object');

create index idx_package_versions_package on package_versions (tenant_id, package_id, version_number desc);
create index idx_package_item_documents_item on package_item_documents (tenant_id, package_item_id, sequence);
create index idx_physical_deliverables_due on physical_deliverables (tenant_id, due_date) where due_date is not null;
create unique index uq_register_requirement on register_items (tenant_id, requirement_id) where requirement_id is not null;

-- Extracted requirements automatically become draft register rows. Existing requirements are backfilled.
create or replace function app.populate_register_item() returns trigger
  language plpgsql
as $$
begin
  insert into register_items (tenant_id, project_id, requirement_id, title, description, due_date, created_by)
  select new.tenant_id, new.project_id, new.id, new.title, new.description,
         (p.submission_deadline at time zone 'Australia/Sydney')::date, new.created_by
    from projects p
   where p.tenant_id = new.tenant_id and p.id = new.project_id
  on conflict (tenant_id, requirement_id) where requirement_id is not null do nothing;
  return new;
end$$;

create trigger trg_requirement_register
after insert on submittal_requirements
for each row execute function app.populate_register_item();

insert into register_items (tenant_id, project_id, requirement_id, title, description, due_date, created_by)
select sr.tenant_id, sr.project_id, sr.id, sr.title, sr.description,
       (p.submission_deadline at time zone 'Australia/Sydney')::date, sr.created_by
  from submittal_requirements sr
  join projects p on p.tenant_id = sr.tenant_id and p.id = sr.project_id
 where sr.archived_at is null
on conflict (tenant_id, requirement_id) where requirement_id is not null do nothing;

-- Reclaim work after a crashed worker. Package generation is idempotent by generation_job_id,
-- so retrying the same job resumes the reserved version and overwrites the same object key.
create or replace function app.claim_next_job(p_job_types text[] default null)
  returns table (id uuid, tenant_id uuid, job_type text, document_id uuid, worker_output jsonb)
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
begin
  update processing_jobs j
     set status = 'succeeded', finished_at = now(), last_error = null, error_details = null, updated_at = now()
   where j.status = 'running' and j.started_at < now() - interval '15 minutes'
     and (
       exists (select 1 from package_versions pv where pv.generation_job_id = j.id and pv.status = 'ready')
       or exists (select 1 from exports e where e.id::text = j.worker_output->>'exportId' and e.status = 'ready' and e.output_document_id is not null)
     );

  update package_versions pv
     set status = 'failed', error_message = 'Worker lease expired on the final attempt'
    from processing_jobs j
   where pv.generation_job_id = j.id
     and j.status = 'running' and j.started_at < now() - interval '15 minutes'
     and j.attempts >= j.max_attempts and pv.status <> 'ready';

  update exports e
     set status = 'failed', error_message = 'Worker lease expired on the final attempt', updated_at = now()
    from processing_jobs j
   where e.id::text = j.worker_output->>'exportId'
     and j.status = 'running' and j.started_at < now() - interval '15 minutes'
     and j.attempts >= j.max_attempts and e.status <> 'ready';

  update packages p
     set status = case when p.output_document_id is null then 'draft'::package_status else 'ready'::package_status end
    from processing_jobs j
   where p.id::text = j.worker_output->>'packageId'
     and j.status = 'running' and j.started_at < now() - interval '15 minutes'
     and j.attempts >= j.max_attempts;

  update processing_jobs
     set status = case when attempts < max_attempts then 'retrying'::job_status else 'failed'::job_status end,
         last_error = 'Worker lease expired before completion',
         finished_at = case when attempts < max_attempts then null else now() end,
         updated_at = now()
   where status = 'running'
     and started_at < now() - interval '15 minutes';

  return query
  update processing_jobs j
     set status = 'running', started_at = now(), attempts = attempts + 1, updated_at = now()
   where j.id = (
     select jj.id
       from processing_jobs jj
      where jj.status in ('queued', 'retrying')
        and jj.attempts < jj.max_attempts
        and (p_job_types is null or jj.job_type = any (p_job_types))
      order by jj.created_at
      for update skip locked
      limit 1
   )
  returning j.id, j.tenant_id, j.job_type, j.document_id, j.worker_output;
end$$;

alter table package_versions enable row level security;
create policy tenant_isolation on package_versions
  using (tenant_id = app.current_tenant_id())
  with check (tenant_id = app.current_tenant_id());

alter table package_item_documents enable row level security;
create policy tenant_isolation on package_item_documents
  using (tenant_id = app.current_tenant_id())
  with check (tenant_id = app.current_tenant_id());

grant select, insert, update, delete on package_versions, package_item_documents to submitsense_app;

commit;
