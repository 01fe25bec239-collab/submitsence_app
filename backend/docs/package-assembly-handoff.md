# Package assembly handoff

This is the implementation contract for frontend, risk, integration, infrastructure, and QA work
around A3 package assembly and D12 register/status tracking. All paths are beneath
`/api/v1/tenants/:tenantId`.

## User workflow

1. Configure tenant cover branding with `GET/PATCH /branding`.
2. Create a draft with `POST /projects/:projectId/packages` and an `Idempotency-Key` header.
3. Inspect `GET /projects/:projectId/packages/:packageId/preview`.
4. Add, reorder, include/exclude, annotate, and attach documents using the package item endpoints.
5. Queue a preserved PDF version with `POST .../regenerate`; poll the returned processing job.
6. Read version history from `GET .../versions`.
7. Queue a consultant PDF or Aconex ZIP using `POST .../export-pdf` or `POST .../export-aconex`.

Draft creation body:

```json
{
  "name": "Fire services submittal 01",
  "registerItemIds": ["uuid"],
  "manualNotes": "Optional package note",
  "coverSheet": {
    "companyName": "Example Fire Pty Ltd",
    "legalName": "Example Fire Pty Ltd",
    "abn": "12345678901",
    "logoDocumentId": "tenant-library-or-project-document-uuid",
    "primaryColour": "#16697A",
    "address": "Optional",
    "phone": "Optional",
    "email": "Optional",
    "preparedBy": "Optional override"
  }
}
```

Project name, client, site, trade, version, and generation time come from authoritative project and
version data. Every cover is labelled `Prepared for review`; optional branding fields may be null.
Tenant branding accepts the same company fields, but its logo must be a tenant-library PNG/JPEG.

Package item operations:

- `POST .../items`: `{ "registerItemId": "uuid", "manualNotes": "optional" }`
- `PATCH .../items/:packageItemId`: any of `{ "sequence": 2, "included": false, "manualNotes": "optional" }`
- `POST .../items/:packageItemId/remove`: soft-excludes the item and preserves history.
- `POST .../items/:packageItemId/documents`: `{ "documentId": "uuid", "role": "attachment" }`

Accepted product documents are attached automatically when a draft line is added. Documents must
belong to the same project or the same tenant's shared document library. Composite foreign keys and
RLS provide the final tenant boundary.

The preview returns each ordered package item plus its ordered document metadata (`documentId`,
title, filename, MIME type, role, inclusion state, sequence, and size), not only aggregate counts.

## Register and status

Creating a `submittal_requirement` automatically creates one register line. The register API returns
worksection and clause references, responsibility, due date, status, consultant response metadata,
and overdue state. Due-date defaults and overdue calculations use the `Australia/Sydney` business
date, independently of the database session timezone. Clause output is reference/location only;
package generation never republishes licensed clause text.

`POST /projects/:projectId/register-items/export` queues CSV, XLSX, or PDF using
`{ "format": "csv" | "xlsx" | "pdf" }` plus `Idempotency-Key`.

Consultant webhook updates may set `submitted`, `revise_and_resubmit`, or `rejected` only, following
the same transition graph as manual updates. The webhook connection must be mapped to the target
project, and replaying a processed external event is a no-op. Only the explicit human sign-off
endpoint can set `human_approved`; the database rejects a system actor that attempts it.

Physical samples and stamped drawings are records only. Their API stores status, responsibility,
tracking reference, due/sent/received/returned dates, notes, and an optional existing document. It
does not generate, certify, or imply certification of a drawing.

## Generated artifacts

- Package PDF: branded cover, register summary, clause cross-references, physical-item tracker, then
  selected PDF/image attachments. Missing or unsupported files produce manifest warnings instead of
  aborting the whole package.
- Register exports: CSV, native XLSX, and PDF.
- Aconex-ready ZIP: package PDF, register CSV/XLSX, selected source attachments, and `metadata.json`
  with schema `submitsense.aconex-bundle.v1`. This is a deterministic interchange bundle, not an
  Aconex upload API call.

Register and Aconex exports include accepted product/vendor identity. CSV fields that could be
interpreted as spreadsheet formulas are neutralised before output, and Aconex register files omit
draft package rows marked as excluded.

Each successful regeneration creates a new `package_versions` row and document. Earlier versions
remain immutable and queryable. The version stores the complete generation snapshot, so a later
Aconex export cannot pick up edits made to the draft after that version was generated. Reprocessing
the same job is idempotent and returns the same version; replaying the same regeneration request does
not reset a ready package or add another audit event.

## Worker and storage

Run the API and worker separately:

```bash
npm run start:dev
npm run worker
```

Required worker configuration:

- `DATABASE_URL`: runtime PostgreSQL login inheriting `submitsense_app`, not the table owner.
- `S3_OUTPUT_BUCKET`: generated-output bucket.
- `AWS_REGION`: must resolve to `ap-southeast-2` or `ap-southeast-4`.
- `S3_KMS_KEY_ARN`: optional KMS key; without it uploads request S3 AES-256 encryption.

The worker checks the bucket's actual AWS region before reading or writing. A non-Australian or
unverifiable region fails the job. Processing jobs remain the durable idempotent ledger. A worker
lease left in `running` for 15 minutes is reclaimed when retries remain. On the final attempt, related
package/export state is closed consistently; an artifact committed just before a crash is reconciled
to `succeeded` rather than regenerated.

## QA commands

```bash
npm run typecheck --prefix backend
npm test --prefix backend
npm audit --prefix backend
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/test/test_guardrails.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/test/test_package_assembly.sql
```

For a local integration database, `PACKAGE_TEST_DATABASE_URL=... npm run verify:package-worker --prefix backend`
generates a real package version plus PDF, CSV, XLSX, and ZIP exports through the production job
handler using an in-memory object-store adapter. `npm run render:package-fixture --prefix backend`
writes a four-page visual fixture to `output/pdf/` for renderer inspection.

## Remaining integration boundaries

- Infrastructure must provide the AU S3 bucket, IAM access, optional KMS key, runtime database role,
  and worker process supervision/retry monitoring.
- The external integration owner must map the Aconex metadata schema and stored consultant references
  to live provider SDK/API calls. No provider credentials or outbound SDK are embedded here.
- Frontend should poll the existing processing-job endpoint and display version/export failures and
  manifest warnings; generation is intentionally asynchronous.
- The risk agent may consume register status, due/overdue state, clause references, accepted-product
  identity, package preview metadata, and physical-deliverable state. It remains responsible for its
  own risk logic and must not mutate generated package versions or infer certification from status.
