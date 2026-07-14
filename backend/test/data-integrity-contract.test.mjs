import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const risk = readFileSync(new URL("../src/risk/risk.service.ts", import.meta.url), "utf8");
const api = readFileSync(new URL("../src/api/api.service.ts", import.meta.url), "utf8");
const ingestion = readFileSync(new URL("../src/ingestion/ingestion.service.ts", import.meta.url), "utf8");
const migration = readFileSync(new URL("../../db/migrations/0019_security_hardening.sql", import.meta.url), "utf8");

test("risk reruns reactivate current flags and learning writes use the active-event conflict key", () => {
  assert.match(risk, /generation_job_id = excluded\.generation_job_id, is_active = true/);
  assert.match(risk, /set is_active = false[\s\S]*state = 'open'[\s\S]*not \(rule_key = any\(\$4::text\[\]\)\)/);
  assert.match(risk, /on conflict \(tenant_id, risk_flag_id\) where risk_flag_id is not null and opted_out = false/);
  assert.match(api, /on conflict \(tenant_id, risk_flag_id\) where risk_flag_id is not null and opted_out = false/g);
  assert.match(migration, /row_number\(\) over \(partition by tenant_id, risk_flag_id order by created_at desc, id desc\)/);
  assert.match(migration, /create unique index uq_learning_active_risk_flag/);
  assert.match(api, /\(\$3::boolean or rf\.is_active = true\)/);
});

test("manual product corrections survive catalogue re-ingestion", () => {
  assert.match(api, /datasheet_document_id, manually_reviewed\)[\s\S]*true\)/);
  assert.match(api, /manually_reviewed = manually_reviewed or \$7/);
  assert.match(ingestion, /from extracted_product_data extracted/);
  assert.match(ingestion, /name = case when manually_reviewed then name else \$2 end/);
  assert.match(ingestion, /category = case when manually_reviewed then category else coalesce\(\$3, category\) end/);
  assert.match(ingestion, /description = case when manually_reviewed then description else coalesce\(\$4, description\) end/);
});

test("uploads are size-bounded and the signed request binds content length", () => {
  assert.match(api, /MAX_UPLOAD_BYTES = 100 \* 1024 \* 1024/);
  assert.match(api, /if \(!size \|\| size > MAX_UPLOAD_BYTES\)/);
  assert.match(api, /requestedBucket !== bucket/);
  assert.match(api, /content-length;content-type;host/);
  assert.match(api, /requiredHeaders: \{ "content-length": String\(sizeBytes\)/);
});
