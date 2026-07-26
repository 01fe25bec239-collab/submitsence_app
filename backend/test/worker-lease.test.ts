import assert from "node:assert/strict";
import { setTimeout as wait } from "node:timers/promises";
import test from "node:test";
import type { Pool } from "pg";
import {
  claimJob,
  completeJob,
  createShutdownCoordinator,
  configuredLease,
  failJob,
  processClaimedJob,
  renewLease,
  run,
  runOnce,
  startHeartbeat,
  type ClaimedJob,
} from "../src/worker/worker";
import { createTaskProtection, protectionExpiryMinutes, type TaskProtection } from "../src/worker/task-protection";

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
  assert.equal(protectionExpiryMinutes({ leaseSeconds: 900, heartbeatMs: 60_000 }), 17);
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
  const running = run(idlePool, { idleMs: 60_000, claimSignal: idleController.signal, jobTypes: ["product_rematch"] });
  await wait(5);
  idleController.abort();
  await running;
});

test("task protection uses the ECS agent endpoint and verifies enable, renew, and removal", async () => {
  const requests: { url: string; body: Record<string, unknown> }[] = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    const body = JSON.parse(String(init?.body)) as { ProtectionEnabled: boolean };
    requests.push({ url: String(url), body });
    return new Response(JSON.stringify({ protection: { ProtectionEnabled: body.ProtectionEnabled } }), { status: 200 });
  };
  const protection = createTaskProtection(
    { leaseSeconds: 900, heartbeatMs: 60_000 },
    { agentUri: "http://ecs-agent", fetchImpl },
  );
  assert.equal(await protection.enable(), true);
  assert.equal(await protection.renew(), true);
  assert.equal(await protection.clear(10), true);
  assert.deepEqual(requests.map((request) => request.url), [
    "http://ecs-agent/task-protection/v1/state",
    "http://ecs-agent/task-protection/v1/state",
    "http://ecs-agent/task-protection/v1/state",
  ]);
  assert.deepEqual(requests.map((request) => request.body), [
    { ProtectionEnabled: true, ExpiresInMinutes: 17 },
    { ProtectionEnabled: true, ExpiresInMinutes: 17 },
    { ProtectionEnabled: false },
  ]);
});

test("hard-kill abort marks the lease lost without cancelling the active handler or writing terminal state", async () => {
  const controller = new AbortController();
  let completed = 0;
  let handlerReturned = false;
  const pool = {
    async query(sql: string) {
      if (sql.includes("complete_processing_job")) completed += 1;
      return { rows: [{ lease_expires_at: new Date(), completed: true }], rowCount: 1 };
    },
  } as unknown as Pool;
  const processing = processClaimedJob(
    pool,
    job,
    async () => {
      controller.abort();
      await wait(5);
      handlerReturned = true;
      return {};
    },
    { leaseSeconds: 900, heartbeatMs: 60_000 },
    controller.signal,
  );
  await processing;
  assert.equal(handlerReturned, true);
  assert.equal(completed, 0);
});

test("protection renewal failure requests drain but a valid database lease still reaches terminal state", async () => {
  let completed = 0;
  let drains = 0;
  const pool = {
    async query(sql: string) {
      if (sql.includes("heartbeat_processing_job")) return { rows: [{ lease_expires_at: new Date() }], rowCount: 1 };
      if (sql.includes("complete_processing_job")) completed += 1;
      return { rows: [{ completed: true }], rowCount: 1 };
    },
  } as unknown as Pool;
  const protection: TaskProtection = { enable: async () => true, renew: async () => false, clear: async () => true };
  await processClaimedJob(
    pool,
    job,
    async () => { await wait(15); return {}; },
    { leaseSeconds: 900, heartbeatMs: 5 },
    undefined,
    () => undefined,
    protection,
    () => { drains += 1; },
  );
  assert.ok(drains >= 1);
  assert.equal(completed, 1);
});

test("a max-three pool supports metrics, handler, and heartbeat; terminal completion needs no fourth connection", async () => {
  let active = 0;
  let maxActive = 0;
  let heartbeats = 0;
  let completions = 0;
  const acquire = () => {
    if (active >= 3) throw new Error("fourth connection requested");
    active += 1;
    maxActive = Math.max(maxActive, active);
    let released = false;
    return () => {
      if (!released) active -= 1;
      released = true;
    };
  };
  const pool = {
    async connect() {
      const release = acquire();
      return { release };
    },
    async query(sql: string) {
      const release = acquire();
      try {
        if (sql.includes("heartbeat_processing_job")) {
          heartbeats += 1;
          await wait(1);
          return { rows: [{ lease_expires_at: new Date() }], rowCount: 1 };
        }
        if (sql.includes("complete_processing_job")) {
          completions += 1;
          return { rows: [{ completed: true }], rowCount: 1 };
        }
        throw new Error(`unexpected query: ${sql}`);
      } finally {
        release();
      }
    },
  } as unknown as Pool;
  const metricsClient = await pool.connect();
  await processClaimedJob(
    pool,
    job,
    async (handlerPool) => {
      const handlerClient = await handlerPool.connect();
      await wait(18);
      handlerClient.release();
      return {};
    },
    { leaseSeconds: 900, heartbeatMs: 5 },
  );
  metricsClient.release();
  assert.ok(heartbeats >= 1);
  assert.equal(completions, 1);
  assert.equal(maxActive, 3);
  assert.equal(active, 0);
});

