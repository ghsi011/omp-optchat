import assert from "node:assert/strict";
import { tool } from "@opencode-ai/plugin";

const z = tool.schema;
export class SmokeFailure extends Error { override readonly name = "OpenCodeSmokeFailure"; }
export function observed<T>(task: Promise<T>) {
  return task.then((value) => ({ ok: true, value } as const), (error: unknown) => ({ ok: false, error } as const));
}
export async function refused(task: Promise<unknown>, label: string): Promise<string> {
  const result = await observed(task);
  if (result.ok) assert.fail(`${label} must reject`);
  if (!(result.error instanceof SmokeFailure)) throw result.error;
  return result.error.message;
}
export async function bounded<T>(task: Promise<T>, label: string, milliseconds = 90_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([task, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new SmokeFailure(`${label} timed out`)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

export class Host {
  readonly child: Bun.Subprocess<"ignore", "pipe", "pipe">;
  readonly ready = Promise.withResolvers<string>();
  diagnostics = "";
  readonly streams: Promise<void>[];
  constructor(executable: string, readonly workspace: string, env: NodeJS.ProcessEnv) {
    const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null, { status: 503 }) });
    const port = reservation.port;
    reservation.stop(true);
    this.child = Bun.spawn([executable, "--print-logs", "--log-level=ERROR", "serve", "--hostname=127.0.0.1", `--port=${port}`, "--no-mdns"],
      { cwd: workspace, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    this.streams = [this.consume(this.child.stdout), this.consume(this.child.stderr)];
    void this.child.exited.then((code) => this.ready.reject(new SmokeFailure(`host exited before ready: ${code}`)));
  }
  private async consume(stream: ReadableStream<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder();
    for await (const chunk of stream) {
      this.diagnostics = (this.diagnostics + decoder.decode(chunk, { stream: true })).slice(-16_384);
      const url = /server listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(this.diagnostics)?.[1];
      if (url) this.ready.resolve(url);
    }
  }
  async request(path: string, body?: Readonly<Record<string, unknown>>): Promise<unknown> {
    const base = await bounded(this.ready.promise, "host startup", 30_000);
    const url = new URL(path, base);
    url.searchParams.set("directory", this.workspace);
    const response = await fetch(url, { method: body ? "POST" : "GET", signal: AbortSignal.timeout(90_000),
      headers: { "content-type": "application/json", "x-opencode-directory": this.workspace },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    const text = await response.text();
    if (!response.ok) throw new SmokeFailure(`${path}: HTTP ${response.status}: ${text.slice(0, 2048)}`);
    return text ? JSON.parse(text) : null;
  }
  async prompt(session: string, marker: string, modelID = "chat"): Promise<void> {
    const answer = z.object({ info: z.object({ error: z.unknown().optional() }).passthrough() }).passthrough()
      .parse(await this.request(`/session/${session}/message`, { model: { providerID: "fixture", modelID },
        parts: [{ type: "text", text: marker }] }));
    if (answer.info.error !== undefined) throw new SmokeFailure(`assistant error: ${JSON.stringify(answer.info.error)}`);
  }
  async dispose(): Promise<void> {
    const controller = new AbortController();
    const response = await fetch(new URL("/global/event", await this.ready.promise),
      { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]) });
    assert(response.ok && response.body, "global disposal event stream must be available");
    const events = response.body;
    const received = (async () => {
      let buffer = "";
      const decoder = new TextDecoder();
      for await (const chunk of events) {
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data:")) continue;
          const event = z.object({ payload: z.object({ type: z.string(), properties: z.object({ directory: z.string().optional() }).passthrough().optional() }) })
            .parse(JSON.parse(line.slice(5)));
          if (event.payload.type === "server.instance.disposed" && event.payload.properties?.directory === this.workspace) return;
        }
      }
      throw new SmokeFailure("event stream closed before instance disposal");
    })().then(() => ({ ok: true } as const), (error: unknown) => ({ ok: false, error } as const));
    try {
      // OpenCode v1.19.0 sends this response before teardown: server/routes/instance/httpapi/lifecycle.ts:20-28.
      await this.request("/instance/dispose", {});
      const result = await received;
      if (!result.ok) throw result.error;
    } finally { controller.abort(); }
  }
  async stop(): Promise<void> {
    if (this.child.exitCode === null) this.child.kill("SIGTERM");
    try { await bounded(this.child.exited, "host shutdown", 5_000); }
    catch (error) {
      if (!(error instanceof SmokeFailure)) throw error;
      this.child.kill("SIGKILL");
      await bounded(this.child.exited, "forced host shutdown", 5_000);
    }
    await Promise.all(this.streams);
  }
}
