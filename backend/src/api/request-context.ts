import { randomUUID } from "node:crypto";

type Req = { headers: Record<string, string | string[] | undefined>; requestId?: string };
type Res = { setHeader(name: string, value: string): void };

export function requestContextMiddleware(req: Req, res: Res, next: () => void) {
  const header = req.headers["x-request-id"];
  req.requestId = (Array.isArray(header) ? header[0] : header) || randomUUID();
  res.setHeader("x-request-id", req.requestId);
  next();
}
