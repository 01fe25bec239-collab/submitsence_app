-- 0005_specs_requirements.sql
-- Parsed spec structure and extracted submittal requirements.
-- COPYRIGHT (req f7 / NFR6): clauses store STRUCTURE + REFERENCES only, never full NATSPEC text.
-- extracted_fragments may hold short working quotes but is tenant-private (RLS) and is never
-- referenced by, or copied into, the public knowledge_base (0011).

begin;

-- --- Worksections (req f6) --------------------------------------------------
create table worksections (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants(id) on delete cascade,
  project_id   uuid not null,
  document_id  uuid,                                   -- source spec document
  code         text not null,                          -- NATSPEC worksection code, e.g. '0171'
  title        text,
  sequence     integer,
  is_superseded boolean not null default false,        -- req f6 superseded markers
  superseded_by_worksection_id uuid references worksections(id) on delete set null,
  source_page_from integer,
  source_page_to   integer,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, project_id)  references projects  (tenant_id, id) on delete cascade,
  foreign key (tenant_id, document_id) references documents (tenant_id, id) on delete set null
);
create index idx_worksections_project on worksections (tenant_id, project_id);
create index idx_worksections_code on worksections (tenant_id, project_id, code);

-- --- Clauses (req f6, f7) — NO full-text column by design -------------------
create table clauses (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id) on delete cascade,
  worksection_id uuid not null,
  clause_number text not null,                         -- e.g. '3.2.1'
  heading       text,                                  -- short heading only, not clause body
  sequence      integer,
  is_hold_point boolean not null default false,
  is_superseded boolean not null default false,
  superseded_by_clause_id uuid references clauses(id) on delete set null,
  source_page   integer,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, worksection_id) references worksections (tenant_id, id) on delete cascade
);
create index idx_clauses_worksection on clauses (tenant_id, worksection_id);
create index idx_clauses_number on clauses (tenant_id, worksection_id, clause_number);

-- --- Clause references (req f6, f7) -----------------------------------------
-- A citable pointer usable by requirements / RFIs / risk flags WITHOUT reproducing clause text.
create table clause_references (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants(id) on delete cascade,
  clause_id      uuid,                                 -- null when citing an unparsed / external clause
  worksection_code text not null,
  clause_number  text not null,
  reference_label text not null,                       -- e.g. 'NATSPEC 0171 cl 3.2.1' (citation, not content)
  source_document_id uuid,
  source_page    integer,
  created_at     timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, clause_id) references clauses (tenant_id, id) on delete set null,
  foreign key (tenant_id, source_document_id) references documents (tenant_id, id) on delete set null
);
create index idx_clause_refs_clause on clause_references (tenant_id, clause_id);

-- --- Extracted fragments (req f6) — tenant-private working text --------------
create table extracted_fragments (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id) on delete cascade,
  clause_id     uuid,
  fragment_type text not null default 'requirement',  -- requirement | note | definition
  content       text not null,                         -- short working quote/paraphrase; tenant-private only
  is_verbatim_quote boolean not null default false,
  source_page   integer,
  created_at    timestamptz not null default now(),
  foreign key (tenant_id, clause_id) references clauses (tenant_id, id) on delete cascade
);
create index idx_fragments_clause on extracted_fragments (tenant_id, clause_id);

-- --- Addenda reconciliation links (req f6) ----------------------------------
create table addenda_reconciliations (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants(id) on delete cascade,
  project_id     uuid not null,
  addendum_document_id uuid not null,
  target_worksection_id uuid,
  target_clause_id uuid,
  action         text not null check (action in ('adds', 'modifies', 'deletes', 'supersedes', 'clarifies')),
  note           text,
  reconciled_by  uuid references users(id),
  created_at     timestamptz not null default now(),
  foreign key (tenant_id, project_id)  references projects  (tenant_id, id) on delete cascade,
  foreign key (tenant_id, addendum_document_id) references documents (tenant_id, id) on delete cascade,
  foreign key (tenant_id, target_worksection_id) references worksections (tenant_id, id) on delete set null,
  foreign key (tenant_id, target_clause_id) references clauses (tenant_id, id) on delete set null
);
create index idx_addenda_project on addenda_reconciliations (tenant_id, project_id);

-- --- Submittal requirements (req f8, f9) ------------------------------------
create table submittal_requirements (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenants(id) on delete cascade,
  project_id        uuid not null,
  worksection_id    uuid not null,                     -- exact worksection (req f8)
  clause_id         uuid,                              -- exact clause (req f8)
  clause_reference_id uuid,
  category          requirement_category not null,     -- req f9
  title             text not null,
  description       text,                              -- requirement summary, NOT verbatim clause text
  is_hold_point     boolean not null default false,
  source_page       integer,
  extraction_job_id uuid references processing_jobs(id) on delete set null,
  confidence        numeric(4,3) check (confidence is null or (confidence >= 0 and confidence <= 1)),
  created_by        uuid references users(id),
  archived_at       timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, project_id)     references projects     (tenant_id, id) on delete cascade,
  foreign key (tenant_id, worksection_id) references worksections (tenant_id, id) on delete cascade,
  foreign key (tenant_id, clause_id)      references clauses      (tenant_id, id) on delete set null,
  foreign key (tenant_id, clause_reference_id) references clause_references (tenant_id, id) on delete set null
);
create index idx_requirements_project on submittal_requirements (tenant_id, project_id);
create index idx_requirements_category on submittal_requirements (tenant_id, project_id, category);
create index idx_requirements_clause on submittal_requirements (tenant_id, clause_id);

commit;
