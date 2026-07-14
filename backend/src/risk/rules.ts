export const RISK_SCORING_VERSION = "a4-rules-v1";

export type RiskSeverity = "low" | "medium" | "high" | "critical";
export type RiskType = "non_compliant_product" | "missing_evidence" | "spec_conflict" | "superseded_clause" | "ambiguous_requirement" | "deadline_risk" | "other";

export interface SourceReference {
  kind: "register_item" | "clause" | "drawing" | "document" | "product_match" | "addendum" | "rule";
  id: string;
  label: string;
  page?: number | null;
}

export interface LinkedDocument {
  id: string;
  title: string;
  role: string;
  mimeType: string | null;
  docType: string;
}

export interface MatchFact {
  id: string;
  productId: string;
  productName: string;
  confidence: number | null;
  decision: string;
  missingInfo: string[];
  documents: LinkedDocument[];
}

export interface RiskCheckItem {
  registerItemId: string;
  title: string;
  description: string | null;
  status: string;
  dueDate: string | null;
  reviewerAssigned: boolean;
  requirementCategory: string | null;
  requirementConfidence: number | null;
  isHoldPoint: boolean;
  clauseReferenceId: string | null;
  clauseReference: SourceReference | null;
  documents: LinkedDocument[];
  drawingReferences: SourceReference[];
  matches: MatchFact[];
  physicalKinds: string[];
  supersededReferences: SourceReference[];
}

export interface RiskFinding {
  ruleKey: string;
  riskType: RiskType;
  severity: RiskSeverity;
  score: number;
  summary: string;
  rationale: string;
  evidence: SourceReference[];
  checklistLabel: string;
}

type Rule = (item: RiskCheckItem) => RiskFinding[];

const allowedMimeTypes = new Set(["application/pdf", "image/png", "image/jpeg"]);
const productCategories = new Set(["product_data", "certificate", "test_report", "manual", "evidence_of_conformity"]);
const evidenceRoles: Record<string, string[]> = {
  product_data: ["datasheet"],
  certificate: ["certificate"],
  test_report: ["test_report"],
  manual: ["manual"],
  evidence_of_conformity: ["certificate", "test_report"],
  commissioning_record: ["test_report", "commissioning_record"],
};

function references(item: RiskCheckItem, extra: SourceReference[] = []): SourceReference[] {
  const base: SourceReference[] = [{ kind: "register_item", id: item.registerItemId, label: item.title }];
  if (item.clauseReference) base.push(item.clauseReference);
  return [...base, ...extra];
}

function finding(item: RiskCheckItem, input: Omit<RiskFinding, "evidence"> & { evidence?: SourceReference[] }): RiskFinding {
  return {
    ...input,
    evidence: references(item, [
      ...(input.evidence ?? []),
      { kind: "rule", id: input.ruleKey, label: `${RISK_SCORING_VERSION}: fixed score ${input.score}/100; ${input.rationale}` },
    ]),
  };
}

const missingProductDocument: Rule = (item) => {
  if (!productCategories.has(item.requirementCategory ?? "")) return [];
  const selected = item.matches.find((match) => match.decision === "accepted") ?? item.matches[0];
  if (!selected || selected.documents.length > 0) return [];
  return [finding(item, {
    ruleKey: "missing_product_document",
    riskType: "missing_evidence",
    severity: "high",
    score: 75,
    summary: "Likely risk: the selected product has no linked product document; needs reviewer confirmation.",
    rationale: "A product match exists, but no tenant-owned datasheet, certificate, test report, or manual is linked.",
    evidence: [{ kind: "product_match", id: selected.id, label: `${selected.productName}; ${selected.decision} match` }],
    checklistLabel: "Link and review the selected product document.",
  })];
};

const missingRequiredEvidence: Rule = (item) => {
  const required = evidenceRoles[item.requirementCategory ?? ""];
  if (!required) return [];
  const docs = [...item.documents, ...item.matches.flatMap((match) => match.documents)];
  if (docs.some((document) => required.includes(document.role))) return [];
  return [finding(item, {
    ruleKey: "missing_required_evidence",
    riskType: "missing_evidence",
    severity: "high",
    score: 80,
    summary: `Likely risk: required ${item.requirementCategory?.replaceAll("_", " ")} evidence is not linked; needs reviewer confirmation.`,
    rationale: `The extracted requirement expects one of these evidence roles: ${required.join(", ")}.`,
    checklistLabel: `Attach and review ${item.requirementCategory?.replaceAll("_", " ")} evidence.`,
  })];
};

