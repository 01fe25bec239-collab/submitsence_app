import assert from "node:assert/strict";
import test from "node:test";
import { configuredJobTypes } from "../src/worker/worker";

test("worker services claim only their configured job types", () => {
  assert.deepEqual(configuredJobTypes(" ingest_vendor_catalogue, product_rematch "), ["ingest_vendor_catalogue", "product_rematch"]);
});
