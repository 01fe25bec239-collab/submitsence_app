import { Module } from "@nestjs/common";
import { ApiModule } from "./api/api.module";
import { AuthModule } from "./auth/auth.module";
import { DbModule } from "./db.module";

@Module({
  imports: [DbModule, AuthModule, ApiModule],
})
export class AppModule {}
