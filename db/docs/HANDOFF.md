# Handoff contract — SubmitSense database layer

For the backend, auth, frontend, QA, and infra agents. This is the stable surface the persistence
layer exposes. Migrations: `db/migrations/0001-0022`, seed `0099`, teardown `9999`.
Database guardrails were validated on PostgreSQL 17 + pgvector 0.8.4 through `0022`
(baseline, package-assembly, risk/RFI, and PB-05B queue-ledger checks pass; see `db/test/`).

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
`processing_jobs(job_type,status,attempts,idempotency_key,worker_output,lease_token,lease_expires_at,next_attempt_at)`.

**Specs:** `worksections(code,is_superseded)`, `clauses(clause_number,is_hold_point,is_superseded)`,
`clause_references(reference_label)`, `extracted_fragments(content)`, `addenda_reconciliations(action)`,
`submittal_requirements(category,worksection_id,clause_id,confidence)`.

**Register:** `register_items(status,due_date,responsible_user_id,human_approved_by,human_approved_at,consultant_platform_ref,consultant_response_ref,consultant_response_at)`,
`physical_deliverables(kind,status,due_date,notes,attachment_document_id)`,
`packages(status,cover_sheet,current_version,output_document_id)`,
`package_items(sequence,included,manual_notes)`, `package_item_documents`,
`package_versions(version_number,status,output_document_id,manifest,checksum_sha256)`,
`exports(export_type,status,package_version_id,metadata,error_message)`.

**Vendors/match:** `vendors`, `vendor_catalogues`, `products(model_number,category)`, `product_documents`,
`product_attributes`, `extracted_product_data`, `product_embeddings(embedding vector(1536))`,
`product_matches(confidence,rationale_summary,evidence,decision,decided_by)`.

**Risk/RFI:** `risk_flags(risk_type,severity,rule_key,risk_score,scoring_version,state,reviewed_by)`,
`checklist_items`, `rfi_drafts(issue_summary,question,suggested_attachments,source_risk_flag_id,conflict_type,review_status,send_status)`, `rfi_cited_clauses`, `rfi_cited_documents`,
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

### Processing-job lease contract

- Workers claim with `app.claim_next_job(job_types, lease_seconds)`. Production defaults are a
  900-second lease and a 60-second heartbeat; accepted lease durations are 30–3600 seconds.
- Heartbeat, success, and failure use `app.heartbeat_processing_job`,
  `app.complete_processing_job`, and `app.fail_processing_job`. Each requires the current UUID
  token; stale or missing tokens change no row.
- Failed attempts retry after 30, 60, 120, 240, and 480 seconds, then at the 900-second cap.
  Exhausted jobs become `failed`; queued/retrying rows already at their maximum are normalized.
- Deploy `0022` before the new worker. Its legacy one-argument claim overload intentionally returns
  no work, so old workers drain/idle without receiving unfenced leases. Roll back workers before
  applying `0022_queue_ledger_hardening.down.sql`.

## 5. Audit event types (emit one per action — req f21)

`document_upload, extraction, match, flag, rfi_action, package_generation, status_change,
human_signoff, export, auth_sensitive, integration_sync, consent_change, billing_event,
admin_action`.

The DB **auto-emits** `status_change` and `human_signoff` for `register_items` transitions. Backend
is responsible for emitting the rest at the corresponding action. Insert with `tenant_id` = current
tenant (RLS `WITH CHECK`), `actor_user_id`/`actor_type` from context; `checksum` is set by trigger.

## 6. Seeded roles & permissions (auth)

Roles: `owner, admin, project_manager, reviewer, contributor, viewer, billing_admin, integration_admin`.
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
- **External integration boundary:** the schema stores Aconex/Procore references and sync jobs, but
  provider SDK calls and credentials remain deployment/integration work.

## 8. Infra / RDS requirements (for the infra agent)

What this schema needs from Amazon RDS. Provisioning (VPC, KMS, DR, ECS/Redis) is the infra agent's;
these are the persistence-layer constraints it must satisfy.

- **Engine:** RDS for PostgreSQL **17** (validated on 17.10). Region `ap-southeast-2` (Sydney);
  automated backups + DR replica to `ap-southeast-4` (Melbourne) — both AU, satisfies residency.
- **Extensions:** `vector` (pgvector ≥ 0.5 for HNSW), `pg_trgm`, `citext` — all on the RDS
  trusted-extension list; the migrations run `CREATE EXTENSION`. pgvector needs **no** `shared_preload_libraries`.
- **Roles / who applies migrations:** run `0001–0099` as the **RDS master user** (it owns the tables
  and so bypasses RLS — required for seeding). The master is not a superuser on RDS, which is fine:
  `CREATE EXTENSION` (trusted) and `CREATE ROLE` (master has `CREATEROLE`) both work. The migrations
  create the app roles `submitsense_app` (RLS-scoped) and `submitsense_auditor` (read-only audit).
- **App connection:** the API/workers connect as a **login role in `submitsense_app`** — never the
  master. Create it after migrating and store the secret in AWS Secrets Manager:
  `create role app_login login password '<secret>' in role submitsense_app;` (auditor login likewise).
- **SSL / encryption:** set `rds.force_ssl=1` (app uses `sslmode=require`); KMS-encrypt storage and
  backups — this mirrors the per-object `kms_key_arn` the `documents` table already records for S3.
- **Connection pooling:** if you front RDS with RDS Proxy / PgBouncer, use **transaction** mode. The
  app sets tenant context via `SET LOCAL` GUCs inside a transaction (`db/orm/tenant-db.ts`);
  statement-level pooling breaks that and would silently drop tenant isolation.
- **Apply to the provisioned instance** (as master), then verify:
  ```bash
  export PGSSLMODE=require
  export DATABASE_URL="postgres://<master>:<pw>@<rds-endpoint>:5432/submitsense"
  for f in db/migrations/0*.sql; do psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$f" || break; done
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/test/test_guardrails.sql   # expect 8× PASS
  ```
  If the test's `set role submitsense_app` is denied, run `grant submitsense_app to <master>;` once.
