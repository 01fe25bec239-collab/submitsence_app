import type { Pool, PoolClient } from "pg";
import { createPool } from "../db.module";
import { withTenantClient } from "../db/tenant-db";
import { ingestCatalogue } from "../ingestion/ingestion.service";
import { isSupportedProcessingJobType, processingJobRegistry, type SupportedProcessingJobType } from "../job-types";
import { computeAndStoreMatches } from "../matching/matching.service";
import { markPackageJobFailed, processPackageJob } from "../package/package.service";
import { generateRfiDraft, runRiskPrecheck } from "../risk/risk.service";

// B6-B7 background worker. Uses processing_jobs, the sole active asynchronous queue. Loop: claim one job cross-tenant via the
// SECURITY DEFINER claimer (0022), then process inside tenant scope as actor 'system'. Lease
// renewal and terminal ledger writes return through narrow token-fenced database functions.
//
export type ClaimedJob = {
  id: string;
  tenant_id: string;
  job_type: SupportedProcessingJobType;
  document_id: string | null;
  worker_output: Record<string, unknown> | null;
  lease_token: string | null;
  lease_expires_at: Date | string | null;
};

export type WorkerLeaseConfig = { leaseSeconds: number; heartbeatMs: number };
const DEFAULT_LEASE_SECONDS = 15 * 60;
const DEFAULT_HEARTBEAT_MS = 60 * 1000;

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

export function configuredLease(value: Partial<Record<"WORKER_LEASE_SECONDS" | "WORKER_HEARTBEAT_MS", string>> = process.env): WorkerLeaseConfig {
  const leaseSeconds = positiveInteger(value.WORKER_LEASE_SECONDS, DEFAULT_LEASE_SECONDS, "WORKER_LEASE_SECONDS");
  const heartbeatMs = positiveInteger(value.WORKER_HEARTBEAT_MS, DEFAULT_HEARTBEAT_MS, "WORKER_HEARTBEAT_MS");
  if (leaseSeconds < 30 || leaseSeconds > 3600) throw new Error("WORKER_LEASE_SECONDS must be between 30 and 3600");
  if (heartbeatMs * 3 > leaseSeconds * 1000) throw new Error("WORKER_HEARTBEAT_MS must be at most one third of the lease duration");
  return { leaseSeconds, heartbeatMs };
}

export function configuredJobTypes(value = process.env.WORKER_JOB_TYPES): SupportedProcessingJobType[] {
  const configured = value?.split(",").map((item) => item.trim()).filter(Boolean) ?? [...processingJobRegistry.asynchronous];
  if (!configured.length) throw new Error("WORKER_JOB_TYPES must contain at least one supported job type");
  for (const jobType of configured) {
    if (!isSupportedProcessingJobType(jobType)) throw new Error(`Unsupported WORKER_JOB_TYPES entry: ${jobType}`);
  }
  return configured as SupportedProcessingJobType[];
}

type Handler = (pool: Pool, job: ClaimedJob) => Promise<Record<string, unknown>>;

const tenantHandler = (handler: (client: PoolClient, job: ClaimedJob) => Promise<Record<string, unknown>>): Handler =>
  (pool, job) => withTenantClient(pool, { tenantId: job.tenant_id, actorType: "system", userId: null }, (client) => handler(client, job));

const handlers = {
  product_rematch: tenantHandler(async (client, job) => {
    const registerItemId = String(job.worker_output?.registerItemId ?? "");
    if (!registerItemId) throw new Error("product_rematch job missing registerItemId");
    return { ...(await computeAndStoreMatches(client, { tenantId: job.tenant_id, registerItemId })) };
  }),
  ingest_vendor_catalogue: tenantHandler(ingestHandler),
  ingest_past_submittal: tenantHandler(ingestHandler),
  risk_flag_generation: tenantHandler(async (client, job) => {
    const out = job.worker_output ?? {};
    const projectId = String(out.projectId ?? "");
    if (!projectId) throw new Error("risk_flag_generation job missing projectId");
    return runRiskPrecheck(client, {
      tenantId: job.tenant_id,
      projectId,
      jobId: job.id,
      packageId: typeof out.packageId === "string" ? out.packageId : null,
      registerItemId: typeof out.registerItemId === "string" ? out.registerItemId : null,
    });
  }),
  rfi_generation: tenantHandler(async (client, job) => {
    const out = job.worker_output ?? {};
    const projectId = String(out.projectId ?? "");
    if (!projectId) throw new Error("rfi_generation job missing projectId");
    const ids = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
    return generateRfiDraft(client, {
      tenantId: job.tenant_id,
      projectId,
      jobId: job.id,
      requestedBy: typeof out.requestedBy === "string" ? out.requestedBy : null,
      riskFlagId: typeof out.riskFlagId === "string" ? out.riskFlagId : null,
      registerItemId: typeof out.registerItemId === "string" ? out.registerItemId : null,
      title: typeof out.title === "string" ? out.title : null,
      issueSummary: typeof out.issueSummary === "string" ? out.issueSummary : null,
      question: typeof out.question === "string" ? out.question : null,
      conflictType: typeof out.conflictType === "string" ? out.conflictType : null,
      clauseReferenceIds: ids(out.clauseReferenceIds),
      drawingDocumentIds: ids(out.drawingDocumentIds),
      suggestedAttachmentIds: ids(out.suggestedAttachmentIds),
    });
  }),
  package_generation: processPackageJob,
  export_consultant_pdf: processPackageJob,
  export_aconex_bundle: processPackageJob,
  export_register_csv: processPackageJob,
  export_register_xlsx: processPackageJob,
  export_register_pdf: processPackageJob,
} satisfies Record<SupportedProcessingJobType, Handler>;

