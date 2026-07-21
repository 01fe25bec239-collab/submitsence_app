import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import type { Pool, PoolClient } from "pg";
import * as v from "../auth/validation";
import type { AuthContext, AuthedRequest, Principal } from "../auth/auth.types";
import { AuthService } from "../auth/auth.service";
import { StripeClient, validStripeSignature } from "../billing/stripe";
import { withTenantClient, withUserClient } from "../db/tenant-db";
import { PG_POOL } from "../db.module";
import * as api from "../api/validation";

const subscriptionStatuses = new Set(["trialing", "active", "past_due", "canceled", "incomplete"]);
const publicationStates = new Set(["draft", "in_review", "published", "archived"]);
const billingEventTypes = new Set([
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "customer.subscription.trial_will_end",
  "invoice.paid",
  "invoice.payment_failed",
]);

@Injectable()
export class CommercialService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly auth: AuthService,
  ) {}

  async publicPlans() {
    const result = await this.pool.query(
      `select key, name, tier, description, price_cents as "priceCents", currency,
              billing_interval as "billingInterval", tax_inclusive as "taxInclusive",
              included_usage as "includedUsage", overage_policy as "overagePolicy",
              feature_limits as "featureLimits", features
         from plans where is_active = true order by sort_order, price_cents`,
    );
    return result.rows;
  }

  async onboard(principal: Principal, body: Record<string, unknown>, req?: AuthedRequest) {
    if (body.termsAccepted !== true || body.privacyAccepted !== true) {
      throw new BadRequestException("Terms and privacy acknowledgement are required");
    }
    const termsVersion = process.env.TERMS_VERSION;
    const privacyVersion = process.env.PRIVACY_VERSION;
    if (!termsVersion || !privacyVersion) throw new ServiceUnavailableException("Legal document versions are not configured");
    const slug = this.slug(body.slug, "slug");
    const abn = api.optionalString(body.abn);
    if (abn && !/^\d{11}$/.test(abn)) throw new BadRequestException("abn must be 11 digits");
    const trade = api.enumValue(body.trade ?? "other", "trade", api.tradePackages);
    try {
      return await withUserClient(this.pool, principal.id, async (client) => {
        const result = await client.query(
          `select tenant_id as "tenantId", membership_id as "membershipId",
                  subscription_id as "subscriptionId", project_id as "projectId"
             from app.create_self_serve_tenant($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::trade_package,$11,$12)`,
          [
            principal.id,
            slug,
            v.string(body.businessName, "businessName"),
            api.optionalString(body.legalName) ?? "",
            abn ?? "",
            body.billingEmail ? v.email(body.billingEmail) : principal.email,
            termsVersion,
            privacyVersion,
            api.optionalString(body.projectName) ?? "",
            trade,
            this.ip(req) ?? "",
            this.userAgent(req),
          ],
        );
        return result.rows[0];
      });
    } catch (error) {
      if (this.pgCode(error) === "23505") throw new ConflictException("That business URL is already in use");
      throw error;
    }
  }

  async subscription(ctx: AuthContext) {
    await this.auth.requireTenantPermission(ctx, "billing.manage");
    return withTenantClient(this.pool, this.dbContext(ctx), async (client) => {
      const result = await client.query(
        `select s.id, s.status, s.trial_ends_at as "trialEndsAt", s.current_period_start as "currentPeriodStart",
                s.current_period_end as "currentPeriodEnd", s.cancel_at as "cancelAt", p.key as "planKey",
                p.name as "planName", p.feature_limits as "featureLimits"
           from tenant_subscriptions s join plans p on p.id = s.plan_id
          order by s.created_at desc limit 1`,
      );
      return result.rows[0] ?? null;
    });
  }

  async startTrial(ctx: AuthContext, req?: AuthedRequest) {
    await this.auth.requireTenantPermission(ctx, "billing.manage", req);
    return withTenantClient(this.pool, this.dbContext(ctx), async (client) => {
      const existing = await client.query(
        `select id,status,trial_ends_at as "trialEndsAt" from tenant_subscriptions order by created_at desc limit 1`,
      );
      if (existing.rows[0]) return existing.rows[0];
      const result = await client.query(
        `insert into tenant_subscriptions (tenant_id,plan_id,status,trial_ends_at)
         select $1,id,'trialing',now()+interval '14 days' from plans where key='trial' and is_active=true
         returning id,status,trial_ends_at as "trialEndsAt"`,
        [ctx.tenantId],
      );
      const row = result.rows[0] ?? (() => { throw new ServiceUnavailableException("Trial plan is not configured"); })();
      await this.tenantAudit(client, ctx, "trial_start", "Tenant trial started", {}, req);
      return row;
    });
  }

  async billingProfile(ctx: AuthContext) {
    await this.auth.requireTenantPermission(ctx, "billing.manage");
    return withTenantClient(this.pool, this.dbContext(ctx), async (client) => {
      const result = await client.query(
        `select billing_email as "billingEmail", billing_name as "billingName", abn, address,
                provider, provider_customer_id as "providerCustomerId"
           from tenant_billing_profiles where tenant_id = $1`,
        [ctx.tenantId],
      );
      return result.rows[0] ?? null;
    });
  }

  async updateBillingProfile(ctx: AuthContext, body: Record<string, unknown>, req?: AuthedRequest) {
    await this.auth.requireTenantPermission(ctx, "billing.manage", req);
    const abn = api.optionalString(body.abn);
    if (abn && !/^\d{11}$/.test(abn)) throw new BadRequestException("abn must be 11 digits");
    return withTenantClient(this.pool, this.dbContext(ctx), async (client) => {
      const result = await client.query(
        `insert into tenant_billing_profiles (tenant_id, billing_email, billing_name, abn, address)
         values ($1,$2,$3,$4,$5::jsonb)
         on conflict (tenant_id) do update set
           billing_email = excluded.billing_email, billing_name = excluded.billing_name,
           abn = excluded.abn, address = excluded.address
         returning billing_email as "billingEmail", billing_name as "billingName", abn, address`,
        [
          ctx.tenantId,
          v.email(body.billingEmail),
          api.optionalString(body.billingName),
          abn,
          JSON.stringify(api.object(body.address)),
        ],
      );
      await this.tenantAudit(client, ctx, "billing_profile_update", "Billing profile updated", {}, req);
      return result.rows[0];
    });
  }

  async checkout(ctx: AuthContext, body: Record<string, unknown>, req?: AuthedRequest) {
    await this.auth.requireTenantPermission(ctx, "billing.manage", req);
    const planKey = v.string(body.planKey, "planKey");
    const stripe = this.stripe();
    const appUrl = process.env.APP_URL;
    if (!appUrl) throw new ServiceUnavailableException("APP_URL is not configured");

    const data = await withTenantClient(this.pool, this.dbContext(ctx), async (client) => {
      const result = await client.query<{
        provider_price_id: string | null;
        customer_id: string | null;
        billing_email: string;
        billing_name: string | null;
      }>(
        `select p.provider_price_id, bp.provider_customer_id as customer_id, bp.billing_email, bp.billing_name
           from plans p cross join tenant_billing_profiles bp
          where p.key = $1 and p.is_active = true and p.tier not in ('trial','enterprise') and bp.tenant_id = $2`,
        [planKey, ctx.tenantId],
      );
      return result.rows[0] ?? (() => { throw new NotFoundException("billable plan or billing profile not found"); })();
    });
    if (!data.provider_price_id) throw new ServiceUnavailableException("Stripe price is not configured for this plan");

    let customerId = data.customer_id;
    if (!customerId) {
      const customer = await stripe.post("/customers", {
        email: data.billing_email,
        name: data.billing_name,
        "metadata[tenant_id]": ctx.tenantId,
      });
      customerId = v.string(customer.id, "Stripe customer id");
      await withTenantClient(this.pool, this.dbContext(ctx), async (client) => {
        await client.query(
          `update tenant_billing_profiles set provider = 'stripe', provider_customer_id = $2 where tenant_id = $1`,
          [ctx.tenantId, customerId],
        );
        await client.query(
          `update tenant_subscriptions set provider = 'stripe', provider_customer_id = $2
            where tenant_id = $1 and status in ('trialing','active','past_due')`,
          [ctx.tenantId, customerId],
        );
      });
    }

    const session = await stripe.post("/checkout/sessions", {
      mode: "subscription",
      customer: customerId,
      "line_items[0][price]": data.provider_price_id,
      "line_items[0][quantity]": 1,
      "automatic_tax[enabled]": true,
      "tax_id_collection[enabled]": true,
      "customer_update[address]": "auto",
      "customer_update[name]": "auto",
      billing_address_collection: "required",
      success_url: `${appUrl}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${appUrl}/pricing`,
      "subscription_data[metadata][tenant_id]": ctx.tenantId,
    });
    await withTenantClient(this.pool, this.dbContext(ctx), (client) =>
      this.tenantAudit(client, ctx, "subscription_checkout_created", "Stripe Checkout session created", { planKey, checkoutSessionId: api.optionalString(session.id) }, req),
    );
    return { checkoutUrl: v.string(session.url, "Stripe checkout URL") };
  }

  async changePlan(ctx: AuthContext, body: Record<string, unknown>, req?: AuthedRequest) {
    await this.auth.requireTenantPermission(ctx, "billing.manage", req);
    const stripe = this.stripe();
    const planKey = v.string(body.planKey, "planKey");
    const data = await withTenantClient(this.pool, this.dbContext(ctx), async (client) => {
      const result = await client.query<{ provider_subscription_id: string; provider_price_id: string }>(
        `select s.provider_subscription_id, p.provider_price_id
           from tenant_subscriptions s cross join plans p
          where s.tenant_id = $1 and s.status in ('active','past_due') and p.key = $2
            and p.is_active = true and p.provider_price_id is not null`,
        [ctx.tenantId, planKey],
      );
      return result.rows[0] ?? (() => { throw new NotFoundException("subscription or plan not found"); })();
    });
    const current = await stripe.get(`/subscriptions/${encodeURIComponent(data.provider_subscription_id)}`);
    const items = (current.items as { data?: Array<{ id?: unknown }> } | undefined)?.data ?? [];
    const itemId = v.string(items[0]?.id, "Stripe subscription item id");
    await stripe.post(`/subscriptions/${encodeURIComponent(data.provider_subscription_id)}`, {
      "items[0][id]": itemId,
      "items[0][price]": data.provider_price_id,
      proration_behavior: "create_prorations",
      payment_behavior: "pending_if_incomplete",
    });
    await withTenantClient(this.pool, this.dbContext(ctx), (client) => this.tenantAudit(client, ctx, "subscription_plan_change_requested", "Subscription plan change requested", { planKey }, req));
    return { status: "pending", planKey };
  }

  async cancelSubscription(ctx: AuthContext, req?: AuthedRequest) {
    await this.auth.requireTenantPermission(ctx, "billing.manage", req);
    const providerId = await withTenantClient(this.pool, this.dbContext(ctx), async (client) => {
      const result = await client.query<{ provider_subscription_id: string }>(
        `select provider_subscription_id from tenant_subscriptions
          where tenant_id = $1 and status in ('active','past_due')`,
        [ctx.tenantId],
      );
      return result.rows[0]?.provider_subscription_id;
    });
    if (!providerId) throw new NotFoundException("active Stripe subscription not found");
    await this.stripe().post(`/subscriptions/${encodeURIComponent(providerId)}`, { cancel_at_period_end: true });
    await withTenantClient(this.pool, this.dbContext(ctx), async (client) => {
      await client.query(`update tenant_subscriptions set cancel_at = current_period_end where provider_subscription_id = $1`, [providerId]);
      await this.tenantAudit(client, ctx, "subscription_cancel_requested", "Subscription cancellation requested", {}, req);
    });
    return { cancelAtPeriodEnd: true };
  }

  async invoices(ctx: AuthContext) {
    await this.auth.requireTenantPermission(ctx, "billing.manage");
    return withTenantClient(this.pool, this.dbContext(ctx), async (client) => {
      const result = await client.query(
        `select id, number, status, currency, subtotal_cents as "subtotalCents", tax_cents as "taxCents",
                total_cents as "totalCents", gst_rate as "gstRate", tax_label as "taxLabel",
                period_start as "periodStart", period_end as "periodEnd", paid_at as "paidAt",
                hosted_invoice_url as "hostedInvoiceUrl", invoice_pdf_url as "invoicePdfUrl"
           from invoices order by created_at desc`,
      );
      return result.rows;
    });
  }

  async claimTrialWorksection(ctx: AuthContext, projectId: string, worksectionId: string) {
    try {
      return await withTenantClient(this.pool, this.dbContext(ctx), async (client) => {
        const result = await client.query(
          `select usage_count as "usageCount", usage_limit as "usageLimit", enforced
             from app.claim_trial_worksection($1,$2)`,
          [v.uuid(projectId, "projectId"), v.uuid(worksectionId, "worksectionId")],
        );
        return result.rows[0];
      });
    } catch (error) {
      if (this.pgCode(error) === "23514") throw new ForbiddenException("Trial worksection limit reached or trial ended");
      if (this.pgCode(error) === "P0002") throw new NotFoundException("worksection not found");
      throw error;
    }
  }

  async billingWebhook(signature: string | undefined, rawBody: Buffer | undefined, body: Record<string, unknown>, req?: AuthedRequest) {
    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!secret || !signature || !rawBody || !validStripeSignature(rawBody, signature, secret)) throw new ForbiddenException("Forbidden");
    const eventId = v.string(body.id, "Stripe event id");
    const eventType = v.string(body.type, "Stripe event type");
    if (!billingEventTypes.has(eventType)) return { id: eventId, status: "ignored" };
    const object = api.object(api.object(body.data).object);
    const customerId = this.stripeId(object.customer, "Stripe customer id");
    const tenantId = await this.resolveBillingTenant(customerId);
    return withTenantClient(this.pool, { tenantId, actorType: "system", userId: null }, async (client) => {
      const inserted = await client.query<{ id: string; status: string; inserted: boolean }>(
        `insert into billing_webhook_events (tenant_id, provider, provider_event_id, event_type, payload)
         values ($1,'stripe',$2,$3,$4::jsonb)
         on conflict (provider, provider_event_id) do update set provider_event_id = excluded.provider_event_id
         returning id, status, (xmax = 0) as inserted`,
        [tenantId, eventId, eventType, JSON.stringify(object)],
      );
      const event = inserted.rows[0];
      if (!event.inserted && event.status === "processed") return { id: event.id, status: event.status };
      await this.applyBillingEvent(client, tenantId, eventType, object);
      await client.query(`update billing_webhook_events set status = 'processed', processed_at = now() where id = $1`, [event.id]);
      await client.query(
        `insert into audit_events (tenant_id,event_type,actor_type,entity_type,entity_id,action,summary,payload,ip_address,user_agent)
         values ($1,'billing_event','system','billing_webhook',$2,$3,'Stripe billing event processed',$4::jsonb,nullif($5::text,'')::inet,$6)`,
        [tenantId, event.id, eventType, JSON.stringify({ providerEventId: eventId, requestId: req?.requestId }), this.ip(req) ?? "", this.userAgent(req)],
      );
      return { id: event.id, status: "processed" };
    });
  }

  async publicArticles(query: Record<string, unknown>) {
    const q = api.optionalString(query.q);
    const category = api.optionalString(query.category);
    const tag = api.optionalString(query.tag);
    const result = await this.pool.query(
      `select a.slug, a.title, a.excerpt, a.seo_title as "seoTitle", a.seo_description as "seoDescription",
              a.canonical_url as "canonicalUrl", a.natspec_reference as "natspecReference",
              a.published_at as "publishedAt", c.slug as "category", ca.name as "author",
              coalesce(jsonb_agg(distinct t.name) filter (where t.id is not null), '[]'::jsonb) as tags
         from knowledge_base_articles a
         left join content_categories c on c.id = a.category_id
         left join content_authors ca on ca.id = a.author_id
         left join content_article_tags at on at.article_id = a.id
         left join content_tags t on t.id = at.tag_id
        where a.publication_state = 'published'
          and ($1::text is null or a.title ilike '%'||$1||'%' or coalesce(a.excerpt,'') ilike '%'||$1||'%' or coalesce(a.body,'') ilike '%'||$1||'%')
          and ($2::text is null or c.slug = $2::citext)
          and ($3::text is null or exists (select 1 from content_article_tags at2 join content_tags t2 on t2.id=at2.tag_id where at2.article_id=a.id and t2.slug=$3::citext))
        group by a.id, c.slug, ca.name order by a.published_at desc nulls last limit 100`,
      [q, category, tag],
    );
    return result.rows;
  }

  async publicArticle(slug: string) {
    const result = await this.pool.query(
      `select a.slug, a.title, a.body, a.excerpt, a.seo_title as "seoTitle", a.seo_description as "seoDescription",
              a.seo_keywords as "seoKeywords", a.canonical_url as "canonicalUrl",
              a.natspec_reference as "natspecReference", a.published_at as "publishedAt",
              c.slug as "category", ca.name as "author", ca.bio as "authorBio",
              coalesce(jsonb_agg(distinct t.name) filter (where t.id is not null), '[]'::jsonb) as tags
         from knowledge_base_articles a
         left join content_categories c on c.id = a.category_id
         left join content_authors ca on ca.id = a.author_id
         left join content_article_tags at on at.article_id = a.id
         left join content_tags t on t.id = at.tag_id
        where a.slug = $1::citext and a.publication_state = 'published'
        group by a.id, c.slug, ca.name, ca.bio`,
      [this.slug(slug, "slug")],
    );
    return result.rows[0] ?? (() => { throw new NotFoundException("article not found"); })();
  }

  async sitemap() {
    const result = await this.pool.query(
      `select slug, coalesce(published_at, updated_at) as "lastModified", canonical_url as "canonicalUrl"
         from knowledge_base_articles where publication_state = 'published' and search_noindex = false
        order by slug`,
    );
    return result.rows;
  }

  async contextualHelp(query: Record<string, unknown>) {
    const values = [query.screen, query.worksection, query.riskType, query.featureArea ?? query.feature].map(api.optionalString);
    const result = await this.pool.query(
      `select distinct a.slug, a.title, a.excerpt, h.sort_order as "sortOrder"
         from contextual_help_links h join knowledge_base_articles a on a.id = h.article_id
        where a.publication_state = 'published'
          and ($1::text is null or lower(h.screen) = lower($1))
          and ($2::text is null or lower(h.worksection) = lower($2))
          and ($3::text is null or lower(h.risk_type) = lower($3))
          and ($4::text is null or lower(h.feature_area) = lower($4))
        order by h.sort_order, a.title limit 20`,
      values,
    );
    return result.rows;
  }

  async adminPlans(principal: Principal) {
    return withUserClient(this.pool, principal.id, async (client) => {
      await this.requirePlatformAdmin(client, "pricing");
      return (await client.query(`select * from plans order by sort_order, price_cents`)).rows;
    });
  }

  async updatePlan(principal: Principal, key: string, body: Record<string, unknown>, req?: AuthedRequest) {
    return withUserClient(this.pool, principal.id, async (client) => {
      await this.requirePlatformAdmin(client, "pricing");
      const result = await client.query(
        `update plans set name=coalesce($2,name), description=coalesce($3,description),
                price_cents=coalesce($4,price_cents), provider_price_id=coalesce($5,provider_price_id),
                included_usage=coalesce($6::jsonb,included_usage), overage_policy=coalesce($7,overage_policy),
                feature_limits=coalesce($8::jsonb,feature_limits), features=coalesce($9::jsonb,features),
                is_active=coalesce($10,is_active), tax_inclusive=coalesce($11,tax_inclusive)
          where key=$1 returning *`,
        [
          v.string(key, "plan key"), api.optionalString(body.name), api.optionalString(body.description),
          api.positiveInt(body.priceCents, "priceCents"), api.optionalString(body.providerPriceId),
          body.includedUsage === undefined ? null : JSON.stringify(api.object(body.includedUsage)), api.optionalString(body.overagePolicy),
          body.featureLimits === undefined ? null : JSON.stringify(api.object(body.featureLimits)),
          body.features === undefined ? null : JSON.stringify(api.object(body.features)),
          typeof body.isActive === "boolean" ? body.isActive : null, typeof body.taxInclusive === "boolean" ? body.taxInclusive : null,
        ],
      );
      const row = result.rows[0] ?? (() => { throw new NotFoundException("plan not found"); })();
      await this.platformAudit(client, principal, "plan", row.id, "pricing_update", "Pricing plan updated", { key, requestId: req?.requestId });
      return row;
    });
  }

  async adminArticles(principal: Principal) {
    return withUserClient(this.pool, principal.id, async (client) => {
      await this.requirePlatformAdmin(client, "content");
      return (await client.query(`select id, slug, title, publication_state as "publicationState", updated_at as "updatedAt" from knowledge_base_articles order by updated_at desc`)).rows;
    });
  }

  async createArticle(principal: Principal, body: Record<string, unknown>, req?: AuthedRequest) {
    return withUserClient(this.pool, principal.id, async (client) => {
      await this.requirePlatformAdmin(client, "content");
      await client.query(
        `insert into content_authors (id,name) values ($1,$2) on conflict (id) do update set name=excluded.name`,
        [principal.id, principal.fullName],
      );
      const categoryId = await this.upsertCategory(client, body.category);
      const result = await client.query<{ id: string }>(
        `insert into knowledge_base_articles
          (slug,title,body,excerpt,seo_title,seo_description,seo_keywords,canonical_url,natspec_reference,
           author_id,category_id,contains_natspec_text,original_wording_confirmed,search_noindex,publication_state)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,false,$13,'draft') returning id,slug,title,publication_state as "publicationState"`,
        [
          this.slug(body.slug, "slug"), v.string(body.title, "title"), v.string(body.body, "body"), api.optionalString(body.excerpt),
          api.optionalString(body.seoTitle), api.optionalString(body.seoDescription), api.stringArray(body.seoKeywords, "seoKeywords"),
          api.optionalString(body.canonicalUrl), api.optionalString(body.natspecReference), principal.id, categoryId,
          body.containsNatspecText === true, body.searchNoindex === true,
        ],
      );
      await this.replaceTags(client, result.rows[0].id, body.tags);
      await this.replaceHelpLinks(client, result.rows[0].id, body.helpContexts);
      await this.platformAudit(client, principal, "knowledge_base_article", result.rows[0].id, "content_create", "Content draft created", { requestId: req?.requestId });
      return result.rows[0];
    });
  }

  async updateArticle(principal: Principal, articleId: string, body: Record<string, unknown>, req?: AuthedRequest) {
    return withUserClient(this.pool, principal.id, async (client) => {
      await this.requirePlatformAdmin(client, "content");
      const id = v.uuid(articleId, "articleId");
      const categoryId = body.category === undefined ? null : await this.upsertCategory(client, body.category);
      const result = await client.query(
        `update knowledge_base_articles set
           slug=coalesce($2,slug), title=coalesce($3,title), body=coalesce($4,body), excerpt=coalesce($5,excerpt),
           seo_title=coalesce($6,seo_title), seo_description=coalesce($7,seo_description), canonical_url=coalesce($8,canonical_url),
           natspec_reference=coalesce($9,natspec_reference), category_id=coalesce($10,category_id),
           contains_natspec_text=coalesce($11,contains_natspec_text),
           original_wording_confirmed=false,
           search_noindex=coalesce($12,search_noindex),
           publication_state=case when publication_state='published' then 'draft'::publication_state else publication_state end,
           reviewer_id=case when publication_state='published' then null else reviewer_id end,
           reviewed_at=case when publication_state='published' then null else reviewed_at end,
           published_at=case when publication_state='published' then null else published_at end
         where id=$1 returning id,slug,title,publication_state as "publicationState"`,
        [
          id, body.slug === undefined ? null : this.slug(body.slug, "slug"), api.optionalString(body.title), api.optionalString(body.body),
          api.optionalString(body.excerpt), api.optionalString(body.seoTitle), api.optionalString(body.seoDescription),
          api.optionalString(body.canonicalUrl), api.optionalString(body.natspecReference), categoryId,
          typeof body.containsNatspecText === "boolean" ? body.containsNatspecText : null,
          typeof body.searchNoindex === "boolean" ? body.searchNoindex : null,
        ],
      );
      const row = result.rows[0] ?? (() => { throw new NotFoundException("article not found"); })();
      if (body.tags !== undefined) await this.replaceTags(client, id, body.tags);
      if (body.helpContexts !== undefined) await this.replaceHelpLinks(client, id, body.helpContexts);
      await this.platformAudit(client, principal, "knowledge_base_article", id, "content_edit", "Content draft edited", { requestId: req?.requestId });
      return row;
    });
  }

  async transitionArticle(principal: Principal, articleId: string, state: string, body: Record<string, unknown>, req?: AuthedRequest) {
    if (!publicationStates.has(state)) throw new BadRequestException("publication state is invalid");
    if (state === "published" && body.originalWordingConfirmed !== true) {
      throw new BadRequestException("The reviewer must confirm the article uses original wording");
    }
    try {
      return await withUserClient(this.pool, principal.id, async (client) => {
        await this.requirePlatformAdmin(client, "content");
        const id = v.uuid(articleId, "articleId");
        let sql: string;
        if (state === "in_review") {
          sql = `update knowledge_base_articles set publication_state='in_review' where id=$1 and publication_state='draft' returning id,slug,title,publication_state as "publicationState"`;
        } else if (state === "published") {
          sql = `update knowledge_base_articles set publication_state='published',reviewer_id=$2,reviewed_at=now(),published_at=now(),archived_at=null,original_wording_confirmed=true
                  where id=$1 and publication_state='in_review' and author_id is distinct from $2
                  returning id,slug,title,publication_state as "publicationState",published_at as "publishedAt"`;
        } else if (state === "archived") {
          sql = `update knowledge_base_articles set publication_state='archived',archived_at=now() where id=$1 and publication_state<>'archived' returning id,slug,title,publication_state as "publicationState"`;
        } else {
          throw new BadRequestException("Use article editing to return published content to draft");
        }
        const result = await client.query(sql, state === "published" ? [id, principal.id] : [id]);
        const row = result.rows[0] ?? (() => { throw new ConflictException("Invalid content workflow transition"); })();
        await this.platformAudit(client, principal, "knowledge_base_article", id, `content_${state}`, `Content ${state}`, {
          requestId: req?.requestId,
          ...(state === "published" ? { originalWordingConfirmed: true } : {}),
        });
        return row;
      });
    } catch (error) {
      if (this.pgCode(error) === "23514") throw new ConflictException("Content safety review is incomplete");
      throw error;
    }
  }

  private async applyBillingEvent(client: PoolClient, tenantId: string, eventType: string, object: Record<string, unknown>) {
    if (eventType.startsWith("customer.subscription.")) {
      const providerSubscriptionId = v.string(object.id, "Stripe subscription id");
      const customerId = this.stripeId(object.customer, "Stripe customer id");
      const rawStatus = eventType === "customer.subscription.deleted" ? "canceled" : String(object.status ?? "incomplete");
      const status = subscriptionStatuses.has(rawStatus) ? rawStatus : rawStatus === "unpaid" ? "past_due" : "incomplete";
      const priceId = this.nestedString(object, ["items", "data", "0", "price", "id"]);
      const plan = priceId ? await client.query<{ id: string }>(`select id from plans where provider_price_id=$1`, [priceId]) : { rows: [] as { id: string }[] };
      const updated = await client.query(
        `update tenant_subscriptions set plan_id=coalesce($2,plan_id), status=$3::subscription_status,
                provider='stripe', provider_customer_id=$4, provider_subscription_id=$5,
                trial_ends_at=coalesce(to_timestamp($6),trial_ends_at), current_period_start=to_timestamp($7),
                current_period_end=to_timestamp($8), cancel_at=case when $9 then to_timestamp($8) else null end,
                canceled_at=case when $3='canceled' then now() else canceled_at end
          where id = coalesce(
            (select id from tenant_subscriptions where tenant_id=$1 and provider_subscription_id=$5 limit 1),
            (select id from tenant_subscriptions where tenant_id=$1 and provider_subscription_id is null
              and status in ('trialing','active','past_due') order by created_at desc limit 1)
          )`,
        [tenantId, plan.rows[0]?.id ?? null, status, customerId, providerSubscriptionId,
          this.epoch(object.trial_end), this.epoch(object.current_period_start), this.epoch(object.current_period_end), object.cancel_at_period_end === true],
      );
      if (!updated.rowCount) {
        if (!plan.rows[0]) throw new ServiceUnavailableException("Stripe price is not mapped to a SubmitSense plan");
        await client.query(
          `insert into tenant_subscriptions
            (tenant_id,plan_id,status,provider,provider_customer_id,provider_subscription_id,trial_ends_at,current_period_start,current_period_end,cancel_at,canceled_at)
           values ($1,$2,$3::subscription_status,'stripe',$4,$5,to_timestamp($6),to_timestamp($7),to_timestamp($8),
                   case when $9 then to_timestamp($8) else null end,case when $3='canceled' then now() else null end)`,
          [tenantId, plan.rows[0].id, status, customerId, providerSubscriptionId,
            this.epoch(object.trial_end), this.epoch(object.current_period_start), this.epoch(object.current_period_end), object.cancel_at_period_end === true],
        );
      }
      await client.query(
        `update tenant_billing_profiles set provider='stripe',provider_customer_id=$2 where tenant_id=$1`,
        [tenantId, customerId],
      );
      return;
    }
    if (eventType.startsWith("invoice.")) {
      const providerInvoiceId = v.string(object.id, "Stripe invoice id");
      const providerSubscriptionId = this.stripeId(object.subscription, "Stripe subscription id", true);
      const total = this.integer(object.total);
      const tax = this.taxTotal(object.total_tax_amounts);
      const status = eventType === "invoice.paid" ? "paid" : eventType === "invoice.payment_failed" ? "open" : this.invoiceStatus(object.status);
      await client.query(
        `insert into invoices
          (tenant_id,subscription_id,number,status,currency,subtotal_cents,tax_cents,total_cents,gst_rate,tax_label,
           period_start,period_end,paid_at,provider_invoice_id,hosted_invoice_url,invoice_pdf_url)
         values ($1,
                (select id from tenant_subscriptions where tenant_id=$1 and ($13::text is null or provider_subscription_id=$13)
                  order by created_at desc limit 1),
                $2,$3::invoice_status,upper($4),$5,$6,$7,case when $6 > 0 then 0.1000 else 0 end,'GST',
                to_timestamp($8),to_timestamp($9),case when $3='paid' then now() else null end,$10,$11,$12)
         on conflict (provider_invoice_id) where provider_invoice_id is not null do update set
           number=excluded.number,status=excluded.status,subtotal_cents=excluded.subtotal_cents,tax_cents=excluded.tax_cents,
           total_cents=excluded.total_cents,paid_at=excluded.paid_at,hosted_invoice_url=excluded.hosted_invoice_url,
           invoice_pdf_url=excluded.invoice_pdf_url,period_start=excluded.period_start,period_end=excluded.period_end`,
        [tenantId, api.optionalString(object.number), status, String(object.currency ?? "aud"), Math.max(0, total - tax), tax, total,
          this.epoch(object.period_start), this.epoch(object.period_end), providerInvoiceId,
          api.optionalString(object.hosted_invoice_url), api.optionalString(object.invoice_pdf), providerSubscriptionId],
      );
    }
  }

  private async requirePlatformAdmin(client: PoolClient, capability: "pricing" | "content") {
    const result = await client.query<{ allowed: boolean }>(`select app.is_platform_admin($1) as allowed`, [capability]);
    if (!result.rows[0]?.allowed) throw new ForbiddenException("Forbidden");
  }

  private async upsertCategory(client: PoolClient, value: unknown): Promise<string | null> {
    const name = api.optionalString(value);
    if (!name) return null;
    const slug = this.slug(name, "category");
    const result = await client.query<{ id: string }>(
      `insert into content_categories (slug,name) values ($1,$2)
       on conflict (slug) do update set name=excluded.name returning id`,
      [slug, name],
    );
    return result.rows[0].id;
  }

  private async replaceTags(client: PoolClient, articleId: string, value: unknown) {
    const tags = api.stringArray(value, "tags");
    await client.query(`delete from content_article_tags where article_id=$1`, [articleId]);
    for (const name of tags) {
      const tag = await client.query<{ id: string }>(
        `insert into content_tags (slug,name) values ($1,$2)
         on conflict (slug) do update set name=excluded.name returning id`,
        [this.slug(name, "tag"), name],
      );
      await client.query(`insert into content_article_tags (article_id,tag_id) values ($1,$2)`, [articleId, tag.rows[0].id]);
    }
  }

  private async replaceHelpLinks(client: PoolClient, articleId: string, value: unknown) {
    if (value === undefined) return;
    if (!Array.isArray(value)) throw new BadRequestException("helpContexts must be an array");
    await client.query(`delete from contextual_help_links where article_id=$1`, [articleId]);
    for (const item of value) {
      const context = api.object(item);
      const fields = [context.screen, context.worksection, context.riskType, context.featureArea].map(api.optionalString);
      if (!fields.some(Boolean)) throw new BadRequestException("Each help context needs a screen, worksection, riskType, or featureArea");
      await client.query(
        `insert into contextual_help_links (article_id,screen,worksection,risk_type,feature_area,sort_order) values ($1,$2,$3,$4,$5,$6)`,
        [articleId, ...fields, api.positiveInt(context.sortOrder, "sortOrder") ?? 0],
      );
    }
  }

  private async platformAudit(client: PoolClient, principal: Principal, entityType: string, entityId: string, action: string, summary: string, payload: Record<string, unknown>) {
    await client.query(
      `insert into audit_events (event_type,actor_user_id,actor_type,entity_type,entity_id,action,summary,payload)
       values ('admin_action',$1,'human',$2,$3,$4,$5,$6::jsonb)`,
      [principal.id, entityType, entityId, action, summary, JSON.stringify(payload)],
    );
  }

  private async tenantAudit(client: PoolClient, ctx: AuthContext, action: string, summary: string, payload: Record<string, unknown>, req?: AuthedRequest) {
    await client.query(
      `insert into audit_events (tenant_id,event_type,actor_user_id,actor_type,entity_type,entity_id,action,summary,payload,ip_address,user_agent)
       values ($1,'billing_event',$2,$3,'tenant',$1,$4,$5,$6::jsonb,nullif($7::text,'')::inet,$8)`,
      [ctx.tenantId, ctx.principal.id, ctx.actorType, action, summary, JSON.stringify({ requestId: req?.requestId, ...payload }), this.ip(req) ?? "", this.userAgent(req)],
    );
  }

  private stripe() {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) throw new ServiceUnavailableException("Stripe is not configured");
    return new StripeClient(key);
  }

  private async resolveBillingTenant(customerId: string) {
    const result = await this.pool.query<{ tenant_id: string | null }>(`select app.resolve_billing_tenant('stripe',$1) as tenant_id`, [customerId]);
    if (!result.rows[0]?.tenant_id) throw new ForbiddenException("Forbidden");
    return result.rows[0].tenant_id;
  }

  private stripeId(value: unknown, name: string): string;
  private stripeId(value: unknown, name: string, optional: true): string | null;
  private stripeId(value: unknown, name: string, optional = false): string | null {
    if (optional && (value === null || value === undefined || value === "")) return null;
    if (typeof value === "string") return v.string(value, name);
    if (value && typeof value === "object" && "id" in value) return v.string((value as { id: unknown }).id, name);
    throw new BadRequestException(`${name} is required`);
  }

  private nestedString(value: unknown, path: string[]): string | null {
    let current: unknown = value;
    for (const part of path) {
      if (Array.isArray(current)) current = current[Number(part)];
      else if (current && typeof current === "object") current = (current as Record<string, unknown>)[part];
      else return null;
    }
    return api.optionalString(current);
  }

  private invoiceStatus(value: unknown) {
    const status = String(value ?? "draft");
    return new Set(["draft", "open", "paid", "void", "uncollectible"]).has(status) ? status : "draft";
  }

  private taxTotal(value: unknown) {
    if (!Array.isArray(value)) return 0;
    return value.reduce((sum, item) => sum + this.integer(api.object(item).amount), 0);
  }

  private epoch(value: unknown) {
    if (value === null || value === undefined || value === "") return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  private integer(value: unknown) {
    const number = Number(value ?? 0);
    return Number.isInteger(number) && number >= 0 ? number : 0;
  }

  private slug(value: unknown, name: string) {
    const slug = v.string(value, name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    if (!slug || slug.length > 100) throw new BadRequestException(`${name} is invalid`);
    return slug;
  }

  private dbContext(ctx: AuthContext) {
    return { tenantId: ctx.tenantId, userId: ctx.principal.id, actorType: ctx.actorType } as const;
  }

  private pgCode(error: unknown) {
    return typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
  }

  private ip(req?: AuthedRequest) {
    return req?.ip ?? req?.socket?.remoteAddress ?? null;
  }

  private userAgent(req?: AuthedRequest) {
    const value = req?.headers["user-agent"];
    return Array.isArray(value) ? value[0] ?? null : value ?? null;
  }
}
