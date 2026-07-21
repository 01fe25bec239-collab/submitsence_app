begin;

drop policy if exists audit_platform_admin_insert on audit_events;
drop policy if exists audit_platform_admin_read on audit_events;
drop policy if exists plan_admin_write on plans;
drop policy if exists plan_public_read on plans;
alter table plans disable row level security;
drop policy if exists kb_admin_write on knowledge_base_articles;
alter table knowledge_base_articles
  drop constraint if exists knowledge_base_articles_author_id_fkey,
  add constraint knowledge_base_articles_author_id_fkey foreign key (author_id) references users(id);
drop table if exists contextual_help_links, content_article_tags, content_tags, content_categories, content_authors,
  billing_webhook_events, trial_worksection_usage, legal_acceptances, tenant_billing_profiles, platform_admins cascade;
alter table knowledge_base_articles
  drop column if exists category_id,
  drop column if exists search_noindex,
  drop column if exists original_wording_confirmed,
  drop column if exists natspec_reference,
  drop column if exists canonical_url;
alter table knowledge_base_articles
  drop constraint if exists chk_publish_copyright_safe,
  add constraint chk_publish_copyright_safe check (
    publication_state <> 'published'
    or contains_natspec_text = false
    or natspec_copyright_cleared = true
  );
drop index if exists uq_invoices_provider;
alter table invoices drop column if exists hosted_invoice_url, drop column if exists invoice_pdf_url;
alter table plans
  drop column if exists sort_order,
  drop column if exists tax_inclusive,
  drop column if exists provider_price_id,
  drop column if exists feature_limits,
  drop column if exists overage_policy,
  drop column if exists included_usage,
  drop column if exists description;
revoke insert, update, delete on plans, knowledge_base_articles from submitsense_app;
drop function if exists app.claim_trial_worksection(uuid, uuid);
drop function if exists app.create_self_serve_tenant(uuid, text, text, text, text, text, text, text, text, trade_package, text, text);
drop function if exists app.is_platform_admin(text);

commit;
