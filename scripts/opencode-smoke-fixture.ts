import assert from "node:assert/strict";
import { readdir, readFile, watch } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Schema } from "effect";

export const protocol = {
  first: "OPTCHAT_FIXTURE_TURN_1", second: "OPTCHAT_FIXTURE_TURN_2",
  restart: "OPTCHAT_FIXTURE_TURN_3", complete: "OPTCHAT_FIXTURE_COMPLETE",
  restored: "OPTCHAT_FIXTURE_RESTORED", summary: "OPTCHAT_FIXTURE_SUMMARY",
  raw: "OPTCHAT_FIXTURE_ARCHIVE_KEY", reasoning: "OPTCHAT_FIXTURE_PRIVATE_REASONING",
  title: "OptChat native title fixture",
  recovery: "The server restarted while you were working. Continue from where you left off without repeating completed work.",
} as const;
export const longReply = `${protocol.raw}\n${"archive-fixture-payload ".repeat(384)}\nOPTCHAT_FIXTURE_RAW_END`;
export const memoryTools = ["zoom", "chat_search", "date", "work"] as const;
const content = Schema.Union([Schema.String, Schema.Array(Schema.Struct({ type: Schema.String, text: Schema.optional(Schema.String) })), Schema.Null]);
const wireMessage = Schema.Struct({ role: Schema.String, content: Schema.optional(content), tool_call_id: Schema.optional(Schema.String),
  tool_calls: Schema.optional(Schema.Array(Schema.Struct({ id: Schema.String,
    function: Schema.Struct({ name: Schema.String, arguments: Schema.String }) }))),
});
const wireRequest = Schema.Struct({
  model: Schema.String, messages: Schema.Array(wireMessage), stream: Schema.optional(Schema.Boolean),
  max_tokens: Schema.optional(Schema.Number), max_completion_tokens: Schema.optional(Schema.Number),
  tools: Schema.optional(Schema.Array(Schema.Struct({ function: Schema.Struct({ name: Schema.String,
    description: Schema.optional(Schema.String), parameters: Schema.optional(Schema.Unknown) }) }))),
});
type WireRequest = typeof wireRequest.Type;
type WireMessage = typeof wireMessage.Type;
const diskRecord = Schema.Struct({ i: Schema.Number, kind: Schema.String, text: Schema.String, date: Schema.String,
  metadata: Schema.optional(Schema.Struct({ source: Schema.Struct({ host: Schema.String, sessionID: Schema.String,
    messageID: Schema.String, partID: Schema.String, slot: Schema.String }) })),
});
const parseRecord = Schema.decodeUnknownOption(diskRecord);
const parseNode = Schema.decodeUnknownOption(Schema.Struct({ l: Schema.Number, i: Schema.Number, text: Schema.String }));

function text(message: WireMessage): string {
  if (typeof message.content === "string") return message.content;
  return message.content?.map((part) => part.text ?? "").join("\n") ?? "";
}

export async function archive(directory: string, sessionID?: string) {
  const records: (typeof diskRecord.Type)[] = [];
  const sessions = new Set<string>();
  const merged = new Map<string, number>();
  for (const entry of await readdir(directory, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    const data = await readFile(join(entry.parentPath, entry.name), "utf8");
    assert(!data.includes(protocol.reasoning), "reasoning must not enter durable memory");
    const scope = dirname(entry.parentPath);
    for (const line of data.split("\n").slice(0, -1).filter(Boolean)) {
      const value: unknown = JSON.parse(line);
      const record = parseRecord(value);
      if (record._tag === "Some" && (!sessionID || record.value.metadata?.source.sessionID === sessionID)) {
        records.push(record.value);
        sessions.add(scope);
      }
      const node = parseNode(value);
      if (node._tag === "Some" && node.value.l > 0) merged.set(scope, (merged.get(scope) ?? 0) + 1);
    }
  }
  return { records, mergedNodes: [...merged].filter(([scope]) => !sessionID || sessions.has(scope)).reduce((count, [, nodes]) => count + nodes, 0) };
}

export async function waitForArchive(memory: string, marker: string, sessionID: string) {
  const controller = new AbortController();
  const changes = watch(memory, { recursive: true, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]) })[Symbol.asyncIterator]();
  try {
    for (;;) {
      const current = await archive(memory, sessionID);
      if (current.records.some((record) => record.text === marker)) return current;
      await changes.next();
    }
  } finally { controller.abort(); }
}

type Call = { readonly name: string; readonly args: Readonly<Record<string, string | number>> };

