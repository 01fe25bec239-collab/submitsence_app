-- 0002_enums.sql
-- All native enum types, centralized. Documented in docs/enums.md.
-- Native enums are used because these value sets are stable and compliance-relevant
-- (esp. submittal_status, req f11 — legally reviewed terminology). New values are added later
-- with `ALTER TYPE <name> ADD VALUE ...`; values are intentionally not removable.

begin;

create type user_kind as enum ('human', 'service_account');

create type project_role as enum ('lead', 'reviewer', 'contributor', 'viewer');

create type project_status as enum
  ('draft', 'active', 'on_hold', 'completed', 'archived', 'cancelled');

create type trade_package as enum
  ('mechanical', 'electrical', 'hydraulic', 'fire_protection', 'communications', 'other');

create type document_type as enum
  ('spec', 'drawing', 'addendum', 'vendor_catalogue', 'past_submittal',
   'generated_package', 'export', 'attachment', 'other');

create type job_status as enum
  ('queued', 'running', 'retrying', 'succeeded', 'failed', 'cancelled');

create type requirement_category as enum
  ('submission', 'hold_point', 'evidence_of_conformity', 'sample', 'shop_drawing',
   'product_data', 'test_report', 'certificate', 'manual', 'commissioning_record', 'other');

-- req f11 — exact, legally reviewed status terminology. Do not rename without legal review.
create type submittal_status as enum
  ('draft', 'submitted', 'human_approved', 'revise_and_resubmit', 'rejected', 'closed', 'cancelled');

create type physical_deliverable_type as enum
  ('physical_sample', 'stamped_shop_drawing', 'mockup', 'other');

create type physical_deliverable_status as enum
  ('required', 'requested', 'in_transit', 'received', 'returned', 'waived');

create type package_status as enum
  ('draft', 'assembling', 'ready', 'submitted', 'superseded');

create type export_status as enum
  ('pending', 'generating', 'ready', 'failed', 'delivered');

create type match_decision as enum ('pending', 'accepted', 'rejected', 'superseded');

create type risk_severity as enum ('low', 'medium', 'high', 'critical');

create type risk_type as enum
  ('non_compliant_product', 'missing_evidence', 'spec_conflict', 'superseded_clause',
   'ambiguous_requirement', 'deadline_risk', 'other');

create type risk_state as enum ('open', 'confirmed', 'dismissed', 'resolved');

create type rfi_conflict_type as enum
  ('ambiguity', 'conflict', 'missing_information', 'discrepancy', 'other');

create type rfi_review_status as enum ('draft', 'in_review', 'approved', 'rejected');

create type rfi_send_status as enum ('not_sent', 'exported', 'sent', 'answered');

create type consultant_outcome as enum
  ('approved', 'revise_and_resubmit', 'rejected', 'withdrawn', 'unknown');

create type consent_state as enum ('unset', 'opted_in', 'opted_out');

create type publication_state as enum ('draft', 'in_review', 'published', 'archived');

create type plan_tier as enum ('trial', 'starter', 'professional', 'enterprise');

create type subscription_status as enum
  ('trialing', 'active', 'past_due', 'canceled', 'incomplete');

create type invoice_status as enum ('draft', 'open', 'paid', 'void', 'uncollectible');

create type integration_provider as enum ('aconex', 'procore', 'other');

create type integration_status as enum ('connected', 'disconnected', 'error', 'revoked');

create type sync_job_type as enum ('package_push', 'response_pull');

create type webhook_status as enum ('received', 'processed', 'failed', 'ignored');

-- req f21 — one row in audit_events per each of these action classes.
create type audit_event_type as enum
  ('document_upload', 'extraction', 'match', 'flag', 'rfi_action', 'package_generation',
   'status_change', 'human_signoff', 'export', 'auth_sensitive', 'integration_sync',
   'consent_change', 'billing_event', 'admin_action');

commit;
