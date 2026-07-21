# SubmitSense web — route map

Next.js 16 App Router, `src/app`. Route groups: `(marketing)` public, `(app)` the
tenant-scoped workspace. Tenant is always explicit in the URL (`/[tenantId]/…`)
so no cross-tenant state can be cached or leaked. Static marketing segments
(`/pricing`) resolve ahead of the dynamic `[tenantId]` segment; tenant IDs are
UUIDs, so they never collide.

Legend — **Status**: ✅ built · 🟡 planned. **Auth**: 🌐 public · 🔒 authed.
Permissions are the strings from `backend/src/auth/permission-policy.json`,
gated in the UI via `can()` / `usePermission()` and enforced by the backend.

## Public — `(marketing)`

| Route | Auth | Backend | Status |
|---|---|---|---|
| `/` | 🌐 | — | ✅ landing |
| `/pricing` | 🌐 | `GET /pricing/plans` | ✅ |
| `/kb` | 🌐 | `GET /content/articles` | 🟡 |
| `/kb/[slug]` | 🌐 | `GET /content/articles/:slug` | 🟡 |

## Auth & onboarding

| Route | Auth | Backend | Status |
|---|---|---|---|
| `/signin` | 🌐 | Cognito (hosted UI or custom) | 🟡 |
| `/signup` | 🌐 | Cognito → `POST /auth/cognito/link-user` (server hook) | 🟡 |
| `/onboarding` | 🔒 | `POST /onboarding` | 🟡 |
| `/invitations/accept` | 🔒 | `POST /auth/invitations/accept` | 🟡 |
| `/select-workspace` | 🔒 | `GET /auth/me` | 🟡 (dev: landing links straight in) |

## Workspace — `(app)/[tenantId]`

Layout resolves `GET /auth/me` + `GET /tenants/:id/session`, checks membership
(unknown tenant → 404), and mounts the permission-gated shell.

| Route | Permission | Backend | Status |
|---|---|---|---|
| `/[tenantId]/projects` | `project.read` | `GET …/projects` | ✅ |
| `/[tenantId]/projects/[projectId]` | `project.read` | `GET …/projects/:id` + `…/dashboard/status` | ✅ dashboard |
| `…/projects/new` | `project.manage` | `POST …/projects` | 🟡 |
| `…/projects/[id]/documents` | `document.upload` | uploads init/finalize, processing-jobs | 🟡 |
| `…/projects/[id]/spec` | `project.read` | worksections, clauses, requirements | 🟡 extraction review |
| `…/projects/[id]/register` | `register.read` | `GET …/register-items` (+ filters) | 🟡 |
| `…/projects/[id]/register/[itemId]` | `register.read` | item detail, assignment, deadline, status | 🟡 |
| `…/projects/[id]/register/sign-off` | `submittal.approve` (human) | `POST …/register-items/sign-off` | 🟡 |
| `…/projects/[id]/matches` | `register.manage` | product-matches accept/reject/override/rematch | 🟡 |
| `…/projects/[id]/risks` | `risk.review` | risk-flags generate/list/confirm/dismiss | 🟡 |
| `…/projects/[id]/rfis` | `rfi.manage` | rfis generate/list | 🟡 |
| `…/projects/[id]/rfis/[rfiId]` | `rfi.manage` / `risk.review` | rfi detail/edit/review/export/handoff | 🟡 |
| `…/projects/[id]/packages` | `package.manage` | packages list/create | 🟡 |
| `…/projects/[id]/packages/[pkgId]` | `package.manage` | items, preview, versions, regenerate, export | 🟡 |
| `…/projects/[id]/deliverables` | `register.manage` | physical-deliverables | 🟡 |
| `…/projects/[id]/audit` | `audit.read` | `GET …/projects/:id/audit-events` | 🟡 |
| `/[tenantId]/vendors` | `project.read` | `GET …/vendors` | 🟡 |
| `/[tenantId]/products` | `project.read` | `GET …/products` | 🟡 |
| `/[tenantId]/products/[id]` | `product.match` | product detail / review-correct | 🟡 |
| `/[tenantId]/audit` | `audit.read` | `GET …/audit-events` | 🟡 |
| `/[tenantId]/billing` | `billing.manage` | subscription, invoices, billing-profile, checkout | 🟡 |
| `/[tenantId]/integrations` | `integration.manage` | connections, mappings, sync-jobs, errors | 🟡 |
| `/[tenantId]/settings/members` | `member.manage` | invitations, members, project members | 🟡 |
| `/[tenantId]/settings/security` | `member.manage` | `PATCH …/settings/security` (MFA) | 🟡 |
| `/[tenantId]/settings/data-use` | `member.manage` | `PATCH …/settings/data-use`, learning-consent | 🟡 |
| `/[tenantId]/settings/branding` | `package.manage` | `GET/PATCH …/branding` | 🟡 |

## Platform admin — `/admin` (separate persona, `platform_admins`)

| Route | Backend | Status |
|---|---|---|
| `/admin/plans` | `GET/PATCH /admin/plans` | 🟡 |
| `/admin/content` | `GET/POST/PATCH /admin/content/articles`, `…/:state` | 🟡 |

## Conventions

- **Reads**: Server Components call `apiFetch` (token stays server-side).
- **Mutations**: Server Actions (to add) using `apiFetch` with `newIdempotencyKey()`
  for uploads / generation / export / webhooks.
- **Async jobs**: `202 + jobId` → poll `…/jobs/:jobId` (client polling component, to add).
- **States**: every list/detail route ships loading (`loading.tsx`/Suspense),
  empty (`EmptyState`), and error (`ErrorState` + `error.tsx`) states.
