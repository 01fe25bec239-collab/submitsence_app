import type { PoolClient } from "pg";
import { assertSafeStatusLanguage } from "../compliance/language";
import { RISK_SCORING_VERSION, runRiskRules, type LinkedDocument, type MatchFact, type RiskCheckItem, type SourceReference } from "./rules";

export interface RiskJobInput {
  tenantId: string;
  projectId: string;
  jobId: string;
  packageId?: string | null;
  registerItemId?: string | null;
}

export interface RfiJobInput {
  tenantId: string;
  projectId: string;
  jobId: string;
  requestedBy: string | null;
  riskFlagId?: string | null;
  registerItemId?: string | null;
  title?: string | null;
  issueSummary?: string | null;
  question?: string | null;
  conflictType?: string | null;
  clauseReferenceIds?: string[];
  drawingDocumentIds?: string[];
  suggestedAttachmentIds?: string[];
}

type BaseRow = {
  register_item_id: string;
  title: string;
  description: string | null;
  status: string;
  due_date: string | Date | null;
  requirement_id: string | null;
  category: string | null;
  requirement_confidence: string | number | null;
  is_hold_point: boolean | null;
  worksection_id: string | null;
  clause_id: string | null;
  clause_reference_id: string | null;
  reference_label: string | null;
  source_page: number | null;
  clause_superseded: boolean | null;
  worksection_superseded: boolean | null;
  reviewer_assigned: boolean;
};

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function docs(value: unknown): LinkedDocument[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw) => {
    const row = object(raw);
    if (!row.id || !row.title) return [];
    return [{ id: String(row.id), title: String(row.title), role: String(row.role ?? "attachment"), mimeType: row.mimeType ? String(row.mimeType) : null, docType: String(row.docType ?? "other") }];
  });
}

