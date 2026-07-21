# SubmitSense

Assistive NATSPEC submittal co-pilot for Australian MEP & fire-protection subcontractors.
Extracts NATSPEC submission requirements, builds submittal registers, matches requirements to a
customer's own vendor data, flags rejection risks, drafts RFIs, assembles consultant-ready
packages, and tracks submittal status — with a licensed human always the final approver.

## Stack

TypeScript-first on AWS Australia (`ap-southeast-2`): Next.js + NestJS, PostgreSQL 17 + pgvector
(RDS), S3, Cognito, BullMQ/Redis. Modular monolith.

## Repo layout

| Path | What | Status |
|---|---|---|
| [`db/`](db/) | PostgreSQL data model — migrations through `0021`, RLS, guardrails, seed, docs | Built; commercial migration requires PG verification |
| [`backend/`](backend/) | NestJS API + worker — auth, tenant scoping, matching, packages, onboarding, billing, and content | In progress |
| `terraform/` | AWS infrastructure (RDS, KMS, VPC, ECS) | ⏳ pending infra agent |

## Getting started

The database is the foundation — see [`db/README.md`](db/README.md) to apply migrations and run the
guardrail test, and [`db/docs/HANDOFF.md`](db/docs/HANDOFF.md) for the contract every other layer
builds against.

Package assembly and register-export operations are documented in
[`backend/docs/package-assembly-handoff.md`](backend/docs/package-assembly-handoff.md).
Onboarding, pricing, Stripe setup, GST metadata, and content moderation are documented in
[`backend/docs/commercial-content-handoff.md`](backend/docs/commercial-content-handoff.md).
