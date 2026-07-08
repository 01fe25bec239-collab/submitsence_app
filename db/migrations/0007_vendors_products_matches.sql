-- 0007_vendors_products_matches.sql
-- Tenant-owned vendor catalogues, products, extracted data, embeddings, and product-match
-- suggestions. Cross-tenant matching is impossible by construction (req f15): a match's composite
-- FKs to register_items(tenant_id,id) AND products(tenant_id,id) both pin the SAME tenant_id column.

begin;

-- --- Vendors ----------------------------------------------------------------
create table vendors (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  name        text not null,
  website     text,
  contact_email citext,
  contact_phone text,
  is_archived boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (tenant_id, id)
);
create index idx_vendors_tenant on vendors (tenant_id) where is_archived = false;
create index idx_vendors_name_trgm on vendors using gin (name gin_trgm_ops);

-- --- Vendor catalogues (req f14) --------------------------------------------
create table vendor_catalogues (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references tenants(id) on delete cascade,
  vendor_id          uuid not null,
  name               text not null,
  source_document_id uuid,
  version            text,
  archived_at        timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, vendor_id)          references vendors   (tenant_id, id) on delete cascade,
  foreign key (tenant_id, source_document_id) references documents (tenant_id, id) on delete set null
);
create index idx_catalogues_vendor on vendor_catalogues (tenant_id, vendor_id);

-- --- Products (req f14) -----------------------------------------------------
create table products (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null references tenants(id) on delete cascade,
  vendor_id            uuid not null,
  catalogue_id         uuid,
  name                 text not null,
  model_number         text,
  category             text,
  description          text,
  datasheet_document_id uuid,
  is_archived          boolean not null default false,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, vendor_id)            references vendors           (tenant_id, id) on delete cascade,
  foreign key (tenant_id, catalogue_id)         references vendor_catalogues (tenant_id, id) on delete set null,
  foreign key (tenant_id, datasheet_document_id) references documents        (tenant_id, id) on delete set null
);
create index idx_products_tenant on products (tenant_id) where is_archived = false;
create index idx_products_vendor on products (tenant_id, vendor_id);
create index idx_products_name_trgm on products using gin (name gin_trgm_ops);
create index idx_products_model on products (tenant_id, model_number);

-- --- Product documents (req f14) --------------------------------------------
create table product_documents (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  product_id  uuid not null,
  document_id uuid not null,
  doc_role    text not null default 'datasheet',      -- datasheet | certificate | test_report | manual | other
  created_at  timestamptz not null default now(),
  unique (product_id, document_id, doc_role),
  foreign key (tenant_id, product_id)  references products  (tenant_id, id) on delete cascade,
  foreign key (tenant_id, document_id) references documents (tenant_id, id) on delete cascade
);
create index idx_product_documents_product on product_documents (tenant_id, product_id);

-- --- Product attributes (req f14) -------------------------------------------
create table product_attributes (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references tenants(id) on delete cascade,
  product_id uuid not null,
  attr_key   text not null,
  attr_value text,
  unit       text,
  source     text,                                     -- e.g. 'datasheet_p3', 'manual_entry'
  created_at timestamptz not null default now(),
  foreign key (tenant_id, product_id) references products (tenant_id, id) on delete cascade
);
create index idx_product_attributes_lookup on product_attributes (tenant_id, product_id, attr_key);

-- --- Extracted product data (req f14) — structured extraction output ----------
create table extracted_product_data (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenants(id) on delete cascade,
  product_id        uuid not null,
  source_document_id uuid,
  extraction_job_id uuid references processing_jobs(id) on delete set null,
  data              jsonb not null default '{}'::jsonb,
  confidence        numeric(4,3) check (confidence is null or (confidence >= 0 and confidence <= 1)),
  created_at        timestamptz not null default now(),
  foreign key (tenant_id, product_id)         references products  (tenant_id, id) on delete cascade,
  foreign key (tenant_id, source_document_id) references documents (tenant_id, id) on delete set null
);
create index idx_extracted_product_product on extracted_product_data (tenant_id, product_id);

-- --- Product embeddings (req f14) — tenant-owned pgvector --------------------
-- ponytail: fixed dim 1536 (common embedding size) so an ANN index can be built. To change the
-- embedding model/dim later: add a new row per model (embedding_model column) and, if dim differs,
-- migrate to a new column + index. HNSW needs a fixed dim; unspecified `vector` cannot be indexed.
create table product_embeddings (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants(id) on delete cascade,
  product_id      uuid not null,
  embedding_model text not null,
  embedding       vector(1536) not null,
  content_hash    text,
  created_at      timestamptz not null default now(),
  unique (product_id, embedding_model),
  foreign key (tenant_id, product_id) references products (tenant_id, id) on delete cascade
);
-- Cosine ANN index for vendor-match search (req f26). RLS still enforces tenant scoping at query time.
create index idx_product_embeddings_hnsw on product_embeddings using hnsw (embedding vector_cosine_ops);
create index idx_product_embeddings_tenant on product_embeddings (tenant_id);

-- --- Product-match suggestions (req f15, f16) -------------------------------
create table product_matches (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenants(id) on delete cascade,
  register_item_id  uuid not null,
  product_id        uuid not null,
  requirement_id    uuid,
  confidence        numeric(4,3) check (confidence is null or (confidence >= 0 and confidence <= 1)),
  rationale_summary text,                              -- req f16
  evidence          jsonb not null default '[]'::jsonb, -- linked evidence: attribute ids, doc pages, clause refs
  decision          match_decision not null default 'pending',  -- human decision (req f16)
  decided_by        uuid references users(id),
  decided_at        timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  -- req f15: BOTH parents pinned to the same tenant_id -> no cross-tenant matches possible.
  foreign key (tenant_id, register_item_id) references register_items (tenant_id, id) on delete cascade,
  foreign key (tenant_id, product_id)       references products       (tenant_id, id) on delete cascade,
  foreign key (tenant_id, requirement_id)   references submittal_requirements (tenant_id, id) on delete set null,
  -- a human decision must record who + when (mirrors the sign-off discipline)
  constraint chk_match_decision_actor check (
    decision = 'pending' or (decided_by is not null and decided_at is not null)
  )
);
create index idx_matches_register on product_matches (tenant_id, register_item_id);
create index idx_matches_product on product_matches (tenant_id, product_id);

commit;
