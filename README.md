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
| [`db/`](db/) | PostgreSQL data model — 15 migrations, RLS, guardrails, seed, docs | ✅ built & validated on PG 17.10 (8/8 guardrails pass) |
| [`backend/`](backend/) | NestJS API + B6-B7 matching worker — auth, RBAC/ABAC, tenant scoping, catalogue ingestion, requirement→product matching | 🚧 in progress |
| `terraform/` | AWS infrastructure (RDS, KMS, VPC, ECS) | ⏳ pending infra agent |

## Getting started

The database is the foundation — see [`db/README.md`](db/README.md) to apply migrations and run the
guardrail test, and [`db/docs/HANDOFF.md`](db/docs/HANDOFF.md) for the contract every other layer
builds against.
