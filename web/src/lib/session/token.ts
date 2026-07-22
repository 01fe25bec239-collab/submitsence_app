import "server-only";
import { cookies } from "next/headers";
import { DEV_AUTH, DEV_TOKEN } from "./dev-stub";

/**
 * Current request's bearer token (server only). Kept in its own module so the
 * API client can import it without pulling in the session resolvers, which
 * themselves depend on the API client.
 *
 * Real auth: a Cognito access token stored in an httpOnly `ss_token` cookie by
 * the sign-in route. Dev auth: a fixed stub token.
 */
export async function getAuthToken(): Promise<string | null> {
  if (DEV_AUTH) return DEV_TOKEN;
  const jar = await cookies();
  return jar.get("ss_token")?.value ?? null;
}
