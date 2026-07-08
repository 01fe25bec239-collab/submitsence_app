import { Global, Module } from "@nestjs/common";
import { Pool } from "pg";

export const PG_POOL = Symbol("PG_POOL");

@Global()
@Module({
  providers: [
    {
      provide: PG_POOL,
      useFactory: () =>
        new Pool({
          connectionString: process.env.DATABASE_URL,
          ssl: process.env.PGSSLMODE === "require" ? { rejectUnauthorized: true } : undefined,
        }),
    },
  ],
  exports: [PG_POOL],
})
export class DbModule {}
