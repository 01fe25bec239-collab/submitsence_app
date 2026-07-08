import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// Mirrors permission-policy.test.mjs: load the policy DATA and assert on it. The guard in
// language.ts is a case-insensitive substring match; we reimplement that one line here so the
// test needs no TS build step (backend is CommonJS, tests are .mjs).
const policyUrl = new URL("../src/compliance/language-policy.json", import.meta.url);
const policy = JSON.parse(readFileSync(policyUrl, "utf8"));
const banned = policy.bannedSystemJudgmentTerms;
const findBanned = (text) => banned.filter((t) => text.toLowerCase().includes(t.toLowerCase()));

// req f11 — these system-judgment terms must be banned.
const requiredBanned = ["certified", "guaranteed compliant", "approved by SubmitSense", "verified compliant", "will not be rejected"];
// req f12 — these review-oriented terms must stay allowed.
const requiredAllowed = ["likely risk", "needs review", "for your engineer to confirm", "source cited", "prepared for review"];

test("every required banned term (req f11) is covered by the policy", () => {
  for (const term of requiredBanned) {
    assert.ok(findBanned(term).length > 0, `banned term not caught: ${term}`);
  }
});

test("a realistic system-generated sentence with a banned claim is flagged", () => {
  assert.deepEqual(findBanned("This submittal is Certified and will not be rejected."), banned.filter((t) => ["certified", "will not be rejected"].includes(t.toLowerCase())));
});

test("allowed review terms (req f12) are present and never trip the guard", () => {
  for (const term of requiredAllowed) {
    assert.ok(policy.allowedReviewTerms.includes(term), `allowed term missing: ${term}`);
    assert.equal(findBanned(term).length, 0, `allowed term flagged as banned: ${term}`);
  }
});

test("compliant status copy passes clean", () => {
  assert.equal(findBanned("Likely risk — needs review; source cited, prepared for review.").length, 0);
});
