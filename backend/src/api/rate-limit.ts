import { HttpException, HttpStatus } from "@nestjs/common";

type Req = { ip?: string; socket?: { remoteAddress?: string }; method?: string; path?: string; originalUrl?: string };

const buckets = new Map<string, { client: string; count: number; resetAt: number }>();
const clientBuckets = new Map<string, Set<string>>();
export const MAX_RATE_LIMIT_BUCKETS = 10_000;
export const MAX_RATE_LIMIT_ROUTES_PER_CLIENT = 100;
const OVERFLOW_BUCKET = "__overflow__";
let nextCleanupAt = 0;

export const rateLimitBucketCount = () => buckets.size;

function deleteBucket(key: string) {
  const bucket = buckets.get(key);
  if (!bucket) return;
  buckets.delete(key);
  const routes = clientBuckets.get(bucket.client);
  routes?.delete(key);
  if (routes?.size === 0) clientBuckets.delete(bucket.client);
}

function evictOldestBucket() {
  const oldestKey = buckets.keys().next().value;
  if (oldestKey) deleteBucket(oldestKey);
}

export function rateLimitMiddleware(req: Req, _res: unknown, next: () => void) {
  let path = (req.path ?? req.originalUrl ?? "").split("?")[0];
  try {
    path = decodeURIComponent(path);
  } catch {
    // Keep malformed paths rate-limited by their raw representation.
  }
  path = path.toLowerCase();
  const now = Date.now();
  if (now >= nextCleanupAt) {
    for (const [key, bucket] of buckets) if (bucket.resetAt <= now) deleteBucket(key);
    nextCleanupAt = now + 60_000;
  }
  const rateClass = path.includes("/uploads") || path.includes("/finalize")
    ? "upload"
    : /(generate|regenerate|export|rematch|sync-jobs|webhooks)/.test(path)
      ? "expensive"
      : /(auth|session)/.test(path)
        ? "auth"
        : /(pricing|content)/.test(path)
          ? "public"
          : "default";
  const limit = { upload: 20, expensive: 10, auth: 30, public: 120, default: 240 }[rateClass];
  const route = path
    .replace(/\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}(?=\/|$)/gi, "/:id")
    .replace(/\/\d+(?=\/|$)/g, "/:id");
  const client = req.ip ?? req.socket?.remoteAddress ?? "unknown";
  const requestedKey = `${client}\n${req.method ?? "GET"}\n${route}`;
  const overflowKey = `${client}\n${OVERFLOW_BUCKET}`;
  const clientBucketCount = clientBuckets.get(client)?.size ?? 0;
  const key = buckets.has(requestedKey) || clientBucketCount < MAX_RATE_LIMIT_ROUTES_PER_CLIENT - 1 ? requestedKey : overflowKey;
  const effectiveLimit = key === overflowKey ? 10 : limit;
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    if (!bucket && buckets.size >= MAX_RATE_LIMIT_BUCKETS) evictOldestBucket();
    buckets.set(key, { client, count: 1, resetAt: now + 60_000 });
    if (!bucket) {
      const routes = clientBuckets.get(client) ?? new Set<string>();
      routes.add(key);
      clientBuckets.set(client, routes);
    }
    next();
    return;
  }
  if (bucket.count >= effectiveLimit) throw new HttpException("Too many requests", HttpStatus.TOO_MANY_REQUESTS);
  bucket.count += 1;
  next();
}
