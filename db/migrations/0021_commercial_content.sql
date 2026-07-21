-- 0021_commercial_content.sql
-- E13-E14: self-serve onboarding, enforceable trials, Stripe-ready billing, and reviewed content.

begin;

alter table plans
  add column description text,
  add column included_usage jsonb not null default '{}'::jsonb,
  add column overage_policy text not null default 'Upgrade before exceeding the included usage.',
  add column feature_limits jsonb not null default '{}'::jsonb,
  add column provider_price_id text unique,
  add column tax_inclusive boolean not null default true,
  add column sort_order integer not null default 0;

create table tenant_billing_profiles (
  tenant_id            uuid primary key references tenants(id) on delete cascade,
  billing_email        citext not null,
  billing_name         text,
  abn                  text,
  address              jsonb not null default '{}'::jsonb,
  provider             text,
  provider_customer_id text unique,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  check (abn is null or abn ~ '^[0-9]{11}$')
);

create table legal_acceptances (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants(id) on delete cascade,
  user_id         uuid not null references users(id) on delete restrict,
  terms_version   text not null,
  privacy_version text not null,
  ip_address      inet,
  user_agent      text,
  accepted_at     timestamptz not null default now(),
  unique (tenant_id, user_id, terms_version, privacy_version)
);

create table trial_worksection_usage (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants(id) on delete cascade,
  project_id     uuid not null,
  worksection_id uuid not null,
  used_at        timestamptz not null default now(),
  unique (tenant_id, worksection_id),
  foreign key (tenant_id, project_id) references projects(tenant_id, id) on delete cascade,
  foreign key (tenant_id, worksection_id) references worksections(tenant_id, id) on delete cascade
);

create table billing_webhook_events (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenants(id) on delete cascade,
  provider          text not null,
  provider_event_id text not null,
  event_type        text not null,
  status            webhook_status not null default 'received',
  payload           jsonb not null default '{}'::jsonb,
  processed_at      timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (provider, provider_event_id)
);

alter table invoices
  add column hosted_invoice_url text,
  add column invoice_pdf_url text;
create unique index uq_invoices_provider on invoices(provider_invoice_id) where provider_invoice_id is not null;

create table platform_admins (
  user_id             uuid primary key references users(id) on delete cascade,
  can_manage_pricing  boolean not null default false,
  can_manage_content  boolean not null default false,
  created_at          timestamptz not null default now()
);

create or replace function app.is_platform_admin(p_capability text) returns boolean
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $$
  select exists (
    select 1 from platform_admins
     where user_id = app.current_user_id()
       and case p_capability
             when 'pricing' then can_manage_pricing
             when 'content' then can_manage_content
             else false
           end
  )
$$;

