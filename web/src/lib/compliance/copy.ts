/*
 * SubmitSense compliance copy catalogue — the single source of truth for
 * compliance-sensitive UI text. SubmitSense is ASSISTIVE and NON-CERTIFYING:
 * it surfaces suggestions and cites sources; a licensed human is always the
 * final approver. The UI must never state or imply the system approved,
 * certified, verified, or guaranteed compliance.
 *
 * Mirrors backend/src/compliance/language-policy.json + language.ts. If the two
 * ever diverge, the backend wins (it fail-closes on generation); update here.
 */

// Exact mirror of backend bannedSystemJudgmentTerms.
export const BANNED_SYSTEM_TERMS = [
  "certified",
  "verified compliant",
  "guaranteed compliant",
  "compliance guaranteed",
  "approved by submitsense",
  "submitsense certifies",
  "submitsense approves",
  "will not be rejected",
  "guaranteed to pass",
  "fully compliant",
  "meets all requirements",
] as const;

// Exact mirror of backend allowedReviewTerms — the sanctioned framing.
export const ALLOWED_REVIEW_TERMS = [
  "likely risk",
  "needs review",
  "for your engineer to confirm",
  "source cited",
  "prepared for review",
] as const;

/**
 * Dev-time guard for SYSTEM-GENERATED copy (status labels, badges, summaries).
 * Not for user-authored free text — a human may legitimately type "certified".
 * Throws in development so a banned phrase fails loudly in tests/CI; in
 * production it logs and returns the text so a copy slip never white-screens.
 */
export function assertSafeSystemCopy(text: string): string {
  const haystack = text.toLowerCase();
  const hits = BANNED_SYSTEM_TERMS.filter((t) => haystack.includes(t));
  if (hits.length) {
    const msg = `Non-compliant system copy: banned term(s) ${JSON.stringify(hits)} in ${JSON.stringify(text)}. Use review-oriented wording (see language-policy.json).`;
    if (process.env.NODE_ENV !== "production") throw new Error(msg);
    console.error(msg);
  }
  return text;
}

// ── Standing disclaimers ────────────────────────────────────────────────────
export const DISCLAIMER = {
  /** Persistent, shown in the app shell footer/banner. */
  assistive:
    "SubmitSense is an assistive tool. It prepares submittals for review and cites its sources — it does not certify compliance. A licensed person is always the final approver.",
  /** On generated packages / exports. */
  packageExport:
    "This package was assembled for review. SubmitSense has not checked it for engineering compliance — confirm all content before submission.",
  /** On product-match suggestions. */
  matchSuggestion:
    "Suggested match, source cited — accept, reject, or override. SubmitSense does not confirm a product complies.",
  /** On rejection-risk output. */
  riskChecklist:
    "Likely risks flagged for your review. These are not findings of non-compliance; your engineer confirms each one.",
  /** On RFI drafts. */
  rfiDraft:
    "Draft prepared for review. Nothing is sent from SubmitSense — export or hand off after a human reviews it.",
  /** On extraction review. */
  extraction:
    "Extracted from your documents with sources cited. Review and correct before relying on it.",
} as const;

// ── Sign-off (the one human, auditable gate) ────────────────────────────────
export const SIGN_OFF = {
  title: "Human sign-off",
  intro:
    "You are recording your professional review of the selected items. This is your decision, not SubmitSense's — it is attributed to you and timestamped in the audit trail.",
  confirmLabel: "I have reviewed these items and take responsibility for this sign-off",
  action: "Record sign-off",
  reassurance: "Only a licensed person can sign off. Automated processes cannot.",
} as const;

// ── Status labels (compliance-safe, human-readable) ─────────────────────────
// Keys match db/docs/enums.md exactly. `tone` maps to a Badge variant.
type Tone = "default" | "secondary" | "muted" | "success" | "warning" | "info" | "destructive";

export const SUBMITTAL_STATUS: Record<string, { label: string; tone: Tone; help?: string }> = {
  draft: { label: "Draft", tone: "muted" },
  submitted: { label: "Submitted for review", tone: "info" },
  human_approved: {
    label: "Human approved",
    tone: "success",
    help: "A licensed reviewer signed this off. SubmitSense did not approve it.",
  },
  revise_and_resubmit: { label: "Revise & resubmit", tone: "warning" },
  rejected: { label: "Rejected", tone: "destructive" },
  closed: { label: "Closed", tone: "secondary" },
  cancelled: { label: "Cancelled", tone: "muted" },
};

export const RISK_SEVERITY: Record<string, { label: string; tone: Tone }> = {
  low: { label: "Low", tone: "muted" },
  medium: { label: "Medium", tone: "info" },
  high: { label: "High", tone: "warning" },
  critical: { label: "Critical", tone: "destructive" },
};

export const RISK_STATE: Record<string, { label: string; tone: Tone }> = {
  open: { label: "Needs review", tone: "warning" },
  confirmed: { label: "Confirmed by reviewer", tone: "info" },
  dismissed: { label: "Dismissed", tone: "muted" },
  resolved: { label: "Resolved", tone: "success" },
};

export const MATCH_DECISION: Record<string, { label: string; tone: Tone }> = {
  pending: { label: "Suggested — needs review", tone: "warning" },
  accepted: { label: "Accepted by reviewer", tone: "success" },
  rejected: { label: "Rejected by reviewer", tone: "muted" },
  superseded: { label: "Superseded", tone: "muted" },
};

export const PACKAGE_STATUS: Record<string, { label: string; tone: Tone }> = {
  draft: { label: "Draft", tone: "muted" },
  assembling: { label: "Assembling", tone: "info" },
  ready: { label: "Ready for review", tone: "success" },
  submitted: { label: "Submitted", tone: "secondary" },
  superseded: { label: "Superseded", tone: "muted" },
};

export const JOB_STATUS: Record<string, { label: string; tone: Tone }> = {
  queued: { label: "Queued", tone: "muted" },
  running: { label: "Processing", tone: "info" },
  retrying: { label: "Retrying", tone: "warning" },
  succeeded: { label: "Done", tone: "success" },
  failed: { label: "Failed", tone: "destructive" },
  cancelled: { label: "Cancelled", tone: "muted" },
};

export const PROJECT_STATUS: Record<string, { label: string; tone: Tone }> = {
  draft: { label: "Draft", tone: "muted" },
  active: { label: "Active", tone: "success" },
  on_hold: { label: "On hold", tone: "warning" },
  completed: { label: "Completed", tone: "info" },
  archived: { label: "Archived", tone: "muted" },
  cancelled: { label: "Cancelled", tone: "muted" },
};

export const TRADE_PACKAGE: Record<string, string> = {
  mechanical: "Mechanical",
  electrical: "Electrical",
  hydraulic: "Hydraulic",
  fire_protection: "Fire protection",
  communications: "Communications",
  other: "Other",
};

/** Safe label lookup with a fallback that de-snake-cases unknown values. */
export function labelFor(
  map: Record<string, { label: string; tone: Tone }>,
  key: string | null | undefined,
): { label: string; tone: Tone } {
  if (key && map[key]) return map[key];
  const label = (key ?? "unknown").replace(/_/g, " ");
  return { label: label.charAt(0).toUpperCase() + label.slice(1), tone: "muted" };
}
