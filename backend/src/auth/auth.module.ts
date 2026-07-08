import { Module } from "@nestjs/common";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import { CognitoAuthGuard, PermissionGuard, TenantGuard } from "./auth.guards";

@Module({
  controllers: [AuthController],
  providers: [AuthService, CognitoAuthGuard, TenantGuard, PermissionGuard],
  exports: [AuthService, CognitoAuthGuard, TenantGuard, PermissionGuard],
})
export class AuthModule {}
