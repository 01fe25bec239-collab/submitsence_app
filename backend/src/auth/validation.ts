import { BadRequestException } from "@nestjs/common";
import type { ProjectRoleKey, TenantRoleKey } from "./auth.types";

const uuidRx = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const tenantRoles = new Set<TenantRoleKey>([
  "owner",
  "admin",
  "project_manager",
  "reviewer",
  "contributor",
  "viewer",
  "billing_admin",
  "integration_admin",
]);
const projectRoles = new Set<ProjectRoleKey>(["lead", "reviewer", "contributor", "viewer"]);
const consentStates = new Set(["unset", "opted_in", "opted_out"]);

export function uuid(value: unknown, name: string): string {
  if (typeof value !== "string" || !uuidRx.test(value)) throw new BadRequestException(`${name} must be a UUID`);
  return value;
}

export function string(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new BadRequestException(`${name} is required`);
  return value.trim();
}

export function email(value: unknown): string {
  const out = string(value, "email").toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(out)) throw new BadRequestException("email is invalid");
  return out;
}

export function tenantRole(value: unknown): TenantRoleKey {
  const out = string(value, "roleKey") as TenantRoleKey;
  if (!tenantRoles.has(out)) throw new BadRequestException("roleKey is invalid");
  return out;
}

export function projectRole(value: unknown): ProjectRoleKey {
  const out = string(value, "role") as ProjectRoleKey;
  if (!projectRoles.has(out)) throw new BadRequestException("role is invalid");
  return out;
}

export function consentState(value: unknown): "unset" | "opted_in" | "opted_out" {
  const out = string(value, "learningLoop");
  if (!consentStates.has(out)) throw new BadRequestException("learningLoop is invalid");
  return out as "unset" | "opted_in" | "opted_out";
}

export function object(value: unknown, name: string): Record<string, unknown> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new BadRequestException(`${name} must be an object`);
  return value as Record<string, unknown>;
}

export function boolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") throw new BadRequestException(`${name} must be boolean`);
  return value;
}
