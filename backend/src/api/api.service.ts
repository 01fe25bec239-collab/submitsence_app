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
                ri.consultant_platform_ref as "consultantPlatformRef", ri.revision,
                sr.category, cr.reference_label as "referenceLabel"
           from register_items ri
           left join users u on u.id = ri.responsible_user_id
           left join submittal_requirements sr on sr.id = ri.requirement_id and sr.tenant_id = ri.tenant_id
           left join clause_references cr on cr.id = sr.clause_reference_id and cr.tenant_id = sr.tenant_id
           left join package_items pi on pi.register_item_id = ri.id and pi.tenant_id = ri.tenant_id
          where ri.project_id = $1 and ri.archived_at is null
            and ($2::text is null or ri.status::text = $2)
            and ($3::uuid is null or ri.responsible_user_id = $3)
            and ($4::date is null or ri.due_date <= $4)
            and ($5::uuid is null or pi.package_id = $5)
          order by ${sortSql}`,
        [
          pid,
          api.optionalString(query.status),
          api.optionalUuid(query.assignedUserId, "assignedUserId"),
          api.optionalDate(query.dueBefore, "dueBefore"),
          api.optionalUuid(query.packageId, "packageId"),
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
      if (userId) {
        const member = await client.query(`select 1 from tenant_memberships where user_id = $1 and status = 'active'`, [userId]);
        if (!member.rows[0]) throw new BadRequestException("assigned user must be an active tenant member");
      }
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
                closed_at = case when $3 = 'closed' then now() else closed_at end
          where project_id = $1 and id = $2
          returning id, status`,
        [pid, id, next],
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

  async requestRegisterExport(ctx: AuthContext, projectId: string, idempotencyKey: string, req?: AuthedRequest) {
    const pid = v.uuid(projectId, "projectId");
    return withTenantClient(this.pool, this.dbContext(ctx), async (client) => this.createExportJob(client, ctx, pid, null, "register_csv", `register_export:${idempotencyKey}`, req));
  }

  async listPhysicalDeliverables(ctx: AuthContext, projectId: string) {
    const pid = v.uuid(projectId, "projectId");
    return withTenantClient(this.pool, this.dbContext(ctx), async (client) => {
      const result = await client.query(
        `select pd.id, pd.register_item_id as "registerItemId", pd.kind, pd.status, pd.description, pd.quantity,
                pd.tracking_ref as "trackingRef", pd.responsible_user_id as "responsibleUserId",
                pd.sent_at as "sentAt", pd.received_at as "receivedAt", pd.returned_at as "returnedAt"
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
    return withTenantClient(this.pool, this.dbContext(ctx), async (client) => {
      await this.requireRegisterItem(client, pid, rid);
      const result = await client.query(
        `insert into physical_deliverables (tenant_id, register_item_id, kind, status, description, quantity, tracking_ref, responsible_user_id)
         values ($1, $2, $3::physical_deliverable_type, $4::physical_deliverable_status, $5, $6, $7, $8)
         returning id, register_item_id as "registerItemId", kind, status`,
        [
          ctx.tenantId,
          rid,
          kind,
          status,
          api.optionalString(body.description),
          api.positiveInt(body.quantity, "quantity"),
          api.optionalString(body.trackingRef),
          api.optionalUuid(body.responsibleUserId, "responsibleUserId"),
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
    return withTenantClient(this.pool, this.dbContext(ctx), async (client) => {
      const result = await client.query(
        `update physical_deliverables pd
            set status = coalesce($3::physical_deliverable_status, pd.status),
                tracking_ref = coalesce($4, pd.tracking_ref),
                sent_at = coalesce($5, pd.sent_at),
                received_at = coalesce($6, pd.received_at),
                returned_at = coalesce($7, pd.returned_at)
           from register_items ri
          where pd.id = $1 and pd.register_item_id = ri.id and ri.project_id = $2
          returning pd.id, pd.status, pd.tracking_ref as "trackingRef"`,
        [
          id,
          pid,
          status,
          api.optionalString(body.trackingRef),
          api.optionalDate(body.sentAt, "sentAt"),
          api.optionalDate(body.receivedAt, "receivedAt"),
          api.optionalDate(body.returnedAt, "returnedAt"),
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

  async generateRiskFlags(ctx: AuthContext, projectId: string, idempotencyKey: string, req?: AuthedRequest) {
    const pid = v.uuid(projectId, "projectId");
    return withTenantClient(this.pool, this.dbContext(ctx), async (client) => {
      const job = await this.enqueueProjectJob(client, ctx, pid, "risk_flag_generation", `risk_flags:${idempotencyKey}`, {});
      await this.recordAudit(client, ctx, "flag", "project", pid, "risk_generation_request", "Risk flag generation requested", { project_id: pid, jobId: job.id }, req);
      return job;
    });
  }

  async listRiskFlags(ctx: AuthContext, projectId: string, query: Record<string, unknown>) {
    const pid = v.uuid(projectId, "projectId");
    return withTenantClient(this.pool, this.dbContext(ctx), async (client) => {
      const result = await client.query(
        `select rf.id, rf.register_item_id as "registerItemId", rf.risk_type as "riskType", rf.severity,
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
          returning id, state, reviewed_at as "reviewedAt"`,
        [id, pid, state, ctx.principal.id, api.optionalString(body.comment)],
      );
      const row = result.rows[0] ?? this.notFound("risk flag");
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
            set resolution_note = concat_ws(E'\n', resolution_note, $3)
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
      const flag = await client.query<{ register_item_id: string | null }>(`select register_item_id from risk_flags where id = $1 and project_id = $2`, [id, pid]);
      if (!flag.rows[0]) return this.notFound("risk flag");
      const result = await client.query(
        `insert into checklist_items (tenant_id, register_item_id, risk_flag_id, label)
         values ($1, $2, $3, $4)
         returning id, label, risk_flag_id as "riskFlagId"`,
        [ctx.tenantId, flag.rows[0].register_item_id, id, v.string(body.label, "label")],
      );
      await this.recordAudit(client, ctx, "flag", "checklist_item", result.rows[0].id, "risk_task_create", "Risk task created", { project_id: pid, flagId: id }, req);
      return result.rows[0];
    });
  }

  async generateRfi(ctx: AuthContext, projectId: string, body: Record<string, unknown>, idempotencyKey: string, req?: AuthedRequest) {
    await this.auth.requireTenantPermission(ctx, "rfi.manage", req);
    const pid = v.uuid(projectId, "projectId");
    const title = api.optionalString(body.title) ?? "Draft RFI - needs review";
    const text = api.optionalString(body.body) ?? "Prepared for review. Source cited where available.";
    assertSafeStatusLanguage(title);
    assertSafeStatusLanguage(text);
    return withTenantClient(this.pool, this.dbContext(ctx), async (client) => {
      const job = await this.enqueueProjectJob(client, ctx, pid, "rfi_generation", `rfi_generation:${idempotencyKey}`, {});
      if (!job.inserted && job.worker_output?.rfiId) return { job, rfiId: job.worker_output.rfiId };
      const result = await client.query<{ id: string }>(
        `insert into rfi_drafts (tenant_id, project_id, register_item_id, title, body, conflict_type, created_by)
         values ($1, $2, $3, $4, $5, $6::rfi_conflict_type, $7)
         returning id, title, review_status as "reviewStatus"`,
        [
          ctx.tenantId,
          pid,
          api.optionalUuid(body.registerItemId, "registerItemId"),
          title,
          text,
          api.enumValue(body.conflictType ?? "ambiguity", "conflictType", api.rfiConflictTypes),
          ctx.principal.id,
        ],
      );
      await this.patchJobOutput(client, job.id, { rfiId: result.rows[0].id });
      await this.recordAudit(client, ctx, "rfi_action", "rfi_draft", result.rows[0].id, "rfi_generate", "RFI draft generated for review", { project_id: pid, jobId: job.id }, req);
      return { rfi: result.rows[0], job: { ...job, worker_output: { ...(job.worker_output ?? {}), rfiId: result.rows[0].id } } };
    });
  }

  async getRfi(ctx: AuthContext, projectId: string, rfiId: string) {
    await this.auth.requireTenantPermission(ctx, "rfi.manage");
    const pid = v.uuid(projectId, "projectId");
    const id = v.uuid(rfiId, "rfiId");
    return withTenantClient(this.pool, this.dbContext(ctx), async (client) => {
      const result = await client.query(`select * from rfi_drafts where id = $1 and project_id = $2`, [id, pid]);
      return result.rows[0] ?? this.notFound("RFI draft");
    });
  }

  async updateRfi(ctx: AuthContext, projectId: string, rfiId: string, body: Record<string, unknown>, req?: AuthedRequest) {
    await this.auth.requireTenantPermission(ctx, "rfi.manage", req);
    const pid = v.uuid(projectId, "projectId");
    const id = v.uuid(rfiId, "rfiId");
    return withTenantClient(this.pool, this.dbContext(ctx), async (client) => {
      const result = await client.query(
        `update rfi_drafts
            set title = coalesce($3, title),
                body = coalesce($4, body),
                conflict_type = coalesce($5::rfi_conflict_type, conflict_type),
                review_status = 'in_review'
          where id = $1 and project_id = $2
          returning id, title, review_status as "reviewStatus"`,
        [
          id,
          pid,
          api.optionalString(body.title),
          api.optionalString(body.body),
          body.conflictType === undefined ? null : api.enumValue(body.conflictType, "conflictType", api.rfiConflictTypes),
        ],
      );
      const row = result.rows[0] ?? this.notFound("RFI draft");
      await this.recordAudit(client, ctx, "rfi_action", "rfi_draft", id, "rfi_edit", "RFI draft edited", { project_id: pid }, req);
      return row;
    });
  }

  async markRfiReviewed(ctx: AuthContext, projectId: string, rfiId: string, req?: AuthedRequest) {
    await this.auth.requireTenantPermission(ctx, "rfi.manage", req);
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
      await this.requireRfi(client, pid, id);
      return this.createExportJob(client, ctx, pid, null, "rfi_pdf", `rfi_export:${id}:${idempotencyKey}`, req);
    });
  }

  async handoffRfi(ctx: AuthContext, projectId: string, rfiId: string, body: Record<string, unknown>, idempotencyKey: string, req?: AuthedRequest) {
    await this.auth.requireTenantPermission(ctx, "rfi.manage", req);
    const pid = v.uuid(projectId, "projectId");
    const id = v.uuid(rfiId, "rfiId");
    const connectionId = v.uuid(body.connectionId, "connectionId");
    return withTenantClient(this.pool, this.dbContext(ctx), async (client) => {
      await this.requireRfi(client, pid, id);
      const job = await this.enqueueSyncJob(client, ctx, connectionId, pid, null, "package_push", `rfi_handoff:${id}:${idempotencyKey}`, { rfiId: id });
      await this.recordAudit(client, ctx, "integration_sync", "rfi_draft", id, "rfi_handoff", "RFI handoff requested", { project_id: pid, jobId: job.id }, req);
      return job;
    });
  }

  async createPackage(ctx: AuthContext, projectId: string, body: Record<string, unknown>, idempotencyKey: string, req?: AuthedRequest) {
    const pid = v.uuid(projectId, "projectId");
    const itemIds = api.uuidArray(body.registerItemIds, "registerItemIds");
    const name = api.optionalString(body.name) ?? "Submittal package draft";
    assertSafeStatusLanguage(name);
    return withTenantClient(this.pool, this.dbContext(ctx), async (client) => {
      const job = await this.enqueueProjectJob(client, ctx, pid, "package_draft", `package_draft:${idempotencyKey}`, { itemIds });
      if (!job.inserted && job.worker_output?.packageId) return { job, packageId: job.worker_output.packageId };
      const pkg = await client.query<{ id: string }>(
        `insert into packages (tenant_id, project_id, name, assembled_by)
         values ($1, $2, $3, $4)
         returning id, name, status`,
        [ctx.tenantId, pid, name, ctx.principal.id],
      );
      await client.query(
        `insert into package_items (tenant_id, package_id, register_item_id, sequence)
         select $1, $2, ri.id, row_number() over ()
           from register_items ri
          where ri.project_id = $3 and ri.id = any($4::uuid[])`,
        [ctx.tenantId, pkg.rows[0].id, pid, itemIds],
      );
      await this.patchJobOutput(client, job.id, { packageId: pkg.rows[0].id });
      await this.recordAudit(client, ctx, "package_generation", "package", pkg.rows[0].id, "package_draft_create", "Package draft created", { project_id: pid, itemIds, jobId: job.id }, req);
      return { package: pkg.rows[0], job: { ...job, worker_output: { ...(job.worker_output ?? {}), packageId: pkg.rows[0].id } } };
    });
  }

  async packagePreview(ctx: AuthContext, projectId: string, packageId: string) {
    const pid = v.uuid(projectId, "projectId");
    const id = v.uuid(packageId, "packageId");
    return withTenantClient(this.pool, this.dbContext(ctx), async (client) => {
      const pkg = await client.query(`select id, name, status from packages where id = $1 and project_id = $2`, [id, pid]);
      if (!pkg.rows[0]) return this.notFound("package");
      const items = await client.query(
        `select pi.sequence, ri.id as "registerItemId", ri.title, ri.status, d.id as "documentId", d.title as "documentTitle"
           from package_items pi
           join register_items ri on ri.id = pi.register_item_id and ri.tenant_id = pi.tenant_id
           left join documents d on d.id = pi.document_id and d.tenant_id = pi.tenant_id
          where pi.package_id = $1
          order by pi.sequence nulls last, ri.title`,
        [id],
      );
      return { package: pkg.rows[0], items: items.rows };
    });
  }

  async regeneratePackage(ctx: AuthContext, projectId: string, packageId: string, idempotencyKey: string, req?: AuthedRequest) {
    const pid = v.uuid(projectId, "projectId");
    const id = v.uuid(packageId, "packageId");
    return withTenantClient(this.pool, this.dbContext(ctx), async (client) => {
      await this.requirePackage(client, pid, id);
      await client.query(`update packages set status = 'assembling' where id = $1`, [id]);
      const job = await this.enqueueProjectJob(client, ctx, pid, "package_generation", `package_regenerate:${id}:${idempotencyKey}`, { packageId: id });
      await this.recordAudit(client, ctx, "package_generation", "package", id, "package_regenerate", "Package regeneration requested", { project_id: pid, jobId: job.id }, req);
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
      const items = await this.listRegister(ctx, pid, query);
      const packages = await client.query(`select id, name, status, consultant_platform_ref as "consultantPlatformRef" from packages where project_id = $1 order by created_at desc`, [pid]);
      return { status: status.rows, due: due.rows, packages: packages.rows, items };
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
    return withTenantClient(this.pool, this.dbContext(ctx), async (client) => {
      const consent = await client.query<{ learning_loop: string }>(`select learning_loop from tenant_consents where tenant_id = $1`, [ctx.tenantId]);
      if (consent.rows[0]?.learning_loop !== "opted_in") throw new ForbiddenException("Learning loop consent is not opted in");
      const result = await client.query(
        `insert into rejection_learning_events (tenant_id, risk_flag_id, register_item_id, human_decision, consultant_outcome,
                                                anonymised_eligible, consent_state, opted_out)
         values ($1, $2, $3, $4::risk_state, $5::consultant_outcome, $6, 'opted_in', false)
         returning id, consent_state as "consentState"`,
        [
          ctx.tenantId,
          api.optionalUuid(body.riskFlagId, "riskFlagId"),
          api.optionalUuid(body.registerItemId, "registerItemId"),
          api.optionalString(body.humanDecision),
          api.optionalString(body.consultantOutcome) ?? "unknown",
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
    // Tenant resolved from the connection's server-side row, NEVER body.tenantId.
    const tenantId = await this.resolveIntegrationTenant(connectionId, checkedProvider);
    return withTenantClient(this.pool, { tenantId, actorType: "system", userId: null }, async (client) => {
      const result = await client.query(
        `insert into webhook_events (tenant_id, connection_id, provider, external_event_id, event_type, payload)
         values ($1, $2, $3::integration_provider, $4, $5, $6::jsonb)
         on conflict (connection_id, external_event_id) do update set status = webhook_events.status
         returning id, status`,
        [tenantId, connectionId, checkedProvider, externalEventId, api.optionalString(body.eventType), JSON.stringify(api.object(body.payload))],
      );
      await client.query(
        `insert into audit_events (tenant_id, event_type, actor_type, entity_type, entity_id, action, summary, payload, ip_address, user_agent)
         values ($1, 'integration_sync', 'system', 'webhook_event', $2, 'integration_webhook_received', 'Integration webhook received', $3::jsonb, nullif($4::text, '')::inet, $5)`,
        [tenantId, result.rows[0].id, JSON.stringify({ request_id: req?.requestId, provider: checkedProvider, externalEventId }), this.ip(req) ?? "", this.userAgent(req)],
      );
      return result.rows[0];
    });
  }

  private async createExportJob(client: PoolClient, ctx: AuthContext, projectId: string, packageId: string | null, exportType: string, idempotencyKey: string, req?: AuthedRequest) {
    const job = await this.enqueueProjectJob(client, ctx, projectId, `export_${exportType}`, idempotencyKey, { packageId, exportType });
    if (!job.inserted && job.worker_output?.exportId) return { job, exportId: job.worker_output.exportId };
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

  private async requireProject(client: PoolClient, projectId: string, allowArchived: boolean) {
    const result = await client.query(`select id from projects where id = $1 and ($2::boolean or is_archived = false)`, [projectId, allowArchived]);
    if (!result.rows[0]) throw new ForbiddenException("Forbidden");
  }

  private async requireRegisterItem(client: PoolClient, projectId: string, itemId: string) {
    const result = await client.query(`select id from register_items where project_id = $1 and id = $2`, [projectId, itemId]);
    if (!result.rows[0]) throw new NotFoundException("register item not found");
  }

  private async requireProjectDocument(client: PoolClient, projectId: string, documentId: string) {
    const result = await client.query(`select id from documents where project_id = $1 and id = $2`, [projectId, documentId]);
    if (!result.rows[0]) throw new NotFoundException("document not found");
  }

  private async requirePackage(client: PoolClient, projectId: string, packageId: string) {
    const result = await client.query(`select id from packages where project_id = $1 and id = $2`, [projectId, packageId]);
    if (!result.rows[0]) throw new NotFoundException("package not found");
  }

  private async requireRfi(client: PoolClient, projectId: string, rfiId: string) {
    const result = await client.query(`select id from rfi_drafts where project_id = $1 and id = $2`, [projectId, rfiId]);
    if (!result.rows[0]) throw new NotFoundException("RFI draft not found");
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