async function loadRiskItems(client: PoolClient, input: RiskJobInput): Promise<RiskCheckItem[]> {
  if (input.packageId) {
    const pkg = await client.query(`select 1 from packages where tenant_id = $1 and project_id = $2 and id = $3 and archived_at is null`, [input.tenantId, input.projectId, input.packageId]);
    if (!pkg.rows[0]) throw new Error("Risk pre-check package does not belong to the project");
  }
  const base = await client.query<BaseRow>(
    `select ri.id as register_item_id, ri.title, ri.description, ri.status::text, ri.due_date,
            sr.id as requirement_id, sr.category::text, sr.confidence as requirement_confidence,
            coalesce(sr.is_hold_point, c.is_hold_point, false) as is_hold_point,
            sr.worksection_id, sr.clause_id, sr.clause_reference_id,
            coalesce(cr.reference_label, concat_ws(' ', ws.code, c.clause_number)) as reference_label,
            coalesce(cr.source_page, sr.source_page, c.source_page) as source_page,
            coalesce(c.is_superseded, false) as clause_superseded,
            coalesce(ws.is_superseded, false) as worksection_superseded,
            exists (
              select 1
                from users reviewer
                join tenant_memberships tm on tm.tenant_id = ri.tenant_id and tm.user_id = reviewer.id and tm.status = 'active'
               where reviewer.id = ri.responsible_user_id and reviewer.kind = 'human' and reviewer.status = 'active'
                 and (
                   exists (select 1 from role_permissions rp join permissions perm on perm.id = rp.permission_id where rp.role_id = tm.role_id and perm.key = 'risk.review')
                   or exists (select 1 from project_memberships pm where pm.tenant_id = ri.tenant_id and pm.project_id = ri.project_id and pm.user_id = reviewer.id and pm.role in ('lead', 'reviewer'))
                 )
            ) as reviewer_assigned
       from register_items ri
       left join submittal_requirements sr on sr.tenant_id = ri.tenant_id and sr.id = ri.requirement_id
       left join worksections ws on ws.tenant_id = sr.tenant_id and ws.id = sr.worksection_id
       left join clauses c on c.tenant_id = sr.tenant_id and c.id = sr.clause_id
       left join clause_references cr on cr.tenant_id = sr.tenant_id and cr.id = sr.clause_reference_id
      where ri.tenant_id = $1 and ri.project_id = $2 and ri.archived_at is null
        and ($3::uuid is null or ri.id = $3)
        and ($4::uuid is null or exists (
          select 1 from package_items pi where pi.tenant_id = ri.tenant_id and pi.package_id = $4 and pi.register_item_id = ri.id and pi.included = true
        ))
      order by ri.created_at, ri.id`,
    [input.tenantId, input.projectId, input.registerItemId ?? null, input.packageId ?? null],
  );
  if (input.registerItemId && base.rows.length === 0) throw new Error("Risk pre-check register item does not belong to the project or package");
  const ids = base.rows.map((row) => row.register_item_id);
  if (ids.length === 0) return [];

  const linked = await client.query<{ register_item_id: string; id: string; title: string; role: string; mime_type: string | null; doc_type: string }>(
    `select distinct pi.register_item_id, d.id, d.title, pid.doc_role as role, d.mime_type, d.doc_type::text
       from package_items pi
       join packages p on p.tenant_id = pi.tenant_id and p.id = pi.package_id and p.project_id = $2
       join package_item_documents pid on pid.tenant_id = pi.tenant_id and pid.package_item_id = pi.id and pid.included = true
       join documents d on d.tenant_id = pid.tenant_id and d.id = pid.document_id and d.archived_at is null
      where pi.tenant_id = $1 and pi.register_item_id = any($3::uuid[]) and pi.included = true and ($4::uuid is null or pi.package_id = $4)
      union
     select distinct pd.register_item_id, d.id, d.title,
            case when pd.kind = 'stamped_shop_drawing' then 'stamped_drawing_reference' else 'physical_deliverable_attachment' end,
            d.mime_type, d.doc_type::text
       from physical_deliverables pd
       join documents d on d.tenant_id = pd.tenant_id and d.id = pd.attachment_document_id and d.archived_at is null
      where pd.tenant_id = $1 and pd.register_item_id = any($3::uuid[])`,
    [input.tenantId, input.projectId, ids, input.packageId ?? null],
  );

  const matchRows = await client.query<{
    register_item_id: string; id: string; product_id: string; product_name: string; confidence: string | number | null;
    decision: string; evidence: unknown; documents: unknown;
  }>(
    `select pm.register_item_id, pm.id, pm.product_id, p.name as product_name, pm.confidence, pm.decision::text, pm.evidence,
            coalesce(product_docs.documents, '[]'::jsonb) as documents
       from product_matches pm
       join products p on p.tenant_id = pm.tenant_id and p.id = pm.product_id and p.is_archived = false
       left join lateral (
         select jsonb_agg(jsonb_build_object('id', source.id, 'title', source.title, 'role', source.role,
                                             'mimeType', source.mime_type, 'docType', source.doc_type)) as documents
           from (
             select d.id, d.title, pd.doc_role as role, d.mime_type, d.doc_type::text as doc_type
               from product_documents pd join documents d on d.tenant_id = pd.tenant_id and d.id = pd.document_id
              where pd.tenant_id = pm.tenant_id and pd.product_id = pm.product_id and d.archived_at is null
             union
             select d.id, d.title, 'datasheet', d.mime_type, d.doc_type::text
               from documents d where d.tenant_id = p.tenant_id and d.id = p.datasheet_document_id and d.archived_at is null
           ) source
       ) product_docs on true
      where pm.tenant_id = $1 and pm.register_item_id = any($2::uuid[]) and pm.decision in ('accepted', 'pending')
      order by pm.register_item_id, (pm.decision = 'accepted') desc, pm.confidence desc nulls last, pm.created_at desc`,
    [input.tenantId, ids],
  );

  const physical = await client.query<{ register_item_id: string; kind: string }>(
    `select register_item_id, kind::text from physical_deliverables where tenant_id = $1 and register_item_id = any($2::uuid[])`,
    [input.tenantId, ids],
  );
  const addenda = await client.query<{ id: string; target_worksection_id: string | null; target_clause_id: string | null; title: string; action: string }>(
    `select ar.id, ar.target_worksection_id, ar.target_clause_id, d.title, ar.action
       from addenda_reconciliations ar
       join documents d on d.tenant_id = ar.tenant_id and d.id = ar.addendum_document_id
      where ar.tenant_id = $1 and ar.project_id = $2 and ar.action in ('supersedes', 'deletes')`,
    [input.tenantId, input.projectId],
  );

  return base.rows.map((row) => {
    const itemDocs: LinkedDocument[] = linked.rows.filter((doc) => doc.register_item_id === row.register_item_id).map((doc) => ({
      id: doc.id, title: doc.title, role: doc.role, mimeType: doc.mime_type, docType: doc.doc_type,
    }));
    const itemMatches: MatchFact[] = matchRows.rows.filter((match) => match.register_item_id === row.register_item_id).map((match) => {
      const evidence = object(match.evidence);
      return {
        id: match.id,
        productId: match.product_id,
        productName: match.product_name,
        confidence: match.confidence === null ? null : Number(match.confidence),
        decision: match.decision,
        missingInfo: strings(evidence.missingInfo),
        documents: docs(match.documents),
      };
    });
    const clauseReference: SourceReference | null = row.clause_reference_id || row.clause_id
      ? { kind: "clause", id: row.clause_reference_id ?? row.clause_id!, label: row.reference_label ?? "Referenced specification clause", page: row.source_page }
      : null;
    const supersededReferences: SourceReference[] = [];
    if ((row.clause_superseded || row.worksection_superseded) && clauseReference) supersededReferences.push(clauseReference);
    for (const addendum of addenda.rows) {
      if (addendum.target_clause_id === row.clause_id || addendum.target_worksection_id === row.worksection_id) {
        supersededReferences.push({ kind: "addendum", id: addendum.id, label: `${addendum.title}; ${addendum.action}` });
      }
    }
    return {
      registerItemId: row.register_item_id,
      title: row.title,
      description: row.description,
      status: row.status,
      dueDate: row.due_date ? String(row.due_date).slice(0, 10) : null,
      reviewerAssigned: row.reviewer_assigned,
      requirementCategory: row.category,
      requirementConfidence: row.requirement_confidence === null ? null : Number(row.requirement_confidence),
      isHoldPoint: Boolean(row.is_hold_point),
      clauseReferenceId: row.clause_reference_id,
      clauseReference,
      documents: itemDocs,
      drawingReferences: itemDocs.filter((doc) => doc.docType === "drawing" || doc.role === "stamped_drawing_reference")
        .map((doc) => ({ kind: "drawing", id: doc.id, label: doc.title })),
      matches: itemMatches,
      physicalKinds: physical.rows.filter((line) => line.register_item_id === row.register_item_id).map((line) => line.kind),
      supersededReferences,
    };
  });
}

