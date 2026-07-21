import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import {
  CommercialAdminController,
  OnboardingController,
  PublicCommercialController,
  TenantCommercialController,
} from "./commercial.controller";
import { CommercialService } from "./commercial.service";

@Module({
  imports: [AuthModule],
  controllers: [PublicCommercialController, OnboardingController, TenantCommercialController, CommercialAdminController],
  providers: [CommercialService],
})
export class CommercialModule {}
