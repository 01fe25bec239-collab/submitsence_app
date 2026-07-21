import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { validStripeSignature } from "../src/billing/stripe";

test("Stripe signatures require the raw body and reject replay outside five minutes", () => {
  const raw = Buffer.from('{"id":"evt_1"}');
  const secret = "whsec_test";
  const timestamp = 1_700_000_000;
  const signature = createHmac("sha256", secret).update(`${timestamp}.`).update(raw).digest("hex");
  const header = `t=${timestamp},v1=${signature}`;
  assert.equal(validStripeSignature(raw, header, secret, timestamp * 1000), true);
  assert.equal(validStripeSignature(raw, `t=${timestamp},v1=00,v1=${signature}`, secret, timestamp * 1000), true);
  assert.equal(validStripeSignature(Buffer.from("changed"), header, secret, timestamp * 1000), false);
  assert.equal(validStripeSignature(raw, header, secret, (timestamp + 301) * 1000), false);
});

test("commercial schema owns trial, GST, webhook, and content safety guardrails", () => {
  const sql = readFileSync(new URL("../../db/migrations/0021_commercial_content.sql", import.meta.url), "utf8");
  assert.match(sql, /trial worksection limit reached/);
  assert.match(sql, /unique \(provider, provider_event_id\)/);
  assert.match(sql, /contains_natspec_text = false and original_wording_confirmed = true/);
  assert.match(sql, /tax_inclusive boolean not null default true/);
  assert.match(sql, /plan_public_read on plans for select using \(true\)/);
});
