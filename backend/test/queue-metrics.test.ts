import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import type { CloudWatchClient, PutMetricDataCommand } from "@aws-sdk/client-cloudwatch";
import type { Pool, PoolClient } from "pg";
import { processingJobRegistry } from "../src/job-types";
import {
  QUEUE_METRICS_LOCK,
  QUEUE_METRICS_NAMESPACE,
  buildQueueMetricData,
  runQueueMetrics,
  validateDimensions,
  type QueueMetricRow,
} from "../src/worker/queue-metrics";

const observedAt = new Date("2030-01-01T00:00:00.000Z");
const rows: QueueMetricRow[] = processingJobRegistry.asynchronous.map((job_type, index) => ({
  job_type,
  queue_depth: index === 0 ? "2" : 0,
  oldest_eligible_created_at: index === 0 ? "2029-12-31T23:58:30.000Z" : null,
  observed_at: observedAt,
}));

test("builds the exact 24-datapoint global and per-type payload", () => {
  const data = buildQueueMetricData("staging", rows);
  assert.equal(data.length, 24);
  assert.deepEqual(data.slice(0, 2).map(({ MetricName, Value, Unit }) => ({ MetricName, Value, Unit })), [
    { MetricName: "QueueDepth", Value: 2, Unit: "Count" },
    { MetricName: "OldestJobAgeSeconds", Value: 90, Unit: "Seconds" },
  ]);
  assert.ok(data.every((datum) => datum.Timestamp?.getTime() === observedAt.getTime()));
  assert.equal(data.filter((datum) => datum.Dimensions?.length === 1).length, 2);
  assert.equal(data.filter((datum) => datum.Dimensions?.length === 2).length, 22);
  assert.deepEqual(
    data.filter((datum) => datum.Dimensions?.length === 2).map((datum) => datum.Dimensions?.[1].Value),
    processingJobRegistry.asynchronous.flatMap((jobType) => [jobType, jobType]),
  );
});

test("emits explicit zeros and clamps clock-skewed ages to zero", () => {
  const skewed = rows.map((row, index) => ({
    ...row,
    queue_depth: 0,
    oldest_eligible_created_at: index === 0 ? "2030-01-01T00:00:01.000Z" : null,
  }));
  const data = buildQueueMetricData("staging", skewed);
  assert.ok(data.every(({ Value }) => Value === 0));
});

test("rejects unexpected dimension keys and job types", () => {
  assert.throws(() => validateDimensions([{ Name: "TenantId", Value: "secret" }]), /unsupported/);
  assert.throws(() => validateDimensions([
    { Name: "Environment", Value: "staging" },
    { Name: "Worker", Value: "one" },
  ]), /unsupported/);
  assert.throws(() => buildQueueMetricData("staging", [{ ...rows[0], job_type: "package_draft" }]), /unexpected/);
});

class FakeClient extends EventEmitter {
  readonly events: string[];
  readonly acquired: boolean;
  metricRows: QueueMetricRow[] = rows;
  failSnapshot = false;
  failUnlock = false;
  releasedWith: Error | undefined;

  constructor(events: string[], acquired = true) {
    super();
    this.events = events;
    this.acquired = acquired;
  }

  async query(sql: string, values?: unknown[]) {
    if (sql.includes("pg_try_advisory_lock")) {
      this.events.push("probe");
      assert.deepEqual(values, [...QUEUE_METRICS_LOCK]);
      return { rows: [{ acquired: this.acquired }], rowCount: 1 };
    }
    if (sql === "begin read only") {
      this.events.push("begin");
      return { rows: [], rowCount: null };
    }
    if (sql.includes("processing_queue_metrics")) {
      this.events.push("snapshot");
      assert.deepEqual(values, [[...processingJobRegistry.asynchronous]]);
      if (this.failSnapshot) throw new Error("database connection lost");
      return { rows: this.metricRows, rowCount: this.metricRows.length };
    }
    if (sql === "commit" || sql === "rollback") {
      this.events.push(sql);
      return { rows: [], rowCount: null };
    }
    if (sql.includes("pg_advisory_unlock")) {
      this.events.push("unlock");
      if (this.failUnlock) throw new Error("unlock connection failure");
      return { rows: [{ unlocked: true }], rowCount: 1 };
    }
    throw new Error(`unexpected query: ${sql}`);
  }

  release(error?: Error) {
    this.releasedWith = error;
    this.events.push(error ? "release-error" : "release");
  }
}

function poolOf(...clients: FakeClient[]): Pool {
  let index = 0;
  return { connect: async () => clients[Math.min(index++, clients.length - 1)] as unknown as PoolClient } as unknown as Pool;
}

function cloudwatch(send: (command: PutMetricDataCommand, options?: { abortSignal?: AbortSignal }) => Promise<unknown>): CloudWatchClient {
  return { send } as unknown as CloudWatchClient;
}

