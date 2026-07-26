import { BadRequestException } from "@nestjs/common";
import * as v from "../auth/validation";

export const documentTypes = new Set(["spec", "drawing", "addendum", "vendor_catalogue", "past_submittal", "generated_package", "export", "attachment", "other"]);
export const projectStatuses = new Set(["draft", "active", "on_hold", "completed", "archived", "cancelled"]);
export const tradePackages = new Set(["mechanical", "electrical", "hydraulic", "fire_protection", "communications", "other"]);
export const submittalStatuses = new Set(["draft", "submitted", "human_approved", "revise_and_resubmit", "rejected", "closed", "cancelled"]);
export const physicalKinds = new Set(["physical_sample", "stamped_shop_drawing", "mockup", "other"]);
export const physicalStatuses = new Set(["required", "requested", "in_transit", "received", "returned", "waived"]);
export const matchDecisions = new Set(["accepted", "rejected"]);
export const riskStates = new Set(["confirmed", "dismissed", "resolved"]);
export const consultantOutcomes = new Set(["approved", "revise_and_resubmit", "rejected", "withdrawn", "unknown"]);
export const registerExportFormats = new Set(["csv", "xlsx", "pdf"]);
export const rfiConflictTypes = new Set(["ambiguity", "conflict", "missing_information", "discrepancy", "other"]);
export const integrationProviders = new Set(["aconex", "procore", "other"]);
export const syncJobTypes = new Set(["package_push", "response_pull"]);
export const consentStates = new Set(["opted_in", "opted_out"]); // 'unset' is the default, never a user choice
export const requirementCategories = new Set(["submission", "hold_point", "evidence_of_conformity", "sample", "shop_drawing", "product_data", "test_report", "certificate", "manual", "commissioning_record", "other"]);

export function object(body: unknown): Record<string, unknown> {
  return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

export function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function optionalUuid(value: unknown, name: string): string | null {
  return value === undefined || value === null || value === "" ? null : v.uuid(value, name);
}

export function optionalDate(value: unknown, name: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) throw new BadRequestException(`${name} must be a date`);
  return value;
}

export function enumValue<T extends string>(value: unknown, name: string, allowed: Set<string>): T {
  const out = v.string(value, name);
  if (!allowed.has(out)) throw new BadRequestException(`${name} is invalid`);
  return out as T;
}

export function stringArray(value: unknown, name: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim() === "")) {
    throw new BadRequestException(`${name} must be a string array`);
  }
  return value.map((item) => item.trim());
}

export function uuidArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.length === 0) throw new BadRequestException(`${name} must be a non-empty UUID array`);
  return value.map((item, i) => v.uuid(item, `${name}[${i}]`));
}

export function optionalUuidArray(value: unknown, name: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new BadRequestException(`${name} must be a UUID array`);
  return value.map((item, i) => v.uuid(item, `${name}[${i}]`));
}

export function positiveInt(value: unknown, name: string): number | null {
  if (value === undefined || value === null || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(n) || n < 0) throw new BadRequestException(`${name} must be a positive integer`);
  return n;
}

export function hexSha256(value: unknown): string {
  const out = v.string(value, "checksumSha256").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(out)) throw new BadRequestException("checksumSha256 must be a SHA-256 hex digest");
  return out;
}

export function idempotencyKey(headers: Record<string, string | string[] | undefined>, body: Record<string, unknown> = {}): string {
  const raw = headers["idempotency-key"] ?? headers["x-idempotency-key"] ?? body.idempotencyKey;
  const value = Array.isArray(raw) ? raw[0] : raw;
  return v.string(value, "Idempotency-Key");
}

export function safeFilename(value: unknown): string {
  return v.string(value, "filename").replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 180);
}
