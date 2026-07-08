# Data retention & deletion

**Retention periods: UNKNOWN — made configurable.** No customer contract periods were supplied
(brief §e/§j), so the schema encodes deletion *mechanism* and *safety*, and leaves the *period* to
configuration. Wire concrete periods once contracts specify them.

## Soft-delete / archive first (req f28)

Legally/commercially significant records are archived, not hard-deleted:

| Entity | Column |
|---|---|
| tenants, projects, documents, register_items, submittal_requirements, packages, vendors, vendor_catalogues, knowledge_base_articles | `archived_at` |
| projects | `is_archived` |
| users | `deleted_at` |

Archived rows remain queryable and audit-linked. Active-set indexes use `WHERE … IS NULL/false`, so
archiving also keeps hot queries fast.

## Immutable records

`audit_events` is append-only (see [rls.md](rls.md)) and should be retained for the **maximum**
statutory period applicable to construction/compliance records — do not purge on the normal cadence.
Sign-off (`human_signoff`) events are the evidentiary trail for who approved what and when.

## Hard deletion (tenant offboarding)

FK `ON DELETE CASCADE` from `tenants` flows through the whole tenant graph, so
`DELETE FROM tenants WHERE id = :tenant` performs a complete erasure for right-to-erasure / contract
exit. Exception: `audit_events.tenant_id` is `ON DELETE RESTRICT` — decide per policy whether to
retain the audit trail (compliance) or explicitly purge it first (erasure). Document that decision
before running a tenant delete.

## Making periods configurable

When periods are known, add a scheduled purge that:
1. reads a per-tenant / per-entity retention config (app config or a small `retention_policies`
   table — deferred until periods exist; adding it now would be guessing),
2. sets `archived_at` at soft-delete age, then
3. hard-deletes archived rows past the retention age — **excluding** `audit_events` unless erasure
   is explicitly requested.

## Residency (NFR4)

All persistence is PostgreSQL + S3 in `ap-southeast-2` (default `tenants.data_region`). No table
depends on non-Australian external storage. Secrets/tokens are referenced (`token_reference`,
`kms_key_arn`), never stored inline, so no secret material leaves the region's KMS/Secrets Manager.