create table content_authors (
  id         uuid primary key,
  name       text not null,
  bio        text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into content_authors (id, name)
select distinct u.id, u.full_name
  from users u join knowledge_base_articles a on a.author_id = u.id;

alter table knowledge_base_articles
  drop constraint knowledge_base_articles_author_id_fkey,
  add constraint knowledge_base_articles_author_id_fkey foreign key (author_id) references content_authors(id),
  add column canonical_url text,
  add column natspec_reference text,
  add column original_wording_confirmed boolean not null default false,
  add column search_noindex boolean not null default false;

update knowledge_base_articles
   set original_wording_confirmed = true
 where publication_state = 'published' and contains_natspec_text = false;

alter table knowledge_base_articles
  drop constraint chk_publish_copyright_safe,
  add constraint chk_publish_copyright_safe check (
    publication_state <> 'published'
    or (contains_natspec_text = false and original_wording_confirmed = true)
  );

create table content_categories (
  id          uuid primary key default gen_random_uuid(),
  slug        citext not null unique,
  name        text not null,
  description text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table content_tags (
  id         uuid primary key default gen_random_uuid(),
  slug       citext not null unique,
  name       text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table knowledge_base_articles
  add column category_id uuid references content_categories(id) on delete set null;

create table content_article_tags (
  article_id uuid not null references knowledge_base_articles(id) on delete cascade,
  tag_id     uuid not null references content_tags(id) on delete cascade,
  primary key (article_id, tag_id)
);

create table contextual_help_links (
  id             uuid primary key default gen_random_uuid(),
  article_id     uuid not null references knowledge_base_articles(id) on delete cascade,
  screen         text,
  worksection    text,
  risk_type      text,
  feature_area   text,
  sort_order     integer not null default 0,
  created_at     timestamptz not null default now(),
  check (num_nonnulls(screen, worksection, risk_type, feature_area) > 0)
);
create index idx_contextual_help_lookup on contextual_help_links (screen, worksection, risk_type, feature_area);

-- New tenant-owned tables use the same RLS contract as the rest of the schema.
alter table tenant_billing_profiles enable row level security;
create policy tenant_isolation on tenant_billing_profiles
  using (tenant_id = app.current_tenant_id()) with check (tenant_id = app.current_tenant_id());
alter table legal_acceptances enable row level security;
create policy tenant_isolation on legal_acceptances
  using (tenant_id = app.current_tenant_id()) with check (tenant_id = app.current_tenant_id());
alter table trial_worksection_usage enable row level security;
create policy tenant_isolation on trial_worksection_usage
  using (tenant_id = app.current_tenant_id()) with check (tenant_id = app.current_tenant_id());
alter table billing_webhook_events enable row level security;
create policy tenant_isolation on billing_webhook_events
  using (tenant_id = app.current_tenant_id()) with check (tenant_id = app.current_tenant_id());

-- Public catalog/content remains readable; only explicitly appointed platform admins may mutate it.
alter table plans enable row level security;
create policy plan_public_read on plans for select using (true);
create policy plan_admin_write on plans for all using (app.is_platform_admin('pricing')) with check (app.is_platform_admin('pricing'));
create policy kb_admin_write on knowledge_base_articles for all
  using (app.is_platform_admin('content')) with check (app.is_platform_admin('content'));
create policy audit_platform_admin_insert on audit_events for insert with check (
  tenant_id is null and (app.is_platform_admin('pricing') or app.is_platform_admin('content'))
);
create policy audit_platform_admin_read on audit_events for select using (
  tenant_id is null and (app.is_platform_admin('pricing') or app.is_platform_admin('content'))
);

alter table content_authors enable row level security;
create policy content_author_public_read on content_authors for select using (true);
create policy content_author_admin_write on content_authors for all
  using (app.is_platform_admin('content')) with check (app.is_platform_admin('content'));
alter table content_categories enable row level security;
create policy content_category_public_read on content_categories for select using (true);
create policy content_category_admin_write on content_categories for all
  using (app.is_platform_admin('content')) with check (app.is_platform_admin('content'));
alter table content_tags enable row level security;
create policy content_tag_public_read on content_tags for select using (true);
create policy content_tag_admin_write on content_tags for all
  using (app.is_platform_admin('content')) with check (app.is_platform_admin('content'));
alter table content_article_tags enable row level security;
create policy content_article_tag_public_read on content_article_tags for select using (
  exists (select 1 from knowledge_base_articles a where a.id = article_id and a.publication_state = 'published')
);
create policy content_article_tag_admin_write on content_article_tags for all
  using (app.is_platform_admin('content')) with check (app.is_platform_admin('content'));
alter table contextual_help_links enable row level security;
create policy contextual_help_public_read on contextual_help_links for select using (
  exists (select 1 from knowledge_base_articles a where a.id = article_id and a.publication_state = 'published')
);
create policy contextual_help_admin_write on contextual_help_links for all
  using (app.is_platform_admin('content')) with check (app.is_platform_admin('content'));

create trigger trg_tenant_billing_profiles_updated_at before update on tenant_billing_profiles
  for each row execute function app.set_updated_at();
create trigger trg_billing_webhook_events_updated_at before update on billing_webhook_events
  for each row execute function app.set_updated_at();
create trigger trg_content_authors_updated_at before update on content_authors
  for each row execute function app.set_updated_at();
create trigger trg_content_categories_updated_at before update on content_categories
  for each row execute function app.set_updated_at();
create trigger trg_content_tags_updated_at before update on content_tags
  for each row execute function app.set_updated_at();

create or replace function app.create_self_serve_tenant(
  p_user_id uuid,
  p_slug text,
  p_name text,
  p_legal_name text,
  p_abn text,
  p_billing_email text,
  p_terms_version text,
  p_privacy_version text,
  p_project_name text,
  p_trade trade_package,
  p_ip_address text,
  p_user_agent text
) returns table (tenant_id uuid, membership_id uuid, subscription_id uuid, project_id uuid)
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
declare
  v_owner_role uuid;
  v_tenant_id uuid;
  v_membership_id uuid;
  v_subscription_id uuid;
  v_project_id uuid;
begin
  if p_user_id is distinct from app.current_user_id() then
    raise exception 'cannot onboard another user' using errcode = 'insufficient_privilege';
  end if;
  if not exists (select 1 from users where id = p_user_id and kind = 'human' and status = 'active') then
    raise exception 'active human user required' using errcode = 'insufficient_privilege';
  end if;

  select t.id, m.id into v_tenant_id, v_membership_id
    from tenants t
    join tenant_memberships m on m.tenant_id = t.id and m.user_id = p_user_id and m.is_owner = true
  where t.slug = p_slug::citext;
  if found then
    select s.id into v_subscription_id from tenant_subscriptions s
     where s.tenant_id = v_tenant_id order by s.created_at desc limit 1;
    select p.id into v_project_id from projects p
     where p.tenant_id = v_tenant_id order by p.created_at limit 1;
    tenant_id := v_tenant_id;
    membership_id := v_membership_id;
    subscription_id := v_subscription_id;
    project_id := v_project_id;
    return next;
    return;
  end if;

  select id into v_owner_role from roles where key = 'owner';
  if v_owner_role is null or not exists (select 1 from plans where key = 'trial' and is_active) then
    raise exception 'commercial catalog is not configured' using errcode = 'object_not_in_prerequisite_state';
  end if;

  insert into tenants (slug, name, legal_name, abn)
  values (p_slug::citext, p_name, nullif(p_legal_name, ''), nullif(p_abn, ''))
  returning id into v_tenant_id;

  insert into tenant_memberships (tenant_id, user_id, role_id, is_owner, status)
  values (v_tenant_id, p_user_id, v_owner_role, true, 'active')
  returning id into v_membership_id;

  insert into tenant_billing_profiles (tenant_id, billing_email, billing_name, abn)
  values (v_tenant_id, p_billing_email::citext, coalesce(nullif(p_legal_name, ''), p_name), nullif(p_abn, ''));

  insert into legal_acceptances (tenant_id, user_id, terms_version, privacy_version, ip_address, user_agent)
  values (v_tenant_id, p_user_id, p_terms_version, p_privacy_version, nullif(p_ip_address, '')::inet, p_user_agent);

  insert into tenant_subscriptions (tenant_id, plan_id, status, trial_ends_at)
  select v_tenant_id, id, 'trialing', now() + interval '14 days' from plans where key = 'trial'
  returning id into v_subscription_id;

  if nullif(p_project_name, '') is not null then
    insert into projects (tenant_id, name, trade, status, created_by)
    values (v_tenant_id, p_project_name, coalesce(p_trade, 'other'), 'draft', p_user_id)
    returning id into v_project_id;
    insert into project_memberships (tenant_id, project_id, user_id, role)
    values (v_tenant_id, v_project_id, p_user_id, 'lead');
  end if;

  insert into audit_events (tenant_id, event_type, actor_user_id, actor_type, entity_type, entity_id, action, summary, payload, ip_address, user_agent)
  values (v_tenant_id, 'auth_sensitive', p_user_id, 'human', 'tenant', v_tenant_id, 'self_serve_onboarding',
          'Self-serve tenant and trial created',
          jsonb_build_object('termsVersion', p_terms_version, 'privacyVersion', p_privacy_version, 'projectId', v_project_id),
          nullif(p_ip_address, '')::inet, p_user_agent);
  tenant_id := v_tenant_id;
  membership_id := v_membership_id;
  subscription_id := v_subscription_id;
  project_id := v_project_id;
  return next;
end$$;

create or replace function app.claim_trial_worksection(p_project_id uuid, p_worksection_id uuid)
returns table (usage_count bigint, usage_limit integer, enforced boolean)
  language plpgsql
  set search_path = public, pg_temp
as $$
declare
  v_tenant_id uuid := app.current_tenant_id();
  v_status subscription_status;
  v_trial_end timestamptz;
begin
  select s.status, s.trial_ends_at,
         coalesce((p.feature_limits ->> 'worksections')::integer, 3)
    into v_status, v_trial_end, usage_limit
    from tenant_subscriptions s join plans p on p.id = s.plan_id
   where s.tenant_id = v_tenant_id and s.status in ('trialing', 'active', 'past_due')
   order by s.created_at desc limit 1 for update of s;

  if v_status is null then raise exception 'subscription required' using errcode = 'check_violation'; end if;
  enforced := v_status = 'trialing';
  if not enforced then
    usage_count := 0;
    return next;
    return;
  end if;
  if v_trial_end <= now() then raise exception 'trial has ended' using errcode = 'check_violation'; end if;
  if not exists (select 1 from worksections where tenant_id = v_tenant_id and project_id = p_project_id and id = p_worksection_id) then
    raise exception 'worksection not found' using errcode = 'no_data_found';
  end if;

  if exists (select 1 from trial_worksection_usage where tenant_id = v_tenant_id and worksection_id = p_worksection_id) then
    select count(*) into usage_count from trial_worksection_usage where tenant_id = v_tenant_id;
    return next;
    return;
  end if;
  select count(*) into usage_count from trial_worksection_usage where tenant_id = v_tenant_id;
  if usage_count >= usage_limit then raise exception 'trial worksection limit reached' using errcode = 'check_violation'; end if;

  insert into trial_worksection_usage (tenant_id, project_id, worksection_id)
  values (v_tenant_id, p_project_id, p_worksection_id);
  usage_count := usage_count + 1;
  insert into audit_events (tenant_id, event_type, actor_user_id, actor_type, entity_type, entity_id, action, summary, payload)
  values (v_tenant_id, 'billing_event', app.current_user_id(), app.current_actor_type(), 'worksection', p_worksection_id,
          'trial_usage', 'Trial worksection used', jsonb_build_object('count', usage_count, 'limit', usage_limit, 'projectId', p_project_id));
  return next;
end$$;

create or replace function app.resolve_billing_tenant(p_provider text, p_customer_id text) returns uuid
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $$
  select tenant_id from (
    select tenant_id, 1 as priority from tenant_billing_profiles
     where provider = p_provider and provider_customer_id = p_customer_id
    union all
    select tenant_id, 2 from tenant_subscriptions
     where provider = p_provider and provider_customer_id = p_customer_id
  ) resolved order by priority limit 1
$$;

grant execute on function app.is_platform_admin(text),
  app.create_self_serve_tenant(uuid, text, text, text, text, text, text, text, text, trade_package, text, text),
  app.claim_trial_worksection(uuid, uuid)
  to submitsense_app;

grant select, insert, update, delete on tenant_billing_profiles, legal_acceptances,
  trial_worksection_usage, billing_webhook_events to submitsense_app;
grant select, insert, update, delete on plans, knowledge_base_articles, content_authors,
  content_categories, content_tags, content_article_tags, contextual_help_links to submitsense_app;
revoke select, insert, update, delete on platform_admins from submitsense_app;

commit;
