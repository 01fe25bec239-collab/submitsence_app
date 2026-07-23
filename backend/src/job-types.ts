import workerPoolsJson from "./worker-pools.json";

export const processingJobRegistry = {
  asynchronous: [
    "product_rematch",
    "ingest_vendor_catalogue",
    "ingest_past_submittal",
    "package_generation",
    "risk_flag_generation",
    "rfi_generation",
    "export_consultant_pdf",
    "export_aconex_bundle",
    "export_register_csv",
    "export_register_xlsx",
    "export_register_pdf",
  ],
  synchronousLedger: ["package_draft"],
  unsupported: [
    "ingest_spec",
    "ingest_drawing",
    "ingest_addendum",
    "ingest_attachment",
    "ingest_document",
    "export_rfi_pdf",
  ],
} as const;

export const syncJobRegistry = {
  asynchronous: [],
  unsupported: ["package_push", "response_pull"],
} as const;

export const documentProcessingJobTypes = {
  spec: "ingest_spec",
  drawing: "ingest_drawing",
  addendum: "ingest_addendum",
  vendor_catalogue: "ingest_vendor_catalogue",
  past_submittal: "ingest_past_submittal",
  attachment: "ingest_attachment",
  other: "ingest_document",
} as const;

export type SupportedProcessingJobType = (typeof processingJobRegistry.asynchronous)[number];
export type SynchronousProcessingLedgerJobType = (typeof processingJobRegistry.synchronousLedger)[number];

const supportedProcessingJobTypes = new Set<string>(processingJobRegistry.asynchronous);

export function isSupportedProcessingJobType(jobType: string): jobType is SupportedProcessingJobType {
  return supportedProcessingJobTypes.has(jobType);
}

export type WorkerPoolName = keyof typeof workerPoolsJson;
export type WorkerPoolConfig = {
  enabled: boolean;
  anchor?: boolean;
  jobTypes: SupportedProcessingJobType[];
};

function validatedWorkerPools(): Record<WorkerPoolName, WorkerPoolConfig> {
  const pools = workerPoolsJson as Record<WorkerPoolName, { enabled: boolean; anchor?: boolean; jobTypes: string[] }>;
  const enabled = Object.entries(pools).filter(([, pool]) => pool.enabled);
  const assigned = enabled.flatMap(([, pool]) => pool.jobTypes);
  const duplicates = assigned.filter((jobType, index) => assigned.indexOf(jobType) !== index);
  const unsupported = assigned.filter((jobType) => !isSupportedProcessingJobType(jobType));
  const missing = processingJobRegistry.asynchronous.filter((jobType) => !assigned.includes(jobType));
  if (duplicates.length || unsupported.length || missing.length || enabled.filter(([, pool]) => pool.anchor).length !== 1) {
    throw new Error("worker-pools.json must map every supported asynchronous job exactly once and declare exactly one enabled anchor");
  }
  return pools as Record<WorkerPoolName, WorkerPoolConfig>;
}

export const workerPools = validatedWorkerPools();
