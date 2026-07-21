import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { ApiExceptionFilter } from "./api/error.filter";
import { rateLimitMiddleware } from "./api/rate-limit";
import { requestContextMiddleware } from "./api/request-context";
import { AppModule } from "./app.module";

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { rawBody: true });
  app.setGlobalPrefix("api/v1");
  app.use(requestContextMiddleware);
  app.use(rateLimitMiddleware);
  app.useGlobalFilters(new ApiExceptionFilter());
  app.enableShutdownHooks();
  await app.listen(Number(process.env.PORT ?? 3000));
}

void bootstrap();
