import { Module } from "@nestjs/common";
import { ApiModule } from "./api/api.module";
import { AuthModule } from "./auth/auth.module";
import { DbModule } from "./db.module";
import { CommercialModule } from "./commercial/commercial.module";

@Module({
  imports: [DbModule, AuthModule, ApiModule, CommercialModule],
})
export class AppModule {}
