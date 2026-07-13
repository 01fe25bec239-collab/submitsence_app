import assert from "node:assert/strict";
import { test } from "node:test";
import { extractStandards, getExtractor } from "../src/ingestion/extraction";
import { getEmbedder, EMBEDDING_DIM } from "../src/ingestion/embedder";

test("extractStandards finds AS / AS-NZS / ISO codes and dedups", () => {
  const found = extractStandards("Pump complies with AS 2941, AS/NZS 3000 and ISO 9001. Also AS2941 again.");
  assert.deepEqual(found, ["AS 2941", "AS/NZS 3000", "ISO 9001"]);
});

test("structured extractor maps catalogue rows to products with attributes + standards", async () => {
  const { products } = await getExtractor().extract({
    mimeType: "text/csv",
    rows: [
      { Vendor: "Acme", Product: "Diesel fire pump", Model: "FBP-20", Category: "product_data", Flow: "20 L/s", Standard: "AS 2941" },
      { Vendor: "Acme", "Product Name": "Brass valve", "Part Number": "BV-50", Size: "50mm" },
      { Product: "orphan with no vendor" }, // dropped: needs vendor + name
    ],
  });
  assert.equal(products.length, 2);
  const pump = products[0];
  assert.equal(pump.vendorName, "Acme");
  assert.equal(pump.name, "Diesel fire pump");
  assert.equal(pump.modelNumber, "FBP-20");
  assert.ok(pump.attributes.some((a) => a.key === "Flow" && a.value === "20 L/s"));
  assert.ok(pump.standards.includes("AS 2941"));
  assert.equal(products[1].modelNumber, "BV-50"); // "Part Number" alias
});

test("PDF/text-only catalogue is unsupported by the default extractor (OCR provider gap), not a silent success", async () => {
  const res = await getExtractor().extract({ mimeType: "application/pdf", text: "scanned catalogue text" });
  assert.equal(res.products.length, 0);
  assert.match(res.unsupportedReason ?? "", /OCR|provider/i);
});

test("default embedder returns an L2-normalised vector of the pgvector dimension", async () => {
  const vec = await getEmbedder().embed("diesel fire booster pump AS 2941");
  assert.equal(vec.length, EMBEDDING_DIM);
  const norm = Math.sqrt(vec.reduce((s, x) => s + x * x, 0));
  assert.ok(Math.abs(norm - 1) < 1e-6);
});
