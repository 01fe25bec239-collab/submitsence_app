# SubmitSense web — QA handoff (foundation increment)

## Run it

```bash
cd web
cp .env.example .env.local     # then set DEV_AUTH=1 for stub auth
npm install
npm run dev                    # http://localhost:3001
```

- `npm run build` — production build (must stay green).
- `npm run typecheck` — `tsc --noEmit`.
- `npm run lint` — eslint.

**Ports**: web runs on **:3001**. The backend runs on **:3000** with a `/api/v1`
prefix (`API_BASE_URL` in `.env.local`). Note: another local app may occupy
:3000 — point `API_BASE_URL` at the real backend or run it on a free port.

## Auth for testing (`DEV_AUTH=1`)

No Cognito needed. A canned session provides two workspaces to exercise
role-aware behaviour:

| Workspace | tenantId | Role | Expected |
|---|---|---|---|
| Example Fire Pty Ltd | `…0001` | owner | all nav items; "New project" visible |
| Harbourside Mechanical | `…0002` | viewer | only Projects + Vendors; no "New project" |

(Full UUIDs in `src/lib/session/dev-stub.ts`.) Switch via the sidebar dropdown.

**Mock data**: with `DEV_AUTH=1`, read endpoints also return sample fixtures
(`src/lib/api/mock.ts`) so every screen renders without a backend. Unmocked
paths fall through to a real fetch. Set `DEV_AUTH=0` and both the auth stub and
the data mocks turn off together — the real Cognito token path (httpOnly
`ss_token` cookie) and live backend take over, with no code to remove.

## What's testable now

| Area | Route | Check |
|---|---|---|
| Landing | `/` | compliance framing; CTAs; "Open demo workspace" (dev only) |
| Pricing | `/pricing` | live plans when backend up; safe error state when not |
| Workspace shell | `/{tenantId}/projects` | sidebar, tenant switcher, role-aware nav, disclaimer footer |
| Projects list | `/{tenantId}/projects` | table + status badges; empty state; permission-gated create |
| Project dashboard | `/{tenantId}/projects/{projectId}` | register/deadlines/packages tiles |
| Permission gating | switch owner↔viewer | nav + actions change with role |
| Error handling | any authed route, backend down | `ErrorState` with safe message + requestId |
| 404 | unknown tenant / bad path | `not-found` page (no cross-tenant leak) |

## Acceptance mapping (foundation)

- ✅ Role permissions affect visible actions (owner vs viewer proven).
- ✅ No UI copy implies automatic certification — enforced by
  `assertSafeSystemCopy`; persistent assistive disclaimer.
- ✅ Public pricing page accessible.
- ✅ Safe error messages carry a requestId; no internals leaked.
- ✅ Tenant scoping in URL; unknown tenant 404s (no cross-tenant state).
- 🟡 Onboarding → project → upload → extraction → matches → package → risk → RFI
  → sign-off: pending per-surface builds (see route-map.md).

## Automated tests

Not yet added. Plan: Vitest + Testing Library for components (StatusBadge
compliance guard, permission gating, EmptyState/ErrorState), Playwright for the
core-loop e2e once those surfaces land. `assertSafeSystemCopy` is the first unit
under test — it must throw on every banned term.

## Known gaps / next

- Wire real Cognito sign-in + `ss_token` cookie; replace dev stub.
- Backend needs **CORS** enabled if the web app calls it cross-origin
  (`main.ts` has none yet) — or keep all calls server-side (current approach).
- Mutations (Server Actions), async-job polling, pagination/virtualisation for
  large registers, analytics wrapper.