function response(body: WireRequest, answer: { readonly text?: string; readonly calls?: readonly Call[]; readonly reasoning?: string }): Response {
  const model = body.model;
  if (!body.stream) return Response.json({ id: "fixture-response", object: "chat.completion", created: 1, model,
    choices: [{ index: 0, message: { role: "assistant", content: answer.text ?? "" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
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
  readonly requests: (WireRequest & { readonly sessionID: string; readonly inputBytes: number; readonly systemBytes: number; readonly toolBytes: number })[] = [];
  readonly errors: string[] = [];
  readonly gates = new Map<string, { readonly started: PromiseWithResolvers<void>; readonly release: PromiseWithResolvers<void> }>();
  readonly releases: PromiseWithResolvers<void>[] = [];
  failCompression = false;
  forcedFailures = 0;
  targetID = 1;
  mainCalls(sessionID: string) { return this.requests.filter((request) => ["chat", "near"].includes(request.model) && request.sessionID === sessionID); }
  releaseAll(): void { for (const release of this.releases) release.resolve(); }
  hold(phase: "compact" | "reply", sessionID = "next") {
    const gate = { started: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() };
    this.releases.push(gate.release);
    this.gates.set(`${phase}:${sessionID}`, gate);
    return gate;
  }
  async wait(phase: "compact" | "reply", sessionID: string): Promise<void> {
    const gate = this.gates.get(`${phase}:${sessionID}`);
    if (!gate) return;
    this.gates.delete(`${phase}:${sessionID}`);
    gate.started.resolve();
    await gate.release.promise;
  }
  readonly server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async (request) => {
    try {
      assert.equal(new URL(request.url).pathname, "/v1/chat/completions");
      assert.equal(request.method, "POST");
      const raw: unknown = await request.json();
      const body = Schema.decodeUnknownSync(wireRequest)(raw);
      const sessionID = request.headers.get("x-opencode-session-id") ?? request.headers.get("x-opencode-session");
      assert(sessionID, "real host inference must identify its session");
      this.requests.push({ ...body, sessionID, inputBytes: Buffer.byteLength(JSON.stringify(raw)),
        systemBytes: Buffer.byteLength(body.messages.filter((message) => message.role === "system").map(text).join("\n")),
        toolBytes: Buffer.byteLength(JSON.stringify(body.tools ?? [])) });
      return await this.answer(body, sessionID);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      this.errors.push(error.message);
      return Response.json({ error: { message: error.message, type: "fixture_assertion" } }, { status: 400 });
    }
  } });

  private async answer(body: WireRequest, sessionID: string): Promise<Response> {
    assert(!JSON.stringify(body).includes(protocol.reasoning), "private reasoning must not reach later model calls");
    if (body.model === "title") {
      assert.equal(body.tools?.length ?? 0, 0, "native title must have no executable tools");
      return response(body, { text: protocol.title });
    }
    if (body.model === "compact") {
      assert.equal(body.tools?.length ?? 0, 0, "stateless compressor must have no executable tools");
      await this.wait("compact", "next");
      if (this.failCompression) {
        this.forcedFailures++;
        return Response.json({ error: { message: "OPTCHAT_FIXTURE_COMPACTOR_FAILED", type: "fixture_failure" } }, { status: 400 });
      }
      return response(body, { text: protocol.summary });
    }
    assert.equal(body.model, "chat", "only synthetic provider models may run");
    const names = body.tools?.map((entry) => entry.function.name) ?? [];
    for (const name of memoryTools) assert(names.includes(name), `missing real memory tool: ${name}`);
    const marker = body.messages.filter((message) => message.role === "user").map(text)
      .findLast((value) => [protocol.first, protocol.second, protocol.restart].some((item) => value.includes(item)));
    assert(marker, "current turn protocol marker required");
    const current = [protocol.first, protocol.second, protocol.restart].findLast((item) => marker.includes(item));
    assert(current);
    if (current === protocol.first) return response(body, { text: longReply, reasoning: protocol.reasoning });
    const results = body.messages.filter((message) => message.role === "tool");
    const context = body.messages.filter((message) => message.role !== "tool").map(text).join("\n");
    assert(context.includes(protocol.summary), "completed history must be represented by the compressed tree");
    assert(!context.includes(longReply), "old long reply must not remain in raw model context");
    const rawSuffix = context.replace(/<chat>[\s\S]*?<\/chat>/g, "");
    assert(!rawSuffix.includes(protocol.first), "prior user belongs only in the history view");
    assert.equal(rawSuffix.split(current).length - 1, 1, "current raw user must appear exactly once outside the view");
    assert.equal(body.messages.filter((message) => message.role === "assistant" && text(message).includes(protocol.raw)).length, 0);
    if (current === protocol.restart) return response(body, { text: protocol.restored });
    if (results.length === 0) return response(body, { calls: [
      { name: "zoom", args: { id: this.targetID, n: 1 } },
      { name: "chat_search", args: { query: protocol.raw } },
      { name: "date", args: { id: this.targetID } },
      { name: "work", args: {} },
    ] });
    const calls = body.messages.flatMap((message) => message.tool_calls ?? []);
    for (const name of memoryTools) {
      assert.equal(calls.filter((call) => call.id === `fixture-${name}` && call.function.name === name).length, 1,
        `exactly one wire call required: ${name}`);
      assert.equal(results.filter((message) => message.tool_call_id === `fixture-${name}`).length, 1,
        `exactly one wire result required: ${name}`);
    }
    const zoom = results.find((message) => message.tool_call_id === "fixture-zoom");
    assert(zoom, "real zoom result must be present");
    const page = Schema.decodeUnknownSync(Schema.Struct({ text: Schema.String }))(JSON.parse(text(zoom)));
    assert.equal(page.text, longReply, "real zoom must retrieve every original byte of the archived reply");
    const search = results.find((message) => message.tool_call_id === "fixture-chat_search");
    assert(search && text(search).includes(protocol.raw), "real search must find durable raw content");
    await this.wait("reply", sessionID);
    return response(body, { text: protocol.complete });
  }
}
