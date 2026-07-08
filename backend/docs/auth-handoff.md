# Auth handoff

## Cognito setup

- Region: `ap-southeast-2`.
- User pool password policy: minimum 14 chars, require upper/lower/number/symbol, temporary passwords expire.
- MFA: optional at pool level; tenant admins enforce per tenant in app settings before allowing admin routes.
- App client: no client secret for browser/mobile clients; access tokens short-lived, refresh tokens per Cognito best practice.
- Post-confirmation trigger calls `POST /auth/cognito/link-user` with `x-internal-auth: AUTH_INTERNAL_SECRET`, `cognitoSub`, `email`, and `fullName`.
- Backend verifies Cognito access JWTs with `COGNITO_USER_POOL_ID` + `COGNITO_CLIENT_ID`.
- SSO fits behind the same user pool/app client; the backend only consumes Cognito JWTs.

## Environment

- `DATABASE_URL`: app login role inheriting `submitsense_app`, never the table owner.
- `COGNITO_USER_POOL_ID`, `COGNITO_CLIENT_ID`: JWT verifier inputs.
- `AUTH_INTERNAL_SECRET`: shared secret for the Cognito post-confirmation link endpoint.
- `INVITE_TTL_DAYS`: optional, defaults to `7`.
- `PGSSLMODE=require`: required for RDS.

## Request contract

- Every protected tenant route requires `Authorization: Bearer <access-token>`.
- Active tenant is explicit: route `:tenantId` or `x-tenant-id`.
- Request bodies are never trusted for tenant identity.
- Tenant DB work must run through `withTenantClient(pool, { tenantId, userId, actorType }, fn)`.
- Human users map to DB `actorType = human`; service accounts map to `system`, so they cannot sign off.

## Endpoints

- `GET /auth/me`: current user + available tenants.
- `POST /auth/invitations/accept`: accept hashed invite token for the authenticated user.
- `POST /tenants/:tenantId/invitations`: create invite; returns raw token once for the mailer.
- `POST /tenants/:tenantId/invitations/:invitationId/resend`
- `POST /tenants/:tenantId/invitations/:invitationId/revoke`
- `POST /tenants/:tenantId/members/:userId/deactivate`
- `DELETE /tenants/:tenantId/members/:userId`
- `POST /tenants/:tenantId/projects/:projectId/members`
- `DELETE /tenants/:tenantId/projects/:projectId/members/:userId`
- `PATCH /tenants/:tenantId/settings/data-use`
- `POST /tenants/:tenantId/service-accounts`
- `PATCH /tenants/:tenantId/settings/security`
- `GET /tenants/:tenantId/session`
- `GET /tenants/:tenantId/projects/:projectId/access`

## Permission model

Source: `backend/src/auth/permission-policy.json`.

- Tenant role grants the maximum permission set.
- Project membership narrows project-scoped actions unless tenant role is `owner` or `admin`.
- Archived projects revoke all project-scoped actions.
- `sign_off` requires `submittal.approve`, project overlay access, active human user, and DB human-signoff guard.
- `mfaRequiredForAdmins` in `tenants.settings` blocks owner/admin tenant context unless the Cognito JWT carries an MFA auth method claim.
- Permission denials audit `auth_sensitive` and return generic `403`.

## Background jobs

Workers resolve a service-account `users.id`, pick the job tenant from trusted queue metadata, then call:

```ts
await withTenantClient(pool, { tenantId, userId: serviceUserId, actorType: "system" }, fn);
```

System actors may sync/export/generate when permitted, but never perform `sign_off`.
