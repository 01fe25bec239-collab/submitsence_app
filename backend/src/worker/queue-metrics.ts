import {
  PutMetricDataCommand,
  type CloudWatchClient,
  type Dimension,
  type MetricDatum,
} from "@aws-sdk/client-cloudwatch";
import type { Pool, PoolClient } from "pg";
import { processingJobRegistry, type SupportedProcessingJobType } from "../job-types";

export const QUEUE_METRICS_NAMESPACE = "SubmitSense/Jobs";
export const QUEUE_METRICS_LOCK = [1398096461, 7] as const;
export const QUEUE_METRICS_RETRY_MS = 10_000;
export const QUEUE_METRICS_PUBLISH_MS = 60_000;
export const QUEUE_METRICS_TIMEOUT_MS = 10_000;

export type QueueMetricRow = {
  job_type: string;
  queue_depth: number | string;
  oldest_eligible_created_at: Date | string | null;
  observed_at: Date | string;
};

type QueueMetricsOptions = {
  environment: string;
  signal: AbortSignal;
  retryMs?: number;
  publishMs?: number;
  timeoutMs?: number;
  warn?: (message: string, error?: unknown) => void;
};

const jobTypes = [...processingJobRegistry.asynchronous];

export function validateDimensions(dimensions: Dimension[]): void {
  const keys = dimensions.map(({ Name }) => Name);
  const valid = keys.length === 1 && keys[0] === "Environment"
    || keys.length === 2 && keys[0] === "Environment" && keys[1] === "JobType";
  if (!valid) throw new Error(`unsupported queue metric dimensions: ${keys.join(",")}`);
}

function dimensions(environment: string, jobType?: SupportedProcessingJobType): Dimension[] {
  const value = [{ Name: "Environment", Value: environment }];
  if (jobType) value.push({ Name: "JobType", Value: jobType });
  validateDimensions(value);
  return value;
}

function ageSeconds(observedAt: Date, createdAt: Date | string | null): number {
  return createdAt === null ? 0 : Math.max(0, (observedAt.getTime() - new Date(createdAt).getTime()) / 1000);
}

export function buildQueueMetricData(
  environment: string,
  rows: QueueMetricRow[],
  supportedTypes: readonly SupportedProcessingJobType[] = jobTypes,
): MetricDatum[] {
  if (!environment) throw new Error("ENVIRONMENT is required for queue metrics");
  if (!rows.length) throw new Error("queue metrics snapshot returned no rows");

  const observedAt = new Date(rows[0].observed_at);
  if (!Number.isFinite(observedAt.getTime())) throw new Error("invalid queue metrics observed_at");
  const byType = new Map<string, QueueMetricRow>();
  for (const row of rows) {
    if (!supportedTypes.includes(row.job_type as SupportedProcessingJobType)) throw new Error(`unexpected queue metric job type: ${row.job_type}`);
    if (byType.has(row.job_type)) throw new Error(`duplicate queue metric job type: ${row.job_type}`);
    if (new Date(row.observed_at).getTime() !== observedAt.getTime()) throw new Error("queue metric snapshot timestamps differ");
    byType.set(row.job_type, row);
  }

  const perType = supportedTypes.map((jobType) => {
    const row = byType.get(jobType);
    const depth = Number(row?.queue_depth ?? 0);
    if (!Number.isSafeInteger(depth) || depth < 0) throw new Error(`invalid queue depth for ${jobType}`);
    return { jobType, depth, oldest: row?.oldest_eligible_created_at ?? null };
  });
  const globalDepth = perType.reduce((sum, row) => sum + row.depth, 0);
  const globalOldest = perType.reduce<Date | null>((oldest, row) => {
    if (row.oldest === null) return oldest;
    const created = new Date(row.oldest);
    return oldest === null || created < oldest ? created : oldest;
  }, null);
  const datum = (MetricName: "QueueDepth" | "OldestJobAgeSeconds", Value: number, Dimensions: Dimension[], Unit: "Count" | "Seconds"): MetricDatum => ({
    MetricName, Value, Dimensions, Unit, Timestamp: observedAt,
  });

  return [
    datum("QueueDepth", globalDepth, dimensions(environment), "Count"),
    datum("OldestJobAgeSeconds", ageSeconds(observedAt, globalOldest), dimensions(environment), "Seconds"),
    ...perType.flatMap(({ jobType, depth, oldest }) => [
      datum("QueueDepth", depth, dimensions(environment, jobType), "Count"),
      datum("OldestJobAgeSeconds", ageSeconds(observedAt, oldest), dimensions(environment, jobType), "Seconds"),
    ]),
  ];
}

