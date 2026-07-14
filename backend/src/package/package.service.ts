import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { withTenantClient } from "../db/tenant-db";
import { renderAconexBundle, renderPackagePdf, renderRegisterCsv, renderRegisterPdf, renderRegisterXlsx } from "./render";
import { S3ObjectStore, type ObjectStore } from "./storage";
import type { ArtifactWarning, CoverSheetModel, LoadedDocument, PackageDocumentRef, PackageSnapshot, PhysicalLineItem, RegisterRow } from "./package.types";

export interface PackageJob {
  id: string;
  tenant_id: string;
  job_type: string;
  document_id: string | null;
  worker_output: Record<string, unknown> | null;
}

interface VersionRow {
  id: string;
  package_id: string;
  version_number: number;
  status: string;
  output_document_id: string | null;
  checksum_sha256: string | null;
  manifest: Record<string, unknown>;
  created_at: Date | string;
}

interface StoredDocument {
  id: string;
  storage_bucket: string;
  object_key: string;
  mime_type: string | null;
  title: string;
  original_filename: string | null;
  checksum_sha256: string | null;
}

const SYSTEM_CONTEXT = (tenantId: string) => ({ tenantId, actorType: "system" as const, userId: null });

function nullable(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function coverFrom(value: unknown): CoverSheetModel {
  const row = object(value);
  return {
    companyName: nullable(row.companyName) ?? "Subcontractor",
    legalName: nullable(row.legalName),
    abn: nullable(row.abn),
    logoDocumentId: nullable(row.logoDocumentId),
    primaryColour: /^#[0-9a-f]{6}$/i.test(String(row.primaryColour ?? "")) ? String(row.primaryColour) : "#16697A",
    address: nullable(row.address),
    phone: nullable(row.phone),
    email: nullable(row.email),
    projectName: nullable(row.projectName) ?? "Project",
    clientName: nullable(row.clientName),
    siteAddress: nullable(row.siteAddress),
    trade: nullable(row.trade) ?? "other",
    preparedBy: nullable(row.preparedBy),
  };
}

export async function resolveCoverSheet(client: PoolClient, tenantId: string, projectId: string, userId: string | null, overrides: Record<string, unknown> = {}): Promise<CoverSheetModel> {
  const result = await client.query<{
    tenant_name: string;
    legal_name: string | null;
    abn: string | null;
    branding: Record<string, unknown>;
    project_name: string;
    client_name: string | null;
    site_address: string | null;
    trade: string;
    prepared_by: string | null;
  }>(
    `select t.name as tenant_name, t.legal_name, t.abn, t.branding,
            p.name as project_name, p.client_name, p.site_address, p.trade::text,
            u.full_name as prepared_by
       from tenants t
       join projects p on p.tenant_id = t.id and p.id = $2
       left join users u on u.id = $3
      where t.id = $1`,
    [tenantId, projectId, userId],
  );
  const row = result.rows[0];
  if (!row) throw new Error("Project not found");
  const branding = object(row.branding);
  return coverFrom({
    companyName: overrides.companyName ?? branding.companyName ?? row.tenant_name,
    legalName: overrides.legalName ?? branding.legalName ?? row.legal_name,
    abn: overrides.abn ?? branding.abn ?? row.abn,
    logoDocumentId: overrides.logoDocumentId ?? branding.logoDocumentId,
    primaryColour: overrides.primaryColour ?? branding.primaryColour,
    address: overrides.address ?? branding.address,
    phone: overrides.phone ?? branding.phone,
    email: overrides.email ?? branding.email,
    projectName: row.project_name,
    clientName: row.client_name,
    siteAddress: row.site_address,
    trade: row.trade,
    preparedBy: overrides.preparedBy ?? row.prepared_by,
  });
}

function documentRef(row: Record<string, unknown>): PackageDocumentRef {
  return {
    id: String(row.id),
    title: String(row.title),
    originalFilename: nullable(row.original_filename),
    mimeType: nullable(row.mime_type),
    storageBucket: String(row.storage_bucket),
    objectKey: String(row.object_key),
    checksumSha256: nullable(row.checksum_sha256),
    role: String(row.doc_role ?? "attachment"),
    sequence: Number(row.sequence ?? 0),
    registerItemId: nullable(row.register_item_id),
  };
}

async function loadRows(client: PoolClient, tenantId: string, projectId: string, packageId: string | null, generatedAt: string): Promise<RegisterRow[]> {
  const result = await client.query<Record<string, unknown>>(
    `select ri.id as register_item_id, ri.title, ri.description, ri.status::text, ri.due_date,
            coalesce(u.full_name, u.email) as responsible_party,
            sr.category::text as requirement_category, ws.code as worksection_code, ws.title as worksection_title,
            cr.reference_label as clause_reference, sr.source_page,
            coalesce(pi.sequence, row_number() over (order by ri.due_date nulls last, ri.created_at))::int as item_number,
            coalesce(pi.included, true) as included, pi.manual_notes,
            product.name as product_name, vendor.name as vendor_name,
            coalesce(ri.due_date < ($4::timestamptz at time zone 'Australia/Sydney')::date and ri.status not in ('closed', 'cancelled'), false) as overdue
       from register_items ri
       left join package_items pi on pi.register_item_id = ri.id and pi.tenant_id = ri.tenant_id and pi.package_id = $3
       left join submittal_requirements sr on sr.id = ri.requirement_id and sr.tenant_id = ri.tenant_id
       left join worksections ws on ws.id = sr.worksection_id and ws.tenant_id = sr.tenant_id
       left join clause_references cr on cr.id = sr.clause_reference_id and cr.tenant_id = sr.tenant_id
       left join users u on u.id = ri.responsible_user_id
       left join lateral (
         select pm.product_id from product_matches pm
          where pm.tenant_id = ri.tenant_id and pm.register_item_id = ri.id and pm.decision = 'accepted'
          order by pm.decided_at desc nulls last, pm.created_at desc limit 1
       ) accepted on true
       left join products product on product.id = accepted.product_id and product.tenant_id = ri.tenant_id
       left join vendors vendor on vendor.id = product.vendor_id and vendor.tenant_id = ri.tenant_id
      where ri.tenant_id = $1 and ri.project_id = $2 and ri.archived_at is null
        and ($3::uuid is null or pi.package_id = $3)
      order by item_number, ri.created_at`,
    [tenantId, projectId, packageId, generatedAt],
  );
  return result.rows.map((row) => ({
    itemNumber: Number(row.item_number),
    registerItemId: String(row.register_item_id),
    description: nullable(row.description) ?? String(row.title),
    worksection: [nullable(row.worksection_code), nullable(row.worksection_title)].filter(Boolean).join(" - ") || null,
    clauseReference: nullable(row.clause_reference),
    clauseLocation: row.source_page ? `Source page ${row.source_page}` : null,
    requiredEvidence: nullable(row.requirement_category)?.replaceAll("_", " ") ?? "submission evidence",
    status: String(row.status),
    responsibleParty: nullable(row.responsible_party),
    dueDate: row.due_date ? String(row.due_date).slice(0, 10) : null,
    overdue: Boolean(row.overdue),
    productName: nullable(row.product_name),
    vendorName: nullable(row.vendor_name),
    included: Boolean(row.included),
    manualNotes: nullable(row.manual_notes),
    documents: [],
    physicalDeliverables: [],
  }));
}

async function loadPackageDocuments(client: PoolClient, tenantId: string, projectId: string, packageId: string, rows: RegisterRow[]) {
  const result = await client.query<Record<string, unknown>>(
    `select d.id, d.title, d.original_filename, d.mime_type, d.storage_bucket, d.object_key, d.checksum_sha256,
            pid.doc_role, pid.sequence, pi.register_item_id
       from package_item_documents pid
       join package_items pi on pi.tenant_id = pid.tenant_id and pi.id = pid.package_item_id
       join documents d on d.tenant_id = pid.tenant_id and d.id = pid.document_id
      where pid.tenant_id = $1 and pi.package_id = $2 and pid.included = true and pi.included = true
        and (d.project_id is null or d.project_id = $3)
      union all
     select d.id, d.title, d.original_filename, d.mime_type, d.storage_bucket, d.object_key, d.checksum_sha256,
            'attachment' as doc_role, 0 as sequence, pi.register_item_id
       from package_items pi
       join documents d on d.tenant_id = pi.tenant_id and d.id = pi.document_id
      where pi.tenant_id = $1 and pi.package_id = $2 and pi.included = true
        and (d.project_id is null or d.project_id = $3)
      order by sequence, title`,
    [tenantId, packageId, projectId],
  );
  const seen = new Set<string>();
  for (const raw of result.rows) {
    const ref = documentRef(raw);
    const key = `${ref.registerItemId}:${ref.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.find((row) => row.registerItemId === ref.registerItemId)?.documents.push(ref);
  }
}

async function loadAcceptedDocuments(client: PoolClient, tenantId: string, projectId: string, rows: RegisterRow[]) {
  const result = await client.query<Record<string, unknown>>(
    `select distinct d.id, d.title, d.original_filename, d.mime_type, d.storage_bucket, d.object_key, d.checksum_sha256,
            pd.doc_role, 0 as sequence, pm.register_item_id
       from product_matches pm
       join products p on p.tenant_id = pm.tenant_id and p.id = pm.product_id
       join product_documents pd on pd.tenant_id = p.tenant_id and pd.product_id = p.id
       join documents d on d.tenant_id = p.tenant_id and d.id = pd.document_id
       join register_items ri on ri.tenant_id = pm.tenant_id and ri.id = pm.register_item_id
      where pm.tenant_id = $1 and ri.project_id = $2 and pm.decision = 'accepted'
        and (d.project_id is null or d.project_id = $2)
      union
     select distinct d.id, d.title, d.original_filename, d.mime_type, d.storage_bucket, d.object_key, d.checksum_sha256,
            'datasheet' as doc_role, 0 as sequence, pm.register_item_id
       from product_matches pm
       join products p on p.tenant_id = pm.tenant_id and p.id = pm.product_id
       join documents d on d.tenant_id = p.tenant_id and d.id = p.datasheet_document_id
       join register_items ri on ri.tenant_id = pm.tenant_id and ri.id = pm.register_item_id
      where pm.tenant_id = $1 and ri.project_id = $2 and pm.decision = 'accepted'
        and p.datasheet_document_id is not null and (d.project_id is null or d.project_id = $2)`,
    [tenantId, projectId],
  );
  for (const raw of result.rows) {
    const ref = documentRef(raw);
    const row = rows.find((item) => item.registerItemId === ref.registerItemId);
    if (row && !row.documents.some((document) => document.id === ref.id)) row.documents.push(ref);
  }
}

async function loadPhysical(client: PoolClient, tenantId: string, rows: RegisterRow[]) {
  const result = await client.query<Record<string, unknown>>(
    `select pd.id, pd.register_item_id, pd.kind::text, pd.description, pd.status::text,
            coalesce(u.full_name, u.email) as responsible_party, pd.due_date, pd.notes, pd.attachment_document_id
       from physical_deliverables pd
       join register_items ri on ri.tenant_id = pd.tenant_id and ri.id = pd.register_item_id
       left join users u on u.id = pd.responsible_user_id
      where pd.tenant_id = $1 and pd.register_item_id = any($2::uuid[])
      order by pd.created_at`,
    [tenantId, rows.map((row) => row.registerItemId)],
  );
  for (const raw of result.rows) {
    const physical: PhysicalLineItem = {
      id: String(raw.id), kind: String(raw.kind), description: nullable(raw.description), status: String(raw.status),
      responsibleParty: nullable(raw.responsible_party), dueDate: raw.due_date ? String(raw.due_date).slice(0, 10) : null,
      notes: nullable(raw.notes), attachmentDocumentId: nullable(raw.attachment_document_id),
    };
    rows.find((row) => row.registerItemId === String(raw.register_item_id))?.physicalDeliverables.push(physical);
  }
}

async function loadLogo(client: PoolClient, tenantId: string, projectId: string, cover: CoverSheetModel): Promise<PackageDocumentRef | null> {
  if (!cover.logoDocumentId) return null;
  const result = await client.query<Record<string, unknown>>(
    `select id, title, original_filename, mime_type, storage_bucket, object_key, checksum_sha256,
            'logo' as doc_role, 0 as sequence, null::uuid as register_item_id
       from documents
      where tenant_id = $1 and id = $2 and archived_at is null and (project_id is null or project_id = $3)`,
    [tenantId, cover.logoDocumentId, projectId],
  );
  return result.rows[0] ? documentRef(result.rows[0]) : null;
}

export async function loadPackageSnapshot(client: PoolClient, tenantId: string, projectId: string, packageId: string, version: number, generatedAt: string): Promise<PackageSnapshot> {
  const pkg = await client.query<{ name: string; cover_sheet: Record<string, unknown> }>(
    `select name, cover_sheet from packages where tenant_id = $1 and project_id = $2 and id = $3 and archived_at is null`,
    [tenantId, projectId, packageId],
  );
  if (!pkg.rows[0]) throw new Error("Package not found");
  const cover = coverFrom(pkg.rows[0].cover_sheet);
  const rows = await loadRows(client, tenantId, projectId, packageId, generatedAt);
  await loadPackageDocuments(client, tenantId, projectId, packageId, rows);
  await loadPhysical(client, tenantId, rows);
  return { tenantId, projectId, packageId, packageName: pkg.rows[0].name, version, generatedAt, cover, rows, logoDocument: await loadLogo(client, tenantId, projectId, cover) };
}

export async function loadProjectRegisterSnapshot(client: PoolClient, tenantId: string, projectId: string, generatedAt: string): Promise<PackageSnapshot> {
  const project = await client.query<{ name: string; cover: Record<string, unknown> }>(
    `select p.name, jsonb_build_object(
              'companyName', coalesce(t.branding->>'companyName', t.name), 'legalName', coalesce(t.branding->>'legalName', t.legal_name),
              'abn', coalesce(t.branding->>'abn', t.abn), 'logoDocumentId', t.branding->>'logoDocumentId',
              'primaryColour', coalesce(t.branding->>'primaryColour', '#16697A'), 'address', t.branding->>'address',
              'phone', t.branding->>'phone', 'email', t.branding->>'email', 'projectName', p.name,
              'clientName', p.client_name, 'siteAddress', p.site_address, 'trade', p.trade::text
            ) as cover
       from projects p join tenants t on t.id = p.tenant_id
      where p.tenant_id = $1 and p.id = $2`,
    [tenantId, projectId],
  );
  if (!project.rows[0]) throw new Error("Project not found");
  const cover = coverFrom(project.rows[0].cover);
  const rows = await loadRows(client, tenantId, projectId, null, generatedAt);
  await loadAcceptedDocuments(client, tenantId, projectId, rows);
  await loadPhysical(client, tenantId, rows);
  return { tenantId, projectId, packageId: null, packageName: "Submittal register", version: 1, generatedAt, cover, rows, logoDocument: await loadLogo(client, tenantId, projectId, cover) };
}

async function loadObject(store: ObjectStore, ref: PackageDocumentRef): Promise<LoadedDocument> {
  try {
    const bytes = await store.get(ref);
    if (ref.checksumSha256 && createHash("sha256").update(bytes).digest("hex") !== ref.checksumSha256) {
      return { ref, bytes: null, error: "Stored object checksum does not match the document record" };
    }
    return { ref, bytes };
  } catch (error) {
    return { ref, bytes: null, error: error instanceof Error ? error.message : "Document unavailable" };
  }
}

async function loadObjects(store: ObjectStore, snapshot: PackageSnapshot) {
  const refs = snapshot.rows.filter((row) => row.included).flatMap((row) => row.documents);
  const unique = [...new Map(refs.map((ref) => [ref.id, ref])).values()];
  const documents = await Promise.all(unique.map((ref) => loadObject(store, ref)));
  const logo = snapshot.logoDocument ? await loadObject(store, snapshot.logoDocument) : null;
  return { documents, logo };
}

async function reserveVersion(pool: Pool, job: PackageJob, projectId: string, packageId: string): Promise<VersionRow> {
  return withTenantClient(pool, SYSTEM_CONTEXT(job.tenant_id), async (client) => {
    const existing = await client.query<VersionRow>(`select * from package_versions where tenant_id = $1 and generation_job_id = $2`, [job.tenant_id, job.id]);
    if (existing.rows[0]) {
      if (existing.rows[0].package_id !== packageId) throw new Error("Package version reservation does not match the job payload");
      const pkg = await client.query(`select 1 from packages where tenant_id = $1 and project_id = $2 and id = $3`, [job.tenant_id, projectId, packageId]);
      if (!pkg.rows[0]) throw new Error("Package not found");
      if (existing.rows[0].status !== "ready") await client.query(`update packages set status = 'assembling' where id = $1`, [packageId]);
      return existing.rows[0];
    }
    const pkg = await client.query<{ current_version: number }>(`select current_version from packages where tenant_id = $1 and project_id = $2 and id = $3 for update`, [job.tenant_id, projectId, packageId]);
    if (!pkg.rows[0]) throw new Error("Package not found");
    const version = pkg.rows[0].current_version + 1;
    const result = await client.query<VersionRow>(
      `insert into package_versions (tenant_id, package_id, version_number, generation_job_id, status)
       values ($1, $2, $3, $4, 'generating') returning *`,
      [job.tenant_id, packageId, version, job.id],
    );
    await client.query(`update packages set current_version = $2, status = 'assembling' where id = $1`, [packageId, version]);
    return result.rows[0];
  });
}

async function generatedDocument(client: PoolClient, input: {
  tenantId: string; projectId: string; title: string; filename: string; bucket: string; key: string; checksum: string;
  contentType: string; docType: "generated_package" | "export"; size: number; versionId: string | null; pageCount: number | null; version: number; supersedesId?: string | null;
}) {
  const result = await client.query<{ id: string }>(
    `insert into documents (tenant_id, project_id, doc_type, title, original_filename, storage_bucket, object_key,
                            checksum_sha256, mime_type, size_bytes, s3_version_id, kms_key_arn, page_count, version, supersedes_document_id)
     values ($1, $2, $3::document_type, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
     on conflict (storage_bucket, object_key) do update
       set checksum_sha256 = excluded.checksum_sha256, size_bytes = excluded.size_bytes,
           s3_version_id = excluded.s3_version_id, page_count = excluded.page_count
     returning id`,
    [input.tenantId, input.projectId, input.docType, input.title, input.filename,
      input.bucket, input.key, input.checksum, input.contentType, input.size, input.versionId, process.env.S3_KMS_KEY_ARN ?? null,
      input.pageCount, input.version, input.supersedesId ?? null],
  );
  return result.rows[0].id;
}

async function generateVersion(pool: Pool, job: PackageJob, projectId: string, packageId: string, store: ObjectStore): Promise<VersionRow> {
  const version = await reserveVersion(pool, job, projectId, packageId);
  if (version.status === "ready" && version.output_document_id) return version;
  const generatedAt = new Date(version.created_at).toISOString();
  const snapshot = await withTenantClient(pool, SYSTEM_CONTEXT(job.tenant_id), (client) => loadPackageSnapshot(client, job.tenant_id, projectId, packageId, version.version_number, generatedAt));
  const loaded = await loadObjects(store, snapshot);
  const rendered = await renderPackagePdf(snapshot, loaded.documents, loaded.logo);
  const bucket = process.env.S3_OUTPUT_BUCKET ?? process.env.S3_BUCKET;
  if (!bucket) throw new Error("S3_OUTPUT_BUCKET is required for generated package files");
  await store.assertAustralianBucket(bucket);
  const key = `tenants/${job.tenant_id}/projects/${projectId}/generated/packages/${packageId}/v${version.version_number}.pdf`;
  const checksum = createHash("sha256").update(rendered.bytes).digest("hex");
  const uploaded = await store.put({ bucket, key, body: rendered.bytes, contentType: "application/pdf", metadata: { packageid: packageId, version: String(version.version_number), preparedforreview: "true" } });
  return withTenantClient(pool, SYSTEM_CONTEXT(job.tenant_id), async (client) => {
    const previous = await client.query<{ output_document_id: string | null }>(`select output_document_id from package_versions where package_id = $1 and version_number < $2 and status = 'ready' order by version_number desc limit 1`, [packageId, version.version_number]);
    const documentId = await generatedDocument(client, {
      tenantId: job.tenant_id, projectId, title: `${snapshot.packageName} v${version.version_number} - Prepared for review`,
      filename: `${packageId}-v${version.version_number}.pdf`, bucket, key, checksum, contentType: "application/pdf",
      docType: "generated_package",
      size: rendered.bytes.length, versionId: uploaded.versionId, pageCount: rendered.pageCount, version: version.version_number,
      supersedesId: previous.rows[0]?.output_document_id,
    });
    const manifest = {
      preparedForReview: true,
      itemCount: snapshot.rows.filter((row) => row.included).length,
      attachmentCount: loaded.documents.filter((doc) => doc.bytes).length,
      warnings: rendered.warnings,
      snapshot,
    };
    const updated = await client.query<VersionRow>(
      `update package_versions set status = 'ready', output_document_id = $2, manifest = $3::jsonb, checksum_sha256 = $4, error_message = null
        where id = $1 returning *`,
      [version.id, documentId, JSON.stringify(manifest), checksum],
    );
    await client.query(`update packages set status = 'ready', output_document_id = $2 where id = $1`, [packageId, documentId]);
    await client.query(
      `insert into audit_events (tenant_id, event_type, actor_type, entity_type, entity_id, action, summary, payload)
       values ($1, 'package_generation', 'system', 'package', $2, 'package_generated', 'Package generated and prepared for review', $3::jsonb)`,
      [job.tenant_id, packageId, JSON.stringify({ project_id: projectId, version: version.version_number, documentId, warnings: rendered.warnings })],
    );
    return updated.rows[0];
  });
}

async function latestReadyVersion(pool: Pool, job: PackageJob, projectId: string, packageId: string, store: ObjectStore) {
  const existing = await withTenantClient(pool, SYSTEM_CONTEXT(job.tenant_id), (client) => client.query<VersionRow>(
    `select pv.* from package_versions pv join packages p on p.tenant_id = pv.tenant_id and p.id = pv.package_id
      where pv.tenant_id = $1 and p.project_id = $2 and pv.package_id = $3 and pv.status = 'ready'
      order by pv.version_number desc limit 1`,
    [job.tenant_id, projectId, packageId],
  ));
  return existing.rows[0] ?? generateVersion(pool, job, projectId, packageId, store);
}

async function loadStoredDocument(client: PoolClient, tenantId: string, documentId: string): Promise<PackageDocumentRef> {
  const result = await client.query<Record<string, unknown>>(
    `select id, title, original_filename, mime_type, storage_bucket, object_key, checksum_sha256,
            'generated_package' as doc_role, 0 as sequence, null::uuid as register_item_id
       from documents where tenant_id = $1 and id = $2`,
    [tenantId, documentId],
  );
  if (!result.rows[0]) throw new Error("Generated document not found");
  return documentRef(result.rows[0]);
}

async function processPackageExport(pool: Pool, job: PackageJob, store: ObjectStore) {
  const out = job.worker_output ?? {};
  const projectId = String(out.projectId ?? "");
  const packageId = String(out.packageId ?? "");
  const exportId = String(out.exportId ?? "");
  if (!projectId || !packageId || !exportId) throw new Error("Package export job is missing projectId, packageId, or exportId");
  const exportType = job.job_type === "export_consultant_pdf" ? "consultant_pdf" : "aconex_bundle";
  const existing = await withTenantClient(pool, SYSTEM_CONTEXT(job.tenant_id), (client) => client.query<{ status: string; output_document_id: string | null }>(
    `select status, output_document_id from exports
      where tenant_id = $1 and id = $2 and project_id = $3 and package_id = $4 and export_type = $5`,
    [job.tenant_id, exportId, projectId, packageId, exportType],
  ));
  if (!existing.rows[0]) throw new Error("Package export row does not match the job payload");
  if (existing.rows[0]?.status === "ready") return { exportId, documentId: existing.rows[0].output_document_id };
  const version = await latestReadyVersion(pool, job, projectId, packageId, store);
  if (!version.output_document_id) throw new Error("Package version has no generated document");
  if (job.job_type === "export_consultant_pdf") {
    await withTenantClient(pool, SYSTEM_CONTEXT(job.tenant_id), async (client) => {
      await client.query(`update exports set status = 'ready', output_document_id = $2, package_version_id = $3, metadata = $4::jsonb, error_message = null, updated_at = now() where id = $1`, [exportId, version.output_document_id, version.id, JSON.stringify({ preparedForReview: true, version: version.version_number })]);
      await client.query(`insert into audit_events (tenant_id, event_type, actor_type, entity_type, entity_id, action, summary, payload) values ($1, 'export', 'system', 'export', $2, 'package_exported', 'Package PDF exported for consultant review', $3::jsonb)`, [job.tenant_id, exportId, JSON.stringify({ project_id: projectId, packageId, version: version.version_number })]);
    });
    return { exportId, documentId: version.output_document_id, packageVersionId: version.id };
  }
  const snapshot = version.manifest?.snapshot as PackageSnapshot | undefined;
  if (!snapshot || snapshot.tenantId !== job.tenant_id || snapshot.projectId !== projectId || snapshot.packageId !== packageId || snapshot.version !== version.version_number) {
    throw new Error("Package version snapshot is missing or does not match the export job");
  }
  const loaded = await loadObjects(store, snapshot);
  const packageRef = await withTenantClient(pool, SYSTEM_CONTEXT(job.tenant_id), (client) => loadStoredDocument(client, job.tenant_id, version.output_document_id!));
  const packagePdf = await loadObject(store, packageRef);
  if (!packagePdf.bytes) throw new Error(`Generated package PDF is unavailable: ${packagePdf.error ?? "unknown error"}`);
  const warningMap = new Map<string, ArtifactWarning>();
  if (Array.isArray(version.manifest?.warnings)) {
    for (const warning of version.manifest.warnings as ArtifactWarning[]) warningMap.set(`${warning.documentId}:${warning.reason}`, warning);
  }
  for (const document of loaded.documents.filter((item) => !item.bytes)) {
    const warning = { documentId: document.ref.id, title: document.ref.title, reason: document.error ?? "Document unavailable" };
    warningMap.set(`${warning.documentId}:${warning.reason}`, warning);
  }
  const warnings = [...warningMap.values()];
  const bundle = await renderAconexBundle(snapshot, packagePdf.bytes, loaded.documents, warnings);
  const bucket = process.env.S3_OUTPUT_BUCKET ?? process.env.S3_BUCKET;
  if (!bucket) throw new Error("S3_OUTPUT_BUCKET is required for generated exports");
  const key = `tenants/${job.tenant_id}/projects/${projectId}/generated/exports/${exportId}.zip`;
  const checksum = createHash("sha256").update(bundle).digest("hex");
  const uploaded = await store.put({ bucket, key, body: bundle, contentType: "application/zip", metadata: { exportid: exportId, packageid: packageId } });
  const documentId = await withTenantClient(pool, SYSTEM_CONTEXT(job.tenant_id), async (client) => {
    const id = await generatedDocument(client, { tenantId: job.tenant_id, projectId, title: `${snapshot.packageName} Aconex-ready bundle`, filename: `${packageId}-v${version.version_number}-aconex.zip`, bucket, key, checksum, contentType: "application/zip", docType: "export", size: bundle.length, versionId: uploaded.versionId, pageCount: null, version: version.version_number });
    await client.query(`update exports set status = 'ready', output_document_id = $2, package_version_id = $3, metadata = $4::jsonb, error_message = null, updated_at = now() where id = $1`, [exportId, id, version.id, JSON.stringify({ schemaVersion: "submitsense.aconex-bundle.v1", version: version.version_number })]);
    await client.query(`insert into audit_events (tenant_id, event_type, actor_type, entity_type, entity_id, action, summary, payload) values ($1, 'export', 'system', 'export', $2, 'package_exported', 'Aconex-ready package bundle exported', $3::jsonb)`, [job.tenant_id, exportId, JSON.stringify({ project_id: projectId, packageId, version: version.version_number, documentId: id })]);
    return id;
  });
  return { exportId, documentId, packageVersionId: version.id };
}

async function processRegisterExport(pool: Pool, job: PackageJob, store: ObjectStore) {
  const out = job.worker_output ?? {};
  const projectId = String(out.projectId ?? "");
  const exportId = String(out.exportId ?? "");
  const format = String(out.exportType ?? job.job_type.replace("export_register_", ""));
  if (!projectId || !exportId || !["csv", "xlsx", "pdf"].includes(format)) throw new Error("Register export job is missing valid projectId, exportId, or format");
  const existing = await withTenantClient(pool, SYSTEM_CONTEXT(job.tenant_id), (client) => client.query<{ status: string; output_document_id: string | null; created_at: Date | string }>(
    `select status, output_document_id, created_at from exports
      where tenant_id = $1 and id = $2 and project_id = $3 and package_id is null and export_type = $4`,
    [job.tenant_id, exportId, projectId, `register_${format}`],
  ));
  if (!existing.rows[0]) throw new Error("Register export row does not match the job payload");
  if (existing.rows[0]?.status === "ready") return { exportId, documentId: existing.rows[0].output_document_id };
  const generatedAt = new Date(existing.rows[0]?.created_at ?? Date.now()).toISOString();
  const snapshot = await withTenantClient(pool, SYSTEM_CONTEXT(job.tenant_id), (client) => loadProjectRegisterSnapshot(client, job.tenant_id, projectId, generatedAt));
  let bytes: Uint8Array;
  let contentType: string;
  let pageCount: number | null = null;
  if (format === "csv") {
    bytes = renderRegisterCsv(snapshot); contentType = "text/csv";
  } else if (format === "xlsx") {
    bytes = await renderRegisterXlsx(snapshot); contentType = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  } else {
    const pdf = await renderRegisterPdf(snapshot); bytes = pdf.bytes; contentType = "application/pdf"; pageCount = pdf.pageCount;
  }
  const bucket = process.env.S3_OUTPUT_BUCKET ?? process.env.S3_BUCKET;
  if (!bucket) throw new Error("S3_OUTPUT_BUCKET is required for generated exports");
  const key = `tenants/${job.tenant_id}/projects/${projectId}/generated/registers/${exportId}.${format}`;
  const checksum = createHash("sha256").update(bytes).digest("hex");
  const uploaded = await store.put({ bucket, key, body: bytes, contentType, metadata: { exportid: exportId, preparedforreview: "true" } });
  const documentId = await withTenantClient(pool, SYSTEM_CONTEXT(job.tenant_id), async (client) => {
    const id = await generatedDocument(client, { tenantId: job.tenant_id, projectId, title: `Submittal register ${format.toUpperCase()} - Prepared for review`, filename: `submittal-register.${format}`, bucket, key, checksum, contentType, docType: "export", size: bytes.length, versionId: uploaded.versionId, pageCount, version: 1 });
    await client.query(`update exports set status = 'ready', output_document_id = $2, metadata = $3::jsonb, error_message = null, updated_at = now() where id = $1`, [exportId, id, JSON.stringify({ format, preparedForReview: true, itemCount: snapshot.rows.length })]);
    await client.query(`insert into audit_events (tenant_id, event_type, actor_type, entity_type, entity_id, action, summary, payload) values ($1, 'export', 'system', 'export', $2, 'register_exported', 'Submittal register exported and prepared for review', $3::jsonb)`, [job.tenant_id, exportId, JSON.stringify({ project_id: projectId, format, documentId: id })]);
    return id;
  });
  return { exportId, documentId, format };
}

export async function processPackageJob(pool: Pool, job: PackageJob, store: ObjectStore = new S3ObjectStore()): Promise<Record<string, unknown>> {
  const out = job.worker_output ?? {};
  if (job.job_type === "package_generation") {
    const projectId = String(out.projectId ?? "");
    const packageId = String(out.packageId ?? "");
    if (!projectId || !packageId) throw new Error("Package generation job is missing projectId or packageId");
    const version = await generateVersion(pool, job, projectId, packageId, store);
    return { packageId, packageVersionId: version.id, version: version.version_number, documentId: version.output_document_id, checksumSha256: version.checksum_sha256 };
  }
  if (["export_consultant_pdf", "export_aconex_bundle"].includes(job.job_type)) return processPackageExport(pool, job, store);
  if (job.job_type.startsWith("export_register_")) return processRegisterExport(pool, job, store);
  throw new Error(`Unsupported package job type ${job.job_type}`);
}

export async function markPackageJobFailed(pool: Pool, job: PackageJob, message: string): Promise<void> {
  await withTenantClient(pool, SYSTEM_CONTEXT(job.tenant_id), async (client) => {
    await client.query(`update package_versions set status = 'failed', error_message = $2 where generation_job_id = $1 and status <> 'ready'`, [job.id, message.slice(0, 500)]);
    const exportId = nullable(job.worker_output?.exportId);
    if (exportId) await client.query(`update exports set status = 'failed', error_message = $2, updated_at = now() where id = $1 and status <> 'ready'`, [exportId, message.slice(0, 500)]);
    const packageId = nullable(job.worker_output?.packageId);
    if (packageId) await client.query(`update packages set status = case when output_document_id is null then 'draft'::package_status else 'ready'::package_status end where id = $1`, [packageId]);
  });
}
