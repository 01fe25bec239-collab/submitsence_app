# Compliance, Security, Audit & Data-Residency Handoff (B8 / C9 / C10)

For the DevOps, backend, frontend, QA, and integrations agents. This is the compliance surface
every other agent must implement against. **Compliance-by-design, not by-disclaimer.**

**What is already enforced (do not rebuild):** the DB layer already implements tenant isolation
(RLS), the append-only audit trail, the human sign-off guard, no-cross-tenant-matching, NATSPEC
copyright checks, consent state, and residency defaults — all validated by `db/test/test_guardrails.sql`
(8 PASS). See [db/docs/rls.md](../db/docs/rls.md), [db/docs/retention.md](../db/docs/retention.md),
[db/docs/HANDOFF.md](../db/docs/HANDOFF.md), and `db/migrations/0009_audit.sql`, `0013_rls_policies.sql`.
This document adds the **service/DevOps/frontend-layer** controls that sit on top and the one net-new
enforceable control this agent shipped: the **language guard** (`backend/src/compliance/`).

**Non-negotiables (fail-closed, NFR1-7):** controls enforced in schema + service + test; audit
tamper-resistant; security fails closed; Australian residency mandatory for launch; no cross-tenant
share/match/train without explicit consent; product stays assistive/non-certifying; minimise PII.

**Stop-and-ask triggers (brief §j):** if legal-reviewed wording conflicts with this doc; if any
processor stores data outside Australia; if asked to weaken audit logs; if asked to make a compliance
guarantee. Do not silently proceed on any of these.

---

## OUTPUTS TO PASTE FORWARD (condensed)

**Security controls:** TLS 1.2+ in transit (`rds.force_ssl=1`, `PGSSLMODE=require`, HTTPS-only);
KMS encryption at rest for RDS + S3 + backups (per-object `documents.kms_key_arn` already tracked);
secrets only in AWS Secrets Manager (never in DB/env files — no `token_reference`/token inline);
short-lived (≤15 min) pre-signed S3 URLs gated by a per-request permission + RLS check; security
headers (HSTS, CSP, X-Content-Type-Options, X-Frame-Options DENY, Referrer-Policy); per-tenant +
per-IP rate limits; integration tokens hashed/referenced and rotated. All controls fail closed.

**Audit contract:** every material action emits one `audit_events` row (14 types, enum in
`0002_enums.sql`). Table is append-only (UPDATE/DELETE/TRUNCATE blocked 3 ways) with per-row SHA-256
checksum. DB auto-emits `status_change` + `human_signoff`; backend emits the other 12. Each row
carries tenant, actor type + id, action, entity type + id, timestamp, checksum; backend adds
`request_id`, `project_id`, source IP, and safe before/after into `payload` (checksum-covered).
Tenant/project-scoped exports run as the app role under RLS (tenant-isolated); `submitsense_auditor`
is reserved for a future platform-level cross-tenant export.

**Compliance guardrail rules:** no component may system-set an approval/compliance/certification
state — only an authenticated `human` actor with `submittal.approve` can reach `human_approved`
(DB-enforced, fail-closed). All system-generated status/label copy must pass
`assertSafeStatusLanguage()` — banned: "certified", "guaranteed compliant", "approved by SubmitSense",
"verified compliant", "will not be rejected"; allowed: "likely risk", "needs review", "for your
engineer to confirm", "source cited", "prepared for review". Learning loop is opt-in only
(`tenant_consents.learning_loop = opted_in`); aggregation view already filters to consented+eligible.
NATSPEC: cite clause references, never publish full clause text.

**Data-residency requirements:** all production data, object storage, DB, logs, backups, queues,
analytics, and temporary processing stay in Australian regions — primary `ap-southeast-2` (Sydney),
DR `ap-southeast-4` (Melbourne). No third-party processor may store or process customer data outside
Australia without explicit approval (checklist below). `tenants.data_region` defaults `ap-southeast-2`.

---

## 1. Audit-event taxonomy & schema usage guide (deliverable 1; f1-3)

Enum `audit_event_type` (`db/migrations/0002_enums.sql`) — emit exactly one per action:

