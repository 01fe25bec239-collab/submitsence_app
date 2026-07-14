import assert from "node:assert/strict";
import test from "node:test";
import { uuid } from "../src/auth/validation";

test("UUID validation accepts canonical values stored by PostgreSQL", () => {
  assert.equal(uuid("55555555-5555-5555-5555-555555555555", "projectId"), "55555555-5555-5555-5555-555555555555");
  assert.throws(() => uuid("not-a-uuid", "projectId"), /projectId must be a UUID/);
});