const unsupportedFormat: Rule = (item) => {
  const allDocuments = [...new Map([...item.documents, ...item.matches.flatMap((match) => match.documents)].map((document) => [document.id, document])).values()];
  const unsupported = allDocuments.filter((document) => !document.mimeType || !allowedMimeTypes.has(document.mimeType));
  if (unsupported.length === 0) return [];
  return [finding(item, {
    ruleKey: "unsupported_file_format",
    riskType: "missing_evidence",
    severity: "medium",
    score: 55,
    summary: "Likely risk: one or more linked files use an unsupported review-package format.",
    rationale: "Package review supports PDF, PNG, and JPEG source evidence.",
    evidence: unsupported.map((document) => ({ kind: "document", id: document.id, label: `${document.title}; MIME ${document.mimeType ?? "missing"}` })),
    checklistLabel: "Replace or convert unsupported evidence files and review the result.",
  })];
};

const productMatch: Rule = (item) => {
  if (!productCategories.has(item.requirementCategory ?? "")) return [];
  if (item.matches.length === 0) return [finding(item, {
    ruleKey: "unmatched_product",
    riskType: "other",
    severity: "high",
    score: 75,
    summary: "Likely risk: no tenant-owned product match is linked; needs reviewer confirmation.",
    rationale: "No accepted or pending product suggestion exists for this register item.",
    checklistLabel: "Select and review a tenant-owned product match.",
  })];
  const selected = item.matches.find((match) => match.decision === "accepted") ?? item.matches[0];
  if (selected.confidence !== null && selected.confidence >= 0.6) return [];
  return [finding(item, {
    ruleKey: "low_confidence_product_match",
    riskType: "other",
    severity: "medium",
    score: 60,
    summary: "Likely risk: the available product match has low or missing confidence; needs reviewer confirmation.",
    rationale: "The deterministic product-match confidence is below 0.60 or unavailable.",
    evidence: [{ kind: "product_match", id: selected.id, label: `${selected.productName}; confidence ${selected.confidence ?? "missing"}` }],
    checklistLabel: "Review the product match and its source evidence.",
  })];
};

const attributeMismatch: Rule = (item) => {
  const selected = item.matches.find((match) => match.decision === "accepted") ?? item.matches[0];
  if (!selected) return [];
  const issues = selected.missingInfo.filter((value) => /not found|mismatch|inconsistent|does not match/i.test(value));
  if (issues.length === 0) return [];
  return [finding(item, {
    ruleKey: "product_attribute_mismatch",
    riskType: "other",
    severity: "high",
    score: 78,
    summary: "Likely risk: extracted product facts appear inconsistent with the requirement; needs reviewer confirmation.",
    rationale: issues.join("; "),
    evidence: [{ kind: "product_match", id: selected.id, label: `${selected.productName}; ${issues.join("; ")}` }],
    checklistLabel: "Compare the requirement against the product attributes and source documents.",
  })];
};

const holdPoint: Rule = (item) => item.isHoldPoint && !["human_approved", "closed"].includes(item.status)
  ? [finding(item, {
      ruleKey: "unmet_hold_point",
      riskType: "other",
      severity: "critical",
      score: 90,
      summary: "Likely risk: the extracted hold point has not received the required human review state.",
      rationale: "The current register state does not record completed human hold-point review; this rule makes no engineering decision.",
      checklistLabel: "Obtain and record the required human hold-point review.",
    })]
  : [];

const physicalTracking: Rule = (item) => {
  const expected = item.requirementCategory === "sample" ? "physical_sample" : item.requirementCategory === "shop_drawing" ? "stamped_shop_drawing" : null;
  if (!expected || item.physicalKinds.includes(expected)) return [];
  return [finding(item, {
    ruleKey: "missing_physical_tracking",
    riskType: "missing_evidence",
    severity: "high",
    score: 72,
    summary: "Likely risk: the required physical sample or stamped-drawing tracking entry is missing.",
    rationale: `Requirement category ${item.requirementCategory} expects a ${expected} tracking record.`,
    checklistLabel: "Create and review the required physical-deliverable tracking entry.",
  })];
};

