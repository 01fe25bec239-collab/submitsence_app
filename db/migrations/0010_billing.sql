-- 0010_billing.sql
-- Plans, subscriptions, invoices (with GST/tax), and usage counters (req f23).
-- Money is stored as integer minor units (cents). Provider IDs are opaque references only.

begin;

-- --- Plans (global catalog; seeded in 0099) --------------------------------
create table plans (
  id               uuid primary key default gen_random_uuid(),
  key              text not null unique,
  name             text not null,
  tier             plan_tier not null,
  price_cents      integer not null default 0 check (price_cents >= 0),
  currency         text not null default 'AUD',
  billing_interval text not null default 'month' check (billing_interval in ('month', 'year')),
  is_active        boolean not null default true,
  features         jsonb not null default '{}'::jsonb,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- --- Tenant subscriptions (with trial) -------------------------------------
create table tenant_subscriptions (
  id                      uuid primary key default gen_random_uuid(),
  tenant_id               uuid not null references tenants(id) on delete cascade,
  plan_id                 uuid not null references plans(id) on delete restrict,
  status                  subscription_status not null default 'trialing',
  trial_ends_at           timestamptz,
  current_period_start    timestamptz,
  current_period_end      timestamptz,
  cancel_at               timestamptz,
  canceled_at             timestamptz,
  provider                text,                        -- e.g. 'stripe'
  provider_customer_id    text,                        -- opaque provider reference
  provider_subscription_id text,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);
-- at most one live subscription per tenant
create unique index uq_subscription_live on tenant_subscriptions (tenant_id)
  where status in ('trialing', 'active', 'past_due');
create index idx_subscriptions_tenant on tenant_subscriptions (tenant_id);

-- --- Invoices (GST/tax fields, req f23) ------------------------------------
create table invoices (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references tenants(id) on delete cascade,
  subscription_id    uuid references tenant_subscriptions(id) on delete set null,
  number             text,
  status             invoice_status not null default 'draft',
  currency           text not null default 'AUD',
  subtotal_cents     integer not null default 0 check (subtotal_cents >= 0),
  tax_cents          integer not null default 0 check (tax_cents >= 0),   -- GST amount
  total_cents        integer not null default 0 check (total_cents >= 0),
  gst_rate           numeric(5,4) not null default 0.1000,               -- AU GST 10%
  tax_label          text not null default 'GST',
  period_start       timestamptz,
  period_end         timestamptz,
  due_at             timestamptz,
  paid_at            timestamptz,
  provider_invoice_id text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint chk_invoice_total check (total_cents = subtotal_cents + tax_cents)
);
create index idx_invoices_tenant on invoices (tenant_id, status);
create unique index uq_invoice_number on invoices (number) where number is not null;

-- --- Usage counters (req f23) ----------------------------------------------
create table usage_counters (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants(id) on delete cascade,
  metric       text not null,                          -- e.g. 'documents_processed', 'pages_extracted'
  period_start date not null,
  period_end   date not null,
  count        bigint not null default 0 check (count >= 0),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (tenant_id, metric, period_start)
);
create index idx_usage_tenant on usage_counters (tenant_id, metric, period_start);

commit;
