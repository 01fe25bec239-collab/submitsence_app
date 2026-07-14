import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { ApiService } from "../src/api/api.service";
import type { AuthContext } from "../src/auth/auth.types";
import { runOnce } from "../src/worker/worker";

const TENANT_ID = "11111111-1111-1111-1111-111111111111";
const PROJECT_ID = "55555555-5555-5555-5555-555555555555";
const WORKSECTION_ID = "66666666-6666-6666-6666-666666666666";
const CLAUSE_ID = "77777777-7777-7777-7777-777777777777";
const USER_ID = "22222222-2222-2222-2222-222222222222";
const PRODUCT_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

async function main() {
  const connectionString = process.env.RISK_TEST_DATABASE_URL;
  if (!connectionString) throw new Error("RISK_TEST_DATABASE_URL is required");
  const pool = new Pool({ connectionString });
  const auth = { requireTenantPermission: async () => undefined } as never;
  const api = new ApiService(pool, auth);
  const ctx: AuthContext = {
    principal: { id: USER_ID, email: "owner@acme.example", cognitoSub: "risk-verification-owner", fullName: "Olivia Owner", kind: "human", status: "active" },
    tenantId: TENANT_ID,
    membershipId: randomUUID(),
    tenantRole: "owner",
    permissions: [],
    actorType: "human",
    isOwner: true,
    mfaRequiredForAdmins: false,
  };
  try {
    const clauseReferenceId = randomUUID();
    const requirementId = randomUUID();
    const packageId = randomUUID();
    const drawingId = randomUUID();
    await pool.query(
      `insert into clause_references (id, tenant_id, clause_id, worksection_code, clause_number, reference_label, source_page)
       values ($1, $2, $3, '0711', '3.2', 'NATSPEC 0711 cl 3.2', 42)`,
      [clauseReferenceId, TENANT_ID, CLAUSE_ID],
    );
    await pool.query(
      `insert into submittal_requirements (id, tenant_id, project_id, worksection_id, clause_id, clause_reference_id, category, title, description, is_hold_point, confidence, created_by)
       values ($1, $2, $3, $4, $5, $6, 'product_data', 'Ambiguous pump submission',
               'Unclear requirement; drawing differs from the specification and references AS 2941', true, 0.420, $7)`,
      [requirementId, TENANT_ID, PROJECT_ID, WORKSECTION_ID, CLAUSE_ID, clauseReferenceId, USER_ID],
    );
    const register = await pool.query<{ id: string }>(`select id from register_items where requirement_id = $1`, [requirementId]);
    const registerItemId = register.rows[0].id;
    await pool.query(`update register_items set responsible_user_id = null, due_date = null where id = $1`, [registerItemId]);
    await pool.query(
      `insert into documents (id, tenant_id, project_id, doc_type, title, original_filename, storage_bucket, object_key, mime_type)
       values ($1, $2, $3, 'drawing', 'Drawing F-201 rev C', 'F-201.dwg', 'test-au-bucket', $4, 'application/acad')`,
      [drawingId, TENANT_ID, PROJECT_ID, `risk-fixtures/${drawingId}.dwg`],
    );
    await pool.query(`insert into packages (id, tenant_id, project_id, name, assembled_by) values ($1, $2, $3, 'Risk verification package', $4)`, [packageId, TENANT_ID, PROJECT_ID, USER_ID]);
    const packageItem = await pool.query<{ id: string }>(`insert into package_items (tenant_id, package_id, register_item_id, sequence) values ($1, $2, $3, 1) returning id`, [TENANT_ID, packageId, registerItemId]);
    await pool.query(`insert into package_item_documents (tenant_id, package_item_id, document_id, doc_role) values ($1, $2, $3, 'drawing_reference')`, [TENANT_ID, packageItem.rows[0].id, drawingId]);
    await pool.query(
      `insert into product_matches (tenant_id, register_item_id, product_id, requirement_id, confidence, rationale_summary, evidence)
       values ($1, $2, $3, $4, 0.310, 'Weak match; needs review.', $5::jsonb)`,
      [TENANT_ID, registerItemId, PRODUCT_ID, requirementId, JSON.stringify({ matches: [], missingInfo: ["Requirement references standard AS 2941 not found on this product"] })],
    );

    const riskKey = `risk-verify-${randomUUID()}`;
    const riskJob = await api.generateRiskFlags(ctx, PROJECT_ID, { packageId, registerItemId }, riskKey);
    assert.equal(riskJob.inserted, true);
    assert.equal(await runOnce(pool, ["risk_flag_generation"]), true);
    const riskJobRow = await pool.query(`select status, worker_output from processing_jobs where id = $1`, [riskJob.id]);
    assert.equal(riskJobRow.rows[0].status, "succeeded");
    assert.ok(riskJobRow.rows[0].worker_output.findings >= 8);

    const flags = await api.listRiskFlags(ctx, PROJECT_ID, {});
    const itemFlags = flags.filter((flag) => flag.registerItemId === registerItemId);
    for (const ruleKey of ["missing_product_document", "missing_required_evidence", "unsupported_file_format", "low_confidence_product_match", "product_attribute_mismatch", "unmet_hold_point", "missing_human_reviewer", "missing_due_date", "ambiguity_candidate", "spec_drawing_conflict_candidate"]) {
      assert.ok(itemFlags.some((flag) => flag.ruleKey === ruleKey), `missing persisted rule ${ruleKey}`);
    }
    assert.ok(itemFlags.every((flag) => flag.scoringVersion === "a4-rules-v1" && flag.riskScore >= 0 && flag.riskScore <= 100));
    assert.ok(itemFlags.every((flag) => flag.evidence.some((reference: { kind: string }) => reference.kind === "register_item")));
    const checklist = await pool.query(`select count(*)::int as count from checklist_items where register_item_id = $1`, [registerItemId]);
    assert.equal(checklist.rows[0].count, itemFlags.length);
    const learningBefore = await pool.query(`select count(*)::int as count from rejection_learning_events where register_item_id = $1 and consent_state = 'opted_in'`, [registerItemId]);
    assert.equal(learningBefore.rows[0].count, itemFlags.length);

    const ambiguity = itemFlags.find((flag) => flag.ruleKey === "ambiguity_candidate");
    await api.reviewRiskFlag(ctx, PROJECT_ID, ambiguity.id, "confirmed", { comment: "Reviewer confirmed clarification is needed" });
    const learnedDecision = await pool.query(`select human_decision from rejection_learning_events where risk_flag_id = $1 order by created_at desc limit 1`, [ambiguity.id]);
    assert.equal(learnedDecision.rows[0].human_decision, "confirmed");
    await api.commentRiskFlag(ctx, PROJECT_ID, ambiguity.id, { comment: "Prepare an RFI draft" });
    const task = await api.createRiskTask(ctx, PROJECT_ID, ambiguity.id, {});
    assert.ok(task.id);

    const conflict = itemFlags.find((flag) => flag.ruleKey === "spec_drawing_conflict_candidate");
    const rfiKey = `rfi-verify-${randomUUID()}`;
    const rfiJob = await api.createRiskRfi(ctx, PROJECT_ID, conflict.id, {}, rfiKey);
    assert.equal(await runOnce(pool, ["rfi_generation"]), true);
    const completedRfiJob = await pool.query(`select status, worker_output from processing_jobs where id = $1`, [rfiJob.id]);
    assert.equal(completedRfiJob.rows[0].status, "succeeded");
    const rfiId = completedRfiJob.rows[0].worker_output.rfiId;
    const rfi = await api.getRfi(ctx, PROJECT_ID, rfiId);
    assert.equal(rfi.reviewStatus, "draft");
    assert.match(rfi.issueSummary, /spec-versus-drawing conflict candidate/i);
    assert.ok(rfi.question);
    assert.ok(rfi.clauseReferences.some((reference: { id: string }) => reference.id === clauseReferenceId));
    assert.ok(rfi.documentReferences.some((reference: { id: string }) => reference.id === drawingId));
    await assert.rejects(api.exportRfi(ctx, PROJECT_ID, rfiId, `blocked-${randomUUID()}`), /requires human review/);
    await api.markRfiReviewed(ctx, PROJECT_ID, rfiId);
    const exportHandoff = await api.exportRfi(ctx, PROJECT_ID, rfiId, `allowed-${randomUUID()}`);
    assert.equal(exportHandoff.job.job_type, "export_rfi_pdf");

    const repeatedRfiJob = await api.createRiskRfi(ctx, PROJECT_ID, conflict.id, {}, rfiKey);
    assert.equal(repeatedRfiJob.id, rfiJob.id);
    const rfiCount = await pool.query(`select count(*)::int as count from rfi_drafts where generation_job_id = $1`, [rfiJob.id]);
    assert.equal(rfiCount.rows[0].count, 1);

    await pool.query(`update tenant_consents set learning_loop = 'opted_out' where tenant_id = $1`, [TENANT_ID]);
    const countBeforeOptedOutRun = await pool.query(`select count(*)::int as count from rejection_learning_events where register_item_id = $1`, [registerItemId]);
    const optedOutJob = await api.generateRiskFlags(ctx, PROJECT_ID, { registerItemId }, `risk-opted-out-${randomUUID()}`);
    assert.equal(await runOnce(pool, ["risk_flag_generation"]), true);
    const countAfterOptedOutRun = await pool.query(`select count(*)::int as count from rejection_learning_events where register_item_id = $1`, [registerItemId]);
    assert.equal(countAfterOptedOutRun.rows[0].count, countBeforeOptedOutRun.rows[0].count);
    await pool.query(`update tenant_consents set learning_loop = 'opted_in' where tenant_id = $1`, [TENANT_ID]);
    const audits = await pool.query(`select action from audit_events where entity_id = any($1::uuid[])`, [[...itemFlags.map((flag) => flag.id), rfiId]]);
    assert.ok(audits.rows.some((event) => event.action === "risk_flag_generated"));
    assert.ok(audits.rows.some((event) => event.action === "rfi_draft_generated"));
    console.log("PASS risk/RFI worker: scoped rules, scoring, citations, checklists, consent, decisions, draft generation, and review gate");
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
