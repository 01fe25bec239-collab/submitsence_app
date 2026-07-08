import { Body, Controller, Get, Headers, Param, Post, Query, Req } from "@nestjs/common";
import type { AuthedRequest } from "../auth/auth.types";
import { ApiService } from "./api.service";
import { openApiDocument } from "./openapi";
import * as api from "./validation";

@Controller()
export class PublicController {
  constructor(private readonly service: ApiService) {}

  @Get("openapi.json")
  openapi() {
    return openApiDocument;
  }

  @Get("pricing/plans")
  plans() {
    return this.service.publicPlans();
  }

  @Get("content/articles")
  articles(@Query() query: Record<string, unknown>) {
    return this.service.publicArticles(query);
  }

  @Get("content/articles/:slug")
  article(@Param("slug") slug: string) {
    return this.service.publicArticle(slug);
  }

  @Get("help")
  help(@Query() query: Record<string, unknown>) {
    return this.service.contextualHelp(query);
  }

  @Post("billing/webhooks/stripe")
  billingWebhook(@Headers("x-webhook-secret") secret: string | undefined, @Req() req: AuthedRequest, @Body() body: unknown) {
    const input = api.object(body);
    return this.service.billingWebhook(input, api.idempotencyKey(req.headers, input), secret, req);
  }

  @Post("integrations/webhooks/:provider")
  integrationWebhook(
    @Param("provider") provider: string,
    @Headers("x-webhook-secret") secret: string | undefined,
    @Req() req: AuthedRequest,
    @Body() body: unknown,
  ) {
    const input = api.object(body);
    return this.service.integrationWebhook(provider, input, api.idempotencyKey(req.headers, input), secret, req);
  }
}