| Event type | Emitted when | Emitted by |
|---|---|---|
| `document_upload` | file uploaded/attached | backend |
| `extraction` | OCR/LLM extraction run on a doc | backend/worker |
| `match` | product match created/decided | backend |
| `flag` | risk flag raised/changed | backend |
| `rfi_action` | RFI draft created/edited/sent | backend |
| `package_generation` | submittal package assembled | backend |
| `status_change` | any `register_items.status` transition | **DB trigger (auto)** |
| `human_signoff` | `register_items` → `human_approved` | **DB trigger (auto)** |
| `export` | audit/package/data export, doc download | backend |
| `auth_sensitive` | login, failed login, invite, permission denial, role change | backend/auth |
| `integration_sync` | external sync (Aconex/Procore/etc.) | integrations |
| `consent_change` | learning-loop / data-use consent change | backend |
| `billing_event` | subscription/invoice state change | backend |
| `admin_action` | tenant settings, member/security admin ops | backend |

**Taxonomy mapping for the prompt's f1 action list** (some collapse onto an existing type — do not
add enum values without a migration): document view/download → `export`; requirement create/edit →
`status_change` or `admin_action` with `entity_type='submittal_requirement'`; role change →
`auth_sensitive` (+ `admin_action`). If a distinct type is genuinely needed later, add it in a new
migration; don't overload `payload.action` as a substitute for the typed column when the type matters
for export/retention.

**Required fields on every write (f3):** `tenant_id` (RLS `WITH CHECK` scopes it), `event_type`,
`actor_user_id` + `actor_type` (from GUC context — never client body), `entity_type`, `entity_id`,
`action` (short verb), `occurred_at`. Put `request_id`, `project_id` (where applicable), source IP,
`user_agent`, and a **safe** before/after summary into `payload` jsonb.

> **Design note — why `project_id`/`request_id` live in `payload`, not new columns:** the checksum
> (`0009_audit.sql`) already hashes `payload`, so anything inside it is tamper-evidenced for free;
> adding top-level columns would leave them *outside* the checksum unless the trigger is also changed.
> Project-scoped export (§4) filters `payload->>'project_id'`; add a partial expression index only if
> export latency demands it (YAGNI until measured).

**before/after safety:** never copy raw document text, PII, or secrets into `payload`. Summaries only
(field name + old/new value or a redacted diff). This is a PII-minimisation boundary (NFR7).

**Backend audit service contract (gap — backend owns):** a single `recordAudit(client, {...})` helper
that INSERTs inside the same tenant transaction (`withTenantClient`, so RLS + actor context apply).
`checksum` is set by the DB trigger — do not compute it in app code. Never expose UPDATE/DELETE paths.

## 2. Human-in-the-loop guardrail specification (deliverables 2; f7-9)

- **No system-only approval/compliance/certification state anywhere.** The only guarded terminal
  judgment is `register_items.status = 'human_approved'`, protected by 3 DB layers (default `draft`,
  CHECK on approver metadata, SECURITY DEFINER trigger requiring an **active `human` user** and
  `app.actor_type <> 'system'`). Fail-closed: default actor is `system`, so jobs cannot approve.
- **App-layer gate:** `sign_off` requires permission `submittal.approve` + project access + human
  actor (`permission-policy.json`, `humanOnly:true`; `permissions.ts:canPerformAction`).
- **Rule for new components** (matching, risk, RFI, packaging): a system/model output is a
  *suggestion* with a `pending`/`open`/`draft` state; only an authenticated human transitions it to
  an accepted/approved/confirmed state. Service accounts (`actor_type=system`) can never sign off.
  Emit `human_signoff`/`status_change` on the human transition (auto for register; explicit elsewhere).
- **Acceptance:** no code path may set a compliance/approval state from a background job or model call.

## 3. Allowed / banned language guide (deliverable 3; f10-12) — ENFORCEABLE

Shipped as `backend/src/compliance/language-policy.json` + `language.ts`
(`assertSafeStatusLanguage()`), tested by `backend/test/compliance-language.test.mjs`.

- **Banned in system-generated copy:** certified · verified compliant · guaranteed compliant ·
  approved by SubmitSense · SubmitSense certifies/approves · will not be rejected · guaranteed to pass
  · fully compliant · meets all requirements.
