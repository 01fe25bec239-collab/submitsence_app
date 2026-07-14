# Entity Relationship Diagram

Every tenant-owned table carries `tenant_id` (RLS scope). Child tables use **composite foreign keys
`(tenant_id, parent_id)`** so a row can never link to a parent in another tenant. Only key relations
are shown below; see [tables.md](tables.md) for full columns.

```mermaid
erDiagram
  tenants ||--o{ tenant_memberships : has
  tenants ||--o{ projects : owns
  tenants ||--o{ tenant_consents : has
  tenants ||--o{ tenant_subscriptions : has
  users ||--o{ tenant_memberships : joins
  roles ||--o{ tenant_memberships : grants
  roles ||--o{ role_permissions : maps
  permissions ||--o{ role_permissions : maps
  projects ||--o{ project_memberships : has
  projects ||--o{ documents : contains
  projects ||--o{ worksections : parsed_into
  projects ||--o{ submittal_requirements : yields
  projects ||--o{ register_items : tracks
  projects ||--o{ packages : assembles

  documents ||--o{ processing_jobs : processed_by
  worksections ||--o{ clauses : contains
  clauses ||--o{ clause_references : cited_by
  clauses ||--o{ extracted_fragments : working_text
  worksections ||--o{ submittal_requirements : maps
  clauses ||--o{ submittal_requirements : maps
  submittal_requirements ||--o{ register_items : becomes

  register_items ||--o{ physical_deliverables : has
  register_items ||--o{ product_matches : matched_to
  register_items ||--o{ risk_flags : flagged
  register_items ||--o{ rfi_drafts : raises
  risk_flags ||--o{ checklist_items : generates
  risk_flags ||--o{ rfi_drafts : may-draft
  risk_flags ||--o{ rejection_learning_events : feeds

  packages ||--o{ package_items : includes
  register_items ||--o{ package_items : included_as
  package_items ||--o{ package_item_documents : selects
  documents ||--o{ package_item_documents : attached_as
  packages ||--o{ package_versions : preserves
  documents ||--o{ package_versions : generated_as
  packages ||--o{ exports : exported_as
  package_versions ||--o{ exports : source_version

  vendors ||--o{ vendor_catalogues : publishes
  vendors ||--o{ products : supplies
  products ||--o{ product_documents : has
  products ||--o{ product_attributes : has
  products ||--o{ extracted_product_data : extracted
  products ||--o{ product_embeddings : embedded
  products ||--o{ product_matches : proposed

  integration_connections ||--o{ external_project_mappings : maps
  integration_connections ||--o{ sync_jobs : runs
  integration_connections ||--o{ webhook_events : receives
  sync_jobs ||--o{ sync_errors : logs

  plans ||--o{ tenant_subscriptions : billed_on
  tenant_subscriptions ||--o{ invoices : issues

  tenants ||--o{ audit_events : records
  users ||--o{ audit_events : actor
```

## Domain groups

- **Tenancy / IAM** — tenants, users, roles, permissions, role_permissions, tenant_memberships, project_memberships
- **Documents** — documents, processing_jobs
- **Specs** — worksections, clauses, clause_references, extracted_fragments, addenda_reconciliations, submittal_requirements
- **Register / workflow** — register_items, physical_deliverables, packages, package_items, package_item_documents, package_versions, exports
- **Vendors / matching** — vendors, vendor_catalogues, products, product_documents, product_attributes, extracted_product_data, product_embeddings, product_matches
- **Risk / RFI / learning** — risk_flags, checklist_items, rfi_drafts, rfi_cited_clauses, rfi_cited_documents, rejection_learning_events, tenant_consents
- **Audit** — audit_events (append-only)
- **Billing** — plans, tenant_subscriptions, invoices, usage_counters
- **Content** — knowledge_base_articles (global, not tenant-owned)
- **Integrations** — integration_connections, external_project_mappings, sync_jobs, webhook_events, sync_errors
