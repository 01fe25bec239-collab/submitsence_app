import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";

export type ActorType = "human" | "service_account" | "system";

export interface TenantContext {
  tenantId: string;
  actorType: ActorType; // required on purpose: the human_approved guard (0006) must never
  //                       default to 'human'. A background job that forgets this is 'system'.
  userId?: string | null; // required by the DB trigger when actorType === 'human'
}

/**
 * Runs `fn` inside ONE transaction with the app.* GUCs set LOCAL, so the RLS policies
 * (0013) and the human-approval guard (0006) evaluate against the right tenant/user/actor.
 *
 * set_config(..., true) = transaction-local, and is parameterized so tenant/user ids can't
 * inject SQL (plain `SET LOCAL x = '...'` cannot be parameterized). Empty string for a
 * missing userId -> app.current_user_id() resolves to NULL.
 *
 * Connect the pool as the non-owner `submitsense_app` role — RLS is bypassed by table owners.
 */
export async function withTenant<T>(
  pool: Pool,
  ctx: TenantContext,
  fn: (db: NodePgDatabase) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select set_config('app.tenant_id', $1, true)", [ctx.tenantId]);
    await client.query("select set_config('app.user_id', $1, true)", [ctx.userId ?? ""]);
    await client.query("select set_config('app.actor_type', $1, true)", [ctx.actorType]);
    const result = await fn(drizzle(client));
    await client.query("commit");
    return result;
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

// ponytail: behavioural check lives in db/test/test_guardrails.sql — it drives these exact
// GUCs against a live DB (cross-tenant read blocked, system actor cannot set human_approved).
// A JS test here would just re-mock Postgres; run the SQL test against RDS instead.
