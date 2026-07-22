import type { Pool, PoolClient } from "pg";
import { createPool } from "../db.module";
import { withTenantClient } from "../db/tenant-db";
import { ingestCatalogue } from "../ingestion/ingestion.service";
import { isSupportedProcessingJobType, processingJobRegistry, type SupportedProcessingJobType } from "../job-types";
import { computeAndStoreMatches } from "../matching/matching.service";
import { markPackageJobFailed, processPackageJob } from "../package/package.service";
import { generateRfiDraft, runRiskPrecheck } from "../risk/risk.service";

// B6-B7 background worker. Uses processing_jobs, the sole active asynchronous queue. Loop: claim one job cross-tenant via the
// SECURITY DEFINER claimer (0017), then process + mark it INSIDE a tenant transaction as actor
// 'system' (withTenantClient), so RLS + the human-approval guard apply and a job can never sign off.
//
type ClaimedJob = { id: string; tenant_id: string; job_type: SupportedProcessingJobType; document_id: string | null; worker_output: Record<string, unknown> | null };

export function configuredJobTypes(value = process.env.WORKER_JOB_TYPES): SupportedProcessingJobType[] {
  const configured = value?.split(",").map((item) => item.trim()).filter(Boolean) ?? [...processingJobRegistry.asynchronous];
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

// Process one claimed job in its own tenant transaction. Returns after marking succeeded/failed.
async function processJob(pool: Pool, job: ClaimedJob): Promise<void> {
  const handler = handlers[job.job_type];
  try {
    if (!handler) throw new Error(`no handler for job_type ${job.job_type}`);
    const result = await handler(pool, job);
    await withTenantClient(pool, { tenantId: job.tenant_id, actorType: "system", userId: null }, async (client) => {
      await client.query(
        `update processing_jobs set status = 'succeeded', finished_at = now(), last_error = null, error_details = null,
                                    updated_at = now(), worker_output = coalesce(worker_output, '{}'::jsonb) || $2::jsonb
          where id = $1`,
        [job.id, JSON.stringify(result)],
      );
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await markPackageJobFailed(pool, job, message).catch(() => undefined);
    // Mark retrying (if attempts remain) or failed. attempts was already incremented by the claimer.
    await withTenantClient(pool, { tenantId: job.tenant_id, actorType: "system", userId: null }, async (client) => {
      await client.query(
        `update processing_jobs
            set status = case when attempts < max_attempts then 'retrying' else 'failed' end,
                last_error = $2, finished_at = case when attempts < max_attempts then finished_at else now() end,
                updated_at = now()
          where id = $1`,
        [job.id, message.slice(0, 500)],
      );
    });
  }
}

// Claim + process a single job. Returns true if one was handled, false if the queue was empty.
export async function runOnce(pool: Pool, jobTypes: SupportedProcessingJobType[] = [...processingJobRegistry.asynchronous]): Promise<boolean> {
  const claimed = await pool.query<ClaimedJob>(`select * from app.claim_next_job($1::text[])`, [jobTypes]);
  const job = claimed.rows[0];
  if (!job) return false;
  await processJob(pool, job);
  return true;
}

export async function run(pool: Pool, opts: { idleMs?: number; signal?: AbortSignal; jobTypes?: SupportedProcessingJobType[] } = {}): Promise<void> {
  const idleMs = opts.idleMs ?? 2000;
  while (!opts.signal?.aborted) {
    const worked = await runOnce(pool, opts.jobTypes ?? [...processingJobRegistry.asynchronous]).catch((e) => {
      console.error("[worker] claim/process error", e);
      return false;
    });
    if (!worked) await new Promise((r) => setTimeout(r, idleMs));
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
