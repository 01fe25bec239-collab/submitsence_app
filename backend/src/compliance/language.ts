import policy from "./language-policy.json";

const banned: string[] = policy.bannedSystemJudgmentTerms;

/**
 * Fail-closed guard for system-GENERATED status/label/certification copy (req f10-f12, NFR3).
 * SubmitSense is assistive and non-certifying; the system must never assert compliance/approval.
 * Call this on any status text, badge label, or summary the *system* emits before returning it.
 * NOT for user-authored free text (a human may legitimately type "certified" in a note).
 * ponytail: case-insensitive substring match — the banned list is short phrases, not a grammar.
 */
export function findBannedTerms(text: string): string[] {
  const haystack = text.toLowerCase();
  return banned.filter((term) => haystack.includes(term.toLowerCase()));
}

export function assertSafeStatusLanguage(text: string): void {
  const hits = findBannedTerms(text);
  if (hits.length > 0) {
    throw new Error(
      `Non-compliant status language: banned term(s) ${JSON.stringify(hits)}. ` +
        `SubmitSense is assistive/non-certifying — use review-oriented wording (see language-policy.json).`,
    );
  }
}

export const allowedReviewTerms: string[] = policy.allowedReviewTerms;
