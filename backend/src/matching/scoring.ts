// Requirement -> product ranking core (B6-B7). Pure and dependency-free so it is
// unit-testable without a DB or model call. Signals: token overlap (name/model/
// category/description/attributes), exact model hit, category alignment, standards/
// certificate coverage, and OPTIONAL cosine on caller-supplied embeddings.
//
// Compliance: `confidence` is a match SUGGESTION signal only. It is never a
// compliance/approval/certification claim (compliance-security-handoff §2). Every
// suggestion carries source-cited `evidence` and `missingInfo`; no product claim is
// invented here — we only echo fields the candidate itself provided.

export interface RequirementInput {
  id: string;
  title: string;
  description?: string | null;
  category?: string | null; // requirement_category
  standards?: string[]; // standards/certs the requirement references (e.g. "AS 1851")
}

export interface ProductAttr {
  key: string;
  value?: string | null;
  unit?: string | null;
}

export interface ProductCandidate {
  id: string;
  name: string;
  modelNumber?: string | null;
  category?: string | null;
  description?: string | null;
  attributes?: ProductAttr[];
  standards?: string[]; // standards/certs the product declares
  hasDatasheet?: boolean; // whether a datasheet/cert doc is linked (source coverage)
  embedding?: number[] | null;
  semanticScore?: number | null; // precomputed cosine (0..1), e.g. from a pgvector query
}

export interface EvidenceRef {
  field: string; // where the match came from: "name" | "model" | "category" | "attribute:<key>" | "standard" | "semantic"
  value: string; // the candidate's own value that matched (source-cited, never invented)
}

export interface MatchSuggestion {
  productId: string;
  confidence: number; // 0..1 blended signal
  rationale: string; // short, assistive language only
  evidence: EvidenceRef[];
  missingInfo: string[];
}

export interface RankOptions {
  limit?: number; // max suggestions returned (default 10)
  minConfidence?: number; // drop suggestions below this floor (default 0.05)
  semanticWeight?: number; // 0..1 weight given to cosine when both embeddings exist (default 0.4)
  requirementEmbedding?: number[] | null;
}

const STOPWORDS = new Set([
  "the", "and", "for", "with", "shall", "must", "per", "any", "all", "are", "was", "this", "that",
  "from", "into", "each", "such", "a", "an", "of", "to", "in", "on", "or", "be", "as", "is", "at",
  "by", "provide", "provided", "supply", "including", "include", "requirement", "requirements",
]);

function tokenize(text: string | null | undefined): Set<string> {
  const out = new Set<string>();
  if (!text) return out;
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 3) continue;
    if (STOPWORDS.has(raw)) continue;
    out.add(raw);
  }
  return out;
}

// Standards/cert codes are normalised so "AS1851", "as 1851", "AS-1851" all compare equal.
function normStandard(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  const c = dot / (Math.sqrt(na) * Math.sqrt(nb));
  return Math.max(0, Math.min(1, (c + 1) / 2)); // map [-1,1] -> [0,1]
}