const reviewerAssignment: Rule = (item) => item.reviewerAssigned ? [] : [finding(item, {
  ruleKey: "missing_human_reviewer",
  riskType: "other",
  severity: "high",
  score: 70,
  summary: "Likely risk: no active human reviewer is assigned to this item.",
  rationale: "The responsible user is missing or does not hold project/tenant review authority.",
  checklistLabel: "Assign an authorised human reviewer.",
})];

const dueDate: Rule = (item) => item.dueDate ? [] : [finding(item, {
  ruleKey: "missing_due_date",
  riskType: "deadline_risk",
  severity: "medium",
  score: 55,
  summary: "Likely risk: this required submission has no due date.",
  rationale: "The register item due_date is empty.",
  checklistLabel: "Set and review the submission due date.",
})];

const supersededReference: Rule = (item) => item.supersededReferences.length === 0 ? [] : [finding(item, {
  ruleKey: "superseded_reference",
  riskType: "superseded_clause",
  severity: "high",
  score: 82,
  summary: "Likely risk: a package reference appears to have been superseded by an addendum.",
  rationale: "The linked worksection/clause is marked superseded or an addendum records a superseding/deleting action.",
  evidence: item.supersededReferences,
  checklistLabel: "Reconcile the package reference against the latest addendum.",
})];

const ambiguity: Rule = (item) => {
  const text = `${item.title} ${item.description ?? ""}`;
  if ((item.requirementConfidence === null || item.requirementConfidence >= 0.65) && !/\b(ambiguous|unclear|not specified|missing information|to be confirmed|tbc)\b/i.test(text)) return [];
  return [finding(item, {
    ruleKey: "ambiguity_candidate",
    riskType: "ambiguous_requirement",
    severity: "medium",
    score: 58,
    summary: "Likely risk: the extracted requirement is an ambiguity candidate and needs reviewer confirmation.",
    rationale: `Extraction confidence is ${item.requirementConfidence ?? "missing"}, or the extracted summary contains an ambiguity marker.`,
    checklistLabel: "Review the ambiguity and decide whether an RFI draft is needed.",
  })];
};

const specDrawingConflict: Rule = (item) => {
  const text = `${item.title} ${item.description ?? ""}`;
  if (!item.clauseReference || item.drawingReferences.length === 0 || !/\b(conflict|discrepancy|differs|inconsistent|does not match|versus)\b/i.test(text)) return [];
  return [finding(item, {
    ruleKey: "spec_drawing_conflict_candidate",
    riskType: "spec_conflict",
    severity: "high",
    score: 85,
    summary: "Likely risk: the extracted facts indicate a spec-versus-drawing conflict candidate.",
    rationale: "Both a clause reference and drawing reference exist, and the extracted summary contains a conflict marker.",
    evidence: item.drawingReferences,
    checklistLabel: "Compare the cited clause and drawing, then confirm whether an RFI draft is required.",
  })];
};

export const riskRuleRegistry: ReadonlyArray<{ key: string; run: Rule }> = [
  { key: "missing_product_document", run: missingProductDocument },
  { key: "missing_required_evidence", run: missingRequiredEvidence },
  { key: "unsupported_file_format", run: unsupportedFormat },
  { key: "product_match", run: productMatch },
  { key: "product_attribute_mismatch", run: attributeMismatch },
  { key: "unmet_hold_point", run: holdPoint },
  { key: "missing_physical_tracking", run: physicalTracking },
  { key: "missing_human_reviewer", run: reviewerAssignment },
  { key: "missing_due_date", run: dueDate },
  { key: "superseded_reference", run: supersededReference },
  { key: "ambiguity_candidate", run: ambiguity },
  { key: "spec_drawing_conflict_candidate", run: specDrawingConflict },
];

export function runRiskRules(items: RiskCheckItem[]): RiskFinding[] {
  return items.flatMap((item) => riskRuleRegistry.flatMap((rule) => rule.run(item)));
}
