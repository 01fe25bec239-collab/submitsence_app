import { Body, Controller, Get, Headers, Param, Patch, Post, Query, Req, UseGuards } from "@nestjs/common";
import { CognitoAuthGuard, PermissionGuard, RequirePermission, TenantGuard } from "../auth/auth.guards";
import type { AuthedRequest } from "../auth/auth.types";
import * as api from "../api/validation";
import { CommercialService } from "./commercial.service";

@Controller()
export class PublicCommercialController {
  constructor(private readonly service: CommercialService) {}

  @Get("pricing/plans")
  plans() { return this.service.publicPlans(); }

  @Get("content/articles")
  articles(@Query() query: Record<string, unknown>) { return this.service.publicArticles(query); }

  @Get("content/articles/:slug")
  article(@Param("slug") slug: string) { return this.service.publicArticle(slug); }

  @Get("content/sitemap")
  sitemap() { return this.service.sitemap(); }

  @Get("help")
  help(@Query() query: Record<string, unknown>) { return this.service.contextualHelp(query); }

  @Post("billing/webhooks/stripe")
  webhook(@Headers("stripe-signature") signature: string | undefined, @Req() req: AuthedRequest, @Body() body: unknown) {
    return this.service.billingWebhook(signature, req.rawBody, api.object(body), req);
  }
}

@UseGuards(CognitoAuthGuard)
@Controller("onboarding")
export class OnboardingController {
  constructor(private readonly service: CommercialService) {}

  @Post()
  onboard(@Req() req: AuthedRequest, @Body() body: unknown) {
    return this.service.onboard(req.principal!, api.object(body), req);
  }
}

@UseGuards(CognitoAuthGuard, TenantGuard, PermissionGuard)
@Controller("tenants/:tenantId")
export class TenantCommercialController {
  constructor(private readonly service: CommercialService) {}

  @RequirePermission("billing")
  @Get("subscription")
  subscription(@Req() req: AuthedRequest) { return this.service.subscription(req.auth!); }

  @RequirePermission("billing")
  @Post("subscription/trial")
  startTrial(@Req() req: AuthedRequest) { return this.service.startTrial(req.auth!, req); }

  @RequirePermission("billing")
  @Post("subscription/checkout")
  checkout(@Req() req: AuthedRequest, @Body() body: unknown) { return this.service.checkout(req.auth!, api.object(body), req); }

  @RequirePermission("billing")
  @Patch("subscription/plan")
  changePlan(@Req() req: AuthedRequest, @Body() body: unknown) { return this.service.changePlan(req.auth!, api.object(body), req); }

  @RequirePermission("billing")
  @Post("subscription/cancel")
  cancel(@Req() req: AuthedRequest) { return this.service.cancelSubscription(req.auth!, req); }

  @RequirePermission("billing")
  @Get("invoices")
  invoices(@Req() req: AuthedRequest) { return this.service.invoices(req.auth!); }

  @RequirePermission("billing")
  @Get("billing-profile")
  billingProfile(@Req() req: AuthedRequest) { return this.service.billingProfile(req.auth!); }

  @RequirePermission("billing")
  @Patch("billing-profile")
  updateBillingProfile(@Req() req: AuthedRequest, @Body() body: unknown) { return this.service.updateBillingProfile(req.auth!, api.object(body), req); }

  @RequirePermission("read", "projectId")
  @Post("projects/:projectId/worksections/:worksectionId/trial-usage")
  claimTrial(
    @Req() req: AuthedRequest,
    @Param("projectId") projectId: string,
    @Param("worksectionId") worksectionId: string,
  ) { return this.service.claimTrialWorksection(req.auth!, projectId, worksectionId); }

  @Get("help")
  help(@Query() query: Record<string, unknown>) { return this.service.contextualHelp(query); }
}

@UseGuards(CognitoAuthGuard)
@Controller("admin")
export class CommercialAdminController {
  constructor(private readonly service: CommercialService) {}

  @Get("plans")
  plans(@Req() req: AuthedRequest) { return this.service.adminPlans(req.principal!); }

  @Patch("plans/:key")
  updatePlan(@Req() req: AuthedRequest, @Param("key") key: string, @Body() body: unknown) {
    return this.service.updatePlan(req.principal!, key, api.object(body), req);
  }

  @Get("content/articles")
  articles(@Req() req: AuthedRequest) { return this.service.adminArticles(req.principal!); }

  @Post("content/articles")
  createArticle(@Req() req: AuthedRequest, @Body() body: unknown) {
    return this.service.createArticle(req.principal!, api.object(body), req);
  }

  @Patch("content/articles/:articleId")
  updateArticle(@Req() req: AuthedRequest, @Param("articleId") articleId: string, @Body() body: unknown) {
    return this.service.updateArticle(req.principal!, articleId, api.object(body), req);
  }

  @Post("content/articles/:articleId/:state")
  transition(
    @Req() req: AuthedRequest,
    @Param("articleId") articleId: string,
    @Param("state") state: string,
    @Body() body: unknown,
  ) { return this.service.transitionArticle(req.principal!, articleId, state, api.object(body), req); }
}
