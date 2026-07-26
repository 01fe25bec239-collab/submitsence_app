import { Global, Module } from "@nestjs/common";
import { Pool } from "pg";

export const PG_POOL = Symbol("PG_POOL");

export function configuredPoolMax(value = process.env.PG_POOL_MAX): number | undefined {
  if (value === undefined) return undefined;
  if (!/^[1-9]\d*$/.test(value)) throw new Error("PG_POOL_MAX must be a positive integer");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error("PG_POOL_MAX must be a positive integer");
  return parsed;
}

// Shared so the API and the worker process connect identically (same role, same SSL policy).
export function createPool(): Pool {
  const max = configuredPoolMax();
  return new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.PGSSLMODE === "require" ? { rejectUnauthorized: true } : undefined,
    ...(max === undefined ? {} : { max }),
  });
}

@Global()
@Module({
  providers: [{ provide: PG_POOL, useFactory: createPool }],
  exports: [PG_POOL],
})
export class DbModule {}
