import { HttpException, HttpStatus } from "@nestjs/common";

type Req = { ip?: string; socket?: { remoteAddress?: string }; method?: string; path?: string; originalUrl?: string };

const buckets = new Map<string, { count: number; resetAt: number }>();

export function rateLimitMiddleware(req: Req, _res: unknown, next: () => void) {
  const path = req.path ?? req.originalUrl ?? "";
  const now = Date.now();
  const limit = path.includes("/uploads") || path.includes("/finalize")
    ? 20
    : /(generate|regenerate|export|rematch|sync-jobs|webhooks)/.test(path)
      ? 10
      : /(auth|session)/.test(path)
        ? 30
        : /(pricing|content)/.test(path)
          ? 120
          : 240;
  const key = `${req.ip ?? req.socket?.remoteAddress ?? "unknown"}:${req.method ?? "GET"}:${path.split("?")[0]}`;
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + 60_000 });
    next();
    return;
  }
  if (bucket.count >= limit) throw new HttpException("Too many requests", HttpStatus.TOO_MANY_REQUESTS);
  bucket.count += 1;
  next();
}