- **Allowed / preferred:** likely risk · needs review · for your engineer to confirm · source cited ·
  prepared for review.
- **How to use (backend + frontend):** run `assertSafeStatusLanguage(text)` on any status label,
  badge, summary, or notification the **system** emits before returning/rendering it. Do **not** run
  it on user-authored free text. Extend the list via the JSON only (keeps one source of truth).

## 4. Audit export (f4-6) — gap, backend owns

- **Project-level export:** filter `audit_events` by `tenant_id` + `payload->>'project_id'`.
- **Tenant-level export (admins):** requires permission `audit.read` (held by owner/admin/PM/reviewer/
  billing_admin/integration_admin per `permission-policy.json`).
- **Cross-tenant safety (f6, NFR2):** tenant/project export runs as the **app role inside
  `withTenantClient`**, so RLS scopes it to the caller's tenant — this is correct and *safer* than the
  auditor role, which **bypasses** tenant RLS. Reserve **`submitsense_auditor`** for a future
  *platform-level* cross-tenant export only (breach investigation, ops). Always bind `tenant_id` from
  trusted context; never accept a tenant id from the request body.
- **Format:** stream CSV/JSONL including `checksum` so recipients can verify tamper-evidence.

## 5. Data-residency control checklist (deliverable 4; f20, NFR4) — DevOps owns

Australian regions only — primary `ap-southeast-2`, DR `ap-southeast-4`. Verify each:

- [ ] RDS PostgreSQL instance + read replicas/DR in AU regions; backups/snapshots AU-only, KMS-encrypted.
- [ ] S3 buckets (documents, packages, exports) in AU; block cross-region replication out of AU.
- [ ] Cognito user pool in an AU region.
- [ ] KMS keys created in AU regions; no key material leaves region.
- [ ] Queues (SQS), workers (ECS/Lambda), and any Redis/cache in AU.
- [ ] CloudWatch/log aggregation + retention in AU; no log shipping to non-AU SaaS.
- [ ] Analytics/telemetry AU-resident (or PII-free + approved); no non-AU product-analytics SaaS on customer data.
- [ ] Temporary processing (OCR/LLM/thumbnailing scratch) in AU; scratch buckets/tmp AU + short-TTL.
- [ ] Secrets Manager in AU.
- [ ] CDN/edge does not persist customer objects outside AU (short-lived pre-signed URLs, no origin copy retained abroad).

## 6. Third-party processing approval checklist (deliverable 5; f21) — required before any new vendor

For every processor touching customer data (LLM/OCR APIs, email, error tracking, analytics, integrations):

- [ ] Processes/stores data in an Australian region (or contractually AU-pinned).
- [ ] Signed DPA; sub-processors disclosed and AU-resident.
- [ ] **Does not train on customer data** (or explicit per-tenant consent obtained — see §11).
- [ ] Data minimised before send (no full documents/PII unless essential; redact where possible).
- [ ] Deletion/retention terms compatible with tenant retention (§12) and right-to-erasure.
- [ ] Breach-notification SLA compatible with NDB timelines (§10).
- [ ] Recorded in a processor register with data categories + region.

**If a processor stores/processes outside Australia → STOP and ask** (brief §j). Do not integrate.

## 7. NATSPEC IP handling policy (deliverable 6; f13-14, NFR6) — DB guard exists; extend to content

NATSPEC clause text is copyrighted/licensed. Rules:

- **Project-authorised display only.** Full clause text may surface **inside a tenant's own
  authorised project workspace** (RLS-private `extracted_fragments`), never in public/global content.
- **Cite clause references, not full text** in outputs, summaries, and packages — always show the
  source citation ("source cited").
- **DB already blocks the leak:** `clauses` stores structure/heading only (no full-text column);
  `knowledge_base_articles` has a CHECK rejecting `published` when `contains_natspec_text` and not
  `natspec_copyright_cleared` (`db/docs/rls.md` guardrail 4; `test_guardrails.sql` test 8).
