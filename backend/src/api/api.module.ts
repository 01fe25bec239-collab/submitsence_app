import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { ApiController } from "./api.controller";
import { ApiService } from "./api.service";
import { PublicController } from "./public.controller";

@Module({
  imports: [AuthModule],
  controllers: [ApiController, PublicController],
  providers: [ApiService],
})
export class ApiModule {}
