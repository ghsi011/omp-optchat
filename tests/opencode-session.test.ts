import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import plugin from "../src/opencode/index.ts";
import { Compressor } from "../src/opencode/compressor.ts";
import { optionsSchema } from "../src/opencode/options.ts";
import { SessionMemory, reconcile } from "../src/opencode/session.ts";
import { admitHistory, projectHistory } from "../src/opencode/projection.ts";
import { Memory } from "../src/memory.ts";
import { Store } from "../src/store.ts";
import { assistant, fixture, user } from "./opencode-fixture.ts";

test("durable partial tool capture converges after crash and rejects changed prefixes", async () => {
  const root = await mkdtemp(join(tmpdir(), "optchat-replay-"));
  let store = await Store.open(join(root, "chat"));
  const a = assistant("a");
  a.parts.push({ type: "tool", id: "tool", messageID: "a", sessionID: "s", tool: "bash", callID: "call",
    state: { status: "error", input: { command: "false" }, error: "exit 1", time: { start: 2, end: 3 } } });
  const records = projectHistory(admitHistory([user("u"), a], "s"));
  for (const record of records.slice(0, -1)) store.append(record.kind, record.text, record.date, record.metadata);
  await store.close();
  store = await Store.open(join(root, "chat"));
  const memory = new Memory(store, async () => "summary");
  try {
    reconcile(memory, records);
    reconcile(memory, records);
    expect(store.messages).toHaveLength(4);
    expect(store.messages.at(-1)?.metadata?.source?.slot).toBe("result");
    expect(() => reconcile(memory, records.slice(1))).toThrow("removed");
    expect(() => reconcile(memory, records.map((record, i) => i === 0 ? { ...record, text: "changed" } : record))).toThrow("conflicts");
    expect(() => reconcile(memory, [...records].reverse())).toThrow("conflicts");
  } finally { await memory.close(); await store.close(); await rm(root, { recursive: true, force: true }); }
});

test("restart compresses unfinished durable work using the persisted user model", async () => {
  const root = await mkdtemp(join(tmpdir(), "optchat-session-"));
  const api = fixture(root);
  const options = optionsSchema.parse({ directory: join(root, "memory"), nodeBytes: 128, viewBytes: 1024, compressionTimeoutMs: 2_000 });
  const compressor = new Compressor(api.host.client, options.compressionTimeoutMs);
  api.histories.set("s", [user("u"), assistant("a", "s", "u", "very long public answer ".repeat(100)), user("next", "s", 4)]);
  let owner = await SessionMemory.open({ id: "s", host: api.host, options, compressor });
  const directory = owner.memory.store.directory;
  await owner.close();
  const store = await Store.open(directory);
  for (const record of projectHistory(admitHistory(api.histories.get("s"), "s"))) store.append(record.kind, record.text, record.date, record.metadata);
  await store.close();
  owner = await SessionMemory.open({ id: "s", host: api.host, options, compressor });
  try {
    const input = structuredClone(api.histories.get("s") ?? []);
    await owner.transform(input);
    expect(api.prompts).toBeGreaterThan(0);
    expect(api.requestedModels).toContainEqual({ providerID: "fixture", modelID: "default-user-model" });
    expect(input.at(-1)?.info.id).toBe("next");
    expect(JSON.stringify(input[0])).not.toContain("very long public answer");
    const count = owner.memory.store.messages.length;
    await owner.refresh();
    expect(owner.memory.store.messages).toHaveLength(count);
    expect(api.deleted.every((id) => id.startsWith("child-"))).toBe(true);
    for (const id of api.deleted) expect(compressor.owned.has(id)).toBe(false);
  } finally { compressor.close(); await owner.close(); api.close(); await rm(root, { recursive: true, force: true }); }
});

