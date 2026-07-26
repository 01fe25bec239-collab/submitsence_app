import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const worker = readFileSync(new URL("../src/worker/worker.ts", import.meta.url), "utf8");
const riskService = readFileSync(new URL("../src/risk/risk.service.ts", import.meta.url), "utf8");
const apiService = readFileSync(new URL("../src/api/api.service.ts", import.meta.url), "utf8");
const rules = readFileSync(new URL("../src/risk/rules.ts", import.meta.url), "utf8");
const migration = readFileSync(new URL("../../db/migrations/0018_risk_rfi_agent.sql", import.meta.url), "utf8");
const handoff = readFileSync(new URL("../docs/risk-rfi-handoff.md", import.meta.url), "utf8");

test("risk and RFI generation jobs are handled under the trusted tenant context", () => {
  assert.match(worker, /risk_flag_generation: tenantHandler/);
  assert.match(worker, /rfi_generation: tenantHandler/);
  assert.match(worker, /tenantId: job\.tenant_id/);
});

test("rule registry covers every requested deterministic pre-check family", () => {
  for (const rule of [
    "missing_product_document", "missing_required_evidence", "unsupported_file_format", "unmatched_product",
    "low_confidence_product_match", "product_attribute_mismatch", "unmet_hold_point", "missing_physical_tracking",
    "missing_human_reviewer", "missing_due_date", "superseded_reference", "ambiguity_candidate",
    "spec_drawing_conflict_candidate",
  ]) assert.match(rules, new RegExp(rule));
  assert.match(rules, /RISK_SCORING_VERSION = "a4-rules-v1"/);
});

test("persistence keeps reviewed decisions and every finding carries source and score evidence", () => {
  assert.match(riskService, /where risk_flags\.state = 'open'/);
  assert.match(riskService, /risk_score/);
  assert.match(riskService, /scoring_version/);
  assert.match(rules, /kind: "register_item"/);
  assert.match(rules, /kind: "rule"/);
  assert.match(migration, /chk_risk_score_range/);
  assert.match(migration, /chk_risk_evidence_array/);
});

test("RFI drafts are structured and human-reviewed while unsupported output paths fail closed", () => {
  assert.match(riskService, /issue_summary, question, suggested_attachments/);
  assert.match(riskService, /rfi_cited_clauses/);
  assert.match(riskService, /rfi_cited_documents/);
  assert.match(apiService, /RFI review requires an active human user/);
  assert.match(apiService, /requireSupportedProcessingJobType\("export_rfi_pdf"\)/);
  assert.match(apiService, /async handoffRfi[\s\S]*return this\.unavailableJobType\(\)/);
  assert.match(handoff, /does not render, email, upload, or send it/);
});

test("learning writes are consent-aware and generated copy remains advisory", () => {
  assert.match(riskService, /learning_loop === "opted_in"/);
  assert.match(apiService, /recordConsentLearningDecision/);
  assert.match(apiService, /learning_outcome_recorded/);
  assert.match(riskService, /assertSafeStatusLanguage/);
  assert.doesNotMatch(riskService, /OpenAI|Anthropic|Bedrock|sendMail|fetch\(/);
});
