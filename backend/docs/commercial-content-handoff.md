# E13-E14 commercial and content handoff

SubmitSense now has one backend contract for self-serve onboarding, pricing, trials, Stripe billing,
GST-ready invoices, reviewed public content, and contextual help. Stripe remains fail-closed until
the account-specific values below are supplied.

## Approved launch catalog

All prices are monthly AUD amounts displayed as GST-inclusive. There are no automatic overage
charges in the initial model.

| Plan | Price | Included limits |
|---|---:|---|
| Free Trial | $0 for 14 days | 1 user, 1 project, 3 distinct worksections |
| Starter | $149/month incl. GST | 3 users, 3 projects, 50 worksections/month |
| Professional | $399/month incl. GST | 10 users, 15 projects, 250 worksections/month |
| Enterprise | Contact sales | Limits agreed in the order form; SSO included |

The API returns cents, currency, tax-inclusive status, included usage, feature limits, and overage
copy from `GET /api/v1/pricing/plans`; the frontend must not hard-code these values.

## Onboarding contract

After Cognito signup and the existing internal user-link hook, call authenticated
`POST /api/v1/onboarding`:

```json
{
  "businessName": "Example Fire Pty Ltd",
  "slug": "example-fire",
  "legalName": "Example Fire Pty Ltd",
  "abn": "51824753556",
  "billingEmail": "accounts@example.com.au",
  "projectName": "First project",
  "trade": "fire_protection",
  "termsAccepted": true,
  "privacyAccepted": true
}
```

One transaction creates the tenant, owner membership, billing profile, versioned legal acceptance,
14-day trial, optional first project, project lead membership, and audit event. Repeating the same
request for the same owner/slug returns the existing resources.

Set `TERMS_VERSION` and `PRIVACY_VERSION` only after counsel supplies the launch documents. The API
returns 503 while either is missing; this intentionally prevents launch without legal terms.

## Trial enforcement

The processing path must call
`POST /api/v1/tenants/{tenantId}/projects/{projectId}/worksections/{worksectionId}/trial-usage`
before processing each extracted worksection. `app.claim_trial_worksection()` locks the subscription,
deduplicates repeated worksections, records an audit event, and rejects a fourth distinct trial
worksection. Paid subscriptions pass without consuming trial usage.

## Stripe configuration still required

Set these only when the Stripe AU account is ready:

- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `APP_URL`
- `plans.provider_price_id` for Starter and Professional via `PATCH /api/v1/admin/plans/{key}`

In Stripe, create AUD recurring Prices whose entered amount is tax-inclusive, enable Stripe Tax,
add the Australian GST registration when required, enable customer ABN/tax-ID collection, and set
invoice branding/legal identity. Confirm with an Australian tax adviser whether and when SubmitSense
must register for GST; this implementation is configuration-ready, not tax or legal advice.

Checkout requests automatic tax, billing address, tax ID, and customer name/address updates.
The webhook endpoint verifies the official `Stripe-Signature` against the raw request body, rejects
replays older than five minutes, resolves tenants only from stored Stripe customer IDs, and applies
events idempotently. Supported state changes cover subscription create/update/delete/trial events and
invoice paid/payment-failed events. Invoice hosted/PDF links and explicit GST amounts are stored for
tenant-scoped listing.

## Content workflow and NATSPEC rules

Platform admins create and edit drafts, then a different platform admin reviews them. Publishing
requires `{ "originalWordingConfirmed": true }` on the `in_review` → `published` request; only that
reviewer action sets the confirmation. Editing published content returns it to draft and clears the
confirmation. Database constraints also prevent publication when `contains_natspec_text` is true.
Articles may store a NATSPEC worksection reference but never protected clause text.

Appoint an administrator as the migration owner, not through a customer-facing endpoint:

```sql
insert into platform_admins (user_id, can_manage_pricing, can_manage_content)
values ('<user-uuid>', true, true);
```

Admin routes live under `/api/v1/admin/plans` and `/api/v1/admin/content/articles`. Public routes
expose only published articles, sitemap metadata, and approved contextual-help links; tenant
documents are never joined into this content model.

## Verification

Run:

```bash
(cd backend && npm run typecheck && npm test)
(cd backend && TEST_DATABASE_URL="$DATABASE_URL" node --import tsx --test test/commercial-webhook.integration.test.ts)
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/test/test_commercial_content.sql
```

The SQL check covers the three-worksection cap, GST metadata, webhook idempotency, publish safety,
and public/private content separation.