function scoreOne(req: RequirementInput, reqTokens: Set<string>, p: ProductCandidate, opts: RankOptions): MatchSuggestion {
  const evidence: EvidenceRef[] = [];
  const missingInfo: string[] = [];

  // --- lexical coverage: fraction of requirement tokens covered by product fields ---
  const productText = [p.name, p.modelNumber, p.category, p.description, ...(p.attributes ?? []).flatMap((a) => [a.key, a.value])]
    .filter(Boolean)
    .join(" ");
  const productTokens = tokenize(productText);
  let covered = 0;
  for (const t of reqTokens) if (productTokens.has(t)) covered++;
  const coverage = reqTokens.size === 0 ? 0 : covered / reqTokens.size;

  // Named-field evidence (source-cited to the candidate's own values).
  if (p.name && [...tokenize(p.name)].some((t) => reqTokens.has(t))) evidence.push({ field: "name", value: p.name });
  if (p.modelNumber) {
    const modelHit = reqTokens.has(p.modelNumber.toLowerCase()) || (req.title + " " + (req.description ?? "")).toLowerCase().includes(p.modelNumber.toLowerCase());
    if (modelHit) evidence.push({ field: "model", value: p.modelNumber });
  }
  for (const a of p.attributes ?? []) {
    if ([...tokenize(`${a.key} ${a.value ?? ""}`)].some((t) => reqTokens.has(t))) {
      evidence.push({ field: `attribute:${a.key}`, value: [a.value, a.unit].filter(Boolean).join(" ") || a.key });
    }
  }

  // --- category alignment ---
  const categoryMatch = !!req.category && !!p.category && tokenize(req.category).size > 0 &&
    [...tokenize(p.category)].some((t) => tokenize(req.category!).has(t));
  if (categoryMatch) evidence.push({ field: "category", value: p.category! });

  // --- standards / certificate coverage ---
  const reqStd = (req.standards ?? []).map(normStandard).filter(Boolean);
  const prodStd = new Set((p.standards ?? []).map(normStandard).filter(Boolean));
  let stdCoverage = 1; // neutral when the requirement names no standards
  if (reqStd.length > 0) {
    let hit = 0;
    for (const s of reqStd) {
      if (prodStd.has(s)) hit++;
      else missingInfo.push(`Requirement references standard "${s.toUpperCase()}" not found on this product`);
    }
    stdCoverage = hit / reqStd.length;
    for (const s of p.standards ?? []) if (reqStd.includes(normStandard(s))) evidence.push({ field: "standard", value: s });
  }

  // --- optional semantic (precomputed cosine wins; else compute from embeddings) ---
  let semantic = 0;
  const embeddingsComparable = !!opts.requirementEmbedding && !!p.embedding && (opts.requirementEmbedding!.length === p.embedding!.length);
  const hasSemantic = p.semanticScore != null || embeddingsComparable;
  if (p.semanticScore != null) semantic = Math.max(0, Math.min(1, p.semanticScore));
  else if (embeddingsComparable) semantic = cosine(opts.requirementEmbedding!, p.embedding!);
  if (hasSemantic && semantic >= 0.75) evidence.push({ field: "semantic", value: `similarity ${semantic.toFixed(2)}` });

  // --- blend ---
  const semanticWeight = hasSemantic ? Math.max(0, Math.min(1, opts.semanticWeight ?? 0.4)) : 0;
  const lexical = 0.6 * coverage + 0.2 * (categoryMatch ? 1 : 0) + 0.2 * stdCoverage;
  let confidence = (1 - semanticWeight) * lexical + semanticWeight * semantic;
  confidence = Math.max(0, Math.min(1, confidence));

  // --- missing-information notes (assistive language only) ---
  if (!p.hasDatasheet) missingInfo.push("No datasheet/certificate linked - source evidence is limited");
  if (!p.attributes || p.attributes.length === 0) missingInfo.push("Product has no structured attributes to compare");
  if (confidence < 0.35) missingInfo.push("Low-confidence suggestion - needs review by your engineer");

  const rationale = evidence.length > 0
    ? `Matched on ${[...new Set(evidence.map((e) => e.field.split(":")[0]))].join(", ")}; needs review.`
    : "Weak lexical/semantic overlap only; needs review.";

  return { productId: p.id, confidence: Number(confidence.toFixed(3)), rationale, evidence, missingInfo };
}

export function rankMatches(req: RequirementInput, candidates: ProductCandidate[], opts: RankOptions = {}): MatchSuggestion[] {
  const reqTokens = tokenize(`${req.title} ${req.description ?? ""}`);
  const minConfidence = opts.minConfidence ?? 0.05;
  const limit = opts.limit ?? 10;
  return candidates
    .map((p) => scoreOne(req, reqTokens, p, opts))
    .filter((m) => m.confidence >= minConfidence)
    .sort((a, b) => b.confidence - a.confidence || a.productId.localeCompare(b.productId))
    .slice(0, limit);
}
