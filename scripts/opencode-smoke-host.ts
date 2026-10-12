import assert from "node:assert/strict";
import { join } from "node:path";
import { OpenCode, type OpenCodeClient, type SessionMessageInfo } from "@opencode/client";
import { Service } from "@opencode/client/service";

export class SmokeFailure extends Error {
  override readonly name = "OpenCodeSmokeFailure";
  constructor(message: string, readonly outcome?: "failed" | "interrupted") { super(message); }
}
export function observed<T>(task: Promise<T>) {
  return task.then((value) => ({ ok: true, value } as const), (error: unknown) => ({ ok: false, error } as const));
}
export async function refused(task: Promise<unknown>, label: string): Promise<string> {
  const result = await observed(task);
  if (result.ok) assert.fail(`${label} must reject`);
  if (!(result.error instanceof SmokeFailure)) throw result.error;
  assert.equal(result.error.outcome, "failed", `${label} must have a native failed outcome`);
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
export async function eventually(predicate: () => Promise<boolean>, label: string, milliseconds = 5_000): Promise<void> {
  const until = performance.now() + milliseconds;
  while (performance.now() < until) {
    if (await predicate()) return;
    await Bun.sleep(10);
  }
  throw new SmokeFailure(`${label} timed out`);
}

export class Host {
  readonly child: Bun.Subprocess<"ignore", "pipe", "pipe">;
  readonly ready: Promise<OpenCodeClient>;
  diagnostics = "";
  readonly streams: readonly Promise<void>[];
  constructor(executable: string, readonly workspace: string, env: NodeJS.ProcessEnv) {
    const state = env.XDG_STATE_HOME;
    assert(state, "host state directory must be explicitly isolated");
    this.child = Bun.spawn([executable, "--log-level=debug", "--print-logs", "serve", "--service", "--hostname=127.0.0.1", "--port=0"],
      { cwd: workspace, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    this.streams = [this.consume(this.child.stdout), this.consume(this.child.stderr)];
    this.ready = this.connect(join(state, "opencode", "service.json"));
  }
  private async connect(file: string): Promise<OpenCodeClient> {
    const limit = performance.now() + 30_000;
    while (performance.now() < limit) {
      if (this.child.exitCode !== null) throw new SmokeFailure(`host exited before ready: ${this.child.exitCode}`);
      const endpoint = await Service.discover({ file, version: "2.0.27" });
      if (endpoint) {
        assert.equal(new URL(endpoint.url).hostname, "127.0.0.1", "test host must listen only on loopback");
        return OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) });
      }
      await Bun.sleep(50);
    }
    throw new SmokeFailure(`host startup timed out: ${this.diagnostics}`);
  }
  private async consume(stream: ReadableStream<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder();
    for await (const chunk of stream) this.diagnostics = (this.diagnostics + decoder.decode(chunk, { stream: true })).slice(-32_768);
  }
  async create(title = "OptChat smoke", modelID = "chat") {
    return (await this.ready).session.create({ title, location: { directory: this.workspace }, model: { providerID: "fixture", id: modelID } });
  }
  async history(sessionID: string): Promise<SessionMessageInfo[]> {
    const client = await this.ready;
    const messages: SessionMessageInfo[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.message.list({ sessionID, limit: 200, ...(cursor ? { cursor } : { order: "asc" }) });
      messages.push(...page.data);
      cursor = page.cursor.next ?? undefined;
    } while (cursor);
    return messages;
  }
  async settle(sessionID: string, after: number): Promise<void> {
    const client = await this.ready;
    await client.session.wait({ sessionID }, { signal: AbortSignal.timeout(90_000) });
    const tail = (await this.history(sessionID)).slice(after);
    const idle = tail.findLast((message) => message.type === "idle");
    if (!idle || idle.type !== "idle") throw new SmokeFailure("host became inactive without an idle marker");
    if (idle.outcome !== "succeeded") throw new SmokeFailure(`turn ${idle.outcome}: ${idle.error?.message ?? "no error detail"}`, idle.outcome);
    const failure = tail.find((message) => message.type === "assistant" && message.error);
    if (failure?.type === "assistant") throw new SmokeFailure(`assistant error: ${JSON.stringify(failure.error)}`);
  }
  async prompt(sessionID: string, text: string, modelID = "chat"): Promise<void> {
    const client = await this.ready;
    const before = (await this.history(sessionID)).length;
    const session = await client.session.get({ sessionID });
    if (session.model?.id !== modelID) await client.session.switchModel({ sessionID, model: { providerID: "fixture", id: modelID } });
    await client.session.prompt({ sessionID, text });
    await this.settle(sessionID, before);
  }
  async compact(sessionID: string): Promise<void> {
    const before = (await this.history(sessionID)).length;
    await (await this.ready).session.compact({ sessionID });
    await this.settle(sessionID, before);
  }
  async interrupt(sessionID: string): Promise<void> {
    assert.equal((await (await this.ready).session.interrupt({ sessionID })).interrupted, true);
  }
  async stop(signal: "SIGTERM" | "SIGKILL" = "SIGTERM"): Promise<void> {
    if (this.child.exitCode === null) this.child.kill(signal);
    try { await bounded(this.child.exited, "host shutdown", 5_000); }
    catch (error) {
      if (!(error instanceof SmokeFailure)) throw error;
      this.child.kill("SIGKILL");
      await bounded(this.child.exited, "forced host shutdown", 5_000);
    }
    await Promise.all(this.streams);
  }
}
