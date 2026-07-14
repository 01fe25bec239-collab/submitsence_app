# Rejection-risk pre-check and RFI drafting handoff

This is the A4-A5 contract for backend, frontend, QA, risk, and integration work. SubmitSense only
identifies likely risks and prepares reviewable drafts. It never makes an engineering decision,
records automatic compliance, or sends an RFI.

## Pre-check input and processing

`POST /api/v1/tenants/:tenantId/projects/:projectId/risk-flags/generate` requires an
`Idempotency-Key`. The optional body narrows the check:

```json
{
  "packageId": "optional-project-package-uuid",
  "registerItemId": "optional-project-register-item-uuid"
}
```

With neither value, all active project register items are checked. With a package, only included
package items are checked. With a register item, only that item is checked. Both may be supplied to
check one item within one package. The endpoint queues `risk_flag_generation`; poll the returned job.

The worker reads existing requirement, clause reference, package document, product match, product
document, physical-deliverable, assignment, deadline, addendum, and extraction-confidence facts.
All queries are tenant/project scoped and run under RLS as a system actor.

## Deterministic rules

Scoring version `a4-rules-v1` uses fixed, explainable 0-100 scores. Scores are prioritisation signals,
not probabilities or compliance decisions.

- Missing product document.
- Missing required evidence role.
- Unsupported PDF/image review-package format.
- Unmatched or low-confidence product suggestion.
- Product attribute/standard inconsistency reported by the source-cited match contract.
- Unmet hold point.
- Missing physical sample or stamped-drawing tracking entry.
- Missing active human reviewer assignment.
- Missing submission due date.
- Superseded worksection/clause or superseding/deleting addendum reference.
- Ambiguity candidate from low extraction confidence or an extracted ambiguity marker.
- Spec-versus-drawing conflict candidate when both references exist and the extracted summary contains
  a conflict marker.

Each flag stores `ruleKey`, `riskType`, `severity`, `riskScore`, `scoringVersion`, assistive `summary`,
and an evidence array. Evidence contains stable register, clause, drawing, document, product-match,
addendum, and rule references; it does not reproduce clause text. Re-running a rule refreshes only an
open flag. Confirmed or dismissed human decisions are preserved.

Every newly generated flag creates one checklist item. `POST .../risk-flags/:flagId/task` returns the
same task unless the human supplies a replacement label. Human reviewers can confirm, dismiss, or
comment; identity and time are retained in the flag/audit records.

## RFI drafts

Create a draft from a flag with `POST .../risk-flags/:flagId/rfi`, or use `POST .../rfis/generate`
with an optional `riskFlagId` or `registerItemId`. Both require `Idempotency-Key` and queue
`rfi_generation`.

Optional generation/edit fields:

```json
{
  "title": "Editable draft title",
  "issueSummary": "Editable issue summary",
  "question": "Editable clarification question",
  "conflictType": "ambiguity",
  "clauseReferenceIds": ["project-clause-reference-uuid"],
  "drawingDocumentIds": ["project-drawing-uuid"],
  "suggestedAttachmentIds": ["project-or-tenant-library-document-uuid"]
}
```

Generated drafts contain structured title, issue summary, question, clause references, drawing
references, and suggested attachments. Default copy is deterministic and source-cited; no LLM is
required. Only reference labels and page numbers are used, never long NATSPEC text.

An active human must call `POST .../rfis/:rfiId/mark-reviewed`. Export and send handoff endpoints
reject every draft whose `reviewStatus` is not `approved`. This component queues the reviewed artifact
for the external export/integration owner; it does not render, email, upload, or send it.

## Audit and learning

- Generation requests, generated flags, checklist actions, decisions, comments, generated RFI drafts,
  edits, and human review are audit logged.
- When tenant consent is `opted_in`, flag generation records anonymised-eligible learning events.
- Human confirm/dismiss decisions update the event stream.
- Known consultant `rejected` or `revise_and_resubmit` webhook outcomes update consented events.
- When consent is unset/opted out, no new learning event is generated. Existing rows are excluded and
  opt-out marks prior rows unusable through the existing consent contract.

## QA

```bash
npm run typecheck --prefix backend
npm test --prefix backend
RISK_TEST_DATABASE_URL=... npm run verify:risk-rfi-worker --prefix backend
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/test/test_risk_rfi_agent.sql
```

Synthetic tests cover missing evidence, unsupported formats, low-confidence/mismatched products,
superseded addenda, ambiguous extraction, spec/drawing conflict, hold points, physical tracking,
reviewer assignment, deadlines, citations, assistive language, scoring, consent, and review gates.

## Boundaries

This component does not implement extraction, catalogue ingestion, package rendering, UI, auth,
billing, infrastructure, external export rendering, email, or provider sending. It does not make a
final compliance or engineering judgment.
