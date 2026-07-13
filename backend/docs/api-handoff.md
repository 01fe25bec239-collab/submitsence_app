# SubmitSense API handoff

Base URL: `/api/v1`. OpenAPI JSON: `/api/v1/openapi.json`.

## Runtime rules

- All tenant endpoints use `CognitoAuthGuard`, `TenantGuard`, and the existing permission guard where an action maps cleanly to `permission-policy.json`.
- Service queries run through `withTenantClient(pool, { tenantId, userId, actorType }, fn)` so database RLS, human sign-off triggers, and tenant FKs remain the enforcement layer.
- Standard errors are `{ requestId, error: { message, diagnosticCode } }`; `x-request-id` is echoed or generated per request.
- Upload finalisation, generated jobs, package generation, billing webhooks, and integration webhooks require `Idempotency-Key` or `X-Idempotency-Key`.
- S3 upload initiation signs PUT URLs with AWS SigV4 from `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, optional `AWS_SESSION_TOKEN`, `AWS_REGION`, and `S3_UPLOAD_BUCKET`. URL TTL is capped at 900 seconds.

## Endpoint groups

- Auth/session: existing Cognito, tenant session, invitations, members, project access.
- Projects: CRUD, archive, unarchive, role-aware list, cross-project search.
- Documents: upload initiation, upload finalisation, processing-job status.
- Parsed specs: worksections, clauses, clause references, source pages, superseded markers, submittal requirements.
- Register: list/filter/sort, assignment, deadline update, status transition, exact-item human sign-off, export request.
- Physical deliverables: sample/stamped drawing status records only.
- Vendors/products: catalogue upload/create/parse status, vendors (list + create), products (list + create + review/correct), product details, product document links.
- Matching: list suggestions, accept, reject, human override, rematch job. The `product_rematch` /
  `ingest_*` jobs are executed by the B6-B7 worker — see [matching-handoff.md](matching-handoff.md).
- Risk/RFI: risk generation/list/review/task; RFI generation/retrieve/edit/review/export/integration handoff.
- Packages: draft, preview, regenerate, PDF export, Aconex-ready bundle export.
- Dashboard/audit/learning: project status dashboard, tenant/project audit export, consent-gated learning event recording, learning-loop consent opt-in/opt-out, anonymised consent-gated learning-pattern aggregate.
- Billing/content/help: public plans, tenant trial/subscription, published KB articles, contextual help.
- Integrations: connection status, mappings, sync jobs, errors, provider webhooks.

## Status rules

`register_items.status` transitions are in `backend/src/api/status-transitions.json`.
Direct status updates cannot set `human_approved`; use `POST /tenants/:tenantId/projects/:projectId/register-items/sign-off`.
The sign-off endpoint requires `submittal.approve`, a human actor, exact `itemIds`, optional `comment`, and only updates submitted items.

## Audit events

The API emits: `document_upload`, `extraction`, `match`, `flag`, `rfi_action`, `package_generation`, `export`, `integration_sync`, `billing_event`, `admin_action`, and `status_change` for non-status metadata changes. The DB still auto-emits register `status_change` and `human_signoff`.

## Queue/job conventions

- Current implementation uses the database as the durable job ledger: `processing_jobs` for document/extraction/package/export/billing work, `sync_jobs` for integration sync, and `webhook_events`/`sync_errors` for inbound integration events.
- Job lifecycle is `queued -> running -> succeeded | failed`, with `retrying` and `cancelled` available.
- Every produced job carries an idempotency key; API callers must send `Idempotency-Key` or `X-Idempotency-Key` for upload finalisation, generated jobs, package/export generation, billing webhooks, and integration webhooks.
- Workers must run with `withTenantClient(pool, { tenantId, userId, actorType: "system" }, fn)` using the job row's trusted `tenant_id`. Background jobs cannot set `human_approved`; the DB rejects system sign-off. The B6-B7 worker (`src/worker/worker.ts`) claims jobs cross-tenant via `app.claim_next_job()` (SECURITY DEFINER, `0016`) then processes each in-tenant — the template for other workers.
- Job audit events must be written inside the tenant transaction, with no PII, secrets, or raw document text in payload.
- Queue broker/runtime/retry/DLQ policy is still open. Recommended default: keep these DB ledgers and add AWS SQS in `ap-southeast-2` for dispatch, with AU-only DLQ/scratch storage.

Skipped: broker adapter and Stripe/Aconex/Procore SDK calls. Add them when DevOps confirms queue runtime, retry policy, and DLQ handling.
