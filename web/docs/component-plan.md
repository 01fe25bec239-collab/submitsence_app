# SubmitSense web — component & library plan

## Stack

- **Next.js 16** (App Router, Turbopack) · **React 19** · **TypeScript** (strict).
- **Tailwind CSS v4** — CSS-first config; tokens in `src/app/globals.css`
  (`@theme` + light/`.dark`). Domain status hues (`success`/`warning`/`info`)
  are deliberately muted — nothing should read as a pass/fail light.
- **UI primitives**: shadcn/ui **conventions**, hand-authored (CVA + `clsx` +
  `tailwind-merge`, the same libraries shadcn uses). The shadcn CLI is skipped
  for now because it isn't reliable on Next 16 this new; our primitives are
  drop-in compatible, so we can adopt the CLI later without rework.
- **Icons**: `lucide-react`.

## Layers

```
src/
  app/                     routes (server components fetch; client where needed)
  components/
    ui/                    primitives — button, card, badge, input, table, skeleton
    shell/                 app-shell (sidebar, tenant switcher, role-aware nav)
    status-badge, empty-state, error-state, assistive-disclaimer   (domain shared)
  lib/
    api/       client (server-only fetch), errors (ApiError), types (hand-modelled)
    session/   token, dev-stub, session (server), permissions, context (client)
    compliance/copy.ts     ← single source of truth for compliance-sensitive text
    format.ts  utils.ts
```

## Primitives (`components/ui`)

`Button` (variants: default/secondary/outline/ghost/destructive/link; sizes),
`Card` (+ Header/Title/Description/Content/Footer), `Badge` (+ status tones:
success/warning/info/muted/destructive), `Input`, `Table` (semantic, scoped
headers, horizontal-scroll container for wide registers), `Skeleton`.

**To add as surfaces need them**: `Dialog`/`Sheet`, `DropdownMenu`, `Select`,
`Tabs`, `Checkbox`/`RadioGroup`, `Textarea`, `Tooltip`, `Toast`, `Pagination`.
These pull in `@radix-ui/*` — add per-primitive, not all at once.

## Domain shared components

- **`StatusBadge`** — maps a domain enum + value → a compliance-checked badge
  via the copy catalogue. Every system label passes `assertSafeSystemCopy()`.
- **`AssistiveDisclaimer`** — the standing "assistive, not certifying" line;
  persistent in the shell footer, reused on generated output.
- **`EmptyState`** / **`ErrorState`** — consistent empty and safe-error UIs;
  `ErrorState` surfaces the `requestId` for support, never internals.
- **`AppShell`** — sidebar + tenant switcher + role-aware nav (`ready:false`
  items render disabled with a "Soon" tag) + user block; wraps `SessionProvider`.

## Patterns

- **Data access**: reads in Server Components through `apiFetch`; the bearer
  token never crosses to the client. `getMe` / `getTenantSession` are wrapped in
  React `cache()` to dedupe per request across layout + page + nav.
- **Permission gating**: server → `can(tenant.permissions, PERM.x)`;
  client → `usePermission(PERM.x)`. Never render an action the user can't perform.
- **Mutations** (next up): Server Actions calling `apiFetch` with an idempotency
  key; optimistic UI only where safe/reversible (e.g. reordering package items),
  never for sign-off, export, or status transitions.
- **Async jobs**: a small client poller hits `…/jobs/:jobId` until terminal.
- **Accessibility**: semantic tables, `scope` on headers, `aria-current` on nav,
  labelled controls, visible focus rings, `role="alert"` on errors.

## Analytics (NFR)

When added: event names + non-sensitive metadata only. Never send document text,
extracted clauses, vendor pricing, tokens, or full register rows.
