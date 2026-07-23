import type { WorkerLeaseConfig } from "./worker";

type Fetch = typeof fetch;

export function protectionExpiryMinutes(config: WorkerLeaseConfig): number {
  return Math.max(1, Math.min(2880, Math.ceil((config.leaseSeconds + 2 * config.heartbeatMs / 1000) / 60)));
}

export type TaskProtection = {
  enable: () => Promise<boolean>;
  renew: () => Promise<boolean>;
  clear: (retryForMs?: number) => Promise<boolean>;
};

export function createTaskProtection(
  config: WorkerLeaseConfig,
  options: {
    agentUri?: string;
    fetchImpl?: Fetch;
    retryMs?: number;
    requestTimeoutMs?: number;
    wait?: (ms: number) => Promise<void>;
  } = {},
): TaskProtection {
  const agentUri = options.agentUri ?? process.env.ECS_AGENT_URI;
  if (!agentUri) throw new Error("ECS_AGENT_URI is required for worker task protection");
  const fetchImpl = options.fetchImpl ?? fetch;
  const retryMs = options.retryMs ?? 1000;
  const requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
  const wait = options.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const url = `${agentUri.replace(/\/$/, "")}/task-protection/v1/state`;
  const expiry = protectionExpiryMinutes(config);

  const update = async (enabled: boolean, timeoutMs = requestTimeoutMs): Promise<boolean> => {
    try {
      const response = await fetchImpl(url, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ProtectionEnabled: enabled,
          ...(enabled ? { ExpiresInMinutes: expiry } : {}),
        }),
        signal: AbortSignal.timeout(Math.max(1, timeoutMs)),
      });
      if (!response.ok) return false;
      const body = await response.json() as { protection?: { ProtectionEnabled?: boolean } };
      return body.protection?.ProtectionEnabled === enabled;
    } catch {
      return false;
    }
  };

  return {
    enable: () => update(true),
    renew: () => update(true),
    clear: async (retryForMs = 30_000) => {
      const deadline = Date.now() + retryForMs;
      do {
        if (await update(false, Math.min(requestTimeoutMs, Math.max(1, deadline - Date.now())))) return true;
        if (Date.now() >= deadline) return false;
        await wait(Math.min(retryMs, Math.max(0, deadline - Date.now())));
      } while (true);
    },
  };
}
