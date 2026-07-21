import { Body, Controller, Get, Headers, Param, Post, Req } from "@nestjs/common";
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
