import "reflect-metadata";
import assert from "node:assert/strict";
import test from "node:test";
import { ApiService } from "../src/api/api.service";
import type { AuthContext } from "../src/auth/auth.types";
import { EMBEDDING_DIM } from "../src/ingestion/embedder";
import { ingestCatalogue } from "../src/ingestion/ingestion.service";
import { runRiskPrecheck } from "../src/risk/risk.service";

const tenantId = "10000000-0000-4000-8000-000000000001";
const projectId = "10000000-0000-4000-8000-000000000002";
const itemId = "10000000-0000-4000-8000-000000000003";
const packageId = "10000000-0000-4000-8000-000000000004";
const flagId = "10000000-0000-4000-8000-000000000005";
const productId = "10000000-0000-4000-8000-000000000006";

const ctx: AuthContext = {
  tenantId,
  membershipId: "10000000-0000-4000-8000-000000000007",
  tenantRole: "admin",
  permissions: ["vendor.manage"],
  actorType: "human",
  isOwner: false,
  mfaRequiredForAdmins: false,
  principal: {
    id: "10000000-0000-4000-8000-000000000008",
    email: "reviewer@example.test",
    cognitoSub: "reviewer",
    fullName: "Reviewer",
    kind: "human",
    status: "active",
  },
};

test("risk reconciliation deactivates archived and explicitly excluded register-item flags", async () => {
  for (const scopedPackageId of [null, packageId]) {
    const reconciliation: { sql?: string; values?: unknown[] } = {};
    const client = {
      async query(sql: string, values?: unknown[]) {
        if (sql.includes("select 1 from packages")) return { rows: [{}], rowCount: 1 };
        if (sql.includes("from register_items ri") && sql.includes("left join submittal_requirements")) return { rows: [], rowCount: 0 };
        if (sql.includes("select 1 from register_items where tenant_id")) return { rows: [{}], rowCount: 1 };
        if (sql.includes("select learning_loop from tenant_consents")) return { rows: [{ learning_loop: "unset" }], rowCount: 1 };
        if (sql.includes("update risk_flags rf")) {
          reconciliation.sql = sql;
          reconciliation.values = values;
          return { rows: [], rowCount: 1 };
        }
        throw new Error(`Unexpected risk query: ${sql}`);
      },
    };

    const result = await runRiskPrecheck(client as never, {
      tenantId,
      projectId,
      jobId: "10000000-0000-4000-8000-000000000009",
      registerItemId: itemId,
      packageId: scopedPackageId,
    });

    assert.equal(result.checkedItems, 0);
    assert.match(reconciliation.sql ?? "", /ri\.archived_at is null/);
    assert.match(reconciliation.sql ?? "", /pi\.included = true/);
    assert.deepEqual(reconciliation.values, [tenantId, projectId, itemId, scopedPackageId]);
  }
});

