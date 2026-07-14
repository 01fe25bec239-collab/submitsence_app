import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { createHash, createHmac, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { AuthService } from "../auth/auth.service";
import type { AuthContext, AuthedRequest } from "../auth/auth.types";
import * as v from "../auth/validation";
import { assertSafeStatusLanguage } from "../compliance/language";
import { getEmbedder, toVectorLiteral } from "../ingestion/embedder";
import { extractStandards } from "../ingestion/extraction";
import { resolveCoverSheet } from "../package/package.service";
import { withTenantClient } from "../db/tenant-db";
import { PG_POOL } from "../db.module";
import transitions from "./status-transitions.json";
import * as api from "./validation";

type AuditEventType =
  | "document_upload"
  | "extraction"
  | "match"
  | "flag"
  | "rfi_action"
  | "package_generation"
  | "export"
  | "integration_sync"
  | "billing_event"
  | "admin_action"
  | "status_change" // also DB-auto for register transitions
  | "auth_sensitive"
  | "consent_change"; // human_signoff is DB-auto only and never emitted through this helper

type JobRow = {
  id: string;
  job_type: string;
  status: string;
  worker_output: Record<string, unknown> | null;
  inserted?: boolean;
};

const uploadDocTypes = new Set(["spec", "drawing", "addendum", "vendor_catalogue", "past_submittal", "attachment", "other"]);
const ingestJobType: Record<string, string> = {
  spec: "ingest_spec",
  drawing: "ingest_drawing",
  addendum: "ingest_addendum",
  vendor_catalogue: "ingest_vendor_catalogue",
  past_submittal: "ingest_past_submittal",
  attachment: "ingest_attachment",
  other: "ingest_document",
};
const externalConsultantStatuses = new Set(["submitted", "revise_and_resubmit", "rejected"]);

@Injectable()
export class ApiService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly auth: AuthService,
  ) {}

  async listProjects(ctx: AuthContext, query: Record<string, unknown>) {
    if (!ctx.permissions.includes("project.read")) return [];
    const includeArchived = query.includeArchived === "true";
    const q = api.optionalString(query.q);
    const tenantWide = ctx.tenantRole === "owner" || ctx.tenantRole === "admin";
    return withTenantClient(this.pool, this.dbContext(ctx), async (client) => {
      const result = await client.query(
        `select p.id, p.name, p.client_name as "clientName", p.site_address as "siteAddress",
                p.trade, p.status, p.is_archived as "isArchived", p.submission_deadline as "submissionDeadline",
                p.tender_close_at as "tenderCloseAt", pm.role as "projectRole", p.created_at as "createdAt"
           from projects p
           left join project_memberships pm on pm.project_id = p.id and pm.user_id = $1
          where ($2::boolean or pm.user_id is not null)
            and ($3::boolean or p.is_archived = false)
            and ($4::text is null or p.name ilike '%' || $4 || '%' or coalesce(p.client_name, '') ilike '%' || $4 || '%')
          order by p.submission_deadline nulls last, p.created_at desc`,
        [ctx.principal.id, tenantWide, includeArchived, q],
      );
      return result.rows;
    });
  }

  async createProject(ctx: AuthContext, body: Record<string, unknown>, req?: AuthedRequest) {
    await this.auth.requireTenantPermission(ctx, "project.manage", req);
    const trade = api.enumValue(body.trade ?? "other", "trade", api.tradePackages);
    const status = api.enumValue(body.status ?? "draft", "status", api.projectStatuses);
    return withTenantClient(this.pool, this.dbContext(ctx), async (client) => {
      const result = await client.query<{ id: string }>(
        `insert into projects (tenant_id, name, client_name, site_address, trade, status, submission_deadline, tender_close_at, created_by)
         values ($1, $2, $3, $4, $5::trade_package, $6::project_status, $7, $8, $9)
         returning id, name, client_name as "clientName", trade, status`,
        [
          ctx.tenantId,
          v.string(body.name, "name"),
          api.optionalString(body.clientName),
          api.optionalString(body.siteAddress),
          trade,
          status,
          api.optionalDate(body.submissionDeadline, "submissionDeadline"),
          api.optionalDate(body.tenderCloseAt, "tenderCloseAt"),
          ctx.principal.id,
        ],
      );
      await client.query(
        `insert into project_memberships (tenant_id, project_id, user_id, role)
         values ($1, $2, $3, 'lead')
         on conflict (project_id, user_id) do nothing`,
        [ctx.tenantId, result.rows[0].id, ctx.principal.id],
      );
      await this.recordAudit(client, ctx, "admin_action", "project", result.rows[0].id, "project_create", "Project created", {}, req);
      return result.rows[0];
    });
  }

  async getProject(ctx: AuthContext, projectId: string) {
    const id = v.uuid(projectId, "projectId");
    return withTenantClient(this.pool, this.dbContext(ctx), async (client) => {
      const result = await client.query(
        `select id, name, client_name as "clientName", site_address as "siteAddress", trade, status,
                is_archived as "isArchived", submission_deadline as "submissionDeadline", tender_close_at as "tenderCloseAt",
                created_at as "createdAt", updated_at as "updatedAt"
           from projects
          where id = $1`,
        [id],
      );
      return result.rows[0] ?? this.notFound("project");
    });
  }

  async updateProject(ctx: AuthContext, projectId: string, body: Record<string, unknown>, req?: AuthedRequest) {
    const id = v.uuid(projectId, "projectId");
    const trade = body.trade === undefined ? null : api.enumValue(body.trade, "trade", api.tradePackages);
    const status = body.status === undefined ? null : api.enumValue(body.status, "status", api.projectStatuses);
    return withTenantClient(this.pool, this.dbContext(ctx), async (client) => {
      const result = await client.query(
        `update projects
            set name = coalesce($2, name),
                client_name = coalesce($3, client_name),
                site_address = coalesce($4, site_address),
                trade = coalesce($5::trade_package, trade),
                status = coalesce($6::project_status, status),
                submission_deadline = coalesce($7, submission_deadline),
                tender_close_at = coalesce($8, tender_close_at)
          where id = $1 and is_archived = false
          returning id, name, client_name as "clientName", trade, status`,
        [
          id,
          api.optionalString(body.name),
          api.optionalString(body.clientName),
          api.optionalString(body.siteAddress),
          trade,
          status,
          api.optionalDate(body.submissionDeadline, "submissionDeadline"),
          api.optionalDate(body.tenderCloseAt, "tenderCloseAt"),
        ],
      );
      const row = result.rows[0] ?? this.notFound("project");
      await this.recordAudit(client, ctx, "admin_action", "project", id, "project_update", "Project updated", {}, req);
      return row;
    });
  }

  async archiveProject(ctx: AuthContext, projectId: string, archived: boolean, req?: AuthedRequest) {
    await this.auth.requireTenantPermission(ctx, "project.manage", req);
    const id = v.uuid(projectId, "projectId");
    return withTenantClient(this.pool, this.dbContext(ctx), async (client) => {
      const result = await client.query(
        `update projects
            set is_archived = $2, archived_at = case when $2 then now() else null end,
                status = case when $2 then 'archived'::project_status else 'active'::project_status end
          where id = $1
          returning id, is_archived as "isArchived", status`,
        [id, archived],
      );
      const row = result.rows[0] ?? this.notFound("project");
      await this.recordAudit(client, ctx, "admin_action", "project", id, archived ? "project_archive" : "project_unarchive", archived ? "Project archived" : "Project unarchived", {}, req);
      return row;
    });
  }

  async initiateUpload(ctx: AuthContext, projectId: string, body: Record<string, unknown>, req?: AuthedRequest, forcedDocType?: string) {
    const pid = v.uuid(projectId, "projectId");
    const docType = api.enumValue(forcedDocType ?? body.docType, "docType", api.documentTypes);
    if (!uploadDocTypes.has(docType)) throw new BadRequestException("docType cannot be uploaded through this endpoint");
    if (docType === "vendor_catalogue") await this.auth.requireTenantPermission(ctx, "vendor.manage", req);
    const filename = api.safeFilename(body.filename);
    const mimeType = v.string(body.mimeType, "mimeType").toLowerCase();
    this.assertAllowedMime(docType, mimeType);
    const sizeBytes = api.positiveInt(body.sizeBytes, "sizeBytes");
    const bucket = process.env.S3_UPLOAD_BUCKET ?? process.env.S3_BUCKET ?? "submitsense-dev-uploads";
    const objectKey = `tenants/${ctx.tenantId}/projects/${pid}/${docType}/${randomUUID()}-${filename}`;
    const expiresSeconds = Math.min(Number(process.env.S3_UPLOAD_EXPIRES_SECONDS ?? 900), 900);
    const signed = this.presignPutObject(bucket, objectKey, mimeType, expiresSeconds);
    await withTenantClient(this.pool, this.dbContext(ctx), async (client) => {
      await this.requireProject(client, pid, false);
      await this.recordAudit(client, ctx, "document_upload", "project", pid, "upload_initiated", "Document upload initiated", { project_id: pid, docType, objectKey, sizeBytes }, req);
    });
    return { bucket, objectKey, uploadUrl: signed.url, expiresAt: signed.expiresAt, requiredHeaders: { "content-type": mimeType } };
  }

  async finalizeUpload(ctx: AuthContext, projectId: string, body: Record<string, unknown>, idempotencyKey: string, req?: AuthedRequest) {
    const pid = v.uuid(projectId, "projectId");
    const docType = api.enumValue(body.docType, "docType", api.documentTypes);
    if (docType === "vendor_catalogue") await this.auth.requireTenantPermission(ctx, "vendor.manage", req);
    const bucket = api.optionalString(body.bucket) ?? process.env.S3_UPLOAD_BUCKET ?? process.env.S3_BUCKET ?? "submitsense-dev-uploads";
    const objectKey = v.string(body.objectKey, "objectKey");
    const prefix = `tenants/${ctx.tenantId}/projects/${pid}/`;
    if (!objectKey.startsWith(prefix)) throw new BadRequestException("objectKey is outside tenant/project scope");
    const mimeType = v.string(body.mimeType, "mimeType").toLowerCase();
    this.assertAllowedMime(docType, mimeType);
    const checksum = api.hexSha256(body.checksumSha256);
    const jobType = ingestJobType[docType] ?? "ingest_document";
    return withTenantClient(this.pool, this.dbContext(ctx), async (client) => {
      await this.requireProject(client, pid, false);
      const doc = await client.query<{ id: string }>(
        `insert into documents (tenant_id, project_id, doc_type, title, original_filename, storage_bucket, object_key,
                                checksum_sha256, mime_type, size_bytes, s3_version_id, kms_key_arn, uploaded_by)
         values ($1, $2, $3::document_type, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         on conflict (storage_bucket, object_key) do update
           set checksum_sha256 = excluded.checksum_sha256,
               mime_type = excluded.mime_type,
               size_bytes = excluded.size_bytes,
               s3_version_id = excluded.s3_version_id,
               kms_key_arn = excluded.kms_key_arn
         returning id, doc_type as "docType", title, object_key as "objectKey"`,
        [
          ctx.tenantId,
          pid,
          docType,
          api.optionalString(body.title) ?? api.safeFilename(body.originalFilename ?? "uploaded document"),
          api.optionalString(body.originalFilename),
          bucket,
          objectKey,
          checksum,
          mimeType,
          api.positiveInt(body.sizeBytes, "sizeBytes"),
          api.optionalString(body.s3VersionId),
          api.optionalString(body.kmsKeyArn),
          ctx.principal.id,
        ],
      );
      const job = await this.enqueueDocumentJob(client, ctx, doc.rows[0].id, jobType, `document_finalize:${idempotencyKey}`, { projectId: pid, docType });
      await this.recordAudit(client, ctx, "document_upload", "document", doc.rows[0].id, "upload_finalized", "Document upload finalised", { project_id: pid, jobId: job.id, docType }, req);
      return { document: doc.rows[0], job };
    });
  }

  async jobStatus(ctx: AuthContext, projectId: string, jobId: string) {
    const pid = v.uuid(projectId, "projectId");
    const jid = v.uuid(jobId, "jobId");
    return withTenantClient(this.pool, this.dbContext(ctx), async (client) => {
      const result = await client.query(
        `select j.id, j.job_type as "jobType", j.status, j.attempts, j.max_attempts as "maxAttempts",
                j.last_error as "lastError", j.error_details as "errorDetails", j.worker_output as "workerOutput",
                j.started_at as "startedAt", j.finished_at as "finishedAt", j.created_at as "createdAt"
           from processing_jobs j
           left join documents d on d.id = j.document_id and d.tenant_id = j.tenant_id
          where j.id = $1 and coalesce(d.project_id::text, j.worker_output->>'projectId') = $2`,
        [jid, pid],
      );
      return result.rows[0] ?? this.notFound("job");
    });
  }

  async listWorksections(ctx: AuthContext, projectId: string) {
    const pid = v.uuid(projectId, "projectId");
    return withTenantClient(this.pool, this.dbContext(ctx), async (client) => {
      const result = await client.query(
        `select ws.id, ws.code, ws.title, ws.sequence, ws.is_superseded as "isSuperseded",
                ws.source_page_from as "sourcePageFrom", ws.source_page_to as "sourcePageTo",
                coalesce(jsonb_agg(jsonb_build_object(
                  'id', c.id, 'clauseNumber', c.clause_number, 'heading', c.heading,
                  'sourcePage', c.source_page, 'isSuperseded', c.is_superseded
                ) order by c.sequence) filter (where c.id is not null), '[]'::jsonb) as clauses
           from worksections ws
           left join clauses c on c.worksection_id = ws.id and c.tenant_id = ws.tenant_id
          where ws.project_id = $1
          group by ws.id
          order by ws.sequence nulls last, ws.code`,
        [pid],
      );
      return result.rows;
    });
  }

  async listClauses(ctx: AuthContext, projectId: string, worksectionId: string) {
    const pid = v.uuid(projectId, "projectId");
    const wid = v.uuid(worksectionId, "worksectionId");
    return withTenantClient(this.pool, this.dbContext(ctx), async (client) => {
      const result = await client.query(
        `select c.id, c.clause_number as "clauseNumber", c.heading, c.is_hold_point as "isHoldPoint",
                c.is_superseded as "isSuperseded", c.source_page as "sourcePage",
                cr.id as "clauseReferenceId", cr.reference_label as "referenceLabel"
           from clauses c
           join worksections ws on ws.id = c.worksection_id and ws.tenant_id = c.tenant_id
           left join clause_references cr on cr.clause_id = c.id and cr.tenant_id = c.tenant_id
          where ws.project_id = $1 and c.worksection_id = $2
          order by c.sequence nulls last, c.clause_number`,
        [pid, wid],
      );
      return result.rows;
    });
  }

  async listRequirements(ctx: AuthContext, projectId: string, query: Record<string, unknown>) {
    const pid = v.uuid(projectId, "projectId");
    const category = api.optionalString(query.category);
    return withTenantClient(this.pool, this.dbContext(ctx), async (client) => {
      const result = await client.query(
        `select sr.id, sr.category, sr.title, sr.description, sr.is_hold_point as "isHoldPoint",
                sr.source_page as "sourcePage", sr.confidence, ws.code as "worksectionCode",
                c.clause_number as "clauseNumber", cr.reference_label as "referenceLabel"
           from submittal_requirements sr
           join worksections ws on ws.id = sr.worksection_id and ws.tenant_id = sr.tenant_id
           left join clauses c on c.id = sr.clause_id and c.tenant_id = sr.tenant_id
           left join clause_references cr on cr.id = sr.clause_reference_id and cr.tenant_id = sr.tenant_id
          where sr.project_id = $1 and sr.archived_at is null
            and ($2::text is null or sr.category::text = $2)
          order by ws.code, c.sequence nulls last, sr.title`,
        [pid, category],
      );
      return result.rows;
    });
  }

  async listRegister(ctx: AuthContext, projectId: string, query: Record<string, unknown>) {
    const pid = v.uuid(projectId, "projectId");
    const overdue = query.overdue === undefined ? null : String(query.overdue).toLowerCase() === "true" ? true : String(query.overdue).toLowerCase() === "false" ? false : (() => { throw new BadRequestException("overdue must be true or false"); })();
    const sort = String(query.sort ?? "due_date");
    const sortSql = new Map([
      ["due_date", "ri.due_date nulls last"],
      ["status", "ri.status"],
      ["title", "ri.title"],
      ["created_at", "ri.created_at desc"],
    ]).get(sort) ?? "ri.due_date nulls last";
    return withTenantClient(this.pool, this.dbContext(ctx), async (client) => {
      const result = await client.query(
        `select ri.id, ri.title, ri.description, ri.status, ri.due_date as "dueDate",
                ri.responsible_user_id as "responsibleUserId", u.full_name as "responsibleName",
                ri.consultant_platform_ref as "consultantPlatformRef", ri.consultant_response_ref as "consultantResponseRef",
                ri.consultant_response_at as "consultantResponseAt", ri.revision,
                sr.category, cr.reference_label as "referenceLabel", ws.code as "worksectionCode",
                coalesce(ri.due_date < (now() at time zone 'Australia/Sydney')::date and ri.status not in ('closed', 'cancelled'), false) as overdue
           from register_items ri
           left join users u on u.id = ri.responsible_user_id
           left join submittal_requirements sr on sr.id = ri.requirement_id and sr.tenant_id = ri.tenant_id
           left join clause_references cr on cr.id = sr.clause_reference_id and cr.tenant_id = sr.tenant_id
           left join worksections ws on ws.id = sr.worksection_id and ws.tenant_id = sr.tenant_id
          where ri.project_id = $1 and ri.archived_at is null
            and ($2::text is null or ri.status::text = $2)
            and ($3::uuid is null or ri.responsible_user_id = $3)
            and ($4::date is null or ri.due_date <= $4)
            and ($5::uuid is null or exists (select 1 from package_items pi where pi.tenant_id = ri.tenant_id and pi.register_item_id = ri.id and pi.package_id = $5))
            and ($6::date is null or ri.due_date >= $6)
            and ($7::boolean is null or coalesce(ri.due_date < (now() at time zone 'Australia/Sydney')::date and ri.status not in ('closed', 'cancelled'), false) = $7)
          order by ${sortSql}`,
        [
          pid,
          api.optionalString(query.status),
          api.optionalUuid(query.assignedUserId, "assignedUserId"),
          api.optionalDate(query.dueBefore, "dueBefore"),
          api.optionalUuid(query.packageId, "packageId"),
          api.optionalDate(query.dueAfter, "dueAfter"),
          overdue,
        ],
      );
      return result.rows;
    });
  }

  async assignRegisterItem(ctx: AuthContext, projectId: string, itemId: string, body: Record<string, unknown>, req?: AuthedRequest) {
    const pid = v.uuid(projectId, "projectId");
    const id = v.uuid(itemId, "itemId");
    const userId = api.optionalUuid(body.userId, "userId");
    return withTenantClient(this.pool, this.dbContext(ctx), async (client) => {
      await this.requireActiveTenantMember(client, userId);
      const result = await client.query(
        `update register_items set responsible_user_id = $3 where project_id = $1 and id = $2 returning id, responsible_user_id as "responsibleUserId"`,
        [pid, id, userId],
      );
      const row = result.rows[0] ?? this.notFound("register item");
      await this.recordAudit(client, ctx, "status_change", "register_item", id, "register_assign", "Register item assigned", { project_id: pid, userId }, req);
      return row;
    });
  }

  async updateRegisterDeadline(ctx: AuthContext, projectId: string, itemId: string, body: Record<string, unknown>, req?: AuthedRequest) {
    const pid = v.uuid(projectId, "projectId");
    const id = v.uuid(itemId, "itemId");
    const dueDate = api.optionalDate(body.dueDate, "dueDate");
    return withTenantClient(this.pool, this.dbContext(ctx), async (client) => {
      const result = await client.query(
        `update register_items set due_date = $3 where project_id = $1 and id = $2 returning id, due_date as "dueDate"`,
        [pid, id, dueDate],
      );
      const row = result.rows[0] ?? this.notFound("register item");
      await this.recordAudit(client, ctx, "status_change", "register_item", id, "deadline_update", "Register item deadline updated", { project_id: pid, dueDate }, req);
      return row;
    });
  }

  async transitionRegisterStatus(ctx: AuthContext, projectId: string, itemId: string, body: Record<string, unknown>) {
    const pid = v.uuid(projectId, "projectId");
    const id = v.uuid(itemId, "itemId");
    const next = api.enumValue(body.status, "status", api.submittalStatuses);
    if (next === "human_approved") throw new BadRequestException("use the human sign-off endpoint for human_approved");
    return withTenantClient(this.pool, this.dbContext(ctx), async (client) => {
      const current = await client.query<{ status: keyof typeof transitions }>(`select status from register_items where project_id = $1 and id = $2`, [pid, id]);
      const from = current.rows[0]?.status ?? this.notFound("register item");
      if (!(transitions[from] as string[]).includes(next)) throw new BadRequestException(`invalid status transition ${from} -> ${next}`);
      const result = await client.query(
        `update register_items
            set status = $3::submittal_status,
                submitted_at = case when $3 = 'submitted' then now() else submitted_at end,
                closed_at = case when $3 = 'closed' then now() else closed_at end,
                consultant_response_ref = coalesce($4, consultant_response_ref),
                consultant_response_at = case when $4::text is not null then now() else consultant_response_at end
          where project_id = $1 and id = $2
          returning id, status`,
        [pid, id, next, api.optionalString(body.consultantResponseRef)],
      );
      return result.rows[0];
    });
  }

  async humanSignOff(ctx: AuthContext, projectId: string, body: Record<string, unknown>) {
    const pid = v.uuid(projectId, "projectId");
    const itemIds = api.uuidArray(body.itemIds, "itemIds");
    const comment = api.optionalString(body.comment);
    return withTenantClient(this.pool, this.dbContext(ctx), async (client) => {
      const result = await client.query(
        `update register_items
            set status = 'human_approved',
                human_approved_by = $3,
                human_approved_at = now(),
                human_approval_note = $4
          where project_id = $1 and id = any($2::uuid[]) and status = 'submitted'
          returning id, status, human_approved_at as "humanApprovedAt"`,
        [pid, itemIds, ctx.principal.id, comment],
      );
      if (result.rowCount !== itemIds.length) throw new BadRequestException("all itemIds must exist in the project and be submitted");
      return { signedOffBy: ctx.principal.id, itemIds: result.rows.map((row) => row.id), timestamp: result.rows[0]?.humanApprovedAt };
    });
  }

  async requestRegisterExport(ctx: AuthContext, projectId: string, body: Record<string, unknown>, idempotencyKey: string, req?: AuthedRequest) {
    const pid = v.uuid(projectId, "projectId");
    const format = api.enumValue(body.format ?? "csv", "format", api.registerExportFormats);
    return withTenantClient(this.pool, this.dbContext(ctx), async (client) => this.createExportJob(client, ctx, pid, null, `register_${format}`, `register_export:${format}:${idempotencyKey}`, req));
  }

  async listPhysicalDeliverables(ctx: AuthContext, projectId: string) {
    const pid = v.uuid(projectId, "projectId");
    return withTenantClient(this.pool, this.dbContext(ctx), async (client) => {
      const result = await client.query(
        `select pd.id, pd.register_item_id as "registerItemId", pd.kind, pd.status, pd.description, pd.quantity,
                pd.tracking_ref as "trackingRef", pd.responsible_user_id as "responsibleUserId",
                pd.sent_at as "sentAt", pd.received_at as "receivedAt", pd.returned_at as "returnedAt",
                pd.due_date as "dueDate", pd.notes, pd.attachment_document_id as "attachmentDocumentId"
           from physical_deliverables pd
           join register_items ri on ri.id = pd.register_item_id and ri.tenant_id = pd.tenant_id
          where ri.project_id = $1
          order by pd.created_at desc`,
        [pid],
      );
      return result.rows;
    });
  }

  async createPhysicalDeliverable(ctx: AuthContext, projectId: string, itemId: string, body: Record<string, unknown>, req?: AuthedRequest) {
    const pid = v.uuid(projectId, "projectId");
    const rid = v.uuid(itemId, "itemId");
    const kind = api.enumValue(body.kind, "kind", api.physicalKinds);
    const status = api.enumValue(body.status ?? "required", "status", api.physicalStatuses);
    const responsibleUserId = api.optionalUuid(body.responsibleUserId, "responsibleUserId");
    return withTenantClient(this.pool, this.dbContext(ctx), async (client) => {
      await this.requireRegisterItem(client, pid, rid);
      await this.requireActiveTenantMember(client, responsibleUserId);
      const result = await client.query(
        `insert into physical_deliverables (tenant_id, register_item_id, kind, status, description, quantity, tracking_ref, responsible_user_id, due_date, notes, attachment_document_id)
         values ($1, $2, $3::physical_deliverable_type, $4::physical_deliverable_status, $5, $6, $7, $8, $9, $10, $11)
         returning id, register_item_id as "registerItemId", kind, status`,
        [
          ctx.tenantId,
          rid,
          kind,
          status,
          api.optionalString(body.description),
          api.positiveInt(body.quantity, "quantity"),
          api.optionalString(body.trackingRef),
          responsibleUserId,
          api.optionalDate(body.dueDate, "dueDate"),
          api.optionalString(body.notes),
          body.attachmentDocumentId ? await this.requireUsableDocument(client, pid, v.uuid(body.attachmentDocumentId, "attachmentDocumentId")) : null,
        ],
      );
      await this.recordAudit(client, ctx, "status_change", "physical_deliverable", result.rows[0].id, "physical_deliverable_create", "Physical deliverable status record created", { project_id: pid, registerItemId: rid }, req);
      return result.rows[0];
    });
  }

  async updatePhysicalDeliverable(ctx: AuthContext, projectId: string, deliverableId: string, body: Record<string, unknown>, req?: AuthedRequest) {
    const pid = v.uuid(projectId, "projectId");
    const id = v.uuid(deliverableId, "deliverableId");
    const status = body.status === undefined ? null : api.enumValue(body.status, "status", api.physicalStatuses);
    const has = (field: string) => Object.prototype.hasOwnProperty.call(body, field);
    const responsibleUserId = has("responsibleUserId") ? api.optionalUuid(body.responsibleUserId, "responsibleUserId") : null;
    return withTenantClient(this.pool, this.dbContext(ctx), async (client) => {
      if (has("responsibleUserId")) await this.requireActiveTenantMember(client, responsibleUserId);
      const attachmentDocumentId = has("attachmentDocumentId") && body.attachmentDocumentId
        ? await this.requireUsableDocument(client, pid, v.uuid(body.attachmentDocumentId, "attachmentDocumentId"))
        : null;
      const result = await client.query(
        `update physical_deliverables pd
            set status = coalesce($3::physical_deliverable_status, pd.status),
                tracking_ref = case when $4 then $5 else pd.tracking_ref end,
                sent_at = case when $6 then $7 else pd.sent_at end,
                received_at = case when $8 then $9 else pd.received_at end,
                returned_at = case when $10 then $11 else pd.returned_at end,
                due_date = case when $12 then $13 else pd.due_date end,
                notes = case when $14 then $15 else pd.notes end,
                attachment_document_id = case when $16 then $17 else pd.attachment_document_id end,
                responsible_user_id = case when $18 then $19 else pd.responsible_user_id end
           from register_items ri
          where pd.id = $1 and pd.register_item_id = ri.id and ri.project_id = $2
          returning pd.id, pd.status, pd.tracking_ref as "trackingRef", pd.due_date as "dueDate", pd.notes,
                    pd.attachment_document_id as "attachmentDocumentId", pd.responsible_user_id as "responsibleUserId"`,
        [
          id,
          pid,
          status,
          has("trackingRef"),
          api.optionalString(body.trackingRef),
          has("sentAt"),
          api.optionalDate(body.sentAt, "sentAt"),
          has("receivedAt"),
          api.optionalDate(body.receivedAt, "receivedAt"),
          has("returnedAt"),
          api.optionalDate(body.returnedAt, "returnedAt"),
          has("dueDate"),
          api.optionalDate(body.dueDate, "dueDate"),
          has("notes"),
          api.optionalString(body.notes),
          has("attachmentDocumentId"),
          attachmentDocumentId,
          has("responsibleUserId"),
          responsibleUserId,
        ],
      );
      const row = result.rows[0] ?? this.notFound("physical deliverable");
      await this.recordAudit(client, ctx, "status_change", "physical_deliverable", id, "physical_deliverable_update", "Physical deliverable status updated", { project_id: pid }, req);
      return row;
    });
  }

  async createVendorCatalogue(ctx: AuthContext, projectId: string, body: Record<string, unknown>, req?: AuthedRequest) {
    await this.auth.requireTenantPermission(ctx, "vendor.manage", req);
    const pid = v.uuid(projectId, "projectId");
    const vendorId = v.uuid(body.vendorId, "vendorId");
    const sourceDocumentId = api.optionalUuid(body.sourceDocumentId, "sourceDocumentId");
    return withTenantClient(this.pool, this.dbContext(ctx), async (client) => {
      if (sourceDocumentId) await this.requireProjectDocument(client, pid, sourceDocumentId);
      const result = await client.query(
        `insert into vendor_catalogues (tenant_id, vendor_id, name, source_document_id, version)
         values ($1, $2, $3, $4, $5)
         returning id, vendor_id as "vendorId", name, source_document_id as "sourceDocumentId", version`,
        [ctx.tenantId, vendorId, v.string(body.name, "name"), sourceDocumentId, api.optionalString(body.version)],
      );
      await this.recordAudit(client, ctx, "document_upload", "vendor_catalogue", result.rows[0].id, "vendor_catalogue_create", "Vendor catalogue created", { project_id: pid, sourceDocumentId }, req);
      return result.rows[0];
    });
  }

  async vendorCatalogueParseStatus(ctx: AuthContext, projectId: string, catalogueId: string) {
    const pid = v.uuid(projectId, "projectId");
    const cid = v.uuid(catalogueId, "catalogueId");
    return withTenantClient(this.pool, this.dbContext(ctx), async (client) => {
      const result = await client.query(
        `select vc.id, vc.name, j.id as "jobId", j.status, j.last_error as "lastError", j.worker_output as "workerOutput"
           from vendor_catalogues vc
           left join documents d on d.id = vc.source_document_id and d.tenant_id = vc.tenant_id
           left join processing_jobs j on j.document_id = vc.source_document_id and j.tenant_id = vc.tenant_id
          where vc.id = $1 and (d.project_id = $2 or vc.source_document_id is null)
          order by j.created_at desc nulls last
          limit 1`,
        [cid, pid],
      );
      return result.rows[0] ?? this.notFound("vendor catalogue");
    });
  }

  async listVendors(ctx: AuthContext, query: Record<string, unknown>) {
    await this.auth.requireTenantPermission(ctx, "vendor.manage");
    const q = api.optionalString(query.q);
    return withTenantClient(this.pool, this.dbContext(ctx), async (client) => {
      const result = await client.query(
        `select id, name, website, contact_email as "contactEmail", contact_phone as "contactPhone"
           from vendors
          where is_archived = false and ($1::text is null or name ilike '%' || $1 || '%')
          order by name`,
        [q],
      );
      return result.rows;
    });
  }

  async listProducts(ctx: AuthContext, query: Record<string, unknown>) {
    await this.auth.requireTenantPermission(ctx, "product.match");
    const q = api.optionalString(query.q);
    return withTenantClient(this.pool, this.dbContext(ctx), async (client) => {
      const result = await client.query(
        `select p.id, p.name, p.model_number as "modelNumber", p.category, v.name as "vendorName"
           from products p
           join vendors v on v.id = p.vendor_id and v.tenant_id = p.tenant_id
          where p.is_archived = false
            and ($1::text is null or p.name ilike '%' || $1 || '%' or coalesce(p.model_number, '') ilike '%' || $1 || '%')
          order by p.name
          limit 100`,
        [q],
      );
      return result.rows;
    });
  }

  async productDetail(ctx: AuthContext, productId: string) {
    await this.auth.requireTenantPermission(ctx, "product.match");
    const id = v.uuid(productId, "productId");
    return withTenantClient(this.pool, this.dbContext(ctx), async (client) => {
      const product = await client.query(
        `select p.id, p.name, p.model_number as "modelNumber", p.category, p.description,
                v.id as "vendorId", v.name as "vendorName"
           from products p join vendors v on v.id = p.vendor_id and v.tenant_id = p.tenant_id
          where p.id = $1 and p.is_archived = false`,
        [id],
      );
      if (!product.rows[0]) return this.notFound("product");
      const attrs = await client.query(`select attr_key as "key", attr_value as "value", unit, source from product_attributes where product_id = $1 order by attr_key`, [id]);
      return { ...product.rows[0], attributes: attrs.rows };
    });
  }

  async productDocuments(ctx: AuthContext, productId: string) {
    await this.auth.requireTenantPermission(ctx, "product.match");
    const id = v.uuid(productId, "productId");
    return withTenantClient(this.pool, this.dbContext(ctx), async (client) => {
      const result = await client.query(
        `select pd.id, pd.doc_role as "docRole", d.id as "documentId", d.title, d.doc_type as "docType", d.object_key as "objectKey"
           from product_documents pd
           join documents d on d.id = pd.document_id and d.tenant_id = pd.tenant_id
          where pd.product_id = $1
          order by pd.doc_role, d.title`,
        [id],
      );
      return result.rows;
    });
  }

  // --- Manual vendor/product entry + review/correction (req f: product review APIs). Lets a tenant
  //     curate its own catalogue without an OCR pipeline; corrections use source='manual_entry' so a
  //     later catalogue re-ingest never overwrites them.
  async createVendor(ctx: AuthContext, body: Record<string, unknown>, req?: AuthedRequest) {
    await this.auth.requireTenantPermission(ctx, "vendor.manage", req);
    return withTenantClient(this.pool, this.dbContext(ctx), async (client) => {
      const result = await client.query(
        `insert into vendors (tenant_id, name, website, contact_email, contact_phone)
         values ($1, $2, $3, $4, $5)
         returning id, name, website, contact_email as "contactEmail", contact_phone as "contactPhone"`,
        [ctx.tenantId, v.string(body.name, "name"), api.optionalString(body.website), api.optionalString(body.contactEmail), api.optionalString(body.contactPhone)],
      );
      await this.recordAudit(client, ctx, "admin_action", "vendor", result.rows[0].id, "vendor_create", "Vendor created", {}, req);
      return result.rows[0];
    });
  }

  async createProduct(ctx: AuthContext, body: Record<string, unknown>, req?: AuthedRequest) {
    await this.auth.requireTenantPermission(ctx, "vendor.manage", req);
    const vendorId = v.uuid(body.vendorId, "vendorId");
    const attributes = this.parseAttributes(body.attributes);
    return withTenantClient(this.pool, this.dbContext(ctx), async (client) => {
      const vendor = await client.query(`select id from vendors where id = $1`, [vendorId]);
      if (!vendor.rows[0]) throw new BadRequestException("vendorId must be an existing tenant vendor");
      const product = await client.query<{ id: string; name: string; model_number: string | null }>(
        `insert into products (tenant_id, vendor_id, catalogue_id, name, model_number, category, description, datasheet_document_id)
         values ($1, $2, $3, $4, $5, $6, $7, $8)
         returning id, name, model_number`,
        [
          ctx.tenantId,
          vendorId,
          api.optionalUuid(body.catalogueId, "catalogueId"),
          v.string(body.name, "name"),
          api.optionalString(body.modelNumber),
          api.optionalString(body.category),
          api.optionalString(body.description),
          api.optionalUuid(body.datasheetDocumentId, "datasheetDocumentId"),
        ],
      );
      await this.writeManualAttributes(client, ctx.tenantId, product.rows[0].id, attributes);
      await this.indexProductEmbedding(client, ctx.tenantId, product.rows[0].id);
      await this.recordAudit(client, ctx, "admin_action", "product", product.rows[0].id, "product_create", "Product created", { vendorId }, req);
      return { id: product.rows[0].id, name: product.rows[0].name, modelNumber: product.rows[0].model_number };
    });
  }

  async updateProduct(ctx: AuthContext, productId: string, body: Record<string, unknown>, req?: AuthedRequest) {
    await this.auth.requireTenantPermission(ctx, "vendor.manage", req);
    const id = v.uuid(productId, "productId");
    const attributes = body.attributes === undefined ? null : this.parseAttributes(body.attributes);
    const archived = body.isArchived === undefined ? null : body.isArchived === true;
    return withTenantClient(this.pool, this.dbContext(ctx), async (client) => {
      const result = await client.query(
        `update products
            set name = coalesce($2, name), model_number = coalesce($3, model_number),
                category = coalesce($4, category), description = coalesce($5, description),
                is_archived = coalesce($6, is_archived)
          where id = $1
          returning id, name, model_number as "modelNumber", is_archived as "isArchived"`,
        [id, api.optionalString(body.name), api.optionalString(body.modelNumber), api.optionalString(body.category), api.optionalString(body.description), archived],
      );
      const row = result.rows[0] ?? this.notFound("product");
      if (attributes) await this.writeManualAttributes(client, ctx.tenantId, id, attributes, true);
      await this.indexProductEmbedding(client, ctx.tenantId, id);
      await this.recordAudit(client, ctx, "admin_action", "product", id, "product_correction", "Product reviewed/corrected", {}, req);
      return row;
    });
  }

  async getBranding(ctx: AuthContext) {
    return withTenantClient(this.pool, this.dbContext(ctx), async (client) => {
      const result = await client.query(`select branding from tenants where id = $1`, [ctx.tenantId]);
      return result.rows[0]?.branding ?? {};
    });
  }

  async updateBranding(ctx: AuthContext, body: Record<string, unknown>, req?: AuthedRequest) {
    await this.auth.requireTenantPermission(ctx, "member.manage", req);
    const patch: Record<string, string | null> = {};
    for (const field of ["companyName", "legalName", "abn", "address", "phone", "email"] as const) {
      if (body[field] !== undefined) patch[field] = api.optionalString(body[field]);
    }
    if (patch.abn && !/^[0-9]{11}$/.test(patch.abn)) throw new BadRequestException("abn must contain 11 digits");
    if (patch.email) patch.email = v.email(patch.email);
    if (body.primaryColour === null || body.primaryColour === "") {
      patch.primaryColour = null;
    } else if (body.primaryColour !== undefined) {
      const colour = v.string(body.primaryColour, "primaryColour");
      if (!/^#[0-9a-f]{6}$/i.test(colour)) throw new BadRequestException("primaryColour must be a six-digit hex colour");
      patch.primaryColour = colour.toUpperCase();
    }
    if (body.logoDocumentId !== undefined) patch.logoDocumentId = api.optionalUuid(body.logoDocumentId, "logoDocumentId");
    return withTenantClient(this.pool, this.dbContext(ctx), async (client) => {
      if (patch.logoDocumentId) {
        const logo = await client.query(`select id from documents where id = $1 and project_id is null and archived_at is null and mime_type in ('image/png', 'image/jpeg')`, [patch.logoDocumentId]);
        if (!logo.rows[0]) throw new BadRequestException("logoDocumentId must reference a tenant-library PNG or JPEG document");
      }
      const result = await client.query(`update tenants set branding = branding || $2::jsonb where id = $1 returning branding`, [ctx.tenantId, JSON.stringify(patch)]);
      await this.recordAudit(client, ctx, "admin_action", "tenant", ctx.tenantId, "branding_update", "Package cover-sheet branding updated", { fields: Object.keys(patch) }, req);
      return result.rows[0]?.branding ?? {};
    });
  }

  // --- Learning-loop consent (req f: tenant opt-in/opt-out) + anonymised aggregation ------------
  async getLearningConsent(ctx: AuthContext) {
    await this.auth.requireTenantPermission(ctx, "member.manage");
    return withTenantClient(this.pool, this.dbContext(ctx), async (client) => {
      const result = await client.query(
        `select learning_loop as "learningLoop", data_use_preferences as "dataUsePreferences", decided_at as "decidedAt"
           from tenant_consents where tenant_id = $1`,
        [ctx.tenantId],
      );
      return result.rows[0] ?? { learningLoop: "unset", dataUsePreferences: {}, decidedAt: null };
    });
  }

  async setLearningConsent(ctx: AuthContext, body: Record<string, unknown>, req?: AuthedRequest) {
    await this.auth.requireTenantPermission(ctx, "member.manage", req);
    const state = api.enumValue(body.learningLoop, "learningLoop", api.consentStates);
    return withTenantClient(this.pool, this.dbContext(ctx), async (client) => {
      const result = await client.query(
        `insert into tenant_consents (tenant_id, learning_loop, decided_by, decided_at)
         values ($1, $2::consent_state, $3, now())
         on conflict (tenant_id) do update set learning_loop = excluded.learning_loop, decided_by = excluded.decided_by, decided_at = now()
         returning learning_loop as "learningLoop", decided_at as "decidedAt"`,
        [ctx.tenantId, state, ctx.principal.id],
      );
      // Opt-out permanently excludes all events collected before this decision.
      if (state === "opted_out") {
        await client.query(`update rejection_learning_events set opted_out = true where tenant_id = $1 and opted_out = false`, [ctx.tenantId]);
      }
      await this.recordAudit(client, ctx, "consent_change", "tenant_consent", ctx.tenantId, `learning_${state}`, `Learning-loop consent set to ${state}`, { learningLoop: state }, req);
      return result.rows[0];
    });
  }

  // Anonymised pattern aggregation, gated on this tenant's opt-in and the DB eligibility filter.
  // Stays inside withTenantClient so RLS scopes it to the tenant (NFR2: no cross-tenant retrieval).
  // Output carries counts + non-identifying dimensions only — no user, no external consultant ref.
  async learningAggregate(ctx: AuthContext, query: Record<string, unknown>) {
    await this.auth.requireTenantPermission(ctx, "risk.review");
    return withTenantClient(this.pool, this.dbContext(ctx), async (client) => {
      const consent = await client.query<{ learning_loop: string }>(`select learning_loop from tenant_consents where tenant_id = $1 for share`, [ctx.tenantId]);
      if (consent.rows[0]?.learning_loop !== "opted_in") return { consent: "not_opted_in", patterns: [] };
      const result = await client.query(
        `select ws.code as "worksectionCode", sr.category::text as "requirementCategory",
                rf.risk_type::text as "riskType", e.consultant_outcome::text as "consultantOutcome",
                count(*)::int as count
           from rejection_learning_events e
           left join risk_flags rf on rf.id = e.risk_flag_id and rf.tenant_id = e.tenant_id
           left join register_items ri on ri.id = e.register_item_id and ri.tenant_id = e.tenant_id
           left join submittal_requirements sr on sr.id = ri.requirement_id and sr.tenant_id = e.tenant_id
           left join worksections ws on ws.id = sr.worksection_id and ws.tenant_id = e.tenant_id
          where e.anonymised_eligible = true and e.opted_out = false and e.consent_state = 'opted_in'
          group by ws.code, sr.category, rf.risk_type, e.consultant_outcome
          order by count desc
          limit 200`,
      );
      return { consent: "opted_in", patterns: result.rows };
    });
  }

  private parseAttributes(value: unknown): { key: string; value: string | null; unit: string | null }[] {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) throw new BadRequestException("attributes must be an array");
    return value.map((a) => {
      const obj = api.object(a);
      return { key: v.string(obj.key, "attributes[].key"), value: api.optionalString(obj.value), unit: api.optionalString(obj.unit) };
    });
  }

  private async writeManualAttributes(client: PoolClient, tenantId: string, productId: string, attrs: { key: string; value: string | null; unit: string | null }[], replace = false) {
    if (replace) await client.query(`delete from product_attributes where tenant_id = $1 and product_id = $2 and source = 'manual_entry'`, [tenantId, productId]);
    for (const a of attrs) {
      await client.query(
        `insert into product_attributes (tenant_id, product_id, attr_key, attr_value, unit, source) values ($1, $2, $3, $4, $5, 'manual_entry')`,
        [tenantId, productId, a.key, a.value, a.unit],
      );
    }
  }

  // Best-effort embedding index for a product (semantic search input). Local deterministic embedder
  // by default; a real AU-hosted model is a processor-approval decision (embedder.ts).
  private async indexProductEmbedding(client: PoolClient, tenantId: string, productId: string) {
    const p = await client.query<{ name: string; model_number: string | null; category: string | null; description: string | null }>(
      `select name, model_number, category, description from products where id = $1`,
      [productId],
    );
    if (!p.rows[0]) return;
    const attrs = await client.query<{ attr_key: string; attr_value: string | null }>(`select attr_key, attr_value from product_attributes where tenant_id = $1 and product_id = $2`, [tenantId, productId]);
    const text = [p.rows[0].name, p.rows[0].model_number, p.rows[0].category, p.rows[0].description, ...attrs.rows.map((a) => `${a.attr_key} ${a.attr_value ?? ""}`), ...extractStandards(p.rows[0].description)].filter(Boolean).join(" ");
    try {
      const embedder = getEmbedder();
      const vec = await embedder.embed(text);
      await client.query(
        `insert into product_embeddings (tenant_id, product_id, embedding_model, embedding)
         values ($1, $2, $3, $4::vector)
         on conflict (product_id, embedding_model) do update set embedding = excluded.embedding, created_at = now()`,
        [tenantId, productId, embedder.model, toVectorLiteral(vec)],
      );
    } catch {
      // semantic index is optional; lexical matching still works without it
    }
  }

  async listProductMatches(ctx: AuthContext, projectId: string) {
    await this.auth.requireTenantPermission(ctx, "product.match");
    const pid = v.uuid(projectId, "projectId");
    return withTenantClient(this.pool, this.dbContext(ctx), async (client) => {
      const result = await client.query(
        `select pm.id, pm.register_item_id as "registerItemId", pm.product_id as "productId",
                p.name as "productName", p.model_number as "modelNumber", v.name as "vendorName",
                pm.confidence, pm.rationale_summary as "rationaleSummary", pm.evidence, pm.decision, pm.decided_at as "decidedAt"
           from product_matches pm
           join register_items ri on ri.id = pm.register_item_id and ri.tenant_id = pm.tenant_id
           join products p on p.id = pm.product_id and p.tenant_id = pm.tenant_id
           join vendors v on v.id = p.vendor_id and v.tenant_id = p.tenant_id
          where ri.project_id = $1
          order by pm.created_at desc`,
        [pid],
      );
      return result.rows;
    });
  }

  async decideProductMatch(ctx: AuthContext, projectId: string, matchId: string, decision: "accepted" | "rejected", req?: AuthedRequest) {
    await this.auth.requireTenantPermission(ctx, "product.match", req);
    const pid = v.uuid(projectId, "projectId");
    const id = v.uuid(matchId, "matchId");
    return withTenantClient(this.pool, this.dbContext(ctx), async (client) => {
      const result = await client.query(
        `update product_matches pm
            set decision = $3::match_decision, decided_by = $4, decided_at = now()
           from register_items ri
          where pm.id = $1 and pm.register_item_id = ri.id and ri.project_id = $2
          returning pm.id, pm.decision, pm.decided_at as "decidedAt"`,
        [id, pid, decision, ctx.principal.id],
      );
      const row = result.rows[0] ?? this.notFound("product match");
      await this.recordAudit(client, ctx, "match", "product_match", id, `match_${decision}`, `Product match ${decision}`, { project_id: pid }, req);
      return row;
    });
  }

  async overrideProductMatch(ctx: AuthContext, projectId: string, body: Record<string, unknown>, req?: AuthedRequest) {
    await this.auth.requireTenantPermission(ctx, "product.match", req);
    const pid = v.uuid(projectId, "projectId");
    const registerItemId = v.uuid(body.registerItemId, "registerItemId");
    const productId = v.uuid(body.productId, "productId");
    return withTenantClient(this.pool, this.dbContext(ctx), async (client) => {
      await this.requireRegisterItem(client, pid, registerItemId);
      const result = await client.query(
        `insert into product_matches (tenant_id, register_item_id, product_id, requirement_id, confidence, rationale_summary, evidence, decision, decided_by, decided_at)
         values ($1, $2, $3, $4, null, $5, $6::jsonb, 'accepted', $7, now())
         returning id, decision`,
        [
          ctx.tenantId,
          registerItemId,
          productId,
          api.optionalUuid(body.requirementId, "requirementId"),
          api.optionalString(body.rationaleSummary) ?? "Human override - needs review trail retained",
          JSON.stringify(api.object(body.evidence)),
          ctx.principal.id,
        ],
      );
      await this.recordAudit(client, ctx, "match", "product_match", result.rows[0].id, "match_override", "Product match overridden by human", { project_id: pid, registerItemId, productId }, req);
      return result.rows[0];
    });
  }

  async requestRematch(ctx: AuthContext, projectId: string, itemId: string, idempotencyKey: string, req?: AuthedRequest) {
    await this.auth.requireTenantPermission(ctx, "product.match", req);
    const pid = v.uuid(projectId, "projectId");
    const rid = v.uuid(itemId, "itemId");
    return withTenantClient(this.pool, this.dbContext(ctx), async (client) => {
      await this.requireRegisterItem(client, pid, rid);
      const job = await this.enqueueProjectJob(client, ctx, pid, "product_rematch", `product_rematch:${idempotencyKey}`, { registerItemId: rid });
      await this.recordAudit(client, ctx, "match", "register_item", rid, "rematch_request", "Product rematch requested", { project_id: pid, jobId: job.id }, req);
      return job;
    });
  }

  async generateRiskFlags(ctx: AuthContext, projectId: string, body: Record<string, unknown>, idempotencyKey: string, req?: AuthedRequest) {
    const pid = v.uuid(projectId, "projectId");
    const packageId = api.optionalUuid(body.packageId, "packageId");
    const registerItemId = api.optionalUuid(body.registerItemId, "registerItemId");
    return withTenantClient(this.pool, this.dbContext(ctx), async (client) => {
      await this.requireProject(client, pid, false);
      if (packageId) await this.requirePackage(client, pid, packageId);
      if (registerItemId) await this.requireRegisterItem(client, pid, registerItemId);
      const job = await this.enqueueProjectJob(client, ctx, pid, "risk_flag_generation", `risk_flags:${idempotencyKey}`, { packageId, registerItemId });
      if (job.inserted) await this.recordAudit(client, ctx, "flag", "project", pid, "risk_generation_request", "Rejection-risk pre-check requested", { project_id: pid, packageId, registerItemId, jobId: job.id }, req);
      return job;
    });
  }

  async listRiskFlags(ctx: AuthContext, projectId: string, query: Record<string, unknown>) {
    const pid = v.uuid(projectId, "projectId");
    return withTenantClient(this.pool, this.dbContext(ctx), async (client) => {
      const result = await client.query(
        `select rf.id, rf.register_item_id as "registerItemId", rf.risk_type as "riskType", rf.severity,
                rf.rule_key as "ruleKey", rf.risk_score as "riskScore", rf.scoring_version as "scoringVersion",
                rf.summary, rf.evidence, rf.state, rf.resolution_note as "resolutionNote",
                cr.reference_label as "referenceLabel", rf.created_at as "createdAt"
           from risk_flags rf
           left join clause_references cr on cr.id = rf.clause_reference_id and cr.tenant_id = rf.tenant_id
          where rf.project_id = $1 and ($2::text is null or rf.state::text = $2)
          order by rf.created_at desc`,
        [pid, api.optionalString(query.state)],
      );
      return result.rows;
    });
  }

  async reviewRiskFlag(ctx: AuthContext, projectId: string, flagId: string, state: "confirmed" | "dismissed" | "resolved", body: Record<string, unknown>, req?: AuthedRequest) {
    const pid = v.uuid(projectId, "projectId");
    const id = v.uuid(flagId, "flagId");
    return withTenantClient(this.pool, this.dbContext(ctx), async (client) => {
      const result = await client.query(
        `update risk_flags
            set state = $3::risk_state, reviewed_by = $4, reviewed_at = now(), resolution_note = coalesce($5, resolution_note)
          where id = $1 and project_id = $2
          returning id, register_item_id, state, reviewed_at as "reviewedAt"`,
        [id, pid, state, ctx.principal.id, api.optionalString(body.comment)],
      );
      const row = result.rows[0] ?? this.notFound("risk flag");
      await this.recordConsentLearningDecision(client, ctx.tenantId, id, row.register_item_id, state);
      await this.recordAudit(client, ctx, "flag", "risk_flag", id, `risk_${state}`, `Risk flag ${state}`, { project_id: pid }, req);
      return row;
    });
  }

  async commentRiskFlag(ctx: AuthContext, projectId: string, flagId: string, body: Record<string, unknown>, req?: AuthedRequest) {
    const pid = v.uuid(projectId, "projectId");
    const id = v.uuid(flagId, "flagId");
    const comment = v.string(body.comment, "comment");
    return withTenantClient(this.pool, this.dbContext(ctx), async (client) => {
      const result = await client.query(
        `update risk_flags
            set resolution_note = concat_ws(E'\n', resolution_note, $3::text)
          where id = $1 and project_id = $2
          returning id, resolution_note as "resolutionNote"`,
        [id, pid, comment],
      );
      const row = result.rows[0] ?? this.notFound("risk flag");
      await this.recordAudit(client, ctx, "flag", "risk_flag", id, "risk_comment", "Risk flag commented", { project_id: pid }, req);
      return row;
    });
  }

  async createRiskTask(ctx: AuthContext, projectId: string, flagId: string, body: Record<string, unknown>, req?: AuthedRequest) {
    const pid = v.uuid(projectId, "projectId");
    const id = v.uuid(flagId, "flagId");
    return withTenantClient(this.pool, this.dbContext(ctx), async (client) => {
      const flag = await client.query<{ register_item_id: string | null; summary: string | null }>(`select register_item_id, summary from risk_flags where id = $1 and project_id = $2`, [id, pid]);
      if (!flag.rows[0]) return this.notFound("risk flag");
      const customLabel = api.optionalString(body.label);
      const label = customLabel ?? `Review likely risk: ${flag.rows[0].summary ?? "source evidence needs reviewer confirmation"}`;
      if (!customLabel) assertSafeStatusLanguage(label);
      const result = await client.query(
        `insert into checklist_items (tenant_id, register_item_id, risk_flag_id, label)
         values ($1, $2, $3, $4)
         on conflict do nothing
         returning id, label, risk_flag_id as "riskFlagId"`,
        [ctx.tenantId, flag.rows[0].register_item_id, id, label],
      );
      const row = result.rows[0] ?? (await client.query(`select id, label, risk_flag_id as "riskFlagId" from checklist_items where risk_flag_id = $1`, [id])).rows[0];
      await this.recordAudit(client, ctx, "flag", "checklist_item", row.id, "risk_task_create", "Human-review checklist task created", { project_id: pid, flagId: id }, req);
      return row;
    });
  }

  async createRiskRfi(ctx: AuthContext, projectId: string, flagId: string, body: Record<string, unknown>, idempotencyKey: string, req?: AuthedRequest) {
    await this.auth.requireTenantPermission(ctx, "rfi.manage", req);
    const pid = v.uuid(projectId, "projectId");
    const id = v.uuid(flagId, "flagId");
    return withTenantClient(this.pool, this.dbContext(ctx), async (client) => {
      const flag = await this.requireRiskFlag(client, pid, id);
      const job = await this.enqueueProjectJob(client, ctx, pid, "rfi_generation", `risk_rfi:${id}:${idempotencyKey}`, this.rfiJobPayload(ctx, body, { riskFlagId: id, registerItemId: flag.register_item_id }));
      if (job.inserted) await this.recordAudit(client, ctx, "rfi_action", "risk_flag", id, "rfi_draft_request", "RFI draft requested from likely risk", { project_id: pid, jobId: job.id }, req);
      return job;
    });
  }

  async generateRfi(ctx: AuthContext, projectId: string, body: Record<string, unknown>, idempotencyKey: string, req?: AuthedRequest) {
    await this.auth.requireTenantPermission(ctx, "rfi.manage", req);
    const pid = v.uuid(projectId, "projectId");
    const riskFlagId = api.optionalUuid(body.riskFlagId, "riskFlagId");
    const registerItemId = api.optionalUuid(body.registerItemId, "registerItemId");
    return withTenantClient(this.pool, this.dbContext(ctx), async (client) => {
      await this.requireProject(client, pid, false);
      if (riskFlagId) await this.requireRiskFlag(client, pid, riskFlagId);
      if (registerItemId) await this.requireRegisterItem(client, pid, registerItemId);
      const job = await this.enqueueProjectJob(client, ctx, pid, "rfi_generation", `rfi_generation:${idempotencyKey}`, this.rfiJobPayload(ctx, body, { riskFlagId, registerItemId }));
      if (job.inserted) await this.recordAudit(client, ctx, "rfi_action", "project", pid, "rfi_draft_request", "RFI draft generation requested", { project_id: pid, riskFlagId, registerItemId, jobId: job.id }, req);
      return job;
    });
  }

  async getRfi(ctx: AuthContext, projectId: string, rfiId: string) {
    await this.auth.requireTenantPermission(ctx, "rfi.manage");
    const pid = v.uuid(projectId, "projectId");
    const id = v.uuid(rfiId, "rfiId");
    return withTenantClient(this.pool, this.dbContext(ctx), async (client) => {
      const result = await client.query(
        `select id, register_item_id as "registerItemId", source_risk_flag_id as "sourceRiskFlagId", title,
                issue_summary as "issueSummary", question, body, conflict_type as "conflictType",
                suggested_attachments as "suggestedAttachments", review_status as "reviewStatus",
                send_status as "sendStatus", reviewed_by as "reviewedBy", reviewed_at as "reviewedAt",
                created_by as "createdBy", created_at as "createdAt", updated_at as "updatedAt"
           from rfi_drafts where id = $1 and project_id = $2`,
        [id, pid],
      );
      const rfi = result.rows[0] ?? this.notFound("RFI draft");
      const clauses = await client.query(
        `select cr.id, cr.reference_label as "referenceLabel", cr.source_page as "sourcePage"
           from rfi_cited_clauses rc join clause_references cr on cr.tenant_id = rc.tenant_id and cr.id = rc.clause_reference_id
          where rc.rfi_id = $1 order by cr.reference_label`,
        [id],
      );
      const documents = await client.query(
        `select d.id, d.title, d.original_filename as "filename", d.doc_type as "docType", rd.note
           from rfi_cited_documents rd join documents d on d.tenant_id = rd.tenant_id and d.id = rd.document_id
          where rd.rfi_id = $1 order by d.title`,
        [id],
      );
      return { ...rfi, clauseReferences: clauses.rows, documentReferences: documents.rows };
    });
  }

  async updateRfi(ctx: AuthContext, projectId: string, rfiId: string, body: Record<string, unknown>, req?: AuthedRequest) {
    await this.auth.requireTenantPermission(ctx, "rfi.manage", req);
    const pid = v.uuid(projectId, "projectId");
    const id = v.uuid(rfiId, "rfiId");
    const has = (field: string) => Object.prototype.hasOwnProperty.call(body, field);
    const clauseReferenceIds = has("clauseReferenceIds") ? api.optionalUuidArray(body.clauseReferenceIds, "clauseReferenceIds") : [];
    const drawingDocumentIds = has("drawingDocumentIds") ? api.optionalUuidArray(body.drawingDocumentIds, "drawingDocumentIds") : [];
    const suggestedAttachmentIds = has("suggestedAttachmentIds") ? api.optionalUuidArray(body.suggestedAttachmentIds, "suggestedAttachmentIds") : [];
    return withTenantClient(this.pool, this.dbContext(ctx), async (client) => {
      let clauseRows: { id: string }[] = [];
      if (has("clauseReferenceIds")) {
        clauseRows = (await client.query<{ id: string }>(
          `select distinct cr.id from clause_references cr
             join submittal_requirements sr on sr.tenant_id = cr.tenant_id and sr.clause_reference_id = cr.id
            where sr.project_id = $1 and cr.id = any($2::uuid[])`,
          [pid, clauseReferenceIds],
        )).rows;
        if (clauseRows.length !== clauseReferenceIds.length) throw new BadRequestException("all clauseReferenceIds must belong to the project");
      }
      const allDocumentIds = [...new Set([...drawingDocumentIds, ...suggestedAttachmentIds])];
      let documentRows: { id: string; title: string; doc_type: string }[] = [];
      if (has("drawingDocumentIds") || has("suggestedAttachmentIds")) {
        documentRows = allDocumentIds.length === 0 ? [] : (await client.query<{ id: string; title: string; doc_type: string }>(
          `select id, title, doc_type::text from documents where id = any($1::uuid[]) and archived_at is null and (project_id is null or project_id = $2)`,
          [allDocumentIds, pid],
        )).rows;
        if (documentRows.length !== allDocumentIds.length) throw new BadRequestException("all RFI document references must belong to the project or tenant library");
      }
      const attachments = documentRows.filter((document) => suggestedAttachmentIds.includes(document.id)).map((document) => ({ documentId: document.id, title: document.title, reason: "Suggested source attachment" }));
      const result = await client.query(
        `update rfi_drafts
            set title = coalesce($3, title),
                issue_summary = coalesce($4, issue_summary),
                question = coalesce($5, question),
                body = coalesce($6, body),
                conflict_type = coalesce($7::rfi_conflict_type, conflict_type),
                suggested_attachments = case when $8 then $9::jsonb else suggested_attachments end,
                review_status = 'in_review'
          where id = $1 and project_id = $2
          returning id, title, issue_summary as "issueSummary", question, conflict_type as "conflictType",
                    suggested_attachments as "suggestedAttachments", review_status as "reviewStatus"`,
        [
          id,
          pid,
          api.optionalString(body.title),
          api.optionalString(body.issueSummary),
          api.optionalString(body.question),
          api.optionalString(body.body),
          body.conflictType === undefined ? null : api.enumValue(body.conflictType, "conflictType", api.rfiConflictTypes),
          has("suggestedAttachmentIds"),
          JSON.stringify(attachments),
        ],
      );
      const row = result.rows[0] ?? this.notFound("RFI draft");
      if (has("clauseReferenceIds")) {
        await client.query(`delete from rfi_cited_clauses where rfi_id = $1`, [id]);
        for (const clause of clauseRows) await client.query(`insert into rfi_cited_clauses (tenant_id, rfi_id, clause_reference_id) values ($1, $2, $3)`, [ctx.tenantId, id, clause.id]);
      }
      if (has("drawingDocumentIds") || has("suggestedAttachmentIds")) {
        await client.query(`delete from rfi_cited_documents where rfi_id = $1`, [id]);
        for (const document of documentRows) await client.query(
          `insert into rfi_cited_documents (tenant_id, rfi_id, document_id, note) values ($1, $2, $3, $4)`,
          [ctx.tenantId, id, document.id, drawingDocumentIds.includes(document.id) ? "Drawing reference" : "Suggested source attachment"],
        );
      }
      await this.recordAudit(client, ctx, "rfi_action", "rfi_draft", id, "rfi_edit", "RFI draft edited", { project_id: pid }, req);
      return row;
    });
  }

  async markRfiReviewed(ctx: AuthContext, projectId: string, rfiId: string, req?: AuthedRequest) {
    await this.auth.requireTenantPermission(ctx, "rfi.manage", req);
    if (ctx.actorType !== "human" || ctx.principal.kind !== "human") throw new ForbiddenException("RFI review requires an active human user");
    const pid = v.uuid(projectId, "projectId");
    const id = v.uuid(rfiId, "rfiId");
    return withTenantClient(this.pool, this.dbContext(ctx), async (client) => {
      const result = await client.query(
        `update rfi_drafts
            set review_status = 'approved', reviewed_by = $3, reviewed_at = now()
          where id = $1 and project_id = $2
          returning id, review_status as "reviewStatus", reviewed_at as "reviewedAt"`,
        [id, pid, ctx.principal.id],
      );
      const row = result.rows[0] ?? this.notFound("RFI draft");
      await this.recordAudit(client, ctx, "rfi_action", "rfi_draft", id, "rfi_review", "RFI draft reviewed by human", { project_id: pid }, req);
      return row;
    });
  }

  async exportRfi(ctx: AuthContext, projectId: string, rfiId: string, idempotencyKey: string, req?: AuthedRequest) {
    await this.auth.requireTenantPermission(ctx, "rfi.manage", req);
    const pid = v.uuid(projectId, "projectId");
    const id = v.uuid(rfiId, "rfiId");
    return withTenantClient(this.pool, this.dbContext(ctx), async (client) => {
      const rfi = await this.requireRfi(client, pid, id);
      if (rfi.review_status !== "approved") throw new BadRequestException("RFI draft requires human review before export handoff");
      return this.createExportJob(client, ctx, pid, null, "rfi_pdf", `rfi_export:${id}:${idempotencyKey}`, req, { rfiId: id });
    });
  }

  async handoffRfi(ctx: AuthContext, projectId: string, rfiId: string, body: Record<string, unknown>, idempotencyKey: string, req?: AuthedRequest) {
    await this.auth.requireTenantPermission(ctx, "rfi.manage", req);
    const pid = v.uuid(projectId, "projectId");
    const id = v.uuid(rfiId, "rfiId");
    const connectionId = v.uuid(body.connectionId, "connectionId");
    return withTenantClient(this.pool, this.dbContext(ctx), async (client) => {
      const rfi = await this.requireRfi(client, pid, id);
      if (rfi.review_status !== "approved") throw new BadRequestException("RFI draft requires human review before send handoff");
      const job = await this.enqueueSyncJob(client, ctx, connectionId, pid, null, "package_push", `rfi_handoff:${id}:${idempotencyKey}`, { rfiId: id });
      await this.recordAudit(client, ctx, "integration_sync", "rfi_draft", id, "rfi_handoff", "RFI handoff requested", { project_id: pid, jobId: job.id }, req);
      return job;
    });
  }

  async createPackage(ctx: AuthContext, projectId: string, body: Record<string, unknown>, idempotencyKey: string, req?: AuthedRequest) {
    const pid = v.uuid(projectId, "projectId");
    const itemIds = api.uuidArray(body.registerItemIds, "registerItemIds");
    if (new Set(itemIds).size !== itemIds.length) throw new BadRequestException("registerItemIds must not contain duplicates");
    const name = api.optionalString(body.name) ?? "Submittal package draft";
    const coverOverrides = v.object(body.coverSheet, "coverSheet");
    assertSafeStatusLanguage(name);
    return withTenantClient(this.pool, this.dbContext(ctx), async (client) => {
      const job = await this.enqueueProjectJob(client, ctx, pid, "package_draft", `package_draft:${idempotencyKey}`, { itemIds });
      if (!job.inserted && job.worker_output?.packageId) {
        const existing = await client.query(`select id, name, status from packages where id = $1 and project_id = $2`, [job.worker_output.packageId, pid]);
        if (!existing.rows[0]) throw new Error("Idempotent package draft resource is missing");
        return { package: existing.rows[0], job };
      }
      await this.requireProject(client, pid, false);
      const cover = await resolveCoverSheet(client, ctx.tenantId, pid, ctx.principal.id, coverOverrides);
      if (cover.logoDocumentId) await this.requireUsableDocument(client, pid, cover.logoDocumentId, ["image/png", "image/jpeg"]);
      const pkg = await client.query<{ id: string }>(
        `insert into packages (tenant_id, project_id, name, assembled_by, cover_sheet, manual_notes)
         values ($1, $2, $3, $4, $5::jsonb, $6)
         returning id, name, status`,
        [ctx.tenantId, pid, name, ctx.principal.id, JSON.stringify(cover), api.optionalString(body.manualNotes)],
      );
      const items = await client.query<{ id: string; register_item_id: string; sequence: number }>(
        `insert into package_items (tenant_id, package_id, register_item_id, sequence)
         select $1, $2, ri.id, selected.ordinality::int
           from unnest($4::uuid[]) with ordinality selected(id, ordinality)
           join register_items ri on ri.id = selected.id and ri.project_id = $3 and ri.archived_at is null
          order by selected.ordinality
         returning id, register_item_id, sequence`,
        [ctx.tenantId, pkg.rows[0].id, pid, itemIds],
      );
      if (items.rowCount !== itemIds.length) throw new BadRequestException("all registerItemIds must belong to the project");
      const attached = await this.attachAcceptedProductDocuments(client, ctx.tenantId, pkg.rows[0].id, pid);
      await client.query(
        `update processing_jobs set status = 'succeeded', finished_at = now(), worker_output = worker_output || $2::jsonb where id = $1`,
        [job.id, JSON.stringify({ packageId: pkg.rows[0].id })],
      );
      await this.recordAudit(client, ctx, "package_generation", "package", pkg.rows[0].id, "package_draft_create", "Package draft created", { project_id: pid, itemIds, jobId: job.id }, req);
      for (const item of items.rows) {
        await this.recordAudit(client, ctx, "package_generation", "package_item", item.id, "package_item_added", "Register item added to package", { project_id: pid, packageId: pkg.rows[0].id, registerItemId: item.register_item_id, sequence: item.sequence }, req);
      }
      for (const document of attached) {
        await this.recordAudit(client, ctx, "package_generation", "package_item", document.package_item_id, "package_file_attached", "Accepted product document attached to package", { project_id: pid, packageId: pkg.rows[0].id, documentId: document.document_id }, req);
      }
      return { package: pkg.rows[0], job: { ...job, status: "succeeded", worker_output: { ...(job.worker_output ?? {}), packageId: pkg.rows[0].id } } };
    });
  }

  async packagePreview(ctx: AuthContext, projectId: string, packageId: string) {
    const pid = v.uuid(projectId, "projectId");
    const id = v.uuid(packageId, "packageId");
    return withTenantClient(this.pool, this.dbContext(ctx), async (client) => {
      const pkg = await client.query(`select id, name, status, current_version as "currentVersion", cover_sheet as "coverSheet", manual_notes as "manualNotes", output_document_id as "outputDocumentId" from packages where id = $1 and project_id = $2`, [id, pid]);
      if (!pkg.rows[0]) return this.notFound("package");
      const items = await client.query(
        `select pi.id as "packageItemId", pi.sequence, pi.included, pi.manual_notes as "manualNotes",
                ri.id as "registerItemId", ri.title, ri.status, ri.due_date as "dueDate",
                ws.code as "worksectionCode", cr.reference_label as "clauseReference", sr.category::text as "requiredEvidence",
                count(distinct d.id)::int as "documentCount",
                coalesce(sum(d.size_bytes) filter (where pid.included), 0)::bigint as "estimatedAttachmentBytes",
                coalesce(jsonb_agg(jsonb_build_object(
                  'id', pid.id, 'documentId', d.id, 'title', d.title, 'filename', d.original_filename,
                  'mimeType', d.mime_type, 'role', pid.doc_role, 'included', pid.included,
                  'sequence', pid.sequence, 'sizeBytes', d.size_bytes
                ) order by pid.sequence, d.title) filter (where d.id is not null), '[]'::jsonb) as documents
           from package_items pi
           join register_items ri on ri.id = pi.register_item_id and ri.tenant_id = pi.tenant_id
           left join submittal_requirements sr on sr.id = ri.requirement_id and sr.tenant_id = ri.tenant_id
           left join worksections ws on ws.id = sr.worksection_id and ws.tenant_id = sr.tenant_id
           left join clause_references cr on cr.id = sr.clause_reference_id and cr.tenant_id = sr.tenant_id
           left join package_item_documents pid on pid.package_item_id = pi.id and pid.tenant_id = pi.tenant_id
           left join documents d on d.id = pid.document_id and d.tenant_id = pid.tenant_id and (d.project_id is null or d.project_id = $2)
          where pi.package_id = $1
          group by pi.id, ri.id, ws.code, cr.reference_label, sr.category
          order by pi.sequence nulls last, ri.title`,
        [id, pid],
      );
      const physical = await client.query(
        `select pd.id, pd.register_item_id as "registerItemId", pd.kind::text, pd.status::text, pd.due_date as "dueDate", pd.notes, pd.attachment_document_id as "attachmentDocumentId"
           from physical_deliverables pd join register_items ri on ri.tenant_id = pd.tenant_id and ri.id = pd.register_item_id
          where ri.project_id = $1 and ri.id in (select register_item_id from package_items where package_id = $2) order by pd.created_at`,
        [pid, id],
      );
      return { package: pkg.rows[0], items: items.rows, physicalDeliverables: physical.rows };
    });
  }

  async addPackageItem(ctx: AuthContext, projectId: string, packageId: string, body: Record<string, unknown>, req?: AuthedRequest) {
    const pid = v.uuid(projectId, "projectId");
    const id = v.uuid(packageId, "packageId");
    const registerItemId = v.uuid(body.registerItemId, "registerItemId");
    return withTenantClient(this.pool, this.dbContext(ctx), async (client) => {
      await this.requirePackage(client, pid, id);
      await this.requireRegisterItem(client, pid, registerItemId);
      const result = await client.query<{ id: string }>(
        `insert into package_items (tenant_id, package_id, register_item_id, sequence, manual_notes)
         select $1, $2, $3, coalesce(max(sequence), 0) + 1, $4 from package_items where package_id = $2
         on conflict (package_id, register_item_id) do update set included = true, manual_notes = coalesce(excluded.manual_notes, package_items.manual_notes)
         returning id`,
        [ctx.tenantId, id, registerItemId, api.optionalString(body.manualNotes)],
      );
      const attached = await this.attachAcceptedProductDocuments(client, ctx.tenantId, id, pid, result.rows[0].id);
      await this.recordAudit(client, ctx, "package_generation", "package_item", result.rows[0].id, "package_item_added", "Register item added to package", { project_id: pid, packageId: id, registerItemId }, req);
      for (const document of attached) await this.recordAudit(client, ctx, "package_generation", "package_item", result.rows[0].id, "package_file_attached", "Accepted product document attached to package", { project_id: pid, packageId: id, documentId: document.document_id }, req);
      return { id: result.rows[0].id, registerItemId, attachedDocumentCount: attached.length };
    });
  }

  async updatePackageItem(ctx: AuthContext, projectId: string, packageId: string, packageItemId: string, body: Record<string, unknown>, req?: AuthedRequest) {
    const pid = v.uuid(projectId, "projectId");
    const id = v.uuid(packageId, "packageId");
    const itemId = v.uuid(packageItemId, "packageItemId");
    const included = body.included === undefined ? null : v.boolean(body.included, "included");
    const sequence = body.sequence === undefined ? null : api.positiveInt(body.sequence, "sequence");
    const hasManualNotes = Object.prototype.hasOwnProperty.call(body, "manualNotes");
    return withTenantClient(this.pool, this.dbContext(ctx), async (client) => {
      const result = await client.query<{ id: string; included: boolean; register_item_id: string }>(
        `update package_items pi set included = coalesce($4, included), sequence = coalesce($5, sequence),
                                    manual_notes = case when $6 then $7 else manual_notes end
          from packages p where pi.id = $1 and pi.package_id = $2 and p.id = pi.package_id and p.project_id = $3
          returning pi.id, pi.included, pi.register_item_id`,
        [itemId, id, pid, included, sequence, hasManualNotes, api.optionalString(body.manualNotes)],
      );
      const row = result.rows[0] ?? this.notFound("package item");
      const action = included === false ? "package_item_removed" : included === true ? "package_item_added" : "package_item_updated";
      await this.recordAudit(client, ctx, "package_generation", "package_item", itemId, action, included === false ? "Register item excluded from package" : "Package item updated", { project_id: pid, packageId: id, registerItemId: row.register_item_id, sequence }, req);
      return row;
    });
  }

  async removePackageItem(ctx: AuthContext, projectId: string, packageId: string, packageItemId: string, req?: AuthedRequest) {
    return this.updatePackageItem(ctx, projectId, packageId, packageItemId, { included: false }, req);
  }

  async attachPackageDocument(ctx: AuthContext, projectId: string, packageId: string, packageItemId: string, body: Record<string, unknown>, req?: AuthedRequest) {
    const pid = v.uuid(projectId, "projectId");
    const id = v.uuid(packageId, "packageId");
    const itemId = v.uuid(packageItemId, "packageItemId");
    const documentId = v.uuid(body.documentId, "documentId");
    const role = api.optionalString(body.role) ?? "attachment";
    return withTenantClient(this.pool, this.dbContext(ctx), async (client) => {
      await this.requireUsableDocument(client, pid, documentId);
      const result = await client.query<{ id: string }>(
        `insert into package_item_documents (tenant_id, package_item_id, document_id, doc_role, sequence)
         select $1, pi.id, $4, $5, coalesce((select max(sequence) + 1 from package_item_documents where package_item_id = pi.id), 0)
           from package_items pi join packages p on p.tenant_id = pi.tenant_id and p.id = pi.package_id
          where pi.id = $2 and pi.package_id = $3 and p.project_id = $6
         on conflict (package_item_id, document_id) do update set included = true, doc_role = excluded.doc_role
         returning id`,
        [ctx.tenantId, itemId, id, documentId, role, pid],
      );
      const row = result.rows[0] ?? this.notFound("package item");
      await this.recordAudit(client, ctx, "package_generation", "package_item", itemId, "package_file_attached", "File attached to package item", { project_id: pid, packageId: id, documentId, role }, req);
      return { id: row.id, packageItemId: itemId, documentId, role };
    });
  }

  async packageVersions(ctx: AuthContext, projectId: string, packageId: string) {
    const pid = v.uuid(projectId, "projectId");
    const id = v.uuid(packageId, "packageId");
    return withTenantClient(this.pool, this.dbContext(ctx), async (client) => {
      await this.requirePackage(client, pid, id);
      const result = await client.query(
        `select pv.id, pv.version_number as "version", pv.status, pv.output_document_id as "outputDocumentId", pv.manifest,
                pv.checksum_sha256 as "checksumSha256", pv.error_message as "errorMessage", pv.created_at as "createdAt"
           from package_versions pv where pv.package_id = $1 order by pv.version_number desc`,
        [id],
      );
      return result.rows;
    });
  }

  async regeneratePackage(ctx: AuthContext, projectId: string, packageId: string, idempotencyKey: string, req?: AuthedRequest) {
    const pid = v.uuid(projectId, "projectId");
    const id = v.uuid(packageId, "packageId");
    return withTenantClient(this.pool, this.dbContext(ctx), async (client) => {
      await this.requirePackage(client, pid, id);
      const job = await this.enqueueProjectJob(client, ctx, pid, "package_generation", `package_regenerate:${id}:${idempotencyKey}`, { packageId: id });
      if (job.inserted) {
        await client.query(`update packages set status = 'assembling' where id = $1`, [id]);
        await this.recordAudit(client, ctx, "package_generation", "package", id, "package_regenerate", "Package regeneration requested", { project_id: pid, jobId: job.id }, req);
      }
      return job;
    });
  }

  async exportPackage(ctx: AuthContext, projectId: string, packageId: string, exportType: "consultant_pdf" | "aconex_bundle", idempotencyKey: string, req?: AuthedRequest) {
    const pid = v.uuid(projectId, "projectId");
    const id = v.uuid(packageId, "packageId");
    return withTenantClient(this.pool, this.dbContext(ctx), async (client) => {
      await this.requirePackage(client, pid, id);
      return this.createExportJob(client, ctx, pid, id, exportType, `package_export:${exportType}:${id}:${idempotencyKey}`, req);
    });
  }

  async dashboard(ctx: AuthContext, projectId: string, query: Record<string, unknown>) {
    const pid = v.uuid(projectId, "projectId");
    return withTenantClient(this.pool, this.dbContext(ctx), async (client) => {
      const status = await client.query(`select status, count(*)::int from register_items where project_id = $1 group by status`, [pid]);
      const due = await client.query(
        `select due_date as "dueDate", count(*)::int
           from register_items
          where project_id = $1 and due_date is not null and status not in ('closed', 'cancelled')
          group by due_date order by due_date limit 30`,
        [pid],
      );
      const overdue = await client.query(`select count(*)::int as count from register_items where project_id = $1 and due_date < (now() at time zone 'Australia/Sydney')::date and status not in ('closed', 'cancelled')`, [pid]);
      const items = await this.listRegister(ctx, pid, query);
      const packages = await client.query(`select id, name, status, current_version as "currentVersion", output_document_id as "outputDocumentId", consultant_platform_ref as "consultantPlatformRef" from packages where project_id = $1 order by created_at desc`, [pid]);
      return { status: status.rows, due: due.rows, overdueCount: overdue.rows[0]?.count ?? 0, packages: packages.rows, items };
    });
  }

  async auditExport(ctx: AuthContext, projectId: string | null, query: Record<string, unknown>) {
    await this.auth.requireTenantPermission(ctx, "audit.read");
    const pid = projectId ? v.uuid(projectId, "projectId") : null;
    return withTenantClient(this.pool, this.dbContext(ctx), async (client) => {
      const result = await client.query(
        `select id, occurred_at as "occurredAt", event_type as "eventType", actor_type as "actorType",
                actor_user_id as "actorUserId", entity_type as "entityType", entity_id as "entityId",
                action, summary, payload, checksum
           from audit_events ae
          where ae.tenant_id = $4::uuid
            and ($1::timestamptz is null or ae.occurred_at >= $1)
            and ($2::timestamptz is null or ae.occurred_at <= $2)
            and (
              $3::uuid is null
              or ae.payload->>'project_id' = $3::text
              or (ae.entity_type = 'project' and ae.entity_id = $3)
              or (ae.entity_type = 'register_item' and exists (select 1 from register_items ri where ri.id = ae.entity_id and ri.project_id = $3))
            )
          order by ae.occurred_at desc
          limit 1000`,
        [api.optionalDate(query.from, "from"), api.optionalDate(query.to, "to"), pid, ctx.tenantId],
      );
      return result.rows;
    });
  }

  async recordLearningEvent(ctx: AuthContext, projectId: string, body: Record<string, unknown>, req?: AuthedRequest) {
    const pid = v.uuid(projectId, "projectId");
    const riskFlagId = api.optionalUuid(body.riskFlagId, "riskFlagId");
    const registerItemId = api.optionalUuid(body.registerItemId, "registerItemId");
    const humanDecision = body.humanDecision === undefined || body.humanDecision === null || body.humanDecision === ""
      ? null
      : api.enumValue(body.humanDecision, "humanDecision", api.riskStates);
    const consultantOutcome = body.consultantOutcome === undefined || body.consultantOutcome === null || body.consultantOutcome === ""
      ? "unknown"
      : api.enumValue(body.consultantOutcome, "consultantOutcome", api.consultantOutcomes);
    return withTenantClient(this.pool, this.dbContext(ctx), async (client) => {
      const consent = await client.query<{ learning_loop: string }>(`select learning_loop from tenant_consents where tenant_id = $1 for share`, [ctx.tenantId]);
      if (consent.rows[0]?.learning_loop !== "opted_in") throw new ForbiddenException("Learning loop consent is not opted in");
      if (registerItemId) await this.requireRegisterItem(client, pid, registerItemId);
      if (riskFlagId) {
        const flag = await this.requireRiskFlag(client, pid, riskFlagId);
        if (registerItemId && flag.register_item_id && flag.register_item_id !== registerItemId) {
          throw new BadRequestException("riskFlagId and registerItemId must refer to the same register item");
        }
      }
      const result = await client.query(
        `insert into rejection_learning_events (tenant_id, risk_flag_id, register_item_id, human_decision, consultant_outcome,
                                                anonymised_eligible, consent_state, opted_out)
         values ($1, $2, $3, $4::risk_state, $5::consultant_outcome, $6, 'opted_in', false)
         returning id, consent_state as "consentState"`,
        [
          ctx.tenantId,
          riskFlagId,
          registerItemId,
          humanDecision,
          consultantOutcome,
          body.anonymisedEligible === true,
        ],
      );
      await this.recordAudit(client, ctx, "flag", "rejection_learning_event", result.rows[0].id, "learning_event_record", "Learning-loop event recorded with tenant consent", { project_id: pid }, req);
      return result.rows[0];
    });
  }

  async publicPlans() {
    const result = await this.pool.query(
      `select key, name, tier, price_cents as "priceCents", currency, billing_interval as "billingInterval", features
         from plans where is_active = true order by price_cents`,
    );
    return result.rows;
  }

  async subscription(ctx: AuthContext) {
    await this.auth.requireTenantPermission(ctx, "billing.manage");
    return withTenantClient(this.pool, this.dbContext(ctx), async (client) => {
      const result = await client.query(
        `select ts.id, ts.status, ts.trial_ends_at as "trialEndsAt", ts.current_period_end as "currentPeriodEnd",
                p.key as "planKey", p.name as "planName", p.tier
           from tenant_subscriptions ts join plans p on p.id = ts.plan_id
          where ts.status in ('trialing', 'active', 'past_due')
          order by ts.created_at desc limit 1`,
      );
      return result.rows[0] ?? null;
    });
  }

  async startTrial(ctx: AuthContext, body: Record<string, unknown>, req?: AuthedRequest) {
    await this.auth.requireTenantPermission(ctx, "billing.manage", req);
    return withTenantClient(this.pool, this.dbContext(ctx), async (client) => {
      const existing = await client.query(`select id, status from tenant_subscriptions where status in ('trialing', 'active', 'past_due') limit 1`);
      if (existing.rows[0]) return existing.rows[0];
      const result = await client.query(
        `insert into tenant_subscriptions (tenant_id, plan_id, status, trial_ends_at)
         select $1, id, 'trialing', now() + interval '14 days'
           from plans where key = $2 and is_active = true
         returning id, status, trial_ends_at as "trialEndsAt"`,
        [ctx.tenantId, api.optionalString(body.planKey) ?? "starter"],
      );
      const row = result.rows[0] ?? this.notFound("plan");
      await this.recordAudit(client, ctx, "billing_event", "tenant_subscription", row.id, "trial_start", "Tenant trial started", {}, req);
      return row;
    });
  }

  async publicArticles(query: Record<string, unknown>) {
    const q = api.optionalString(query.q);
    const result = await this.pool.query(
      `select slug, title, excerpt, seo_title as "seoTitle", seo_description as "seoDescription", published_at as "publishedAt"
         from knowledge_base_articles
        where publication_state = 'published'
          and ($1::text is null or title ilike '%' || $1 || '%' or coalesce(excerpt, '') ilike '%' || $1 || '%')
        order by published_at desc nulls last`,
      [q],
    );
    return result.rows;
  }

  async publicArticle(slug: string) {
    const result = await this.pool.query(
      `select slug, title, body, excerpt, seo_title as "seoTitle", seo_description as "seoDescription", published_at as "publishedAt"
         from knowledge_base_articles
        where slug = $1 and publication_state = 'published'`,
      [v.string(slug, "slug")],
    );
    return result.rows[0] ?? this.notFound("article");
  }

  async contextualHelp(query: Record<string, unknown>) {
    const terms = [query.screen, query.worksection, query.feature, query.riskType].map(api.optionalString).filter(Boolean).join(" ");
    return this.publicArticles({ q: terms || undefined });
  }

  async listConnections(ctx: AuthContext) {
    await this.auth.requireTenantPermission(ctx, "integration.manage");
    return withTenantClient(this.pool, this.dbContext(ctx), async (client) => {
      const result = await client.query(
        `select id, provider, status, external_account_id as "externalAccountId", display_name as "displayName",
                scopes, token_expires_at as "tokenExpiresAt"
           from integration_connections order by provider, display_name`,
      );
      return result.rows;
    });
  }

  async listMappings(ctx: AuthContext, connectionId: string) {
    await this.auth.requireTenantPermission(ctx, "integration.manage");
    const id = v.uuid(connectionId, "connectionId");
    return withTenantClient(this.pool, this.dbContext(ctx), async (client) => {
      const result = await client.query(
        `select id, project_id as "projectId", external_project_id as "externalProjectId", external_project_name as "externalProjectName"
           from external_project_mappings where connection_id = $1 order by external_project_name`,
        [id],
      );
      return result.rows;
    });
  }

  async createMapping(ctx: AuthContext, connectionId: string, body: Record<string, unknown>, req?: AuthedRequest) {
    await this.auth.requireTenantPermission(ctx, "integration.manage", req);
    const id = v.uuid(connectionId, "connectionId");
    const projectId = v.uuid(body.projectId, "projectId");
    return withTenantClient(this.pool, this.dbContext(ctx), async (client) => {
      const result = await client.query(
        `insert into external_project_mappings (tenant_id, connection_id, project_id, external_project_id, external_project_name)
         values ($1, $2, $3, $4, $5)
         on conflict (connection_id, external_project_id) do update
           set project_id = excluded.project_id, external_project_name = excluded.external_project_name
         returning id, project_id as "projectId", external_project_id as "externalProjectId"`,
        [ctx.tenantId, id, projectId, v.string(body.externalProjectId, "externalProjectId"), api.optionalString(body.externalProjectName)],
      );
      await this.recordAudit(client, ctx, "integration_sync", "external_project_mapping", result.rows[0].id, "integration_mapping_upsert", "Integration project mapping saved", { project_id: projectId, connectionId: id }, req);
      return result.rows[0];
    });
  }

  async createSyncJob(ctx: AuthContext, connectionId: string, body: Record<string, unknown>, idempotencyKey: string, req?: AuthedRequest) {
    await this.auth.requireTenantPermission(ctx, "integration.manage", req);
    const id = v.uuid(connectionId, "connectionId");
    const projectId = api.optionalUuid(body.projectId, "projectId");
    const packageId = api.optionalUuid(body.packageId, "packageId");
    const jobType = api.enumValue(body.jobType ?? "package_push", "jobType", api.syncJobTypes);
    return withTenantClient(this.pool, this.dbContext(ctx), async (client) => {
      const job = await this.enqueueSyncJob(client, ctx, id, projectId, packageId, jobType, `integration_sync:${id}:${idempotencyKey}`, api.object(body.payload));
      await this.recordAudit(client, ctx, "integration_sync", "sync_job", job.id, "sync_job_create", "Integration sync job created", { project_id: projectId, connectionId: id }, req);
      return job;
    });
  }

  async syncJobStatus(ctx: AuthContext, jobId: string) {
    await this.auth.requireTenantPermission(ctx, "integration.manage");
    const id = v.uuid(jobId, "jobId");
    return withTenantClient(this.pool, this.dbContext(ctx), async (client) => {
      const result = await client.query(`select id, job_type as "jobType", status, attempts, last_error as "lastError", payload from sync_jobs where id = $1`, [id]);
      return result.rows[0] ?? this.notFound("sync job");
    });
  }

  async integrationErrors(ctx: AuthContext, query: Record<string, unknown>) {
    await this.auth.requireTenantPermission(ctx, "integration.manage");
    return withTenantClient(this.pool, this.dbContext(ctx), async (client) => {
      const result = await client.query(
        `select id, connection_id as "connectionId", sync_job_id as "syncJobId", error_code as "errorCode", message, details, created_at as "createdAt"
           from sync_errors
          where ($1::uuid is null or connection_id = $1)
          order by created_at desc limit 200`,
        [api.optionalUuid(query.connectionId, "connectionId")],
      );
      return result.rows;
    });
  }

  async billingWebhook(body: Record<string, unknown>, idempotencyKey: string, secret: string | undefined, req?: AuthedRequest) {
    this.requireWebhookSecret("BILLING_WEBHOOK_SECRET", secret);
    // Tenant comes from a verified provider identifier, NEVER body.tenantId (compliance: trusted
    // context only). ponytail: shared-secret gate kept; per-provider HMAC signature verification over
    // the raw body is the production hardening (needs raw-body middleware — DevOps/backend).
    const tenantId = await this.resolveBillingTenant(v.string(body.customerId, "customerId"));
    return withTenantClient(this.pool, { tenantId, actorType: "system", userId: null }, async (client) => {
      const job = await this.enqueueProjectJob(client, { tenantId }, null, "billing_webhook", `billing_webhook:${idempotencyKey}`, api.object(body));
      await client.query(
        `insert into audit_events (tenant_id, event_type, actor_type, entity_type, entity_id, action, summary, payload, ip_address, user_agent)
         values ($1, 'billing_event', 'system', 'billing_webhook', $2, 'billing_webhook_received', 'Billing webhook received', $3::jsonb, nullif($4::text, '')::inet, $5)`,
        [tenantId, job.id, JSON.stringify({ request_id: req?.requestId, providerEventId: api.optionalString(body.eventId) }), this.ip(req) ?? "", this.userAgent(req)],
      );
      return job;
    });
  }

  async integrationWebhook(provider: string, body: Record<string, unknown>, idempotencyKey: string, secret: string | undefined, req?: AuthedRequest) {
    this.requireWebhookSecret("INTEGRATION_WEBHOOK_SECRET", secret);
    const connectionId = v.uuid(body.connectionId, "connectionId");
    const checkedProvider = api.enumValue(provider, "provider", api.integrationProviders);
    const externalEventId = api.optionalString(body.externalEventId) ?? idempotencyKey;
    const eventType = api.optionalString(body.eventType);
    const payload = api.object(body.payload);
    // Tenant resolved from the connection's server-side row, NEVER body.tenantId.
    const tenantId = await this.resolveIntegrationTenant(connectionId, checkedProvider);
    return withTenantClient(this.pool, { tenantId, actorType: "system", userId: null }, async (client) => {
      const connection = await client.query(`select 1 from integration_connections where id = $1 and provider = $2::integration_provider and status = 'connected'`, [connectionId, checkedProvider]);
      if (!connection.rows[0]) throw new ForbiddenException("Forbidden");
      const result = await client.query<{ id: string; status: string; inserted: boolean }>(
        `insert into webhook_events (tenant_id, connection_id, provider, external_event_id, event_type, payload)
         values ($1, $2, $3::integration_provider, $4, $5, $6::jsonb)
         on conflict (connection_id, external_event_id) do update set status = webhook_events.status
         returning id, status, (xmax = 0) as inserted`,
        [tenantId, connectionId, checkedProvider, externalEventId, eventType, JSON.stringify(payload)],
      );
      if (!result.rows[0].inserted && result.rows[0].status === "processed") {
        return { id: result.rows[0].id, status: result.rows[0].status };
      }
      if (eventType === "consultant_status") {
        const projectId = v.uuid(payload.projectId, "payload.projectId");
        const registerItemId = v.uuid(payload.registerItemId, "payload.registerItemId");
        const next = v.string(payload.status, "payload.status");
        if (!externalConsultantStatuses.has(next)) throw new BadRequestException("external consultant status must be submitted, revise_and_resubmit, or rejected");
        const mapping = await client.query(
          `select 1 from external_project_mappings where tenant_id = $1 and connection_id = $2 and project_id = $3`,
          [tenantId, connectionId, projectId],
        );
        if (!mapping.rows[0]) throw new BadRequestException("consultant status project is not mapped to this integration connection");
        const current = await client.query<{ status: keyof typeof transitions }>(`select status from register_items where tenant_id = $1 and project_id = $2 and id = $3`, [tenantId, projectId, registerItemId]);
        const from = current.rows[0]?.status ?? this.notFound("register item");
        if (from !== next && !(transitions[from] as string[]).includes(next)) throw new BadRequestException(`invalid status transition ${from} -> ${next}`);
        await client.query(
          `update register_items
              set status = $4::submittal_status,
                  consultant_platform_ref = coalesce($5, consultant_platform_ref),
                  consultant_response_ref = $6,
                  consultant_response_at = now(),
                  submitted_at = case when $4 = 'submitted' then coalesce(submitted_at, now()) else submitted_at end
            where tenant_id = $1 and project_id = $2 and id = $3`,
          [tenantId, projectId, registerItemId, next, api.optionalString(payload.consultantPlatformRef), api.optionalString(payload.responseRef) ?? externalEventId],
        );
        await client.query(
          `insert into audit_events (tenant_id, event_type, actor_type, entity_type, entity_id, action, summary, payload)
           values ($1, 'integration_sync', 'system', 'register_item', $2, 'consultant_response_update', 'Consultant response reference and status recorded', $3::jsonb)`,
          [tenantId, registerItemId, JSON.stringify({ project_id: projectId, provider: checkedProvider, status: next, responseRef: api.optionalString(payload.responseRef) ?? externalEventId })],
        );
        const consultantOutcome = next === "rejected" ? "rejected" : next === "revise_and_resubmit" ? "revise_and_resubmit" : null;
        if (consultantOutcome) {
          const consent = await client.query<{ learning_loop: string }>(`select learning_loop from tenant_consents where tenant_id = $1`, [tenantId]);
          if (consent.rows[0]?.learning_loop === "opted_in") {
            await client.query(
              `insert into rejection_learning_events (tenant_id, risk_flag_id, register_item_id, consultant_outcome, anonymised_eligible, consent_state, opted_out)
               select $1, rf.id, rf.register_item_id, $3::consultant_outcome, true, 'opted_in', false
                 from risk_flags rf
                where rf.tenant_id = $1 and rf.register_item_id = $2
                  and not exists (select 1 from rejection_learning_events e where e.tenant_id = rf.tenant_id and e.risk_flag_id = rf.id and e.opted_out = false)`,
              [tenantId, registerItemId, consultantOutcome],
            );
            await client.query(
              `update rejection_learning_events e set consultant_outcome = $3::consultant_outcome
                 from risk_flags rf
                where e.tenant_id = $1 and e.risk_flag_id = rf.id and rf.register_item_id = $2 and e.opted_out = false`,
              [tenantId, registerItemId, consultantOutcome],
            );
            await client.query(
              `insert into audit_events (tenant_id, event_type, actor_type, entity_type, entity_id, action, summary, payload)
               values ($1, 'flag', 'system', 'register_item', $2, 'learning_outcome_recorded', 'Known consultant outcome recorded for consented learning', $3::jsonb)`,
              [tenantId, registerItemId, JSON.stringify({ project_id: projectId, consultantOutcome })],
            );
          }
        }
      }
      await client.query(
        `insert into audit_events (tenant_id, event_type, actor_type, entity_type, entity_id, action, summary, payload, ip_address, user_agent)
         values ($1, 'integration_sync', 'system', 'webhook_event', $2, 'integration_webhook_received', 'Integration webhook received', $3::jsonb, nullif($4::text, '')::inet, $5)`,
        [tenantId, result.rows[0].id, JSON.stringify({ request_id: req?.requestId, provider: checkedProvider, externalEventId }), this.ip(req) ?? "", this.userAgent(req)],
      );
      await client.query(`update webhook_events set status = 'processed', processed_at = now() where id = $1`, [result.rows[0].id]);
      return { id: result.rows[0].id, status: "processed" };
    });
  }

  private async createExportJob(client: PoolClient, ctx: AuthContext, projectId: string, packageId: string | null, exportType: string, idempotencyKey: string, req?: AuthedRequest, payload: Record<string, unknown> = {}) {
    const job = await this.enqueueProjectJob(client, ctx, projectId, `export_${exportType}`, idempotencyKey, { packageId, exportType, ...payload });
    if (!job.inserted && job.worker_output?.exportId) {
      const existing = await client.query(`select id, export_type as "exportType", status from exports where id = $1 and project_id = $2`, [job.worker_output.exportId, projectId]);
      if (!existing.rows[0]) throw new Error("Idempotent export resource is missing");
      return { export: existing.rows[0], job };
    }
    const result = await client.query<{ id: string }>(
      `insert into exports (tenant_id, project_id, package_id, export_type, requested_by)
       values ($1, $2, $3, $4, $5)
       returning id, export_type as "exportType", status`,
      [ctx.tenantId, projectId, packageId, exportType, ctx.principal.id],
    );
    await this.patchJobOutput(client, job.id, { exportId: result.rows[0].id });
    await this.recordAudit(client, ctx, "export", "export", result.rows[0].id, "export_request", "Export requested", { project_id: projectId, packageId, exportType, jobId: job.id }, req);
    return { export: result.rows[0], job: { ...job, worker_output: { ...(job.worker_output ?? {}), exportId: result.rows[0].id } } };
  }

  private async enqueueDocumentJob(client: PoolClient, ctx: AuthContext, documentId: string, jobType: string, idempotencyKey: string, payload: Record<string, unknown>): Promise<JobRow> {
    const result = await client.query<JobRow>(
      `insert into processing_jobs (tenant_id, document_id, job_type, idempotency_key, worker_output)
       values ($1, $2, $3, $4, $5::jsonb)
       on conflict (tenant_id, idempotency_key) do update set idempotency_key = excluded.idempotency_key
       returning id, job_type, status, worker_output, (xmax = 0) as inserted`,
      [ctx.tenantId, documentId, jobType, idempotencyKey, JSON.stringify(payload)],
    );
    await this.recordAudit(client, ctx, "extraction", "processing_job", result.rows[0].id, "job_enqueue", "Document processing job enqueued", payload);
    return result.rows[0];
  }

  private async enqueueProjectJob(client: PoolClient, ctx: Pick<AuthContext, "tenantId">, projectId: string | null, jobType: string, idempotencyKey: string, payload: Record<string, unknown>): Promise<JobRow> {
    const result = await client.query<JobRow>(
      `insert into processing_jobs (tenant_id, document_id, job_type, idempotency_key, worker_output)
       values ($1, null, $2, $3, $4::jsonb)
       on conflict (tenant_id, idempotency_key) do update set idempotency_key = excluded.idempotency_key
       returning id, job_type, status, worker_output, (xmax = 0) as inserted`,
      [ctx.tenantId, jobType, idempotencyKey, JSON.stringify({ projectId, ...payload })],
    );
    return result.rows[0];
  }

  private async enqueueSyncJob(
    client: PoolClient,
    ctx: AuthContext,
    connectionId: string,
    projectId: string | null,
    packageId: string | null,
    jobType: string,
    idempotencyKey: string,
    payload: Record<string, unknown>,
  ): Promise<JobRow> {
    const result = await client.query<JobRow>(
      `insert into sync_jobs (tenant_id, connection_id, project_id, package_id, job_type, idempotency_key, payload)
       values ($1, $2, $3, $4, $5::sync_job_type, $6, $7::jsonb)
       on conflict (tenant_id, idempotency_key) do update set idempotency_key = excluded.idempotency_key
       returning id, job_type, status, payload as worker_output, (xmax = 0) as inserted`,
      [ctx.tenantId, connectionId, projectId, packageId, jobType, idempotencyKey, JSON.stringify(payload)],
    );
    return result.rows[0];
  }

  private async patchJobOutput(client: PoolClient, jobId: string, patch: Record<string, unknown>) {
    await client.query(`update processing_jobs set worker_output = worker_output || $2::jsonb where id = $1`, [jobId, JSON.stringify(patch)]);
  }

  private rfiJobPayload(ctx: AuthContext, body: Record<string, unknown>, scope: { riskFlagId: string | null; registerItemId: string | null }) {
    return {
      requestedBy: ctx.principal.id,
      riskFlagId: scope.riskFlagId,
      registerItemId: scope.registerItemId,
      title: api.optionalString(body.title),
      issueSummary: api.optionalString(body.issueSummary) ?? api.optionalString(body.body),
      question: api.optionalString(body.question),
      conflictType: body.conflictType === undefined ? null : api.enumValue(body.conflictType, "conflictType", api.rfiConflictTypes),
      clauseReferenceIds: api.optionalUuidArray(body.clauseReferenceIds, "clauseReferenceIds"),
      drawingDocumentIds: api.optionalUuidArray(body.drawingDocumentIds, "drawingDocumentIds"),
      suggestedAttachmentIds: api.optionalUuidArray(body.suggestedAttachmentIds, "suggestedAttachmentIds"),
    };
  }

  private async recordConsentLearningDecision(client: PoolClient, tenantId: string, riskFlagId: string, registerItemId: string | null, state: string) {
    const consent = await client.query<{ learning_loop: string }>(`select learning_loop from tenant_consents where tenant_id = $1`, [tenantId]);
    if (consent.rows[0]?.learning_loop !== "opted_in") return;
    const updated = await client.query(
      `update rejection_learning_events set human_decision = $3::risk_state
        where id = (select id from rejection_learning_events where tenant_id = $1 and risk_flag_id = $2 and opted_out = false order by created_at desc limit 1)`,
      [tenantId, riskFlagId, state],
    );
    if (!updated.rowCount) {
      await client.query(
        `insert into rejection_learning_events (tenant_id, risk_flag_id, register_item_id, human_decision, anonymised_eligible, consent_state, opted_out)
         values ($1, $2, $3, $4::risk_state, true, 'opted_in', false)`,
        [tenantId, riskFlagId, registerItemId, state],
      );
    }
  }

  private async attachAcceptedProductDocuments(client: PoolClient, tenantId: string, packageId: string, projectId: string, onlyPackageItemId: string | null = null) {
    const result = await client.query<{ package_item_id: string; document_id: string }>(
      `with candidates as (
         select pi.id as package_item_id, pd.document_id, pd.doc_role
           from package_items pi
           join product_matches pm on pm.tenant_id = pi.tenant_id and pm.register_item_id = pi.register_item_id and pm.decision = 'accepted'
           join product_documents pd on pd.tenant_id = pm.tenant_id and pd.product_id = pm.product_id
           join documents d on d.tenant_id = pd.tenant_id and d.id = pd.document_id and (d.project_id is null or d.project_id = $3)
          where pi.tenant_id = $1 and pi.package_id = $2 and ($4::uuid is null or pi.id = $4)
         union
         select pi.id, p.datasheet_document_id, 'datasheet'
           from package_items pi
           join product_matches pm on pm.tenant_id = pi.tenant_id and pm.register_item_id = pi.register_item_id and pm.decision = 'accepted'
           join products p on p.tenant_id = pm.tenant_id and p.id = pm.product_id
           join documents d on d.tenant_id = p.tenant_id and d.id = p.datasheet_document_id and (d.project_id is null or d.project_id = $3)
          where pi.tenant_id = $1 and pi.package_id = $2 and p.datasheet_document_id is not null and ($4::uuid is null or pi.id = $4)
         union
         select pi.id, pd.attachment_document_id, case when pd.kind = 'stamped_shop_drawing' then 'stamped_drawing_reference' else 'physical_deliverable_attachment' end
           from package_items pi
           join physical_deliverables pd on pd.tenant_id = pi.tenant_id and pd.register_item_id = pi.register_item_id
           join documents d on d.tenant_id = pd.tenant_id and d.id = pd.attachment_document_id and (d.project_id is null or d.project_id = $3)
          where pi.tenant_id = $1 and pi.package_id = $2 and pd.attachment_document_id is not null and ($4::uuid is null or pi.id = $4)
       )
       insert into package_item_documents (tenant_id, package_item_id, document_id, doc_role, sequence)
       select $1, package_item_id, document_id, doc_role,
              row_number() over (partition by package_item_id order by doc_role, document_id)::int
         from candidates
       on conflict (package_item_id, document_id) do nothing
       returning package_item_id, document_id`,
      [tenantId, packageId, projectId, onlyPackageItemId],
    );
    return result.rows;
  }

  private async requireProject(client: PoolClient, projectId: string, allowArchived: boolean) {
    const result = await client.query(`select id from projects where id = $1 and ($2::boolean or is_archived = false)`, [projectId, allowArchived]);
    if (!result.rows[0]) throw new ForbiddenException("Forbidden");
  }

  private async requireRegisterItem(client: PoolClient, projectId: string, itemId: string) {
    const result = await client.query(`select id from register_items where project_id = $1 and id = $2`, [projectId, itemId]);
    if (!result.rows[0]) throw new NotFoundException("register item not found");
  }

  private async requireActiveTenantMember(client: PoolClient, userId: string | null) {
    if (!userId) return;
    const result = await client.query(`select 1 from tenant_memberships where user_id = $1 and status = 'active'`, [userId]);
    if (!result.rows[0]) throw new BadRequestException("assigned user must be an active tenant member");
  }

  private async requireRiskFlag(client: PoolClient, projectId: string, flagId: string) {
    const result = await client.query<{ register_item_id: string | null }>(`select register_item_id from risk_flags where project_id = $1 and id = $2`, [projectId, flagId]);
    if (!result.rows[0]) throw new NotFoundException("risk flag not found");
    return result.rows[0];
  }

  private async requireProjectDocument(client: PoolClient, projectId: string, documentId: string) {
    const result = await client.query(`select id from documents where project_id = $1 and id = $2`, [projectId, documentId]);
    if (!result.rows[0]) throw new NotFoundException("document not found");
  }

  private async requireUsableDocument(client: PoolClient, projectId: string, documentId: string, allowedMimeTypes?: string[]): Promise<string> {
    const result = await client.query<{ id: string; mime_type: string | null }>(`select id, mime_type from documents where id = $1 and archived_at is null and (project_id is null or project_id = $2)`, [documentId, projectId]);
    if (!result.rows[0]) throw new NotFoundException("document not found");
    if (allowedMimeTypes && !allowedMimeTypes.includes(result.rows[0].mime_type ?? "")) throw new BadRequestException("document type is not allowed here");
    return result.rows[0].id;
  }

  private async requirePackage(client: PoolClient, projectId: string, packageId: string) {
    const result = await client.query(`select id from packages where project_id = $1 and id = $2`, [projectId, packageId]);
    if (!result.rows[0]) throw new NotFoundException("package not found");
  }

  private async requireRfi(client: PoolClient, projectId: string, rfiId: string) {
    const result = await client.query<{ id: string; review_status: string }>(`select id, review_status from rfi_drafts where project_id = $1 and id = $2`, [projectId, rfiId]);
    if (!result.rows[0]) throw new NotFoundException("RFI draft not found");
    return result.rows[0];
  }

  private async recordAudit(
    client: PoolClient,
    ctx: AuthContext,
    eventType: AuditEventType,
    entityType: string,
    entityId: string,
    action: string,
    summary: string,
    payload: Record<string, unknown> = {},
    req?: AuthedRequest,
  ) {
    await client.query(
      `insert into audit_events (tenant_id, event_type, actor_user_id, actor_type, entity_type, entity_id, action, summary, payload, ip_address, user_agent)
       values ($1, $2::audit_event_type, $3, $4, $5, $6, $7, $8, $9::jsonb, nullif($10::text, '')::inet, $11)`,
      [
        ctx.tenantId,
        eventType,
        ctx.principal.id,
        ctx.actorType,
        entityType,
        entityId,
        action,
        summary,
        JSON.stringify({ request_id: req?.requestId, ...payload }),
        this.ip(req) ?? "",
        this.userAgent(req),
      ],
    );
  }

  private assertAllowedMime(docType: string, mimeType: string) {
    const ok =
      mimeType === "application/pdf" ||
      (docType === "vendor_catalogue" && ["text/csv", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "application/vnd.ms-excel"].includes(mimeType)) ||
      (docType === "attachment" && mimeType.startsWith("image/"));
    if (!ok) throw new BadRequestException("mimeType is not allowed for docType");
  }

  private presignPutObject(bucket: string, key: string, mimeType: string, expiresSeconds: number) {
    const accessKey = process.env.AWS_ACCESS_KEY_ID;
    const secretKey = process.env.AWS_SECRET_ACCESS_KEY;
    const region = process.env.AWS_REGION ?? "ap-southeast-2";
    if (!accessKey || !secretKey) throw new ServiceUnavailableException("S3 signing is not configured");
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
    const date = amzDate.slice(0, 8);
    const host = `${bucket}.s3.${region}.amazonaws.com`;
    const scope = `${date}/${region}/s3/aws4_request`;
    const query: Record<string, string> = {
      "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
      "X-Amz-Credential": `${accessKey}/${scope}`,
      "X-Amz-Date": amzDate,
      "X-Amz-Expires": String(expiresSeconds),
      "X-Amz-SignedHeaders": "content-type;host",
      "X-Amz-Content-Sha256": "UNSIGNED-PAYLOAD",
    };
    if (process.env.AWS_SESSION_TOKEN) query["X-Amz-Security-Token"] = process.env.AWS_SESSION_TOKEN;
    const canonicalQuery = Object.keys(query)
      .sort()
      .map((k) => `${this.rfc3986(k)}=${this.rfc3986(query[k])}`)
      .join("&");
    const canonicalUri = `/${key.split("/").map((part) => this.rfc3986(part)).join("/")}`;
    const canonicalHeaders = `content-type:${mimeType}\nhost:${host}\n`;
    const canonicalRequest = ["PUT", canonicalUri, canonicalQuery, canonicalHeaders, "content-type;host", "UNSIGNED-PAYLOAD"].join("\n");
    const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, this.sha256(canonicalRequest)].join("\n");
    const signingKey = this.hmac(this.hmac(this.hmac(this.hmac(`AWS4${secretKey}`, date), region), "s3"), "aws4_request");
    const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");
    return { url: `https://${host}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`, expiresAt: new Date(now.getTime() + expiresSeconds * 1000).toISOString() };
  }

  private hmac(key: string | Buffer, data: string): Buffer {
    return createHmac("sha256", key).update(data).digest();
  }

  private sha256(data: string): string {
    return createHash("sha256").update(data).digest("hex");
  }

  private rfc3986(value: string): string {
    return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  }

  private requireWebhookSecret(envName: string, secret: string | undefined) {
    if (!process.env[envName] || secret !== process.env[envName]) throw new ForbiddenException("Forbidden");
  }

  // Resolve tenant for an unauthenticated webhook from a trusted server-side mapping (SECURITY
  // DEFINER fns in 0015_webhook_tenant_resolvers.sql), never from the request body. Unknown -> 403.
  private async resolveIntegrationTenant(connectionId: string, provider: string): Promise<string> {
    const result = await this.pool.query<{ tenant_id: string | null }>(
      `select app.resolve_integration_tenant($1, $2::integration_provider) as tenant_id`,
      [connectionId, provider],
    );
    const tenantId = result.rows[0]?.tenant_id;
    if (!tenantId) throw new ForbiddenException("Forbidden");
    return tenantId;
  }

  private async resolveBillingTenant(customerId: string): Promise<string> {
    const result = await this.pool.query<{ tenant_id: string | null }>(
      `select app.resolve_billing_tenant('stripe', $1) as tenant_id`,
      [customerId],
    );
    const tenantId = result.rows[0]?.tenant_id;
    if (!tenantId) throw new ForbiddenException("Forbidden");
    return tenantId;
  }

  private dbContext(ctx: AuthContext) {
    return { tenantId: ctx.tenantId, userId: ctx.principal.id, actorType: ctx.actorType };
  }

  private notFound(name: string): never {
    throw new NotFoundException(`${name} not found`);
  }

  private ip(req?: AuthedRequest): string | null {
    return req?.ip ?? req?.socket?.remoteAddress ?? null;
  }

  private userAgent(req?: AuthedRequest): string | null {
    const value = req?.headers["user-agent"];
    return Array.isArray(value) ? value[0] ?? null : value ?? null;
  }
}