export const registeredWorkerJobTypes = Object.keys(handlers) as SupportedProcessingJobType[];

async function ingestHandler(client: PoolClient, job: ClaimedJob): Promise<Record<string, unknown>> {
  const out = job.worker_output ?? {};
  // The catalogue row this document backs (if the human created one via the API).
  const cat = job.document_id
    ? await client.query<{ id: string }>(`select id from vendor_catalogues where tenant_id = $1 and source_document_id = $2 limit 1`, [job.tenant_id, job.document_id])
    : { rows: [] as { id: string }[] };
  const summary = await ingestCatalogue(client, {
    tenantId: job.tenant_id,
    documentId: job.document_id,
    projectId: (out.projectId as string) ?? null,
    catalogueId: cat.rows[0]?.id ?? null,
    extractionJobId: job.id,
    // ponytail: structured rows come from worker_output when a pre-parser/dev path supplied them.
    // Downloading the S3 object and parsing CSV/xlsx/PDF is the wiring gap (needs AU S3 + a parser /
    // AU-hosted OCR-LLM). Until then, PDF-only uploads ingest zero products with a recorded reason.
    source: { mimeType: String(out.mimeType ?? ""), rows: (out.rows as Record<string, unknown>[]) ?? undefined, text: (out.text as string) ?? null },
  });
  // Extraction audit (req: OCR/LLM extraction run on a doc). No document text in payload.
  await client.query(
    `insert into audit_events (tenant_id, event_type, actor_type, entity_type, entity_id, action, summary, payload)
     values ($1, 'extraction', 'system', 'document', $2, 'catalogue_ingest', 'Vendor catalogue ingested', $3::jsonb)`,
    [job.tenant_id, job.document_id, JSON.stringify({ projectId: out.projectId ?? null, ...summary })],
  );
  return { ...summary };
}

export async function claimJob(pool: Pool, jobTypes: SupportedProcessingJobType[], leaseSeconds: number): Promise<ClaimedJob | null> {
  const claimed = await pool.query<ClaimedJob>(`select * from app.claim_next_job($1::text[], $2::integer)`, [jobTypes, leaseSeconds]);
  return claimed.rows[0] ?? null;
}

export async function renewLease(pool: Pool, job: ClaimedJob, leaseSeconds: number): Promise<Date | string | null> {
  if (!job.lease_token) return null;
  const renewed = await pool.query<{ lease_expires_at: Date | string }>(
    `select * from app.heartbeat_processing_job($1::uuid, $2::uuid, $3::integer)`,
    [job.id, job.lease_token, leaseSeconds],
  );
  return renewed.rows[0]?.lease_expires_at ?? null;
}

export async function completeJob(pool: Pool, job: ClaimedJob, output: Record<string, unknown>): Promise<boolean> {
  if (!job.lease_token) return false;
  const completed = await pool.query<{ completed: boolean }>(
    `select app.complete_processing_job($1::uuid, $2::uuid, $3::jsonb) as completed`,
    [job.id, job.lease_token, JSON.stringify(output)],
  );
  return completed.rows[0]?.completed === true;
}

export async function failJob(pool: Pool, job: ClaimedJob, message: string): Promise<{ status: string; next_attempt_at: Date | string | null } | null> {
  if (!job.lease_token) return null;
  const failed = await pool.query<{ status: string; next_attempt_at: Date | string | null }>(
    `select * from app.fail_processing_job($1::uuid, $2::uuid, $3::text)`,
    [job.id, job.lease_token, message.slice(0, 500)],
  );
  return failed.rows[0] ?? null;
}

