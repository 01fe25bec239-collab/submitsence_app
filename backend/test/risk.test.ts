import assert from "node:assert/strict";
import test from "node:test";
import { findBannedTerms } from "../src/compliance/language";
import { RISK_SCORING_VERSION, runRiskRules, type RiskCheckItem } from "../src/risk/rules";

function item(overrides: Partial<RiskCheckItem> = {}): RiskCheckItem {
  return {
    registerItemId: "10000000-0000-0000-8000-000000000001",
    title: "Pump product data",
    description: "Provide pump product data",
    status: "draft",
    dueDate: "2026-08-01",
    reviewerAssigned: true,
    requirementCategory: "product_data",
    requirementConfidence: 0.95,
    isHoldPoint: false,
    clauseReferenceId: "20000000-0000-0000-8000-000000000001",
    clauseReference: { kind: "clause", id: "20000000-0000-0000-8000-000000000001", label: "NATSPEC 0711 cl 2.4", page: 42 },
    documents: [{ id: "30000000-0000-0000-8000-000000000001", title: "Pump datasheet", role: "datasheet", mimeType: "application/pdf", docType: "attachment" }],
    drawingReferences: [],
    matches: [{
      id: "40000000-0000-0000-8000-000000000001",
      productId: "50000000-0000-0000-8000-000000000001",
      productName: "Pump P20",
      confidence: 0.9,
      decision: "accepted",
      missingInfo: [],
      documents: [{ id: "30000000-0000-0000-8000-000000000001", title: "Pump datasheet", role: "datasheet", mimeType: "application/pdf", docType: "attachment" }],
    }],
    physicalKinds: [],
    supersededReferences: [],
    ...overrides,
  };
}

test("missing product and required evidence produce source-linked likely-risk flags", () => {
  const findings = runRiskRules([item({ documents: [], matches: [{ ...item().matches[0], documents: [] }] })]);
  assert.deepEqual(findings.filter((finding) => finding.ruleKey.startsWith("missing_")).map((finding) => finding.ruleKey).sort(), ["missing_product_document", "missing_required_evidence"]);
  for (const finding of findings) {
    assert.ok(finding.evidence.some((reference) => reference.kind === "register_item"));
    assert.ok(finding.evidence.some((reference) => reference.kind === "clause"));
  }
});

test("unsupported file format is identified with the exact document reference", () => {
  const unsupported = { id: "30000000-0000-0000-8000-000000000002", title: "Native CAD", role: "drawing", mimeType: "application/acad", docType: "drawing" };
  const [finding] = runRiskRules([item({ documents: [], matches: [{ ...item().matches[0], documents: [unsupported] }] })]).filter((value) => value.ruleKey === "unsupported_file_format");
  assert.ok(finding.evidence.some((reference) => reference.id === unsupported.id));
});

test("low-confidence and attribute inconsistency remain advisory and explainable", () => {
  const findings = runRiskRules([item({ matches: [{ ...item().matches[0], confidence: 0.31, missingInfo: ["Requirement references standard AS 2941 not found on this product"] }] })]);
  assert.ok(findings.some((finding) => finding.ruleKey === "low_confidence_product_match"));
  assert.ok(findings.some((finding) => finding.ruleKey === "product_attribute_mismatch"));
  assert.ok(findings.every((finding) => finding.evidence.some((reference) => reference.kind === "rule" && reference.label.includes(RISK_SCORING_VERSION))));
});

test("superseded addendum evidence produces a superseded-reference flag", () => {
  const addendum = { kind: "addendum" as const, id: "60000000-0000-0000-8000-000000000001", label: "Addendum 03; supersedes" };
  const [finding] = runRiskRules([item({ supersededReferences: [addendum] })]).filter((value) => value.ruleKey === "superseded_reference");
  assert.ok(finding.evidence.some((reference) => reference.id === addendum.id));
});

test("ambiguous extraction and spec-drawing conflict candidates preserve exact references", () => {
  const drawing = { kind: "drawing" as const, id: "70000000-0000-0000-8000-000000000001", label: "Drawing F-201 rev C" };
  const findings = runRiskRules([item({
    description: "Unclear requirement; drawing differs from the specification reference",
    requirementConfidence: 0.42,
    drawingReferences: [drawing],
  })]);
  assert.ok(findings.some((finding) => finding.ruleKey === "ambiguity_candidate"));
  const conflict = findings.find((finding) => finding.ruleKey === "spec_drawing_conflict_candidate");
  assert.ok(conflict?.evidence.some((reference) => reference.id === drawing.id));
  assert.ok(conflict?.evidence.some((reference) => reference.kind === "clause"));
});

test("hold point, physical tracking, reviewer, and deadline rules are deterministic", () => {
  const first = runRiskRules([item({ requirementCategory: "sample", isHoldPoint: true, reviewerAssigned: false, dueDate: null, documents: [], matches: [] })]);
  const second = runRiskRules([item({ requirementCategory: "sample", isHoldPoint: true, reviewerAssigned: false, dueDate: null, documents: [], matches: [] })]);
  assert.deepEqual(first, second);
  for (const key of ["unmet_hold_point", "missing_physical_tracking", "missing_human_reviewer", "missing_due_date"]) assert.ok(first.some((finding) => finding.ruleKey === key));
});

test("all generated risk copy remains assistive and non-certifying", () => {
  const findings = runRiskRules([item({ requirementCategory: "sample", isHoldPoint: true, reviewerAssigned: false, dueDate: null, documents: [], matches: [], requirementConfidence: 0.2 })]);
  for (const finding of findings) {
    assert.deepEqual(findBannedTerms(finding.summary), []);
    assert.deepEqual(findBannedTerms(finding.checklistLabel), []);
    assert.notEqual(finding.riskType, "non_compliant_product");
    assert.ok(finding.score >= 0 && finding.score <= 100);
  }
});
