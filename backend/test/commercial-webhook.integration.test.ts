import "reflect-metadata";
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import test from "node:test";
import { ConflictException } from "@nestjs/common";
import { Pool } from "pg";
import type { AuthService } from "../src/auth/auth.service";
import type { Principal } from "../src/auth/auth.types";
import { CommercialService } from "../src/commercial/commercial.service";

const databaseUrl = process.env.TEST_DATABASE_URL;

test("signed Stripe replay is idempotent and an early invoice is retained", { skip: !databaseUrl }, async () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const tenantId = randomUUID();
  const suffix = tenantId.replaceAll("-", "");
  const customerId = `cus_${suffix}`;
  const subscriptionId = `sub_${suffix}`;
  const invoiceId = `in_${suffix}`;
  const eventId = `evt_invoice_${suffix}`;
  const secret = "whsec_commercial_integration";
  const previousSecret = process.env.STRIPE_WEBHOOK_SECRET;
  process.env.STRIPE_WEBHOOK_SECRET = secret;

  const send = async (event: Record<string, unknown>) => {
    const raw = Buffer.from(JSON.stringify(event));
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = createHmac("sha256", secret).update(`${timestamp}.`).update(raw).digest("hex");
    return new CommercialService(pool, {} as AuthService).billingWebhook(`t=${timestamp},v1=${signature}`, raw, event);
  };

  try {
    await pool.query(`insert into tenants (id,slug,name) values ($1,$2,$3)`, [tenantId, `webhook-${suffix}`, "Webhook test"]);
    await pool.query(
      `insert into tenant_billing_profiles (tenant_id,billing_email,provider,provider_customer_id)
       values ($1,$2,'stripe',$3)`,
      [tenantId, `billing-${suffix}@example.com`, customerId],
    );
    await pool.query(
      `insert into tenant_subscriptions (tenant_id,plan_id,status,trial_ends_at,provider,provider_customer_id)
       select $1,id,'trialing',now()+interval '14 days','stripe',$2 from plans where key='trial'`,
      [tenantId, customerId],
    );
    await pool.query(
      `insert into tenant_subscriptions (tenant_id,plan_id,status,provider,provider_customer_id)
       select $1,id,'incomplete','stripe',$2 from plans where key='trial'`,
      [tenantId, customerId],
    );

    const invoiceEvent = {
      id: eventId,
      type: "invoice.paid",
      data: { object: {
        id: invoiceId,
        customer: customerId,
        subscription: subscriptionId,
        number: `INV-${suffix.slice(0, 8)}`,
        status: "paid",
        currency: "aud",
        total: 11_000,
        total_tax_amounts: [{ amount: 1_000 }],
        period_start: 1_700_000_000,
        period_end: 1_702_592_000,
        hosted_invoice_url: `https://example.test/${invoiceId}`,
        invoice_pdf: `https://example.test/${invoiceId}.pdf`,
      } },
    };

    assert.equal((await send(invoiceEvent)).status, "processed");
    assert.equal((await send(invoiceEvent)).status, "processed");
    assert.equal((await pool.query(`select count(*)::int as count from invoices where tenant_id=$1 and provider_invoice_id=$2`, [tenantId, invoiceId])).rows[0].count, 1);
    assert.equal((await pool.query(`select count(*)::int as count from billing_webhook_events where tenant_id=$1 and provider_event_id=$2`, [tenantId, eventId])).rows[0].count, 1);
    assert.equal((await pool.query(`select count(*)::int as count from audit_events where tenant_id=$1 and action='invoice.paid'`, [tenantId])).rows[0].count, 1);

    assert.equal((await send({
      id: `evt_subscription_${suffix}`,
      type: "customer.subscription.created",
      data: { object: {
        id: subscriptionId,
        customer: customerId,
        status: "active",
        current_period_start: 1_700_000_000,
        current_period_end: 1_702_592_000,
        items: { data: [] },
      } },
    })).status, "processed");
    assert.equal((await pool.query(`select count(*)::int as count from tenant_subscriptions where tenant_id=$1 and provider_subscription_id=$2`, [tenantId, subscriptionId])).rows[0].count, 1);
    assert.equal((await pool.query(`select count(*)::int as count from tenant_subscriptions where tenant_id=$1 and status='incomplete'`, [tenantId])).rows[0].count, 1);
  } finally {
    await pool.query(`delete from tenants where id=$1`, [tenantId]).catch(() => undefined);
    await pool.end();
    previousSecret === undefined ? delete process.env.STRIPE_WEBHOOK_SECRET : process.env.STRIPE_WEBHOOK_SECRET = previousSecret;
  }
});

test("only a different human reviewer can confirm original wording at publish", { skip: !databaseUrl }, async () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const author: Principal = {
    id: randomUUID(), email: `author-${randomUUID()}@example.com`, cognitoSub: randomUUID(),
    fullName: "Content Author", kind: "human", status: "active",
  };
  const reviewer: Principal = {
    id: randomUUID(), email: `reviewer-${randomUUID()}@example.com`, cognitoSub: randomUUID(),
    fullName: "Content Reviewer", kind: "human", status: "active",
  };
  const service = new CommercialService(pool, {} as AuthService);
  let articleId: string | undefined;

  try {
    for (const user of [author, reviewer]) {
      await pool.query(`insert into users (id,email,cognito_sub,full_name) values ($1,$2,$3,$4)`, [user.id, user.email, user.cognitoSub, user.fullName]);
      await pool.query(`insert into platform_admins (user_id,can_manage_content) values ($1,true)`, [user.id]);
    }
    const article = await service.createArticle(author, {
      slug: `review-${randomUUID()}`,
      title: "Original guidance",
      body: "An original explanation without protected clause text.",
      originalWordingConfirmed: true,
    });
    articleId = article.id;
    assert.equal((await pool.query(`select original_wording_confirmed from knowledge_base_articles where id=$1`, [articleId])).rows[0].original_wording_confirmed, false);
    await service.transitionArticle(author, articleId, "in_review", {});
    await assert.rejects(service.transitionArticle(author, articleId, "published", { originalWordingConfirmed: true }), ConflictException);
    await service.transitionArticle(reviewer, articleId, "published", { originalWordingConfirmed: true });
    const published = (await pool.query(`select reviewer_id,original_wording_confirmed from knowledge_base_articles where id=$1`, [articleId])).rows[0];
    assert.equal(published.reviewer_id, reviewer.id);
    assert.equal(published.original_wording_confirmed, true);
  } finally {
    if (articleId) await pool.query(`delete from knowledge_base_articles where id=$1`, [articleId]).catch(() => undefined);
    await pool.query(`delete from content_authors where id=any($1::uuid[])`, [[author.id, reviewer.id]]).catch(() => undefined);
    await pool.query(`delete from users where id=any($1::uuid[])`, [[author.id, reviewer.id]]).catch(() => undefined);
    await pool.end();
  }
});
