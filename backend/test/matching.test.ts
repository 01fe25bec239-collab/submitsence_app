import assert from "node:assert/strict";
import { test } from "node:test";
import { rankMatches, type ProductCandidate, type RequirementInput } from "../src/matching/scoring";

const requirement: RequirementInput = {
  id: "req-1",
  title: "Fire hydrant booster pump set",
  description: "Diesel driven fire pump, 1851 compliant, 20 L/s at 700 kPa",
  category: "product_data",
  standards: ["AS 2941"],
};

const tenantAProducts: ProductCandidate[] = [
  {
    id: "p-pump",
    name: "Diesel fire booster pump",
    modelNumber: "FBP-20-700",
    category: "product_data",
    description: "Diesel driven booster pump set",
    attributes: [{ key: "flow", value: "20", unit: "L/s" }, { key: "pressure", value: "700", unit: "kPa" }],
    standards: ["AS 2941"],
    hasDatasheet: true,
  },
  {
    id: "p-valve",
    name: "Brass isolation valve",
    modelNumber: "BV-50",
    category: "product_data",
    description: "Brass gate valve",
    attributes: [{ key: "size", value: "50", unit: "mm" }],
    standards: [],
    hasDatasheet: false,
  },
];

test("ranks the relevant product above the irrelevant one", () => {
  const results = rankMatches(requirement, tenantAProducts);
  assert.equal(results[0].productId, "p-pump");
  assert.ok(results[0].confidence > results[1]?.confidence ?? 0);
});

test("every suggestion carries source-cited evidence, never invented claims", () => {
  const [top] = rankMatches(requirement, tenantAProducts);
  assert.ok(top.evidence.length > 0);
  // evidence values must be echoes of the candidate's own fields
  const pump = tenantAProducts[0];
  const known = new Set([pump.name, pump.modelNumber, pump.category, "20 L/s", "700 kPa", "AS 2941"]);
  for (const e of top.evidence) {
    if (e.field === "semantic") continue;
    assert.ok([...known].some((k) => k && e.value.includes(String(k).split(" ")[0])), `evidence ${JSON.stringify(e)} not sourced from candidate`);
  }
});

test("flags a missing standard the requirement asked for", () => {
  const req: RequirementInput = { ...requirement, standards: ["AS 1668"] };
  const [top] = rankMatches(req, tenantAProducts);
  assert.ok(top.missingInfo.some((m) => m.includes("1668")));
});

test("confidence stays in [0,1] and never asserts approval", () => {
  for (const m of rankMatches(requirement, tenantAProducts)) {
    assert.ok(m.confidence >= 0 && m.confidence <= 1);
    assert.doesNotMatch(m.rationale, /certified|guaranteed|approved|compliant/i);
  }
});

test("cross-tenant candidates are simply not passed in - ranking only sees what it is given", () => {
  // The service layer scopes candidates to one tenant (RLS + SQL). Prove the pure core
  // returns nothing for an empty candidate set: no tenant B leakage is possible here.
  assert.deepEqual(rankMatches(requirement, []), []);
});

test("semantic similarity lifts a lexically-thin but embedding-close product", () => {
  const thin: ProductCandidate = { id: "p-emb", name: "Model X pump unit", embedding: [1, 0, 0], hasDatasheet: true, attributes: [{ key: "k", value: "v" }] };
  const far: ProductCandidate = { id: "p-far", name: "Unrelated widget", embedding: [0, 1, 0], hasDatasheet: true, attributes: [{ key: "k", value: "v" }] };
  const results = rankMatches(requirement, [thin, far], { requirementEmbedding: [1, 0, 0], semanticWeight: 0.6 });
  assert.equal(results[0].productId, "p-emb");
});
