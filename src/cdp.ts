export interface CDPTarget {
  id: string;
  type: string;
  url?: string;
  title?: string;
}

export class CDPSession {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (value: any) => void; reject: (error: unknown) => void }>();
  private readonly listeners = new Map<string, Array<(params: any) => void>>();

  constructor(private readonly ws: WebSocket) {
    ws.addEventListener("message", (event: MessageEvent) => {
      const payloadText =
        typeof event.data === "string" ? event.data : Buffer.from(event.data as ArrayBuffer).toString("utf8");
      const payload = JSON.parse(payloadText);
      if (payload.id !== undefined && this.pending.has(payload.id)) {
        const deferred = this.pending.get(payload.id)!;
        this.pending.delete(payload.id);
        if (payload.error) {
          deferred.reject(new Error(JSON.stringify(payload.error)));
        } else {
          deferred.resolve(payload.result);
        }
      }

      if (payload.method) {
        for (const listener of this.listeners.get(payload.method) ?? []) {
          listener(payload.params);
        }
      }
    });
  }

  async send(method: string, params?: unknown): Promise<any> {
    const id = this.nextId++;
    return await new Promise<any>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method: string, handler: (params: any) => void): void {
    const listeners = this.listeners.get(method) ?? [];
    listeners.push(handler);
    this.listeners.set(method, listeners);
  }

  close(): void {
    this.ws.close();
  }
}

export async function waitForCDP(cdpPort: number, maxWaitMs = 15_000): Promise<void> {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${cdpPort}/json/version`);
      if (response.ok) {
        return;
      }
    } catch {
      // ignore while waiting
    }
    await Bun.sleep(250);
  }
  throw new Error("CDP did not start in time");
}

export async function listTargets(cdpPort: number): Promise<CDPTarget[]> {
  const response = await fetch(`http://127.0.0.1:${cdpPort}/json/list`);
  if (!response.ok) {
    throw new Error(`Unable to list CDP targets: ${response.status}`);
  }
  return (await response.json()) as CDPTarget[];
}

export async function connectCDP(cdpPort: number, targetId: string): Promise<CDPSession> {
  return await new Promise<CDPSession>((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${cdpPort}/devtools/page/${targetId}`);
    ws.addEventListener("open", () => resolve(new CDPSession(ws)), { once: true });
    ws.addEventListener("error", () => reject(new Error(`Failed to connect to CDP target ${targetId}`)), { once: true });
  });
}

export async function cdpEval(
  cdp: CDPSession,
  expression: string,
  options: {
    awaitPromise?: boolean;
    contextId?: number;
  } = {},
): Promise<any> {
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: options.awaitPromise ?? false,
    contextId: options.contextId,
  });
  if (result?.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || JSON.stringify(result.exceptionDetails));
  }
  return result?.result?.value;
}

export async function cdpWaitFor(
  cdp: CDPSession,
  expression: string,
  options: {
    timeoutMs?: number;
    intervalMs?: number;
  } = {},
): Promise<any> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const intervalMs = options.intervalMs ?? 500;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await cdpEval(cdp, expression, { awaitPromise: true });
    if (value) {
      return value;
    }
    await Bun.sleep(intervalMs);
  }
  throw new Error(`Timed out waiting for CDP expression: ${expression.slice(0, 120)}`);
}
