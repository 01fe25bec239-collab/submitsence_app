import { BadGatewayException } from "@nestjs/common";
import { createHmac, timingSafeEqual } from "node:crypto";

type FormValue = string | number | boolean | null | undefined;

export function validStripeSignature(rawBody: Buffer, header: string, secret: string, now = Date.now()): boolean {
  const parts = header.split(",").map((part) => part.split("=", 2) as [string, string]);
  const timestamp = Number(parts.find(([key]) => key === "t")?.[1]);
  if (!Number.isFinite(timestamp) || Math.abs(now / 1000 - timestamp) > 300) return false;
  const expected = createHmac("sha256", secret).update(`${timestamp}.`).update(rawBody).digest();
  return parts.filter(([key]) => key === "v1").some(([, value]) => {
    const actual = Buffer.from(value, "hex");
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  });
}

export class StripeClient {
  constructor(
    private readonly secretKey: string,
    private readonly baseUrl = process.env.STRIPE_API_BASE ?? "https://api.stripe.com/v1",
  ) {}

  get(path: string) {
    return this.request(path, "GET");
  }

  post(path: string, fields: Record<string, FormValue>) {
    return this.request(path, "POST", fields);
  }

  private async request(path: string, method: "GET" | "POST", fields: Record<string, FormValue> = {}) {
    const body = new URLSearchParams();
    for (const [key, value] of Object.entries(fields)) if (value !== null && value !== undefined) body.set(key, String(value));
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.secretKey}`, ...(method === "POST" ? { "Content-Type": "application/x-www-form-urlencoded" } : {}) },
      ...(method === "POST" ? { body } : {}),
    });
    const payload = (await response.json()) as Record<string, unknown>;
    if (!response.ok) {
      const error = payload.error as Record<string, unknown> | undefined;
      throw new BadGatewayException(typeof error?.message === "string" ? error.message : "Stripe request failed");
    }
    return payload;
  }
}