type Heartbeat = { lost: () => boolean; stop: () => Promise<void> };

export function startHeartbeat(
  pool: Pool,
  job: ClaimedJob,
  config: WorkerLeaseConfig,
  signal?: AbortSignal,
  warn: (message: string) => void = (message) => console.warn(message),
): Heartbeat {
  let stopped = false;
  let leaseLost = false;
  let inFlight: Promise<void> | null = null;

  const stopTimer = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    signal?.removeEventListener("abort", abort);
  };
  const lose = (reason: string) => {
    leaseLost = true;
    stopTimer();
    warn(`[worker] lost lease for job ${job.id}; terminal update skipped (${reason})`);
  };
  const tick = () => {
    if (stopped || inFlight) return;
    inFlight = renewLease(pool, job, config.leaseSeconds)
      .then((expiry) => { if (!expiry) lose("replaced lease"); })
      .catch(() => lose("heartbeat error"))
      .finally(() => { inFlight = null; });
  };
  const abort = () => {
    leaseLost = true;
    stopTimer();
  };
  const timer = setInterval(tick, config.heartbeatMs);
  timer.unref();
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();

  return {
    lost: () => leaseLost,
    stop: async () => {
      stopTimer();
      await inFlight;
    },
  };
}

export async function processClaimedJob(
  pool: Pool,
  job: ClaimedJob,
  handler: Handler,
  config: WorkerLeaseConfig,
  signal?: AbortSignal,
  warn?: (message: string) => void,
): Promise<void> {
  const warning = warn ?? ((message: string) => console.warn(message));
  if (!job.lease_token) {
    warning(`[worker] claimed job ${job.id} had no lease token; terminal update skipped`);
    return;
  }
  if (signal?.aborted) {
    warning(`[worker] shutdown before job ${job.id} started; lease left for expiry`);
    return;
  }
  const heartbeat = startHeartbeat(pool, job, config, signal, warning);
  let result: Record<string, unknown> | undefined;
  let failure: unknown;
  let didFail = false;
  try {
    result = await handler(pool, job);
  } catch (err) {
    didFail = true;
    failure = err;
  } finally {
    await heartbeat.stop();
  }

  if (heartbeat.lost()) return;
  if (didFail) {
    const message = failure instanceof Error ? failure.message : String(failure);
    const failed = await failJob(pool, job, message);
    if (!failed) {
      warning(`[worker] lost lease for job ${job.id}; failure update skipped`);
      return;
    }
    await markPackageJobFailed(pool, job, message).catch(() => undefined);
    return;
  }
  if (!await completeJob(pool, job, result ?? {})) {
    warning(`[worker] lost lease for job ${job.id}; success update skipped`);
  }
}

// Process one claimed job and mark it through the fenced database functions.
async function processJob(pool: Pool, job: ClaimedJob, config: WorkerLeaseConfig, signal?: AbortSignal): Promise<void> {
  const handler = handlers[job.job_type];
  await processClaimedJob(pool, job, async (handlerPool, handlerJob) => {
    if (!handler) throw new Error(`no handler for job_type ${job.job_type}`);
    return handler(handlerPool, handlerJob);
  }, config, signal);
}

// Claim + process a single job. Returns true if one was handled, false if the queue was empty.
export async function runOnce(
  pool: Pool,
  jobTypes: SupportedProcessingJobType[] = [...processingJobRegistry.asynchronous],
  config: WorkerLeaseConfig = configuredLease(),
  signal?: AbortSignal,
): Promise<boolean> {
  const job = await claimJob(pool, jobTypes, config.leaseSeconds);
  if (!job) return false;
  await processJob(pool, job, config, signal);
  return true;
}

function idle(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

export async function run(pool: Pool, opts: { idleMs?: number; signal?: AbortSignal; jobTypes?: SupportedProcessingJobType[] } = {}): Promise<void> {
  const idleMs = opts.idleMs ?? 2000;
  const lease = configuredLease();
  while (!opts.signal?.aborted) {
    const worked = await runOnce(pool, opts.jobTypes ?? [...processingJobRegistry.asynchronous], lease, opts.signal).catch((e) => {
      console.error("[worker] claim/process error", e);
      return false;
    });
    if (!worked) await idle(idleMs, opts.signal);
  }
}

if (require.main === module) {
  const pool = createPool();
  const controller = new AbortController();
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => controller.abort());
  run(pool, { signal: controller.signal, jobTypes: configuredJobTypes() })
    .catch((e) => {
      console.error("[worker] fatal", e);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}
