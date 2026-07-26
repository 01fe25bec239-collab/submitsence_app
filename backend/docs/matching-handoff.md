# Vendor Matching & BYO Product-Catalogue Handoff (B6-B7)

For the package (D), risk (C), frontend, QA, and compliance agents. This is the contract for the
tenant-owned catalogue ingestion + requirement→product matching engine. It sits on the DB layer
(migrations `0007`, `0008`, `0016`) and the API/auth/compliance layers already shipped.

**Moat & non-negotiable:** matching uses each tenant's OWN vendor data only. No cross-tenant
retrieval, embedding search, or suggestion is possible — enforced three ways: RLS (`submitsense_app`
has no BYPASSRLS), an explicit `p.tenant_id = $1` filter on candidate load, and the `product_matches`
composite FKs that pin `register_items` and `products` to the SAME `tenant_id` (0007). SubmitSense is
**assistive**: a match is a `pending` suggestion with cited evidence and a confidence signal, never a
compliance/approval claim. Only a human accept/reject/override decides it.

## What shipped

| Piece | Path |
|---|---|
| Ranking core (pure, deterministic, unit-tested) | `src/matching/scoring.ts` |
| Requirement→product matching service (DB) | `src/matching/matching.service.ts` |
| Product extraction (structured catalogues) + standards detection | `src/ingestion/extraction.ts` |
| Embedding generation (tenant-isolated, pgvector) | `src/ingestion/embedder.ts` |
| Catalogue ingestion (persist products/attrs/docs/embeddings, dedup) | `src/ingestion/ingestion.service.ts` |
| Background worker (claims jobs cross-tenant, runs each in-tenant as `system`) | `src/worker/worker.ts` |
| Job claimer (SECURITY DEFINER, FOR UPDATE SKIP LOCKED) | `db/migrations/0016_job_claim.sql` |
| Manual product create/review/correction, consent, aggregate | `src/api/api.service.ts` |

Run the worker: `npm --prefix backend run worker` (separate process; same DB role as the API).

## Matching contract (for package D + frontend)

- **Input:** a `register_items` row (with its linked `submittal_requirements`, if any). Trigger a run
  with `POST …/register-items/{itemId}/product-matches/rematch` (enqueues `product_rematch`); the
  worker computes and stores suggestions.
- **Output:** `product_matches` rows, `decision='pending'`, each carrying:
  - `confidence` (0..1) — a **suggestion signal**, not approval. Never render it as certified/compliant.
  - `rationale_summary` — short, assistive, passes `assertSafeStatusLanguage()`.
  - `evidence` jsonb = `{ references: [{field, value}], missingInfo: [string] }`. `references` are
    **source-cited** to the product's own fields (name/model/category/attribute/standard/semantic);
    `missingInfo` lists gaps (missing standard, no datasheet, low confidence). Frontend must show the
    citations and the missing-info notes, and present matches as "needs review".
  - `requirement_id` — the requirement matched, when the register item is linked to one.
- **Read:** `GET …/projects/{projectId}/product-matches`. **Decide (human only):**
  `…/product-matches/{matchId}/accept|reject`, `…/product-matches/override`. Re-running rematch
  replaces prior **pending** rows only — accepted/rejected/overridden decisions are preserved.
- **Ranking signals:** lexical token coverage (0.6) + category alignment (0.2) + standards/cert
  coverage (0.2), blended with optional semantic cosine (pgvector `<=>`, weight 0.4 when a query
  embedding exists). Deterministic and tie-broken by product id.

## Ingestion contract

- Human uploads a catalogue (`vendor_catalogue`) or past submittal (`past_submittal`) → document +
  `ingest_*` job (existing API). The worker extracts products and writes `vendors`, `products`,
  `product_attributes`, `product_documents` (datasheet link), `extracted_product_data`, and a
  `product_embeddings` row per product. **Idempotent:** re-ingesting updates existing products
  (same vendor + model, else vendor + name) rather than duplicating — this is the in-tenant duplicate
  detection.
- **Manual path (no OCR needed):** `POST …/vendors`, `POST …/products` (with `attributes[]`),
  `PATCH …/products/{productId}` for review/correction. Corrections are stored `source='manual_entry'`
  so a later catalogue re-ingest never overwrites them. Manual create/update also indexes an embedding.

## Learning loop (for risk C + compliance)

- Consent is **opt-in only**. `GET/POST …/learning-consent` sets `tenant_consents.learning_loop`
  (`opted_in|opted_out`); changes emit `consent_change`. Opt-out flips future events' `opted_out` and
  never retroactively exposes past snapshots; operational audit is preserved.
- Match/risk decisions feed `rejection_learning_events` (existing `…/learning-events`, itself
  consent-gated). Supply `consultant_outcome` from package/status/integration signals when known.
- `GET …/learning-patterns` returns an **anonymised** aggregate (counts by worksection code,
  requirement category, risk type, consultant outcome) **only** when the tenant is `opted_in`, reading
  strictly `anonymised_eligible AND NOT opted_out AND consent_state='opted_in'`. It runs in-tenant
  under RLS — no tenant identity, no user, no external consultant ref in the output.

## Audit

- `match` — one event per rematch run (register item, count, match ids). `extraction` — one per
  catalogue ingest. `admin_action` — vendor/product create/correct. `consent_change` — consent set.
  No document text, PII, or secrets in any payload.

## Known gaps / stop-and-ask (for DevOps + product + compliance)

- **OCR/LLM extraction from PDFs is not wired.** The default extractor parses structured catalogues
  (CSV/xlsx rows) only; PDF/scanned input ingests zero products with a recorded reason. A real
  extractor MUST run on Australian-hosted/approved infra (compliance §5-6) — processor-approval
  decision. Also unwired: downloading the S3 object and parsing CSV/xlsx into rows (needs AU S3 + a
  parser dep); until then the worker reads rows from `worker_output`.
- **Embeddings** use a deterministic local hashing embedder so ingestion/pgvector/semantic search run
  reproducibly without shipping tenant text to any processor. Swap in an AU-resident model
  (`setEmbedder`, keep `dim=1536`) once approved — that is a processor decision, **stop and ask**.
- **Scale:** candidate load is a capped (500) full-catalogue scan; add a pgvector ANN prefilter (the
  HNSW index already exists) when a tenant's catalogue exceeds a few hundred products.
- **Cross-tenant / global learning** is intentionally NOT built: aggregation is within a consented
  tenant only. A platform-wide anonymised aggregate would need the reserved `submitsense_auditor`-style
  role + k-anonymity + legal sign-off — **stop and ask** before building it.
- **Stuck jobs:** a worker crash mid-process leaves a job `running`; add a reaper (requeue `running`
  older than N minutes) when it bites.
- **Stale-document detection** (by datasheet date / manual mark) is a small follow-up, not yet built.

## Tests

`npm --prefix backend test` includes: `matching.test.ts` (ranking, evidence, missing-standard,
confidence bounds, empty-candidate = no cross-tenant leak, semantic lift), `ingestion.test.ts`
(structured parse, standards, embedder dims), `b6b7-contract.test.mjs` (tenant-scoped SQL, worker
system-actor, claimer SECURITY DEFINER, consent gating). DB-level cross-tenant-match block is proved
by `db/test/test_guardrails.sql` test 5.
