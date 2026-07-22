import "server-only";
import { getAuthToken } from "@/lib/session/token";
import { ApiError, type StandardError } from "./errors";
import { MOCK_ENABLED, mockResponse } from "./mock";

const BASE_URL = process.env.API_BASE_URL ?? "http://localhost:3000/api/v1";

export interface ApiFetchOptions {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  body?: unknown;
  /** Required by the backend for upload finalise, generation, export, webhooks. */
  idempotencyKey?: string;
  /** Extra headers (rarely needed). */
  headers?: Record<string, string>;
  /**
   * Auth token override. Defaults to the current server session token.
   * Pass `null` explicitly for public endpoints (pricing, content, help).
   */
  token?: string | null;
  /** Next cache behaviour. Defaults to no-store (tenant data is never shared-cached). */
  cache?: RequestCache;
  /** Optional Next revalidate window for genuinely public, cacheable content. */
  revalidate?: number;
}

/**
 * Server-only fetch to the SubmitSense API. The bearer token never crosses to
 * the client — read data in Server Components / Server Actions and pass plain
 * results down. Always throws ApiError (never a bare Response) so callers can
 * render safe error UIs carrying a requestId.
 */
export async function apiFetch<T>(
  path: string,
  opts: ApiFetchOptions = {},
): Promise<T> {
  // Dev mock layer: serve fixtures for known reads when there's no backend.
  if (MOCK_ENABLED) {
    const mocked = mockResponse(path, opts.method ?? "GET");
    if (mocked !== undefined) return structuredClone(mocked) as T;
  }

  const token = opts.token === undefined ? await getAuthToken() : opts.token;

  const headers: Record<string, string> = {
    accept: "application/json",
    ...opts.headers,
  };
  if (token) headers.authorization = `Bearer ${token}`;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  if (opts.idempotencyKey) headers["idempotency-key"] = opts.idempotencyKey;

  const next =
    opts.revalidate !== undefined ? { revalidate: opts.revalidate } : undefined;

  let res: Response;
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      method: opts.method ?? "GET",
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      cache: next ? undefined : (opts.cache ?? "no-store"),
      next,
    });
  } catch (err) {
    throw new ApiError(
      0,
      null,
      "network_error",
      `Could not reach the SubmitSense API (${(err as Error).message}).`,
    );
  }

  const requestId = res.headers.get("x-request-id");

  if (!res.ok) {
    let payload: Partial<StandardError> = {};
    try {
      payload = (await res.json()) as StandardError;
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(
      res.status,
      payload.requestId ?? requestId,
      payload.error?.diagnosticCode ?? null,
      payload.error?.message ?? `Request failed with status ${res.status}.`,
    );
  }

  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** Fresh idempotency key for a mutating request. */
export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}
