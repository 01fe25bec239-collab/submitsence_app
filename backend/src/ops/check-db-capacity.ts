import { createPool } from "../db.module";

function requiredInteger(name: string, value = process.env[name]): number {
  if (!value || !/^[1-9]\d*$/.test(value)) throw new Error(`${name} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

export async function checkDbCapacity(
  required = requiredInteger("REQUIRED_CONNECTIONS"),
  reservePercent = requiredInteger("RESERVE_PERCENT"),
): Promise<DbCapacity> {
  const pool = createPool();
  try {
    const result = await pool.query<{ max_connections: string }>("show max_connections");
    return evaluateDbCapacity(Number(result.rows[0]?.max_connections), required, reservePercent);
  } finally {
    await pool.end();
  }
}

export type DbCapacity = {
  maxConnections: number;
  usableConnections: number;
  requiredConnections: number;
  reservePercent: number;
  sufficient: boolean;
};

export function evaluateDbCapacity(maxConnections: number, requiredConnections: number, reservePercent: number): DbCapacity {
  if (reservePercent >= 100) throw new Error("RESERVE_PERCENT must be less than 100");
  if (!Number.isSafeInteger(maxConnections) || maxConnections <= 0) throw new Error("database returned an invalid max_connections");
  const usableConnections = Math.floor(maxConnections * (100 - reservePercent) / 100);
  return { maxConnections, usableConnections, requiredConnections, reservePercent, sufficient: requiredConnections <= usableConnections };
}

async function main(): Promise<void> {
  const capacity = await checkDbCapacity();
  console.log(JSON.stringify({ check: "pb08-db-capacity", ...capacity }));
  console.log(
    `PB-08 database capacity: required ${capacity.requiredConnections}, usable ${capacity.usableConnections} ` +
    `of ${capacity.maxConnections} with ${capacity.reservePercent}% reserve`,
  );
  if (!capacity.sufficient) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({ check: "pb08-db-capacity", sufficient: false, error: message }));
    console.error(`PB-08 database capacity check failed: ${message}`);
    process.exitCode = 1;
  });
}
