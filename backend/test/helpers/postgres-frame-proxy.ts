import net from "node:net";

/**
 * PB-10 Step 3 Phase 2c blocker 7: a deterministic, protocol-aware TCP proxy
 * for the ambiguous-COMMIT PostgreSQL test suite.
 *
 * TCP is a byte stream, not a message stream: a single frontend or backend
 * message can arrive split across arbitrarily many `data` events, or several
 * messages can arrive coalesced into one. Searching individual chunks for a
 * literal byte sequence (the proxy this replaces) is therefore unsound —
 * "commit\0" can straddle a chunk boundary and simply never match, or a
 * bound parameter elsewhere in the stream could coincidentally contain the
 * same bytes. FrameSplitter instead buffers across calls and only ever
 * inspects complete, correctly framed PostgreSQL messages.
 *
 * Frontend/backend framing (https://www.postgresql.org/docs/current/protocol-message-formats.html):
 * every message after the connection's startup phase is `type:1 length:4(BE,
 * includes itself) body:length-4`. The one exception is the startup phase
 * itself (SSLRequest/GSSENCRequest, if sent, and the StartupMessage), which
 * carries no leading type byte — just `length:4(BE, includes itself)
 * body:length-4`. This suite's connections never negotiate SSL or GSS
 * encryption (the disposable test database is always plaintext), so once a
 * connection's first, untyped message turns out not to be an
 * SSLRequest/GSSENCRequest, every later message on that same direction is
 * assumed typed for the rest of the connection's life; a real SSL/GSS
 * upgrade is out of scope (the stream would go opaque and unparseable to
 * both this proxy and any literal-search predecessor).
 */
export interface ParsedFrame {
  /** The complete message, byte-for-byte, exactly as received. */
  raw: Buffer;
  /** null only for a startup-phase message (StartupMessage/SSLRequest/GSSENCRequest), which has no type byte. */
  type: string | null;
  body: Buffer;
}

const SSL_REQUEST_CODE = 80877103;
const GSSENC_REQUEST_CODE = 80877104;

export class FrameSplitter {
  private buffer = Buffer.alloc(0);
  private startupDone: boolean;

  /** assumeTyped: true for a direction that never sees the untyped startup framing (see class doc). */
  constructor(assumeTyped = false) {
    this.startupDone = assumeTyped;
  }

  /** Feeds one chunk of raw socket bytes; returns every complete message now available, in order. */
  push(chunk: Buffer): ParsedFrame[] {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    const frames: ParsedFrame[] = [];
    for (;;) {
      if (!this.startupDone) {
        if (this.buffer.length < 4) break;
        const length = this.buffer.readUInt32BE(0);
        if (length < 4) throw new Error(`postgres-frame-proxy: impossible startup frame length ${length}`);
        if (this.buffer.length < length) break;
        const raw = this.buffer.subarray(0, length);
        this.buffer = this.buffer.subarray(length);
        const body = raw.subarray(4);
        const negotiationCode = body.length === 4 ? body.readUInt32BE(0) : -1;
        const isNegotiation = negotiationCode === SSL_REQUEST_CODE || negotiationCode === GSSENC_REQUEST_CODE;
        frames.push({ raw, type: null, body });
        if (!isNegotiation) this.startupDone = true;
        continue;
      }
      if (this.buffer.length < 5) break;
      const type = String.fromCharCode(this.buffer[0]);
      const length = this.buffer.readUInt32BE(1);
      if (length < 4) throw new Error(`postgres-frame-proxy: impossible message length ${length} for type ${type}`);
      const total = 1 + length;
      if (this.buffer.length < total) break;
      const raw = this.buffer.subarray(0, total);
      this.buffer = this.buffer.subarray(total);
      frames.push({ raw, type, body: raw.subarray(5) });
    }
    return frames;
  }
}

/** A simple-query message body is a single null-terminated string. */
function simpleQueryText(body: Buffer): string {
  const terminator = body.indexOf(0);
  return (terminator === -1 ? body : body.subarray(0, terminator)).toString("utf8").trim().toLowerCase();
}

/** A CommandComplete body is a single null-terminated command tag, e.g. "COMMIT". */
function commandTag(body: Buffer): string {
  const terminator = body.indexOf(0);
  return (terminator === -1 ? body : body.subarray(0, terminator)).toString("utf8").trim();
}

