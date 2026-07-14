# Table-by-table reference

Conventions: PK `id uuid`; tenant tables carry `tenant_id uuid not null`; timestamps are
`timestamptz` (UTC); `created_at`/`updated_at` present unless noted (`updated_at` auto-maintained by
trigger). Composite FKs `(tenant_id, parent_id)` enforce same-tenant linkage. "Soft-delete" =
`archived_at`/`is_archived` rather than row deletion.

## Tenancy & IAM (0003)

| Table | Purpose | Key columns / constraints |
|---|---|---|
| `tenants` | Root of every tenant graph | `slug` (citext unique), `abn` (11-digit CHECK), `status`, `data_region` default `ap-southeast-2`, `archived_at` |
| `users` | Global human/service identity | `email` (citext unique), `cognito_sub` (unique, links AWS Cognito identity), `kind` (`human`\|`service_account`) — only `human` may sign off |
| `roles` | System RBAC roles | `key` unique |
| `permissions` | Granular permission catalog | `key` unique |
| `role_permissions` | Role→permission map | PK `(role_id, permission_id)` |
| `tenant_memberships` | User↔tenant with a role | unique `(tenant_id, user_id)`, `is_owner`, `status` |

## Projects & documents (0004)

| Table | Purpose | Key columns / constraints |
|---|---|---|
| `projects` | Isolated work container | `client_name`, `site_address`, `trade`, `status`, `is_archived`, `submission_deadline` |
| `project_memberships` | Project-level access | unique `(project_id, user_id)`, `role` (project_role) |
| `documents` | File **metadata only** (S3) | `storage_bucket`+`object_key` (unique), `checksum_sha256`, `mime_type`, `size_bytes`, `s3_version_id`, `kms_key_arn`, `version`, `supersedes_document_id`. No binary column. `project_id` null = tenant-level library |
| `processing_jobs` | Doc-processing work items | `status` (job_status), `attempts`/`max_attempts`, `idempotency_key` (unique per tenant), `last_error`, `error_details`, `worker_output` |

## Specs & requirements (0005)

| Table | Purpose | Key columns / constraints |
|---|---|---|
| `worksections` | NATSPEC worksection | `code`, `title`, `is_superseded`, `superseded_by_worksection_id`, source pages |
| `clauses` | Clause **structure only** | `clause_number`, `heading` (short), `is_hold_point`, `is_superseded`. **No full-text column** (req f7/NFR6) |
| `clause_references` | Citable pointer to a clause | `reference_label`, `worksection_code`, `clause_number` — cite without reproducing text |
| `extracted_fragments` | Tenant-private working text | `content`, `is_verbatim_quote`. RLS-protected; never surfaced to public content |
| `addenda_reconciliations` | Addendum↔clause links | `action` (adds/modifies/deletes/supersedes/clarifies) |
| `submittal_requirements` | Requirement → exact clause | `category` (requirement_category), `worksection_id`, `clause_id`, `confidence`, `is_hold_point` |

## Register & workflow (0006)

| Table | Purpose | Key columns / constraints |
|---|---|---|
| `register_items` | Submittal register line | `status` (submittal_status, default `draft`), `due_date`, `responsible_user_id`, consultant platform/response refs, `revision`, **`human_approved_by`/`human_approved_at`**. Auto-populated from requirements; CHECK + trigger guard on `human_approved` (req f12) |
| `physical_deliverables` | Samples / stamped drawings | `kind`, `status`, `tracking_ref`, `due_date`, `notes`, optional `attachment_document_id` - tracked line items, not generated stamped/certified files (req f13) |
| `packages` | Consultant-ready package draft | `status`, immutable cover snapshot, `current_version`, latest `output_document_id`, consultant reference |
| `package_items` | Editable package register lines | unique `(package_id, register_item_id)`, explicit `sequence`, `included`, manual notes |
| `package_item_documents` | Selected package files | per-item document role, order, and inclusion; composite FKs enforce tenant identity |
| `package_versions` | Preserved generated outputs | monotonically increasing version, generation-job idempotency, output document, manifest, checksum, failure detail |
| `exports` | Generated exports | `export_type`, `status` (export_status), `output_document_id` |

## Vendors & matching (0007)