test("swallowed config errors still block transforms and disabled mode has no hooks", async () => {
  const root = await mkdtemp(join(tmpdir(), "optchat-config-"));
  const api = fixture(root);
  try {
    const hooks = await plugin(api.host, { directory: join(root, "memory") });
    await expect(hooks.config?.({ agent: { "optchat-compressor": {} } })).rejects.toThrow("reserved");
    const input = [user("u")];
    const before = structuredClone(input);
    await expect(hooks["experimental.chat.messages.transform"]?.({}, { messages: input })).rejects.toThrow("reserved");
    expect(input).toEqual(before);
    expect(await plugin(api.host, { directory: join(root, "memory"), enabled: false })).toEqual({});
    const invalid = await plugin(api.host, { directory: "relative", viewBytes: "oops" });
    await expect(invalid["experimental.chat.messages.transform"]?.({}, { messages: input })).rejects.toThrow("invalid plugin options");
  } finally { api.close(); await rm(root, { recursive: true, force: true }); }
});

test("dispose captures the final answer even when no idle callback was delivered", async () => {
  const root = await mkdtemp(join(tmpdir(), "optchat-dispose-"));
  const api = fixture(root);
  api.histories.set("s", [user("u")]);
  const options = optionsSchema.parse({ directory: join(root, "memory") });
  const compressor = new Compressor(api.host.client, 1_000);
  const owner = await SessionMemory.open({ id: "s", host: api.host, options, compressor });
  try {
    await owner.transform([user("u")]);
    api.histories.set("s", [user("u"), assistant("final", "s", "u", "final answer sentinel")]);
    await owner.close(true);
    await owner.close(true);
    const store = await Store.open(owner.memory.store.directory);
    try { expect(store.messages.at(-1)?.text).toBe("final answer sentinel"); } finally { await store.close(); }
  } finally { compressor.close(); await owner.close(); api.close(); await rm(root, { recursive: true, force: true }); }
});

test("summary timeout keeps input intact and another ordinary session progresses", async () => {
  const root = await mkdtemp(join(tmpdir(), "optchat-timeout-"));
  const api = fixture(root);
  api.hang = true;
  api.histories.set("s", [user("u"), assistant("a", "s", "u", "long history ".repeat(100)), user("next", "s", 4)]);
  api.histories.set("other", [user("u-other", "other")]);
  const options = optionsSchema.parse({ directory: join(root, "memory"), compressionTimeoutMs: 100, nodeBytes: 128 });
  const compressor = new Compressor(api.host.client, options.compressionTimeoutMs);
  const a = await SessionMemory.open({ id: "s", host: api.host, options, compressor });
  const b = await SessionMemory.open({ id: "other", host: api.host, options, compressor });
  try {
    const input = structuredClone(api.histories.get("s") ?? []);
    const before = structuredClone(input);
    const start = Date.now();
    const stalled = a.transform(input);
    await b.transform([user("u-other", "other")]);
    await expect(stalled).rejects.toThrow("timed out");
    expect(Date.now() - start).toBeLessThan(2_000);
    expect(input).toEqual(before);
    expect(b.memory.store.messages).toHaveLength(1);
  } finally { compressor.close(); await a.close(); await b.close(); api.close(); await rm(root, { recursive: true, force: true }); }
});

test("active source groups cannot disappear from model context", async () => {
  const root = await mkdtemp(join(tmpdir(), "optchat-raw-loop-"));
  const api = fixture(root);
  const a = assistant("a");
  if (a.info.role === "assistant") a.info.finish = "tool-calls";
  api.histories.set("s", [user("u"), a, user("steer", "s", 4)]);
  const options = optionsSchema.parse({ directory: join(root, "memory") });
  const compressor = new Compressor(api.host.client, 1_000);
  const owner = await SessionMemory.open({ id: "s", host: api.host, options, compressor });
  try {
    const input = [user("u"), user("steer", "s", 4)];
    await expect(owner.transform(input)).rejects.toThrow("incomplete");
    expect(input).toHaveLength(2);
  } finally { compressor.close(); await owner.close(); api.close(); await rm(root, { recursive: true, force: true }); }
});