async function readQueueMetrics(client: PoolClient): Promise<QueueMetricRow[]> {
  await client.query("begin read only");
  try {
    const result = await client.query<QueueMetricRow>("select * from app.processing_queue_metrics($1::text[])", [jobTypes]);
    await client.query("commit");
    return result.rows;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  }
}

function wait(ms: number, signal: AbortSignal, wake?: Promise<void>): Promise<"timer" | "abort" | "wake"> {
  if (signal.aborted) return Promise.resolve("abort");
  return new Promise((resolve) => {
    let settled = false;
    const finish = (reason: "timer" | "abort" | "wake") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", aborted);
      resolve(reason);
    };
    const aborted = () => finish("abort");
    const timer = setTimeout(() => finish("timer"), ms);
    timer.unref();
    signal.addEventListener("abort", aborted, { once: true });
    wake?.then(() => finish("wake"));
  });
}

function errorValue(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

async function releaseLeader(client: PoolClient, connectionError?: Error): Promise<void> {
  if (connectionError) {
    client.release(connectionError);
    return;
  }
  try {
    const result = await client.query<{ unlocked: boolean }>(
      "select pg_advisory_unlock($1, $2) as unlocked",
      [...QUEUE_METRICS_LOCK],
    );
    if (result.rows[0]?.unlocked !== true) throw new Error("queue metrics advisory unlock failed");
    client.release();
  } catch (error) {
    client.release(errorValue(error));
  }
}

export async function runQueueMetrics(pool: Pool, cloudwatch: CloudWatchClient, options: QueueMetricsOptions): Promise<void> {
  const warn = options.warn ?? ((message, error) => console.warn(message, error));
  const retryMs = options.retryMs ?? QUEUE_METRICS_RETRY_MS;
  const publishMs = options.publishMs ?? QUEUE_METRICS_PUBLISH_MS;
  const timeoutMs = options.timeoutMs ?? QUEUE_METRICS_TIMEOUT_MS;

  try {
    while (!options.signal.aborted) {
      let client: PoolClient;
      try {
        client = await pool.connect();
      } catch (error) {
        warn("[queue-metrics] leadership probe connection failed", error);
        await wait(retryMs, options.signal);
        continue;
      }
      if (options.signal.aborted) {
        client.release();
        break;
      }

      let acquired = false;
      try {
        const result = await client.query<{ acquired: boolean }>(
          "select pg_try_advisory_lock($1, $2) as acquired",
          [...QUEUE_METRICS_LOCK],
        );
        acquired = result.rows[0]?.acquired === true;
      } catch (error) {
        client.release(errorValue(error));
        warn("[queue-metrics] leadership probe failed", error);
        await wait(retryMs, options.signal);
        continue;
      }
      if (!acquired) {
        client.release();
        await wait(retryMs, options.signal);
        continue;
      }

      let connectionError: Error | undefined;
      let loseLeadership!: () => void;
      const leadershipLost = new Promise<void>((resolve) => { loseLeadership = resolve; });
      const onConnectionError = (error: Error) => {
        connectionError = error;
        loseLeadership();
      };
      client.once("error", onConnectionError);

      while (!options.signal.aborted && !connectionError) {
        let rows: QueueMetricRow[];
        try {
          rows = await readQueueMetrics(client);
        } catch (error) {
          connectionError = errorValue(error);
          warn("[queue-metrics] database snapshot failed; leadership relinquished", error);
          break;
        }
        if (options.signal.aborted) break;

        try {
          await cloudwatch.send(
            new PutMetricDataCommand({ Namespace: QUEUE_METRICS_NAMESPACE, MetricData: buildQueueMetricData(options.environment, rows) }),
            { abortSignal: AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)]) },
          );
        } catch (error) {
          warn("[queue-metrics] CloudWatch publication failed", error);
        }
        if (options.signal.aborted || connectionError) break;
        if (await wait(publishMs, options.signal, leadershipLost) !== "timer") break;
      }

      client.removeListener("error", onConnectionError);
      await releaseLeader(client, connectionError);
      if (!options.signal.aborted) await wait(retryMs, options.signal);
    }
  } catch (error) {
    warn("[queue-metrics] loop stopped after an isolated failure", error);
  }
}
