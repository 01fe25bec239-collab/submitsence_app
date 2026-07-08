-- 0015_webhook_tenant_resolvers.sql
-- Webhooks arrive with NO authenticated session and must not trust a caller-supplied tenant id
-- (compliance: tenant scope comes from trusted context, never the request body). These
-- SECURITY DEFINER resolvers map a *verified provider identifier* -> tenant_id. They bypass RLS
-- only for this narrow lookup, mirroring app.resolve_cognito_principal (0014). Unknown identifier
-- returns NULL, and the caller turns that into a generic 403 (fail-closed).

begin;

-- Integration webhook: the connection row is the server-side source of truth for its tenant.
create or replace function app.resolve_integration_tenant(
  p_connection_id uuid,
  p_provider integration_provider
) returns uuid
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $$
  select tenant_id from integration_connections
   where id = p_connection_id and provider = p_provider
   limit 1
$$;

-- Billing webhook: resolve from the provider's opaque customer id recorded on the subscription.
create or replace function app.resolve_billing_tenant(
  p_provider text,
  p_customer_id text
) returns uuid
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $$
  select tenant_id from tenant_subscriptions
   where provider = p_provider and provider_customer_id = p_customer_id
   order by created_at desc
   limit 1
$$;

grant execute on function
  app.resolve_integration_tenant(uuid, integration_provider),
  app.resolve_billing_tenant(text, text)
  to submitsense_app;

commit;
