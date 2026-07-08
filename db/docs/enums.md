# Enum reference

Native PostgreSQL enum types (0002). Add values later with `ALTER TYPE <name> ADD VALUE '<v>'`;
values are intentionally not removable. **`submittal_status` is legally reviewed terminology — do not
rename without legal sign-off.**

| Enum | Values | Used by |
|---|---|---|
| `user_kind` | human, service_account | `users.kind` — only `human` may record sign-off |
| `project_role` | lead, reviewer, contributor, viewer | `project_memberships.role` |
| `project_status` | draft, active, on_hold, completed, archived, cancelled | `projects.status` |
| `trade_package` | mechanical, electrical, hydraulic, fire_protection, communications, other | `projects.trade` |
| `document_type` | spec, drawing, addendum, vendor_catalogue, past_submittal, generated_package, export, attachment, other | `documents.doc_type` |
| `job_status` | queued, running, retrying, succeeded, failed, cancelled | `processing_jobs.status`, `sync_jobs.status` |
| `requirement_category` | submission, hold_point, evidence_of_conformity, sample, shop_drawing, product_data, test_report, certificate, manual, commissioning_record, other | `submittal_requirements.category` (req f9) |
| **`submittal_status`** | **draft, submitted, human_approved, revise_and_resubmit, rejected, closed, cancelled** | `register_items.status` (req f11) |
| `physical_deliverable_type` | physical_sample, stamped_shop_drawing, mockup, other | `physical_deliverables.kind` |
| `physical_deliverable_status` | required, requested, in_transit, received, returned, waived | `physical_deliverables.status` |
| `package_status` | draft, assembling, ready, submitted, superseded | `packages.status` |
| `export_status` | pending, generating, ready, failed, delivered | `exports.status` |
| `match_decision` | pending, accepted, rejected, superseded | `product_matches.decision` |
| `risk_severity` | low, medium, high, critical | `risk_flags.severity` |
| `risk_type` | non_compliant_product, missing_evidence, spec_conflict, superseded_clause, ambiguous_requirement, deadline_risk, other | `risk_flags.risk_type` |
| `risk_state` | open, confirmed, dismissed, resolved | `risk_flags.state`, `rejection_learning_events.human_decision` |
| `rfi_conflict_type` | ambiguity, conflict, missing_information, discrepancy, other | `rfi_drafts.conflict_type` |
| `rfi_review_status` | draft, in_review, approved, rejected | `rfi_drafts.review_status` |
| `rfi_send_status` | not_sent, exported, sent, answered | `rfi_drafts.send_status` |
| `consultant_outcome` | approved, revise_and_resubmit, rejected, withdrawn, unknown | `rejection_learning_events.consultant_outcome` |
| `consent_state` | unset, opted_in, opted_out | `tenant_consents.learning_loop`, learning events |
| `publication_state` | draft, in_review, published, archived | `knowledge_base_articles.publication_state` |
| `plan_tier` | trial, starter, professional, enterprise | `plans.tier` |
| `subscription_status` | trialing, active, past_due, canceled, incomplete | `tenant_subscriptions.status` |
| `invoice_status` | draft, open, paid, void, uncollectible | `invoices.status` |
| `integration_provider` | aconex, procore, other | connections, webhooks |
| `integration_status` | connected, disconnected, error, revoked | `integration_connections.status` |
| `sync_job_type` | package_push, response_pull | `sync_jobs.job_type` |
| `webhook_status` | received, processed, failed, ignored | `webhook_events.status` |
| `audit_event_type` | document_upload, extraction, match, flag, rfi_action, package_generation, status_change, human_signoff, export, auth_sensitive, integration_sync, consent_change, billing_event, admin_action | `audit_events.event_type` (req f21) |

## Status columns backed by `text + CHECK` (not enums)

These are low-churn operational flags kept flexible: `tenants.status` (active/suspended/closed),
`users.status` (active/invited/suspended/deactivated), `tenant_memberships.status`
(active/invited/suspended), `plans.billing_interval` (month/year), `addenda_reconciliations.action`.