export async function runRiskPrecheck(client: PoolClient, input: RiskJobInput): Promise<Record<string, unknown>> {
  const items = await loadRiskItems(client, input);
  const findings = runRiskRules(items);
  let created = 0;
  let refreshed = 0;
  const flagIds: string[] = [];
  const consent = await client.query<{ learning_loop: string }>(`select learning_loop from tenant_consents where tenant_id = $1`, [input.tenantId]);
  for (const finding of findings) {
    assertSafeStatusLanguage(finding.summary);
    assertSafeStatusLanguage(finding.checklistLabel);
    const item = items.find((candidate) => candidate.registerItemId === finding.evidence.find((ref) => ref.kind === "register_item")?.id)!;
    const result = await client.query<{ id: string; inserted: boolean }>(
      `insert into risk_flags (tenant_id, project_id, register_item_id, clause_reference_id, risk_type, severity, summary,
                               evidence, rule_key, risk_score, scoring_version, generation_job_id)
       values ($1, $2, $3, $4, $5::risk_type, $6::risk_severity, $7, $8::jsonb, $9, $10, $11, $12)
       on conflict (tenant_id, project_id, register_item_id, rule_key) where register_item_id is not null
       do update set risk_type = excluded.risk_type, severity = excluded.severity, summary = excluded.summary,
                     evidence = excluded.evidence, risk_score = excluded.risk_score, scoring_version = excluded.scoring_version,
                     generation_job_id = excluded.generation_job_id, updated_at = now()
         where risk_flags.state = 'open'
       returning id, (xmax = 0) as inserted`,
      [input.tenantId, input.projectId, item.registerItemId, item.clauseReferenceId,
        finding.riskType, finding.severity, finding.summary, JSON.stringify(finding.evidence), finding.ruleKey,
        finding.score, RISK_SCORING_VERSION, input.jobId],
    );
    let row = result.rows[0];
    if (!row) {
      row = (await client.query<{ id: string; inserted: boolean }>(
        `select id, false as inserted from risk_flags where tenant_id = $1 and project_id = $2 and register_item_id = $3 and rule_key = $4`,
        [input.tenantId, input.projectId, item.registerItemId, finding.ruleKey],
      )).rows[0];
    }
    if (!row) continue;
    flagIds.push(row.id);
    row.inserted ? created++ : refreshed++;
    if (row.inserted) {
      await client.query(
        `insert into checklist_items (tenant_id, register_item_id, risk_flag_id, label)
         values ($1, $2, $3, $4) on conflict do nothing`,
        [input.tenantId, item.registerItemId, row.id, finding.checklistLabel],
      );
    }
    await client.query(
      `insert into audit_events (tenant_id, event_type, actor_type, entity_type, entity_id, action, summary, payload)
       values ($1, 'flag', 'system', 'risk_flag', $2, 'risk_flag_generated', $3, $4::jsonb)`,
      [input.tenantId, row.id, finding.summary, JSON.stringify({ project_id: input.projectId, jobId: input.jobId, ruleKey: finding.ruleKey, riskScore: finding.score, scoringVersion: RISK_SCORING_VERSION })],
    );
    if (consent.rows[0]?.learning_loop === "opted_in") {
      await client.query(
        `insert into rejection_learning_events (tenant_id, risk_flag_id, register_item_id, anonymised_eligible, consent_state, opted_out)
         values ($1, $2, $3, true, 'opted_in', false)`,
        [input.tenantId, row.id, item.registerItemId],
      );
    }
  }
  return { projectId: input.projectId, packageId: input.packageId ?? null, registerItemId: input.registerItemId ?? null, scoringVersion: RISK_SCORING_VERSION, checkedItems: items.length, findings: findings.length, created, refreshed, flagIds };
}

