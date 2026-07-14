# Aconex / Procore integration handoff

## System contract

- Confirmed Section 0 stack: TypeScript-first modular monolith; Next.js 15+/React frontend; NestJS REST API; PostgreSQL 17+ with RLS and pgvector; S3/SSE-KMS document storage; Textract plus layout-aware NATSPEC parsing; BullMQ/ElastiCache Redis as the target long-running-job platform; Cognito plus application RBAC/ABAC; AWS Sydney production with Australian-only Melbourne disaster recovery; ECS/Fargate workers; CloudWatch/WAF/GuardDuty; all customer data and processing kept in Australian regions.
- Current backend convention: tenant context is applied with `withTenantClient`; integration records use `integration_connections`, `external_project_mappings`, `sync_jobs`, `webhook_events`, and `sync_errors`; the currently implemented worker uses the PostgreSQL job ledger pending BullMQ infrastructure.
- Auth contract: `integration.manage` is required for connection, mapping, sync-job, and capability operations. Tokens are referenced by Australian AWS Secrets Manager ARN only and are never returned by the API.
- Package contract: package generation and Aconex-ready bundle generation remain owned by the package module. A future approved adapter consumes the ready export; it does not assemble packages.
- Status contract: an external consultant outcome is stored separately from SubmitSense human sign-off. Only an explicit human action may set `human_approved`.
- Compliance contract: no scraping, approval bypass, plaintext tokens, cross-tenant retrieval, confidential document bodies in logs, or certification language.
- Current human partner status: **No partner/marketplace approval or live API credentials are currently available for Aconex or Procore. Both providers remain disabled behind capability gates. Only provider-neutral contracts, secure token-reference validation, adapter skeletons, mocks, and tests are enabled until approved sandbox or production access is supplied.**

## Shipped technical readiness

- `IntegrationAdapter` is the provider boundary. `AconexAdapter` and `ProcoreAdapter` fail closed with a non-retryable `partner_approval_required` error.
- `MockIntegrationAdapter` supports tenant-scoped, idempotent package pushes and response pulls for QA without live access.
- `GET /tenants/:tenantId/integrations/providers` returns capability and approval state for UI feature gating.
- Existing connection/mapping/sync/error endpoints remain the persistence boundary. Sync-job creation now also checks provider availability, connection state, and an Australian Secrets Manager token reference.
- Existing integration webhooks remain tenant-resolved from the server-side connection mapping and idempotent by external event ID. Their shared-secret route is not advertised as a live provider webhook until official signature rules are implemented.

## Status mapping

| External canonical status | Stored consultant status | SubmitSense register status |
|---|---|---|
| `submitted` | `submitted` | `submitted` |
| `approved` | `approved` | unchanged; never `human_approved` |
| `returned` | `revise_and_resubmit` | `revise_and_resubmit` |
| `revise_and_resubmit` | `revise_and_resubmit` | `revise_and_resubmit` |
| `rejected` | `rejected` | `rejected` |

Provider-specific raw values must be mapped to these canonical values inside the approved adapter after official API documentation is available. Unknown values fail closed.

## Remaining work after human approval

DevOps must provide the provider, sandbox/production environment, approval evidence, OAuth client metadata, granted scopes, approved base URLs, webhook signature contract, rate limits, and Secrets Manager references. Do not place client secrets or tokens in tickets, source, database rows, logs, or this document.

Then implement the official OAuth callback/token refresh transport, approved attachment upload and response APIs, provider signature verification, rate-limit headers, and the production sync worker. Until those facts exist, inventing endpoint paths, scopes, or status codes would risk bypassing partner terms.

## QA

```bash
cd backend
node --import tsx --test test/integrations.test.ts
npm run typecheck
```
