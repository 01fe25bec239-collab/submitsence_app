import assert from "node:assert/strict";
import { setTimeout as wait } from "node:timers/promises";
import test from "node:test";
import type { Pool } from "pg";
import {
  claimJob,
  completeJob,
  configuredLease,
  failJob,
  processClaimedJob,
  renewLease,
  run,
  startHeartbeat,
  type ClaimedJob,
} from "../src/worker/worker";

const token = "10000000-0000-4000-8000-000000000010";
const job: ClaimedJob = {
  id: "10000000-0000-4000-8000-000000000011",
  tenant_id: "10000000-0000-4000-8000-000000000012",
  job_type: "product_rematch",
  document_id: null,
  worker_output: {},
  lease_token: token,
  lease_expires_at: "2030-01-01T00:15:00.000Z",
};

test("lease configuration keeps heartbeats comfortably inside the bounded lease", () => {
  assert.deepEqual(configuredLease({}), { leaseSeconds: 900, heartbeatMs: 60_000 });
  assert.deepEqual(configuredLease({ WORKER_LEASE_SECONDS: "300", WORKER_HEARTBEAT_MS: "50000" }), { leaseSeconds: 300, heartbeatMs: 50_000 });
  assert.throws(() => configuredLease({ WORKER_LEASE_SECONDS: "29" }), /between 30 and 3600/);
  assert.throws(() => configuredLease({ WORKER_LEASE_SECONDS: "300", WORKER_HEARTBEAT_MS: "100001" }), /one third/);
});

test("the claim token is retained through fenced success completion", async () => {
  const calls: { sql: string; values?: unknown[] }[] = [];
  const pool = {
    async query(sql: string, values?: unknown[]) {
      calls.push({ sql, values });
      if (sql.includes("claim_next_job")) return { rows: [job], rowCount: 1 };
      if (sql.includes("complete_processing_job")) return { rows: [{ completed: true }], rowCount: 1 };
      throw new Error(`unexpected query: ${sql}`);
    },
  } as unknown as Pool;

  const claimed = await claimJob(pool, ["product_rematch"], 900);
  assert.equal(claimed?.lease_token, token);
  await processClaimedJob(pool, claimed!, async () => ({ matched: 1 }), { leaseSeconds: 900, heartbeatMs: 60_000 });
  const completion = calls.find((call) => call.sql.includes("complete_processing_job"));
  assert.deepEqual(completion?.values, [job.id, token, JSON.stringify({ matched: 1 })]);
});

test("missing tokens cannot renew, complete, or fail a job", async () => {
  let queries = 0;
  const pool = { query: async () => { queries += 1; return { rows: [], rowCount: 0 }; } } as unknown as Pool;
  const missing = { ...job, lease_token: null };
  assert.equal(await renewLease(pool, missing, 900), null);
  assert.equal(await completeJob(pool, missing, {}), false);
  assert.equal(await failJob(pool, missing, "no token"), null);
  assert.equal(queries, 0);
});

test("failure is fenced by token and consumes the database retry schedule result", async () => {
  let values: unknown[] | undefined;
  const nextAttempt = "2030-01-01T00:00:30.000Z";
  const pool = {
    async query(_sql: string, input?: unknown[]) {
      values = input;
      return { rows: [{ status: "retrying", next_attempt_at: nextAttempt }], rowCount: 1 };
    },
  } as unknown as Pool;
  assert.deepEqual(await failJob(pool, job, "dependency unavailable"), { status: "retrying", next_attempt_at: nextAttempt });
  assert.deepEqual(values, [job.id, token, "dependency unavailable"]);
});

test("heartbeat renews periodically, stops cleanly, and treats replacement as lease loss", async () => {
  let renewals = 0;
  const pool = {
    async query() {
      renewals += 1;
      return { rows: renewals === 1 ? [{ lease_expires_at: new Date() }] : [], rowCount: renewals === 1 ? 1 : 0 };
    },
  } as unknown as Pool;
  const warnings: string[] = [];
  const heartbeat = startHeartbeat(pool, job, { leaseSeconds: 900, heartbeatMs: 5 }, undefined, (message) => warnings.push(message));
  await wait(25);
  await heartbeat.stop();
  const stoppedAt = renewals;
  await wait(15);
  assert.equal(heartbeat.lost(), true);
  assert.equal(renewals, stoppedAt);
  assert.match(warnings[0], /lost lease/);
  assert.doesNotMatch(warnings[0], new RegExp(token));
});

test("a lost lease prevents terminal writes after the handler returns", async () => {
  let completions = 0;
  const pool = {
    async query(sql: string) {
      if (sql.includes("heartbeat_processing_job")) return { rows: [], rowCount: 0 };
      if (sql.includes("complete_processing_job")) completions += 1;
      return { rows: [{ completed: true }], rowCount: 1 };
    },
  } as unknown as Pool;
  await processClaimedJob(
    pool,
    job,
    async () => { await wait(20); return { shouldNotPersist: true }; },
    { leaseSeconds: 900, heartbeatMs: 5 },
    undefined,
    () => undefined,
  );
  assert.equal(completions, 0);
});

test("abort stops heartbeat and idle timers used by SIGINT/SIGTERM cleanup", async () => {
  const controller = new AbortController();
  let renewals = 0;
  const heartbeatPool = { query: async () => { renewals += 1; return { rows: [{ lease_expires_at: new Date() }], rowCount: 1 }; } } as unknown as Pool;
  const heartbeat = startHeartbeat(heartbeatPool, job, { leaseSeconds: 900, heartbeatMs: 5 }, controller.signal);
  await wait(12);
  controller.abort();
  await heartbeat.stop();
  const stoppedAt = renewals;
  await wait(12);
  assert.equal(renewals, stoppedAt);
  assert.equal(heartbeat.lost(), true);

  const idleController = new AbortController();
  const idlePool = { query: async () => ({ rows: [], rowCount: 0 }) } as unknown as Pool;
  const running = run(idlePool, { idleMs: 60_000, signal: idleController.signal, jobTypes: ["product_rematch"] });
  await wait(5);
  idleController.abort();
  await running;
});