test("leader publishes immediately, uses one request, then unlocks before normal release", async () => {
  const events: string[] = [];
  const client = new FakeClient(events);
  const controller = new AbortController();
  let command: PutMetricDataCommand | undefined;
  await runQueueMetrics(poolOf(client), cloudwatch(async (input, options) => {
    command = input;
    events.push("send");
    assert.equal(options?.abortSignal?.aborted, false);
    controller.abort();
    return {};
  }), { environment: "staging", signal: controller.signal, retryMs: 1, publishMs: 1 });

  assert.equal(command?.input.Namespace, QUEUE_METRICS_NAMESPACE);
  assert.equal(command?.input.MetricData?.length, 24);
  assert.deepEqual(events, ["probe", "begin", "snapshot", "commit", "send", "unlock", "release"]);
});

test("CloudWatch rejection and timeout remain non-fatal and abort publication", async () => {
  for (const mode of ["reject", "timeout"] as const) {
    const events: string[] = [];
    const warnings: string[] = [];
    const client = new FakeClient(events);
    const controller = new AbortController();
    await runQueueMetrics(poolOf(client), cloudwatch(async (_command, options) => {
      if (mode === "reject") throw new Error("CloudWatch rejected");
      await new Promise<void>((_resolve, reject) => options?.abortSignal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
    }), {
      environment: "staging",
      signal: controller.signal,
      publishMs: 60_000,
      timeoutMs: 5,
      warn: (message) => {
        warnings.push(message);
        if (message.includes("CloudWatch")) controller.abort();
      },
    });
    assert.ok(warnings.some((message) => message.includes("CloudWatch publication failed")));
    assert.deepEqual(events.slice(-2), ["unlock", "release"]);
  }
});

test("shared abort cancels an in-flight publication", async () => {
  const client = new FakeClient([]);
  const controller = new AbortController();
  let publicationAborted = false;
  await runQueueMetrics(poolOf(client), cloudwatch(async (_command, options) => {
    setImmediate(() => controller.abort());
    await new Promise<void>((_resolve, reject) => options?.abortSignal?.addEventListener("abort", () => {
      publicationAborted = true;
      reject(new Error("aborted"));
    }, { once: true }));
  }), { environment: "staging", signal: controller.signal, warn: () => undefined });
  assert.equal(publicationAborted, true);
});

test("non-leaders release probe clients and retry until abort", async () => {
  const events: string[] = [];
  const first = new FakeClient(events, false);
  const second = new FakeClient(events, false);
  const controller = new AbortController();
  const pool = poolOf(first, second);
  setTimeout(() => controller.abort(), 12);
  await runQueueMetrics(pool, cloudwatch(async () => assert.fail("non-leader published")), {
    environment: "staging", signal: controller.signal, retryMs: 5,
  });
  assert.ok(events.filter((event) => event === "probe").length >= 2);
  assert.equal(events.filter((event) => event === "release").length, events.filter((event) => event === "probe").length);
});

test("connection loss discards the leader and hands over to a new session", async () => {
  const events: string[] = [];
  const first = new FakeClient(events);
  const second = new FakeClient(events);
  const controller = new AbortController();
  let sends = 0;
  await runQueueMetrics(poolOf(first, second), cloudwatch(async () => {
    sends += 1;
    if (sends === 1) setImmediate(() => first.emit("error", new Error("socket lost")));
    else controller.abort();
    return {};
  }), { environment: "staging", signal: controller.signal, retryMs: 1, publishMs: 60_000 });
  assert.equal(sends, 2);
  assert.match(first.releasedWith?.message ?? "", /socket lost/);
  assert.deepEqual(events.slice(-2), ["unlock", "release"]);
});

test("database and unlock failures discard the pinned client without rejecting", async () => {
  for (const failure of ["snapshot", "unlock"] as const) {
    const client = new FakeClient([]);
    if (failure === "snapshot") client.failSnapshot = true;
    else client.failUnlock = true;
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 8);
    await runQueueMetrics(poolOf(client), cloudwatch(async () => ({})), {
      environment: "staging", signal: controller.signal, retryMs: 60_000, warn: () => undefined,
    });
    assert.ok(client.releasedWith instanceof Error);
  }
});

test("worker owns and awaits metrics teardown before CloudWatch destroy and pool.end", () => {
  const source = readFileSync(new URL("../src/worker/worker.ts", import.meta.url), "utf8");
  const awaitBoth = source.indexOf("await Promise.all([worker, metrics])");
  const destroy = source.indexOf("cloudwatch.destroy()", awaitBoth);
  const poolEnd = source.indexOf("await pool.end()", destroy);
  assert.ok(awaitBoth > 0 && destroy > awaitBoth && poolEnd > destroy);
  assert.doesNotMatch(source, /runQueueMetrics\([^;]+\);\s*run\(/s);
});

test("abortable leadership waits leave no delayed work", async () => {
  const events: string[] = [];
  const client = new FakeClient(events, false);
  const controller = new AbortController();
  const running = runQueueMetrics(poolOf(client), cloudwatch(async () => ({})), {
    environment: "staging", signal: controller.signal, retryMs: 60_000,
  });
  await delay(2);
  controller.abort();
  await running;
  const count = events.length;
  await delay(10);
  assert.equal(events.length, count);
});