test("consented risk decisions use one conflict-safe learning-event write", async () => {
  const queries: { sql: string; values?: unknown[] }[] = [];
  const client = {
    async query(sql: string, values?: unknown[]) {
      queries.push({ sql, values });
      if (sql.includes("select learning_loop")) return { rows: [{ learning_loop: "opted_in" }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    },
  };
  const service = new ApiService({} as never, {} as never);

  await (service as unknown as {
    recordConsentLearningDecision(client: unknown, tenant: string, flag: string, item: string, state: string): Promise<void>;
  }).recordConsentLearningDecision(client, tenantId, flagId, itemId, "confirmed");

  assert.equal(queries.length, 2);
  assert.match(queries[1].sql, /insert into rejection_learning_events/);
  assert.match(queries[1].sql, /on conflict \(tenant_id, risk_flag_id\).*do update/s);
  assert.deepEqual(queries[1].values, [tenantId, flagId, itemId, "confirmed"]);
});

test("consultant outcomes create learning events only for active risk flags", async () => {
  const activeFlagId = flagId;
  const staleFlagId = "10000000-0000-4000-8000-000000000011";
  const learnedFlagIds: string[] = [];
  const client = {
    async query(sql: string) {
      if (sql === "begin" || sql === "commit" || sql === "rollback" || sql.includes("set_config")) return { rows: [], rowCount: 0 };
      if (sql.includes("select 1 from integration_connections")) return { rows: [{}], rowCount: 1 };
      if (sql.includes("insert into webhook_events")) return { rows: [{ id: "10000000-0000-4000-8000-000000000012", status: "received", inserted: true }], rowCount: 1 };
      if (sql.includes("select 1 from external_project_mappings")) return { rows: [{}], rowCount: 1 };
      if (sql.includes("select status from register_items")) return { rows: [{ status: "submitted" }], rowCount: 1 };
      if (sql.includes("select learning_loop")) return { rows: [{ learning_loop: "opted_in" }], rowCount: 1 };
      if (sql.includes("insert into rejection_learning_events")) {
        const flags = [{ id: activeFlagId, isActive: true }, { id: staleFlagId, isActive: false }];
        learnedFlagIds.push(...flags.filter((risk) => !sql.includes("rf.is_active = true") || risk.isActive).map((risk) => risk.id));
        return { rows: [], rowCount: learnedFlagIds.length };
      }
      return { rows: [], rowCount: 1 };
    },
    release() {},
  };
  const pool = {
    query: async () => ({ rows: [{ tenant_id: tenantId }], rowCount: 1 }),
    connect: async () => client,
  };
  const previousSecret = process.env.INTEGRATION_WEBHOOK_SECRET;
  process.env.INTEGRATION_WEBHOOK_SECRET = "test-secret";
  try {
    const service = new ApiService(pool as never, {} as never);
    await service.integrationWebhook("aconex", {
      connectionId: "10000000-0000-4000-8000-000000000013",
      externalEventId: "consultant-response-1",
      eventType: "consultant_status",
      payload: { projectId, registerItemId: itemId, status: "rejected" },
    }, "consultant-response-1", "test-secret");
  } finally {
    if (previousSecret === undefined) delete process.env.INTEGRATION_WEBHOOK_SECRET;
    else process.env.INTEGRATION_WEBHOOK_SECRET = previousSecret;
  }

  assert.deepEqual(learnedFlagIds, [activeFlagId]);
});

test("product PATCH marks manual review only when a non-empty protected core field is supplied", async () => {
  async function updatedWith(body: Record<string, unknown>): Promise<boolean> {
    let reviewed: boolean | undefined;
    const client = {
      async query(sql: string, values?: unknown[]) {
        if (sql === "begin" || sql === "commit" || sql === "rollback" || sql.includes("set_config")) return { rows: [], rowCount: 0 };
        if (sql.includes("update products")) {
          reviewed = values?.[6] as boolean;
          return { rows: [{ id: productId, name: "Reviewed pump", modelNumber: "P-1", isArchived: body.isArchived === true }], rowCount: 1 };
        }
        if (sql.includes("select name, model_number")) return { rows: [{ name: "Reviewed pump", model_number: "P-1", category: null, description: null }], rowCount: 1 };
        if (sql.includes("select attr_key")) return { rows: [], rowCount: 0 };
        return { rows: [], rowCount: 1 };
      },
      release() {},
    };
    const pool = { connect: async () => client };
    const auth = { requireTenantPermission: async () => undefined };
    const service = new ApiService(pool as never, auth as never);
    await service.updateProduct(ctx, productId, body);
    return reviewed!;
  }

  assert.equal(await updatedWith({ isArchived: true }), false);
  assert.equal(await updatedWith({ name: "   ", isArchived: true }), false);
  assert.equal(await updatedWith({ modelNumber: "MANUAL-2" }), true);
});

test("re-ingestion finds a manually renamed product through its prior extracted identity", async () => {
  let identityQuery = "";
  let updatedProduct: string | undefined;
  const client = {
    async query(sql: string, values?: unknown[]) {
      if (sql.includes("select id from vendors")) return { rows: [{ id: "10000000-0000-4000-8000-000000000010" }], rowCount: 1 };
      if (sql.includes("select p.id from products p")) {
        identityQuery = sql;
        return { rows: [{ id: productId }], rowCount: 1 };
      }
      if (sql.includes("update products set")) {
        updatedProduct = values?.[0] as string;
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    },
  };

  const result = await ingestCatalogue(client as never, {
    tenantId,
    documentId: null,
    projectId: null,
    catalogueId: null,
    source: { mimeType: "text/csv", rows: [{ Vendor: "Acme", Product: "Original pump", Model: "ORIGINAL-1" }] },
    embedder: { model: "test", embed: async () => Array(EMBEDDING_DIM).fill(0) },
  });

  assert.equal(result.productsUpdated, 1);
  assert.equal(result.productsCreated, 0);
  assert.equal(updatedProduct, productId);
  assert.match(identityQuery, /from extracted_product_data extracted/);
  assert.match(identityQuery, /extracted\.data->>'modelNumber'/);
});
