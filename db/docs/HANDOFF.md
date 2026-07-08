# Handoff contract — SubmitSense database layer

For the backend, auth, frontend, and QA agents. This is the stable surface the persistence layer
exposes. Migrations: `db/migrations/0001–0013`, seed `0099`, teardown `9999`.

## 1. Connection & request context (backend + auth)

- App connects as a **login role that inherits `submitsense_app`** (never the table owner — that
  bypasses RLS). Audit export uses `submitsense_auditor`.
- Set these GUCs with `SET LOCAL` at the start of every request transaction:

  | GUC | Type | Purpose |
  |---|---|---|
  | `app.tenant_id` | uuid | RLS scope — **required** for all tenant queries |
  | `app.user_id` | uuid | actor attribution in audit/status triggers |
  | `app.actor_type` | `human` \| `system` | gates human sign-off; **defaults to `system`** (fail-closed) |

- Helpers: `app.current_tenant_id()`, `app.current_user_id()`, `app.current_actor_type()`.
- **Cognito → user**: on each request, resolve the Cognito `sub` to `users.cognito_sub`, then set
  `app.user_id` to that row's `id`. Cognito owns authentication/MFA/SSO; this DB owns tenant scoping,
  RBAC data, and the human-actor guard.

## 2. Guardrails enforced in the DB (cannot be bypassed in app code)

1. **Tenant isolation** — RLS on every `tenant_id` table. Cross-tenant read/write is impossible for
   `submitsense_app`.
2. **Human sign-off** — `register_items.status = 'human_approved'` requires `human_approved_by`
   (an active `human` user) + `human_approved_at`, and `app.actor_type <> 'system'`. Set actor
   context to `human` and pass a real reviewer id, or the write is rejected.
3. **No cross-tenant product match** — `product_matches` composite FKs force one tenant on both
   sides. Don't try to match across tenants; it will FK-fail.
4. **Append-only audit** — `audit_events` rejects UPDATE/DELETE/TRUNCATE. Insert only.
5. **NATSPEC copyright** — no clause full-text columns; publishing flagged-but-uncleared content is
   CHECK-rejected. Never put clause text into `knowledge_base_articles`.

## 3. Table inventory (key columns)

**Tenancy/IAM:** `tenants(slug, abn, status)`, `users(email, kind)`,
`roles(key)`, `permissions(key)`, `role_permissions`, `tenant_memberships(tenant_id,user_id,role_id,is_owner)`,
`project_memberships(project_id,user_id,role)`.

**Projects/docs:** `projects(name,client_name,trade,status,submission_deadline,is_archived)`,
`documents(doc_type,storage_bucket,object_key,checksum_sha256,mime_type,size_bytes,s3_version_id,kms_key_arn,version)`,
`processing_jobs(job_type,status,attempts,idempotency_key,worker_output)`.

**Specs:** `worksections(code,is_superseded)`, `clauses(clause_number,is_hold_point,is_superseded)`,
`clause_references(reference_label)`, `extracted_fragments(content)`, `addenda_reconciliations(action)`,
`submittal_requirements(category,worksection_id,clause_id,confidence)`.

**Register:** `register_items(status,due_date,responsible_user_id,human_approved_by,human_approved_at,consultant_platform_ref)`,
`physical_deliverables(kind,status)`, `packages(status,output_document_id)`, `package_items`, `exports(export_type,status)`.

**Vendors/match:** `vendors`, `vendor_catalogues`, `products(model_number,category)`, `product_documents`,
`product_attributes`, `extracted_product_data`, `product_embeddings(embedding vector(1536))`,
`product_matches(confidence,rationale_summary,evidence,decision,decided_by)`.

**Risk/RFI:** `risk_flags(risk_type,severity,state,reviewed_by)`, `checklist_items`,
`rfi_drafts(conflict_type,review_status,send_status)`, `rfi_cited_clauses`, `rfi_cited_documents`,
`rejection_learning_events(consultant_outcome,anonymised_eligible,consent_state,opted_out)`, `tenant_consents(learning_loop)`.

**Audit:** `audit_events(event_type,actor_user_id,actor_type,entity_type,entity_id,payload,occurred_at,checksum)`.

**Billing:** `plans(key,tier,price_cents)`, `tenant_subscriptions(status,trial_ends_at)`,
`invoices(subtotal_cents,tax_cents,total_cents,gst_rate)`, `usage_counters(metric,period_start,count)`.

**Content:** `knowledge_base_articles(slug,publication_state,contains_natspec_text,natspec_copyright_cleared)`.

**Integrations:** `integration_connections(provider,status,token_reference)`, `external_project_mappings`,
`sync_jobs(job_type,status,idempotency_key)`, `webhook_events(status)`, `sync_errors`.

## 4. Workflow status enums (frontend state machines)

- **Submittal** (`register_items.status`): `draft → submitted → human_approved | revise_and_resubmit | rejected → closed | cancelled`. Only `human_approved` is guarded.
- **Job** (`processing_jobs`/`sync_jobs`): `queued → running → succeeded | failed`; `retrying`, `cancelled`.
- **Match** (`product_matches.decision`): `pending → accepted | rejected | superseded`.
- **Risk** (`risk_flags.state`): `open → confirmed | dismissed | resolved`.
- **RFI**: review `draft → in_review → approved | rejected`; send `not_sent → exported → sent → answered`.
- **Package**: `draft → assembling → ready → submitted | superseded`.
- **Subscription**: `trialing → active → past_due | canceled | incomplete`.
- **Publication**: `draft → in_review → published → archived`.

Full value lists: [enums.md](enums.md).

## 5. Audit event types (emit one per action — req f21)

`document_upload, extraction, match, flag, rfi_action, package_generation, status_change,
human_signoff, export, auth_sensitive, integration_sync, consent_change, billing_event,
admin_action`.

The DB **auto-emits** `status_change` and `human_signoff` for `register_items` transitions. Backend
is responsible for emitting the rest at the corresponding action. Insert with `tenant_id` = current
tenant (RLS `WITH CHECK`), `actor_user_id`/`actor_type` from context; `checksum` is set by trigger.

## 6. Seeded roles & permissions (auth)

Roles: `owner, admin, project_manager, reviewer, contributor, viewer, billing_admin`.
Key permission: **`submittal.approve`** (held by owner/admin/reviewer) — the app-layer gate that
should precede a `human_approved` write; the DB additionally enforces the human-actor guard.
Full permission list is seeded in `0099_seed.sql`.

## 7. Assumptions & open items for a human

- **Assumed** (brief §j): PG17+, pgvector, UUID PKs, UTC, S3, `ap-southeast-2`, modular monolith.
- **Embedding dim = 1536** — change requires a column/index migration (see indexing.md).
- **Retention periods UNKNOWN → configurable** — soft-delete columns + tenant-cascade in place; wire
  concrete periods when contracts specify (retention.md).
- **User provisioning** is an elevated/auth-service operation (RLS blocks the app role from
  inserting arbitrary `users`). Auth agent owns signup/invite flows.
- **Not in scope here:** APIs, OCR, LLM prompts, PDF generation, billing-provider integration, auth
  provider setup, deployment, external Aconex/Procore calls.
