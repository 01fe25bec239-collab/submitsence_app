# SubmitSense

Assistive NATSPEC submittal co-pilot for Australian MEP & fire-protection subcontractors.
Extracts NATSPEC submission requirements, builds submittal registers, matches requirements to a
customer's own vendor data, flags rejection risks, drafts RFIs, assembles consultant-ready
packages, and tracks submittal status — with a licensed human always the final approver.

## Stack

TypeScript-first on AWS Australia (`ap-southeast-2`): Next.js + NestJS, PostgreSQL 17 + pgvector
(RDS), S3, and Cognito. PostgreSQL `processing_jobs` is the authoritative asynchronous queue;
SubmitSense does not currently depend on Redis or BullMQ. Reconsider them only for a measured future
requirement. Queue metrics are deferred to PB-07 and worker autoscaling to PB-08. Modular monolith.

## Repo layout

| Path | What | Status |
|---|---|---|
| [`db/`](db/) | PostgreSQL data model — migrations through `0021`, RLS, guardrails, seed, docs | Built; commercial migration requires PG verification |
| [`backend/`](backend/) | NestJS API + worker — auth, tenant scoping, matching, packages, onboarding, billing, and content | In progress |
| [`terraform/`](terraform/) | AWS infrastructure (VPC, ECS, RDS, S3, Cognito, KMS, WAF, backups, monitoring) | Built; AWS apply pending account/domain inputs |
| [`infra/`](infra/) | Deployment, recovery, incident, residency, IAM, monitoring, and cost runbooks | Built |

## Getting started

The database is the foundation — see [`db/README.md`](db/README.md) to apply migrations and run the
guardrail test, and [`db/docs/HANDOFF.md`](db/docs/HANDOFF.md) for the contract every other layer
builds against.

Package assembly and register-export operations are documented in
[`backend/docs/package-assembly-handoff.md`](backend/docs/package-assembly-handoff.md).
Onboarding, pricing, Stripe setup, GST metadata, and content moderation are documented in
[`backend/docs/commercial-content-handoff.md`](backend/docs/commercial-content-handoff.md).
