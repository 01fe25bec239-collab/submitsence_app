import type { Pool, PoolClient } from "pg";

export type ActorType = "human" | "service_account" | "system";

export interface TenantContext {
  tenantId: string;
  actorType: ActorType;
  userId?: string | null;
}

export async function withTenantClient<T>(
  pool: Pool,
  ctx: TenantContext,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select set_config('app.tenant_id', $1, true)", [ctx.tenantId]);
    await client.query("select set_config('app.user_id', $1, true)", [ctx.userId ?? ""]);
    await client.query("select set_config('app.actor_type', $1, true)", [ctx.actorType]);
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

export async function withUserClient<T>(pool: Pool, userId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select set_config('app.user_id', $1, true)", [userId]);
    await client.query("select set_config('app.actor_type', 'human', true)");
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}