export interface CommitProxy {
  port: number;
  /** Swallows the client's own outgoing "commit" Query frame before it ever reaches PostgreSQL, then kills both legs. */
  armDropBeforeServer(): void;
  /** Lets "commit" reach PostgreSQL and waits for the real CommandComplete("COMMIT") response, then kills both legs before relaying it. */
  armDropBeforeClient(): void;
  /**
   * PB-10 Step 3 Phase 2c final review, item 7 scenario 2: swallows the
   * client's own outgoing "rollback" Query frame before it ever reaches
   * PostgreSQL, then kills both legs — a genuine, non-authoritative failure
   * of the ROLLBACK itself (no SQLSTATE, since PostgreSQL never saw it),
   * exactly the shape a real network partition mid-ROLLBACK produces.
   */
  armDropRollback(): void;
  /**
   * PB-10 Step 3 Phase 2c final review, blocker 1: holds the first frontend
   * frame whose raw bytes contain `needle` — and every frontend frame after
   * it on that same connection — instead of forwarding them, until the
   * returned `release()` is called. PostgreSQL therefore never sees the
   * statement, so it is genuinely still in flight for as long as the test
   * chooses: a controlled gate on a real query, not a sleep and not a
   * fabricated stall. Disarms itself on the first match, so only one
   * connection is ever gated. `engaged` resolves the moment the gate closes.
   */
  armStallFrontendContaining(needle: string): { engaged: Promise<void>; release(): void };
  close(): Promise<void>;
}

export function startCommitProxy(targetHost: string, targetPort: number): Promise<CommitProxy> {
  return new Promise((resolve, reject) => {
    let dropBeforeServer = false;
    let dropBeforeClient = false;
    let dropRollback = false;
    let stallNeedle: Buffer | undefined;
    let onStallEngaged: (() => void) | undefined;
    // Set once a connection is gated: the queued frontend frames plus the
    // function that flushes them onward. Only ever one at a time.
    let stalled: { queue: Buffer[]; flush: () => void } | undefined;
    const server = net.createServer((clientSocket) => {
      const serverSocket = net.connect({ host: targetHost, port: targetPort });
      const kill = (): void => {
        clientSocket.destroy();
        serverSocket.destroy();
      };
      // Frontend (client -> server) is the direction that carries the
      // untyped StartupMessage; backend (server -> client) is always typed
      // in this suite (see class doc — no SSL/GSS negotiation is exercised).
      const frontend = new FrameSplitter(false);
      const backend = new FrameSplitter(true);

      let stalling: Buffer[] | undefined;
      const flushStalled = (): void => {
        const queued = stalling ?? [];
        stalling = undefined;
        for (const raw of queued) {
          if (!serverSocket.destroyed) serverSocket.write(raw);
        }
      };

      clientSocket.on("data", (chunk: Buffer) => {
        let frames: ParsedFrame[];
        try {
          frames = frontend.push(chunk);
        } catch {
          // A malformed/unparseable frontend stream: fail closed by killing
          // the connection rather than guessing at message boundaries.
          kill();
          return;
        }
        for (const frame of frames) {
          if (dropBeforeServer && frame.type === "Q" && simpleQueryText(frame.body) === "commit") {
            dropBeforeServer = false;
            kill();
            return;
          }
          if (dropRollback && frame.type === "Q" && simpleQueryText(frame.body) === "rollback") {
            dropRollback = false;
            kill();
            return;
          }
          if (stalling === undefined && stallNeedle !== undefined && frame.raw.includes(stallNeedle)) {
            // Gate this connection from here on: this frame, and everything
            // the client sends after it, waits for release().
            stallNeedle = undefined;
            stalling = [];
            stalled = { queue: stalling, flush: flushStalled };
            const engaged = onStallEngaged;
            onStallEngaged = undefined;
            engaged?.();
          }
          if (stalling !== undefined) {
            stalling.push(frame.raw);
            continue;
          }
          if (!serverSocket.destroyed) serverSocket.write(frame.raw);
        }
      });
      serverSocket.on("data", (chunk: Buffer) => {
        let frames: ParsedFrame[];
        try {
          frames = backend.push(chunk);
        } catch {
          kill();
          return;
        }
        for (const frame of frames) {
          if (dropBeforeClient && frame.type === "C" && commandTag(frame.body) === "COMMIT") {
            dropBeforeClient = false;
            kill();
            return;
          }
          if (!clientSocket.destroyed) clientSocket.write(frame.raw);
        }
      });
      clientSocket.on("error", () => undefined);
      serverSocket.on("error", () => undefined);
      clientSocket.on("close", () => serverSocket.destroy());
      serverSocket.on("close", () => clientSocket.destroy());
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("commit proxy failed to bind a TCP port"));
        return;
      }
      resolve({
        port: address.port,
        armDropBeforeServer: () => { dropBeforeServer = true; },
        armDropBeforeClient: () => { dropBeforeClient = true; },
        armDropRollback: () => { dropRollback = true; },
        armStallFrontendContaining: (needle: string) => {
          stallNeedle = Buffer.from(needle, "utf8");
          const engaged = new Promise<void>((resolveEngaged) => { onStallEngaged = resolveEngaged; });
          return {
            engaged,
            release: () => {
              stallNeedle = undefined;
              onStallEngaged = undefined;
              const gate = stalled;
              stalled = undefined;
              gate?.flush();
            },
          };
        },
        close: () => new Promise((res) => server.close(() => res())),
      });
    });
  });
}
