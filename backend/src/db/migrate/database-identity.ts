import { Client } from "pg";

/**
 * Live-PostgreSQL identity of a connection target: the cluster's
 * system_identifier (from pg_control_system(), stable per initdb) plus the
 * connected database's OID (stable per database, reused only after DROP).
 * Two connections describe the same physical database iff both match,
 * regardless of how each URL spells host/user/params/encoding.
 */
async function readIdentity(url: string): Promise<{ clusterId: string; databaseOid: string; databaseName: string }> {
  const client = new Client({ connectionString: url, application_name: "pb10-database-identity-check" });
  await client.connect();
  try {
    const result = await client.query<{ cluster_id: string; database_oid: string; database_name: string }>(`
      select (select system_identifier::text from pg_catalog.pg_control_system()) as cluster_id,
             (select oid::text from pg_catalog.pg_database where datname = current_database()) as database_oid,
             current_database() as database_name
    `);
    const row = result.rows[0];
    if (!row?.cluster_id || !row.database_oid) {
      throw new Error("Could not determine PostgreSQL cluster/database identity");
    }
    return { clusterId: row.cluster_id, databaseOid: row.database_oid, databaseName: row.database_name };
  } finally {
    await client.end();
  }
}

/**
 * Rejects before any destructive statement runs if two connection targets
 * resolve to the same physical database in the same PostgreSQL cluster.
 * Compares live server identity, not URL text, so it catches aliasing
 * (localhost vs 127.0.0.1), differing credentials/query params/encoding,
 * and any other textual form that resolves to the same database. Never
 * logs a password or full connection URL.
 */
export async function assertDistinctDatabases(
  urls: { a: string | undefined; b: string | undefined },
  labels: { a: string; b: string },
): Promise<void> {
  if (!urls.a) throw new Error(`${labels.a} is required`);
  if (!urls.b) throw new Error(`${labels.b} is required`);

  const [identityA, identityB] = await Promise.all([readIdentity(urls.a), readIdentity(urls.b)]);

  if (identityA.clusterId === identityB.clusterId && identityA.databaseOid === identityB.databaseOid) {
    throw new Error(
      `${labels.a} and ${labels.b} both resolve to database "${identityA.databaseName}" `
      + `(cluster ${identityA.clusterId}, oid ${identityA.databaseOid}); they must be distinct databases`,
    );
  }
}
