# Indexing strategy

Indexes are declared inline with each table. Rationale by access pattern (req f26):

## Tenant / project scoping
Every hot child table has a leading `(tenant_id, …)` btree so RLS-filtered scans stay index-driven:
`idx_projects_tenant`, `idx_documents_tenant_project`, `idx_worksections_project`,
`idx_requirements_project`, `idx_register_status`, etc. Partial `WHERE is_archived = false` /
`WHERE archived_at IS NULL`-style predicates keep active-set lookups small.

## Document lookup
`documents(storage_bucket, object_key)` unique (S3 key), `idx_documents_type`,
`idx_documents_checksum` (dedupe by content hash).

## Clause references
`idx_worksections_code (tenant_id, project_id, code)`,
`idx_clauses_number (tenant_id, worksection_id, clause_number)`,
`idx_clause_refs_clause`.

## Status dashboards
`idx_register_status (tenant_id, project_id, status)`, `idx_risk_flags_project (…, state)`,
`idx_rfi_project (…, review_status)`, `idx_packages_project (…, status)`.

## Due dates
`idx_register_due (tenant_id, due_date) WHERE status NOT IN ('closed','cancelled')`,
`idx_projects_deadline (tenant_id, submission_deadline) WHERE …`.

## Vector search (req f14/f26)
`idx_product_embeddings_hnsw` — HNSW on `embedding vector_cosine_ops` (pgvector ≥ 0.5). Cosine
distance for nearest-vendor-product search. RLS enforces tenant scoping at query time; keep a
`tenant_id` predicate in the query for correctness and to let the planner prune.
> Upgrade path: if filtered ANN recall becomes a problem, move to pgvector ≥ 0.8 iterative scans or
> per-tenant partial indexes. HNSW build/search params (`m`, `ef_construction`, `ef_search`) are
> tunable later without a schema change.

## Fuzzy text search
GIN trigram (`pg_trgm`) on `vendors.name`, `products.name`, `knowledge_base_articles.title`.

## Audit export (req f26)
`idx_audit_tenant_time (tenant_id, occurred_at)` for per-tenant time-range export;
`idx_audit_type_time`, `idx_audit_entity`, `idx_audit_actor`.

## Integration sync
`idx_sync_jobs_status (tenant_id, status) WHERE status IN ('queued','running','retrying')`,
`idx_webhooks_status (status, received_at)`, `idx_connections_tenant (tenant_id, provider)`.

## Idempotency / uniqueness
`processing_jobs(tenant_id, idempotency_key)`, `sync_jobs(tenant_id, idempotency_key)`,
`external_project_mappings(connection_id, external_project_id)`,
`webhook_events(connection_id, external_event_id)` — dedupe worker/webhook delivery.

## Notes
- Composite `UNIQUE (tenant_id, id)` on parent tables doubles as the FK target and a covering index.
- Add indexes reactively from real query plans once traffic exists; the set above covers the
  dashboards, lookups, and search paths in scope. Don't pre-index speculative columns.
