# SubmitSense web — compliance copy catalogue

**Source of truth is code, not this file:** [`src/lib/compliance/copy.ts`](../src/lib/compliance/copy.ts).
It mirrors the backend's `backend/src/compliance/language-policy.json` +
`language.ts`. If the two ever diverge, the **backend wins** — it fail-closes on
generation. This doc is the human-readable summary and the rule set for authors.

## The rule

SubmitSense is **assistive and non-certifying**. System-generated status text,
badges, and summaries must never assert compliance/approval on the system's
behalf. A licensed human is always the final approver.

- **Banned in system copy** (case-insensitive substring): `certified`,
  `verified compliant`, `guaranteed compliant`, `compliance guaranteed`,
  `approved by submitsense`, `submitsense certifies`, `submitsense approves`,
  `will not be rejected`, `guaranteed to pass`, `fully compliant`,
  `meets all requirements`.
- **Sanctioned framing**: `likely risk`, `needs review`,
  `for your engineer to confirm`, `source cited`, `prepared for review`.
- `assertSafeSystemCopy(text)` enforces this at runtime — **throws in dev/CI**,
  logs in prod. `StatusBadge` runs every label through it, so a banned phrase
  cannot reach the screen. Not applied to user-authored free text (a human may
  legitimately type "certified" in a note).

## Standing disclaimers (`DISCLAIMER`)

| Key | Where |
|---|---|
| `assistive` | app shell footer + marketing footer (persistent) |
| `packageExport` | generated packages / export screens |
| `matchSuggestion` | product-match review |
| `riskChecklist` | rejection-risk review |
| `rfiDraft` | RFI draft editor (never auto-sent) |
| `extraction` | extraction review |

## Human sign-off (`SIGN_OFF`)

Explicit, attributed, auditable. Copy stresses "your decision, not SubmitSense's",
requires an explicit confirm checkbox, and states only a licensed person can sign
off. Wire to `POST …/register-items/sign-off` (human actor only).

## Status labels (compliance-safe)

Maps keyed to `db/docs/enums.md`, each `{ label, tone }` (tone = Badge variant):

- `SUBMITTAL_STATUS` — note `human_approved` → "Human approved" with help text
  "A licensed reviewer signed this off. SubmitSense did not approve it."
- `RISK_SEVERITY`, `RISK_STATE` (`open` → "Needs review"),
  `MATCH_DECISION` (`pending` → "Suggested — needs review"),
  `PACKAGE_STATUS`, `JOB_STATUS`, `PROJECT_STATUS`, `TRADE_PACKAGE`.

## Authoring rule

Any new system-emitted status/label/summary string goes through the catalogue
and `assertSafeSystemCopy`. Do not inline compliance-sensitive copy in components.

> Open item for the Compliance Agent: confirm marketing/long-form disclaimer
> wording. The backend list above is authoritative for **system status copy**;
> marketing prose has not been separately signed off.
