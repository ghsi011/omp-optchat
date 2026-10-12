import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tool } from "@opencode-ai/plugin";

const z = tool.schema;
export const protocol = {
  first: "OPTCHAT_FIXTURE_TURN_1", second: "OPTCHAT_FIXTURE_TURN_2",
  restart: "OPTCHAT_FIXTURE_TURN_3", complete: "OPTCHAT_FIXTURE_COMPLETE",
  restored: "OPTCHAT_FIXTURE_RESTORED", summary: "OPTCHAT_FIXTURE_SUMMARY",
  raw: "OPTCHAT_FIXTURE_ARCHIVE_KEY", reasoning: "OPTCHAT_FIXTURE_PRIVATE_REASONING",
} as const;
export const longReply = `${protocol.raw}\n${"archive-fixture-payload ".repeat(384)}\nOPTCHAT_FIXTURE_RAW_END`;
export const memoryTools = ["zoom", "chat_search", "date", "work"] as const;
const content = z.union([z.string(), z.array(z.object({ type: z.string(), text: z.string().optional() }).passthrough()), z.null()]);
const wireMessage = z.object({ role: z.string(), content: content.optional(), tool_call_id: z.string().optional() }).passthrough();
const wireRequest = z.object({
  model: z.string(), messages: z.array(wireMessage),
  max_tokens: z.number().int().positive().optional(),
  tools: z.array(z.object({ function: z.object({ name: z.string() }).passthrough() }).passthrough()).optional(),
}).passthrough();
type WireRequest = ReturnType<typeof wireRequest.parse>;
type WireMessage = ReturnType<typeof wireMessage.parse>;
const diskRecord = z.object({ i: z.number().int(), kind: z.string(), text: z.string(), date: z.string(),
  metadata: z.object({ source: z.object({ sessionID: z.string() }).passthrough() }).passthrough().optional(),
}).passthrough();
export const canonical = z.array(z.object({
  info: z.object({ id: z.string(), role: z.string() }).passthrough(),
  parts: z.array(z.object({ type: z.string(), text: z.string().optional(), tool: z.string().optional(),
    callID: z.string().optional(), state: z.object({ status: z.string(), output: z.string().optional() }).passthrough().optional(),
  }).passthrough()),
}));

function text(message: WireMessage): string {
  if (typeof message.content === "string") return message.content;
  return message.content?.map((part) => part.text ?? "").join("\n") ?? "";
}