- **Public-content safety check (gap — content/backend owns):** before publishing any KB/marketing/
  public page, run a NATSPEC-text detector (clause-number patterns + fuzzy match against known clause
  fragments) → set `contains_natspec_text` accordingly so the DB CHECK can fire. Add this as a
  regression test (§13). Never publish copied clause bodies publicly, even if flagged cleared, without
  a licence sign-off.

## 8. Security-control requirements (deliverable 8; f16-19, f27-28) — DevOps + backend

- **In transit (f17):** TLS 1.2+ everywhere; HTTPS-only; `rds.force_ssl=1`; app `PGSSLMODE=require`.
- **At rest (f16):** KMS-encrypt RDS storage + automated backups + all S3 buckets. `documents` already
  records a per-object `kms_key_arn` — honour it on read/write.
- **Secrets (f18):** AWS Secrets Manager only. No plaintext secrets/OAuth tokens in DB, env files, or
  logs. DB stores **references** (`integration_connections.token_reference`), never material.
  `AUTH_INTERNAL_SECRET`, DB creds, Cognito config → Secrets Manager; rotate on a schedule.
- **File access (f19):** short-lived pre-signed S3 URLs (≤15 min), minted only after a per-request
  permission + tenant (RLS) check. No public buckets. Scope each URL to one object.
- **Security headers (f27):** HSTS (long max-age + preload), `Content-Security-Policy`,
  `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`,
  disable `X-Powered-By`.
- **Rate limits / abuse (f27):** per-IP + per-tenant limits on auth, upload, export, and expensive
  extraction/generation endpoints; lockout/backoff on repeated failed logins (emit `auth_sensitive`).
- **Integration tokens (f28):** stored hashed/referenced (never plaintext), rotated on a schedule and
  on suspected compromise; revocation path required. Invitation tokens already hashed-only.
- **Fail closed (NFR3):** missing tenant context, missing permission, unverified JWT, or absent
  actor → deny. Permission denials return a **generic 403** (no enumeration) and emit `auth_sensitive`.

## 9. Privacy controls (deliverable 7; f22, NFR7) — backend + product

- **Minimise PII:** collect only what a submittal workflow needs; keep PII out of `audit_events.payload`
  and out of third-party payloads; redact before external processing.
- **Access:** PII in project records is tenant-isolated by RLS; project membership narrows further.
- **Data subject support:** right-to-erasure via tenant cascade delete (`retention.md`), with the
  documented `audit_events` retain-vs-purge decision made explicitly per request.
- **Consent for learning:** §11.

## 10. Notifiable Data Breaches support (deliverable 7; f23) — process + technical hooks

Support the NDB scheme (identify → contain → assess → notify). Technical requirements:

- **Incident logging:** an append-only incident record (reuse `audit_events` with `admin_action` +
  a dedicated `payload.incident_id`, or a small `security_incidents` table if richer fields are
  needed — defer until the response runbook is written).
- **Affected-data identification:** given a time window / actor / entity, query `audit_events`
  (indexed by tenant+time, entity, actor) to enumerate what was accessed/exported.
- **Tenant-impact export:** per-tenant report of affected records + data categories (reuses §4 export).
- **Evidence preservation:** audit is already tamper-evident (checksum) and append-only; snapshot the
  relevant audit range + S3 versions (`documents.s3_version_id`) and preserve under legal hold — do
  not purge on the normal retention cadence during an open incident.
- **A breach is a stop-and-ask** for wording/notification decisions — engineering preserves evidence;
  legal/product own notification content and timing.

## 11. Learning-loop consent & opt-out (f24, NFR5) — enforced in DB, backend must honour

- `tenant_consents.learning_loop` is `unset | opted_in | opted_out` (default **`unset`** = not
  consented). Aggregation is **opt-in only**.
- The DB view already gates aggregation to `anonymised_eligible = true AND opted_out = false AND
  consent_state = 'opted_in'` (`0008_risk_rfi_learning.sql`) — never read learning data outside it.
- Each `rejection_learning_event` snapshots consent state at event time; changing consent does not
  retroactively expose past events (opt-out excludes them going forward).
- **Consent changes emit `consent_change`** (audit trail of who changed what, when).
- **Cross-tenant:** no tenant's data is ever matched/retrieved/trained with another's — RLS +
  composite FKs make it unrepresentable; the learning aggregate operates only within consented,
  anonymised, tenant-eligible rows.