function nullable(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function conflictType(riskType: string | null): string {
  if (riskType === "spec_conflict") return "conflict";
  if (riskType === "ambiguous_requirement") return "ambiguity";
  if (riskType === "missing_evidence") return "missing_information";
  return "discrepancy";
}

function defaultQuestion(type: string): string {
  if (type === "conflict") return "Please confirm which cited requirement should govern and identify any required revision.";
  if (type === "ambiguity") return "Please clarify the cited requirement so the submission can be prepared for human review.";
  if (type === "missing_information") return "Please provide the missing information or identify the applicable source reference.";
  return "Please clarify the discrepancy between the cited project information.";
}

export async function generateRfiDraft(client: PoolClient, input: RfiJobInput): Promise<Record<string, unknown>> {
  const existing = await client.query<{ id: string }>(`select id from rfi_drafts where tenant_id = $1 and generation_job_id = $2`, [input.tenantId, input.jobId]);
  if (existing.rows[0]) return { projectId: input.projectId, rfiId: existing.rows[0].id };
  const source = await client.query<{
    flag_id: string | null; register_item_id: string; item_title: string; item_description: string | null; risk_type: string | null;
    flag_summary: string | null; evidence: unknown; clause_reference_id: string | null; reference_label: string | null; source_page: number | null;
  }>(
    `select rf.id as flag_id, ri.id as register_item_id, ri.title as item_title, ri.description as item_description,
            rf.risk_type::text, rf.summary as flag_summary, coalesce(rf.evidence, '[]'::jsonb) as evidence,
            coalesce(rf.clause_reference_id, sr.clause_reference_id) as clause_reference_id,
            cr.reference_label, coalesce(cr.source_page, sr.source_page) as source_page
       from register_items ri
       left join submittal_requirements sr on sr.tenant_id = ri.tenant_id and sr.id = ri.requirement_id
       left join risk_flags rf on rf.tenant_id = ri.tenant_id and rf.register_item_id = ri.id
                               and ($3::uuid is null or rf.id = $3) and rf.state in ('open', 'confirmed')
       left join clause_references cr on cr.tenant_id = ri.tenant_id and cr.id = coalesce(rf.clause_reference_id, sr.clause_reference_id)
      where ri.tenant_id = $1 and ri.project_id = $2 and ri.archived_at is null
        and ($4::uuid is null or ri.id = $4)
        and ($3::uuid is null or rf.id = $3)
      order by (rf.id = $3) desc nulls last, rf.risk_score desc nulls last, ri.created_at
      limit 1`,
    [input.tenantId, input.projectId, input.riskFlagId ?? null, input.registerItemId ?? null],
  );
  const row = source.rows[0];
  if (!row) throw new Error("RFI generation requires a project-scoped register item or risk flag");
  const type = nullable(input.conflictType) ?? conflictType(row.risk_type);
  const title = nullable(input.title) ?? `Draft RFI - ${row.item_title}`;
  const issueSummary = nullable(input.issueSummary) ?? row.flag_summary ?? row.item_description ?? `Information needs clarification for ${row.item_title}.`;
  const question = nullable(input.question) ?? defaultQuestion(type);
  if (!nullable(input.question)) assertSafeStatusLanguage(`Draft RFI - needs reviewer confirmation. ${question}`);

  const evidence = Array.isArray(row.evidence) ? row.evidence.map(object) : [];
  const evidenceDocumentIds = evidence.filter((ref) => ref.kind === "drawing" || ref.kind === "document").map((ref) => String(ref.id));
  const requestedDocumentIds = [...new Set([...(input.drawingDocumentIds ?? []), ...(input.suggestedAttachmentIds ?? []), ...evidenceDocumentIds])];
  const documentRows = requestedDocumentIds.length === 0 ? { rows: [] as { id: string; title: string; doc_type: string }[] } : await client.query<{ id: string; title: string; doc_type: string }>(
    `select id, title, doc_type::text from documents where tenant_id = $1 and id = any($2::uuid[]) and archived_at is null and (project_id is null or project_id = $3)`,
    [input.tenantId, requestedDocumentIds, input.projectId],
  );
  if (documentRows.rows.length !== requestedDocumentIds.length) throw new Error("One or more RFI attachment references do not belong to the project");

  const clauseIds = [...new Set([row.clause_reference_id, ...(input.clauseReferenceIds ?? [])].filter((value): value is string => Boolean(value)))];
  const clauseRows = clauseIds.length === 0 ? { rows: [] as { id: string; reference_label: string; source_page: number | null }[] } : await client.query<{ id: string; reference_label: string; source_page: number | null }>(
    `select distinct cr.id, cr.reference_label, cr.source_page
       from clause_references cr
       join submittal_requirements sr on sr.tenant_id = cr.tenant_id and sr.clause_reference_id = cr.id and sr.project_id = $3
      where cr.tenant_id = $1 and cr.id = any($2::uuid[])`,
    [input.tenantId, clauseIds, input.projectId],
  );
  if (clauseRows.rows.length !== clauseIds.length) throw new Error("One or more RFI clause references do not belong to the project");
  const sourceLabels = [...clauseRows.rows.map((clause) => `${clause.reference_label}${clause.source_page ? ` (page ${clause.source_page})` : ""}`), ...documentRows.rows.map((document) => document.title)];
  const body = `Issue summary: ${issueSummary}\n\nQuestion: ${question}\n\nSource references: ${sourceLabels.join("; ") || "Register item only"}\n\nPrepared for human review. No response or engineering decision is assumed.`;
  const attachments = documentRows.rows.map((document) => ({ documentId: document.id, title: document.title, reason: document.doc_type === "drawing" ? "Drawing reference" : "Suggested source attachment" }));
  const inserted = await client.query<{ id: string }>(
    `insert into rfi_drafts (tenant_id, project_id, register_item_id, title, body, conflict_type, created_by,
                             source_risk_flag_id, generation_job_id, issue_summary, question, suggested_attachments)
     values ($1, $2, $3, $4, $5, $6::rfi_conflict_type, $7, $8, $9, $10, $11, $12::jsonb)
     returning id`,
    [input.tenantId, input.projectId, row.register_item_id, title, body, type, input.requestedBy, row.flag_id, input.jobId, issueSummary, question, JSON.stringify(attachments)],
  );
  for (const clause of clauseRows.rows) await client.query(`insert into rfi_cited_clauses (tenant_id, rfi_id, clause_reference_id) values ($1, $2, $3) on conflict do nothing`, [input.tenantId, inserted.rows[0].id, clause.id]);
  for (const document of documentRows.rows) await client.query(`insert into rfi_cited_documents (tenant_id, rfi_id, document_id, note) values ($1, $2, $3, $4) on conflict do nothing`, [input.tenantId, inserted.rows[0].id, document.id, document.doc_type === "drawing" ? "Drawing reference" : "Suggested source attachment"]);
  await client.query(
    `insert into audit_events (tenant_id, event_type, actor_type, entity_type, entity_id, action, summary, payload)
     values ($1, 'rfi_action', 'system', 'rfi_draft', $2, 'rfi_draft_generated', 'RFI draft generated for human review', $3::jsonb)`,
    [input.tenantId, inserted.rows[0].id, JSON.stringify({ project_id: input.projectId, jobId: input.jobId, sourceRiskFlagId: row.flag_id, requestedBy: input.requestedBy, clauseReferenceIds: clauseRows.rows.map((clause) => clause.id), documentIds: documentRows.rows.map((document) => document.id) })],
  );
  return { projectId: input.projectId, rfiId: inserted.rows[0].id, sourceRiskFlagId: row.flag_id, reviewStatus: "draft" };
}