test("the first signal drains claims and metrics without hard-killing; a second signal hard-kills", () => {
  let deadline: (() => void) | undefined;
  let deadlineMs = 0;
  let hardKills = 0;
  const shutdown = createShutdownCoordinator(
    () => { hardKills += 1; },
    (callback, milliseconds) => {
      deadline = callback;
      deadlineMs = milliseconds;
      return { unref: () => undefined } as unknown as NodeJS.Timeout;
    },
  );
  assert.equal(shutdown.requestDrain(), true);
  assert.equal(shutdown.state(), "drainRequested");
  assert.equal(shutdown.claimController.signal.aborted, true);
  assert.equal(shutdown.metricsController.signal.aborted, true);
  assert.equal(shutdown.hardKillController.signal.aborted, false);
  assert.equal(deadlineMs, 110_000);
  shutdown.markDraining();
  assert.equal(shutdown.state(), "draining");
  assert.equal(shutdown.requestDrain(), false);
  assert.equal(shutdown.state(), "hardKilled");
  assert.equal(shutdown.hardKillController.signal.aborted, true);
  assert.equal(hardKills, 1);
  assert.ok(deadline);
});

test("a first signal during active work leaves the handler, heartbeat, and fenced terminal write alive", async () => {
  let heartbeats = 0;
  let completions = 0;
  const pool = {
    async query(sql: string) {
      if (sql.includes("heartbeat_processing_job")) {
        heartbeats += 1;
        return { rows: [{ lease_expires_at: new Date() }], rowCount: 1 };
      }
      if (sql.includes("complete_processing_job")) {
        completions += 1;
        return { rows: [{ completed: true }], rowCount: 1 };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  } as unknown as Pool;
  const shutdown = createShutdownCoordinator(
    () => undefined,
    () => ({ unref: () => undefined } as unknown as NodeJS.Timeout),
  );
  let handlerFinished = false;
  const processing = processClaimedJob(
    pool,
    job,
    async () => {
      await wait(18);
      handlerFinished = true;
      return {};
    },
    { leaseSeconds: 900, heartbeatMs: 5 },
    shutdown.hardKillController.signal,
  );
  await wait(2);
  shutdown.requestDrain();
  shutdown.markDraining();
  await processing;
  assert.equal(shutdown.claimController.signal.aborted, true);
  assert.equal(shutdown.metricsController.signal.aborted, true);
  assert.equal(shutdown.hardKillController.signal.aborted, false);
  assert.equal(handlerFinished, true);
  assert.ok(heartbeats >= 1);
  assert.equal(completions, 1);
});

test("the hard deadline follows the same hard-kill path", () => {
  let deadline: (() => void) | undefined;
  let hardKills = 0;
  const shutdown = createShutdownCoordinator(
    () => { hardKills += 1; },
    (callback) => {
      deadline = callback;
      return { unref: () => undefined } as unknown as NodeJS.Timeout;
    },
  );
  shutdown.requestDrain();
  deadline?.();
  assert.equal(shutdown.state(), "hardKilled");
  assert.equal(shutdown.hardKillController.signal.aborted, true);
  assert.equal(hardKills, 1);
});

test("a protection failure prevents claiming and a post-claim drain leaves the lease for expiry", async () => {
  let claims = 0;
  const noClaimPool = { query: async () => { claims += 1; return { rows: [], rowCount: 0 }; } } as unknown as Pool;
  const unavailable: TaskProtection = { enable: async () => false, renew: async () => true, clear: async () => true };
  assert.equal(await runOnce(noClaimPool, ["product_rematch"], { leaseSeconds: 900, heartbeatMs: 60_000 }, { protection: unavailable }), false);
  assert.equal(claims, 0);

  let emptyClears = 0;
  const order: string[] = [];
  const orderedEmptyPool = { query: async () => { order.push("claim"); return { rows: [], rowCount: 0 }; } } as unknown as Pool;
  const emptyProtection: TaskProtection = {
    enable: async () => { order.push("protect"); return true; },
    renew: async () => true,
    clear: async () => { order.push("clear"); emptyClears += 1; return true; },
  };
  assert.equal(await runOnce(orderedEmptyPool, ["product_rematch"], { leaseSeconds: 900, heartbeatMs: 60_000 }, { protection: emptyProtection }), false);
  assert.equal(emptyClears, 1);
  assert.deepEqual(order, ["protect", "claim", "clear"]);

  let draining = false;
  let terminalWrites = 0;
  let clears = 0;
  const racePool = {
    async query(sql: string) {
      if (sql.includes("claim_next_job")) {
        draining = true;
        return { rows: [job], rowCount: 1 };
      }
      terminalWrites += 1;
      return { rows: [], rowCount: 0 };
    },
  } as unknown as Pool;
  const protection: TaskProtection = {
    enable: async () => true,
    renew: async () => true,
    clear: async () => { clears += 1; return true; },
  };
  assert.equal(await runOnce(
    racePool,
    ["product_rematch"],
    { leaseSeconds: 900, heartbeatMs: 60_000 },
    { protection, drainRequested: () => draining },
  ), false);
  assert.equal(terminalWrites, 0);
  assert.equal(clears, 1);

  let removalDrains = 0;
  const emptyPool = { query: async () => ({ rows: [], rowCount: 0 }) } as unknown as Pool;
  const stuckProtection: TaskProtection = { enable: async () => true, renew: async () => true, clear: async () => false };
  await assert.rejects(
    runOnce(emptyPool, ["product_rematch"], { leaseSeconds: 900, heartbeatMs: 60_000 }, {
      protection: stuckProtection,
      onProtectionFailure: () => { removalDrains += 1; },
    }),
    /task protection could not be removed/,
  );
  assert.equal(removalDrains, 1);
});
