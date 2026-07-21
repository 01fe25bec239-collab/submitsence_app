// Mirrors the backend StandardError envelope:
//   { requestId, error: { message, diagnosticCode } }
export interface StandardError {
  requestId: string;
  error: { message: string; diagnosticCode: string };
}

/**
 * Thrown by apiFetch on any non-2xx response or transport failure.
 * `requestId` is surfaced to users in error UIs so support can trace an issue
 * without exposing internals. status 0 === could not reach the API.
 */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly requestId: string | null,
    public readonly diagnosticCode: string | null,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }

  get isNetwork() {
    return this.status === 0;
  }
  get isAuth() {
    return this.status === 401;
  }
  get isForbidden() {
    return this.status === 403;
  }
}