## 12. Retention, deletion & audit preservation (deliverables, f25-26) — configurable

Periods **UNKNOWN → configurable** (no customer contract supplied). Mechanism is built
(`db/docs/retention.md`): soft-delete/archive columns, tenant cascade for erasure, per-tenant/project
config point. **Audit preservation (f26):** when operational records are archived/deleted,
`audit_events` is **retained** (`tenant_id` is `ON DELETE RESTRICT`; append-only) — the sign-off and
status history survive record deletion. Wire concrete periods + a scheduled purge only once contracts
specify them; the purge must **exclude `audit_events`** unless erasure is explicitly requested and
signed off. **Product owner must set final retention periods** (known gap).

## 13. Compliance regression test plan (deliverable 9; f29) — QA owns

| Area | Test | Status |
|---|---|---|
| Status/certification language | `backend/test/compliance-language.test.mjs` | **shipped** (this agent) |
| Human sign-off fail-closed | `db/test/test_guardrails.sql` tests 1-4 | exists |
| Tenant isolation (RLS) | `db/test/test_guardrails.sql` test 7 | exists |
| No cross-tenant match | `db/test/test_guardrails.sql` test 5 | exists |
| Audit append-only | `db/test/test_guardrails.sql` test 6 | exists |
| NATSPEC public-content copying | `db/test/test_guardrails.sql` test 8 | exists |
| Audit event emitted per action | backend integration test per action type | **gap — build** |
| Data residency | infra/config assertion: all regions ∈ {ap-southeast-2, ap-southeast-4} | **gap — build** |
| Pre-signed URL expiry + auth | backend test: URL TTL ≤ 15 min, denied without permission | **gap — build** |
| Learning aggregation respects consent | query the aggregate view, assert opted-out/ unset excluded | **gap — build** |

Run in CI: `npm test --prefix backend` (adds the language test to the existing suite) and, against a
migrated DB, `psql ... -f db/test/test_guardrails.sql` (expect 8 PASS).

## 14. Per-agent handoff (deliverable 10)

- **DevOps/infra:** residency checklist (§5); KMS at rest + TLS in transit (§8); Secrets Manager;
  pre-signed URL config; security headers + rate limits at the edge; AU-only logs/backups/analytics;
  CI runs both test suites (§13). Region allow-list assertion is your test to add.
- **Backend:** `recordAudit` helper + emit the 12 non-auto event types with required `payload`
  fields (§1); tenant/project audit export via the app role under RLS (§4); call
  `assertSafeStatusLanguage()` on system copy (§3); enforce human-only transitions on every new
  component (§2); short-lived pre-signed URLs with permission check (§8); consent honoured (§11).
- **Frontend:** only render system status text that passed the language guard; never display an
  approval/compliance/certification claim from a system source; surface citations ("source cited");
  present model outputs as "needs review"/"likely risk", human actions as explicit confirmations.
- **QA:** own the test matrix (§13); build the four gap tests; treat any banned-language or residency
  failure as a release blocker (residency is mandatory for launch, NFR4).
- **Integrations:** processor approval checklist before any new external service (§6); tokens
  hashed/referenced + rotated (§8); emit `integration_sync`; no customer data to non-AU endpoints.

## Language / claims constraint (all agents)

Never state or imply "certified", "guaranteed compliant", "approved by SubmitSense", "verified
compliant", or "will not be rejected" — in the product, docs, or marketing. SubmitSense is
**assistive and non-certifying**; it prepares submittals for human/engineer review and cites sources.
Do not claim the product itself is "certified" or "guaranteed compliant" with any standard.

## Known gaps / owner decisions (blockers surfaced, not solved here)

- Real Cognito pool + **MFA policy** not configured — product owner decides final MFA posture.
- **Retention periods** unset — product owner + legal must specify; mechanism is ready.
- **Legal-reviewed copy** not yet available — if it conflicts with §3, legal wins → stop and ask.
- Token revocation / secure logout wiring still needed (auth known gap).
- Production domains, CSP allow-list, and rate-limit thresholds are DevOps/owner decisions.
