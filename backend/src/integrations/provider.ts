export type IntegrationProvider = "aconex" | "procore";
export type ConsultantStatus = "submitted" | "approved" | "revise_and_resubmit" | "rejected";
export type RegisterConsultantStatus = Exclude<ConsultantStatus, "approved">;

export interface ProviderCapabilities {
  provider: IntegrationProvider;
  approval: "pending";
  enabled: false;
  authentication: "partner_approved_oauth2";
  packagePush: false;
  responsePull: false;
  webhooks: false;
  reason: string;
}

export interface PackagePushInput {
  tenantId: string;
  projectId: string;
  externalProjectId: string;
  packageId: string;
  idempotencyKey: string;
  fileName: string;
  content: Uint8Array;
  metadata: Record<string, string>;
}

export interface ExternalResponse {
  tenantId: string;
  projectId: string;
  externalProjectId: string;
  registerItemId: string;
  externalEventId: string;
  status: ConsultantStatus;
  responseRef: string | null;
}

export interface IntegrationAdapter {
  readonly provider: IntegrationProvider;
  readonly capabilities: ProviderCapabilities | (Omit<ProviderCapabilities, "approval" | "enabled" | "packagePush" | "responsePull" | "webhooks" | "reason"> & {
    approval: "mock";
    enabled: true;
    packagePush: true;
    responsePull: true;
    webhooks: true;
  });
  pushPackage(input: PackagePushInput): Promise<{ externalRef: string }>;
  pullResponses(input: { tenantId: string; projectId: string; externalProjectId: string; cursor?: string | null }): Promise<{ responses: ExternalResponse[]; cursor: string | null }>;
}

export interface IntegrationTokenStore {
  // The resolved token is memory-only. Implementations must not log, persist, or return it via APIs.
  resolve(tokenReference: string): Promise<{ accessToken: string; expiresAt: string | null }>;
}

export class IntegrationProviderError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "IntegrationProviderError";
  }
}

export class PartnerApprovalRequiredError extends IntegrationProviderError {
  constructor(provider: IntegrationProvider) {
    super("partner_approval_required", `${provider} integration is unavailable until partner approval and approved API credentials exist`, false);
  }
}

const pendingCapabilities = (provider: IntegrationProvider): ProviderCapabilities => ({
  provider,
  approval: "pending",
  enabled: false,
  authentication: "partner_approved_oauth2",
  packagePush: false,
  responsePull: false,
  webhooks: false,
  reason: "Partner approval and approved API credentials are not currently available",
});

class PendingPartnerAdapter implements IntegrationAdapter {
  readonly capabilities: ProviderCapabilities;

  constructor(readonly provider: IntegrationProvider) {
    this.capabilities = pendingCapabilities(provider);
  }

  pushPackage(_input: PackagePushInput): Promise<{ externalRef: string }> {
    return Promise.reject(new PartnerApprovalRequiredError(this.provider));
  }

  pullResponses(_input: { tenantId: string; projectId: string; externalProjectId: string }): Promise<{ responses: ExternalResponse[]; cursor: string | null }> {
    return Promise.reject(new PartnerApprovalRequiredError(this.provider));
  }
}

export class AconexAdapter extends PendingPartnerAdapter {
  constructor() { super("aconex"); }
}

export class ProcoreAdapter extends PendingPartnerAdapter {
  constructor() { super("procore"); }
}

export class MockIntegrationAdapter implements IntegrationAdapter {
  readonly capabilities;
  private readonly pushes = new Map<string, string>();
  private readonly responses: ExternalResponse[] = [];

  constructor(readonly provider: IntegrationProvider = "aconex") {
    this.capabilities = {
      provider,
      approval: "mock" as const,
      enabled: true as const,
      authentication: "partner_approved_oauth2" as const,
      packagePush: true as const,
      responsePull: true as const,
      webhooks: true as const,
    };
  }

  async pushPackage(input: PackagePushInput): Promise<{ externalRef: string }> {
    const key = `${input.tenantId}:${input.idempotencyKey}`;
    const existing = this.pushes.get(key);
    if (existing) return { externalRef: existing };
    const externalRef = `mock-${this.provider}-${this.pushes.size + 1}`;
    this.pushes.set(key, externalRef);
    return { externalRef };
  }

  async pullResponses(input: { tenantId: string; projectId: string; externalProjectId: string; cursor?: string | null }) {
    const offset = Number.parseInt(input.cursor ?? "0", 10) || 0;
    const scoped = this.responses.filter((item) =>
      item.tenantId === input.tenantId && item.projectId === input.projectId && item.externalProjectId === input.externalProjectId,
    );
    return { responses: scoped.slice(offset), cursor: scoped.length ? String(scoped.length) : null };
  }

  seedResponse(response: ExternalResponse): void {
    if (!this.responses.some((item) => item.tenantId === response.tenantId && item.externalEventId === response.externalEventId)) this.responses.push(response);
  }
}

export function listProviderCapabilities(): ProviderCapabilities[] {
  return [pendingCapabilities("aconex"), pendingCapabilities("procore")];
}

export function providerCapabilities(provider: string): ProviderCapabilities | null {
  return provider === "aconex" || provider === "procore" ? pendingCapabilities(provider) : null;
}

export function mapExternalConsultantStatus(value: unknown): { consultantStatus: ConsultantStatus; registerStatus: RegisterConsultantStatus | null } {
  if (typeof value !== "string") throw new IntegrationProviderError("invalid_status", "External consultant status is required", false);
  const status = value.trim().toLowerCase();
  if (status === "approved") return { consultantStatus: "approved", registerStatus: null };
  if (status === "returned") return { consultantStatus: "revise_and_resubmit", registerStatus: "revise_and_resubmit" };
  if (status === "submitted" || status === "revise_and_resubmit" || status === "rejected") {
    return { consultantStatus: status, registerStatus: status };
  }
  throw new IntegrationProviderError("invalid_status", "Unsupported external consultant status", false);
}

export function assertAustralianSecretReference(value: unknown): string {
  if (typeof value !== "string" || !/^arn:aws:secretsmanager:ap-southeast-(2|4):\d{12}:secret:[A-Za-z0-9/_+=.@-]+$/.test(value)) {
    throw new IntegrationProviderError("invalid_token_reference", "Token reference must be an AWS Secrets Manager ARN in an Australian region", false);
  }
  return value;
}