| Table | Purpose | Key columns / constraints |
|---|---|---|
| `vendors` | Tenant's vendors | `name` (trigram index) |
| `vendor_catalogues` | Catalogue instances | `source_document_id`, `version` |
| `products` | Tenant's products | `model_number`, `category`, `datasheet_document_id` (trigram index on name) |
| `product_documents` | Product↔file (datasheet/cert) | `doc_role` |
| `product_attributes` | Key/value product data | `attr_key`, `attr_value`, `unit`, `source` |
| `extracted_product_data` | Structured extraction output | `data` jsonb, `confidence` |
| `product_embeddings` | pgvector embeddings | `embedding vector(1536)`, `embedding_model`, HNSW cosine index. Tenant-owned |
| `product_matches` | Match suggestions | `confidence`, `rationale_summary`, `evidence` jsonb, `decision` (match_decision), `decided_by`/`decided_at`. **Composite FKs to both register_items and products pin the same tenant → no cross-tenant match** (req f15) |

## Risk, RFI & learning (0008)

| Table | Purpose | Key columns / constraints |
|---|---|---|
| `risk_flags` | Rejection-risk flags | `risk_type`, `severity`, `rule_key`, explainable `risk_score`, `scoring_version`, `state`, source-reference `evidence`, `reviewed_by`. CHECK: score 0-100; evidence array; non-`open` state needs a reviewer |
| `checklist_items` | Generated checklist | `label`, `is_done`, `done_by`/`done_at`; may link a `risk_flag_id` |
| `rfi_drafts` | RFI drafts | `title`, `issue_summary`, `question`, `suggested_attachments`, `source_risk_flag_id`, `conflict_type`, `review_status`, `send_status`, `reviewed_by` |
| `rfi_cited_clauses` | RFI→clause citations | PK `(rfi_id, clause_reference_id)` |
| `rfi_cited_documents` | RFI→drawing citations | PK `(rfi_id, document_id)` |
| `rejection_learning_events` | Pattern-learning events | `human_decision`, `consultant_outcome`, `anonymised_eligible`, `consent_state`, `opted_out` |
| `tenant_consents` | Learning-loop consent | unique `(tenant_id)`, `learning_loop` (consent_state), `data_use_preferences` |

## Audit (0009)

| Table | Purpose | Key columns / constraints |
|---|---|---|
| `audit_events` | **Append-only** trail | `event_type` (audit_event_type), `actor_user_id`, `actor_type`, `entity_type`/`entity_id`, `payload`, `ip_address`, `occurred_at`, `checksum`. UPDATE/DELETE/TRUNCATE blocked by triggers + revoked grants; checksum for tamper-evidence |

## Billing (0010)

| Table | Purpose | Key columns / constraints |
|---|---|---|
| `plans` | Plan catalog | `key` unique, `tier`, `price_cents`, `currency` (AUD), `billing_interval` |
| `tenant_subscriptions` | Subscription + trial | `status` (subscription_status), `trial_ends_at`, provider IDs. Partial unique: one live sub per tenant |
| `invoices` | Invoices with GST | `subtotal_cents`+`tax_cents`=`total_cents` (CHECK), `gst_rate` default 0.10, `tax_label`='GST' |
| `usage_counters` | Metered usage | unique `(tenant_id, metric, period_start)` |

## Content (0011)

| Table | Purpose | Key columns / constraints |
|---|---|---|
| `knowledge_base_articles` | **Global** public content | `slug` (citext unique), SEO fields, `publication_state`, `author_id`/`reviewer_id`, `contains_natspec_text`, `natspec_copyright_cleared`. CHECK blocks publishing uncleared NATSPEC text (NFR6). Not tenant-owned; RLS exposes only published rows |

## Integrations (0012)

| Table | Purpose | Key columns / constraints |
|---|---|---|
| `integration_connections` | Aconex/Procore connection | `provider`, `status`, `scopes`, **`token_reference`** (Secrets Manager/KMS ref, never a raw token — NFR3), `token_expires_at` |
| `external_project_mappings` | Local↔external project | unique `(connection_id, external_project_id)` |
| `sync_jobs` | Package-push / response-pull | `job_type` (sync_job_type), `status` (job_status), `idempotency_key` unique per tenant |
| `webhook_events` | Inbound webhooks | `external_event_id`, `status` (webhook_status); `tenant_id` null until mapped |
| `sync_errors` | Integration errors | `error_code`, `message`, `details` |