export async function archive(directory: string, sessionID?: string) {
  const records: ReturnType<typeof diskRecord.parse>[] = [];
  let mergedNodes = 0;
  for (const entry of await readdir(directory, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    const data = await readFile(join(entry.parentPath, entry.name), "utf8");
    assert(!data.includes(protocol.reasoning), "reasoning must not enter durable memory");
    for (const line of data.split("\n").filter(Boolean)) {
      const value: unknown = JSON.parse(line);
      const record = diskRecord.safeParse(value);
      if (record.success && (!sessionID || record.data.metadata?.source.sessionID === sessionID)) records.push(record.data);
      const node = z.object({ l: z.number(), i: z.number(), text: z.string() }).safeParse(value);
      if (node.success && node.data.l > 0) mergedNodes++;
    }
  }
  return { records, mergedNodes };
}

type Call = { readonly name: string; readonly args: Readonly<Record<string, string | number>> };

function sse(model: string, answer: { readonly text?: string; readonly calls?: readonly Call[]; readonly reasoning?: string }): Response {
  const chunks = [];
  const base = { id: "fixture-response", object: "chat.completion.chunk", created: 1, model };
  chunks.push({ ...base, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] });
  if (answer.reasoning) chunks.push({ ...base, choices: [{ index: 0, delta: { reasoning_content: answer.reasoning }, finish_reason: null }] });
  if (answer.text) chunks.push({ ...base, choices: [{ index: 0, delta: { content: answer.text }, finish_reason: null }] });
  if (answer.calls) chunks.push({ ...base, choices: [{ index: 0, delta: { tool_calls: answer.calls.map((call, index) => ({
    index, id: `fixture-${call.name}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args) },
  })) }, finish_reason: null }] });
  chunks.push({ ...base, choices: [{ index: 0, delta: {}, finish_reason: answer.calls ? "tool_calls" : "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
  return new Response(`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`,
    { headers: { "content-type": "text/event-stream" } });
}

export class Fixture {
  readonly requests: (WireRequest & { readonly sessionID: string; readonly parentID: string | null })[] = [];
  readonly errors: string[] = [];
  readonly compactStarted = Promise.withResolvers<void>();
  readonly compactRelease = Promise.withResolvers<void>();
  readonly gates = new Map<string, { readonly started: PromiseWithResolvers<void>; readonly release: PromiseWithResolvers<void> }>();
  failureSession: string | undefined;
  forcedFailures = 0;
  targetID = 1;
  hold(phase: "compact" | "reply", sessionID: string) {
    const gate = { started: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() };
    this.gates.set(`${phase}:${sessionID}`, gate);
    return gate;
  }
  async wait(phase: "compact" | "reply", sessionID: string): Promise<void> {
    const gate = this.gates.get(`${phase}:${sessionID}`);
    if (!gate) return;
    gate.started.resolve();
    await gate.release.promise;
  }
  readonly server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async (request) => {
    try {
      assert.equal(new URL(request.url).pathname, "/v1/chat/completions");
      assert.equal(request.method, "POST");
      const body = wireRequest.parse(await request.json());
      const sessionID = request.headers.get("x-opencode-session-id");
      const parentID = request.headers.get("x-opencode-parent-session-id");
      assert(sessionID, "real host inference must identify its session");
      this.requests.push({ ...body, sessionID, parentID });
      return await this.answer(body, sessionID, parentID);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      this.errors.push(error.message);
      return Response.json({ error: { message: error.message, type: "fixture_assertion" } }, { status: 400 });
    }
  } });

  private async answer(body: WireRequest, sessionID: string, parentID: string | null): Promise<Response> {
    assert(!JSON.stringify(body).includes(protocol.reasoning), "private reasoning must not reach later model calls");
    if (body.model === "compact") {
      assert(parentID, "only a parented compressor session may call the compact model");
      assert(body.max_tokens !== undefined && body.max_tokens <= 4_096, "compressor must reserve a bounded output allocation");
      assert.equal(body.tools?.length ?? 0, 0, "scratch compactor must have no executable tools");
      this.compactStarted.resolve();
      await this.compactRelease.promise;
      await this.wait("compact", parentID);
      if (parentID === this.failureSession) {
        this.forcedFailures++;
        return Response.json({ error: { message: "OPTCHAT_FIXTURE_COMPACTOR_FAILED", type: "fixture_failure" } }, { status: 400 });
      }
      return sse(body.model, { text: protocol.summary });
    }
    assert.equal(body.model, "chat", "only synthetic provider models may run");
    const names = body.tools?.map((entry) => entry.function.name) ?? [];
    for (const name of memoryTools) assert(names.includes(name), `missing real memory tool: ${name}`);
    const marker = body.messages.filter((message) => message.role === "user").map(text)
      .findLast((value) => [protocol.first, protocol.second, protocol.restart].some((item) => value.includes(item)));
    assert(marker, "current turn protocol marker required");
    const current = [protocol.first, protocol.second, protocol.restart].findLast((item) => marker.includes(item));
    assert(current);
    if (current === protocol.first) return sse(body.model, { text: longReply, reasoning: protocol.reasoning });
    const results = body.messages.filter((message) => message.role === "tool");
    const context = body.messages.filter((message) => message.role !== "tool").map(text).join("\n");
    assert(context.includes(protocol.summary), "completed history must be represented by the compressed tree");
    assert(!context.includes(longReply), "old long reply must not remain in raw model context");
    const rawSuffix = context.replace(/<chat>[\s\S]*?<\/chat>/g, "");
    assert(!rawSuffix.includes(protocol.first), "prior user belongs only in the history view");
    assert.equal(rawSuffix.split(current).length - 1, 1, "current raw user must appear exactly once outside the view");
    assert.equal(body.messages.filter((message) => message.role === "assistant" && text(message).includes(protocol.raw)).length, 0);
    if (current === protocol.restart) return sse(body.model, { text: protocol.restored });
    if (results.length === 0) return sse(body.model, { calls: [
      { name: "zoom", args: { id: this.targetID, n: 1 } },
      { name: "chat_search", args: { query: protocol.raw } },
      { name: "date", args: { id: this.targetID } },
      { name: "work", args: {} },
    ] });
    for (const name of memoryTools) assert(results.some((message) => message.tool_call_id === `fixture-${name}`), `missing wire result: ${name}`);
    const zoom = results.find((message) => message.tool_call_id === "fixture-zoom");
    assert(zoom && text(zoom).includes(protocol.raw), "real zoom must retrieve durable original bytes");
    const search = results.find((message) => message.tool_call_id === "fixture-chat_search");
    assert(search && text(search).includes(protocol.raw), "real search must find durable raw content");
    await this.wait("reply", sessionID);
    return sse(body.model, { text: protocol.complete });
  }
}
