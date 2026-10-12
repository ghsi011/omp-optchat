import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import plugin from "../src/opencode/index.ts";
import { Compressor, SCRATCH_MARKER } from "../src/opencode/compressor.ts";
import { optionsSchema } from "../src/opencode/options.ts";
import { SessionMemory } from "../src/opencode/session.ts";
import { admitHistory, projectHistory } from "../src/opencode/projection.ts";
import { Store } from "../src/store.ts";
import { assistant, fixture, user } from "./opencode-fixture.ts";

test("conflicting or reverted recovery cannot start a compressor and releases its lease", async () => {
  const root = await mkdtemp(join(tmpdir(), "optchat-recovery-admit-"));
  const api = fixture(root);
  const options = optionsSchema.parse({ directory: join(root, "memory"), nodeBytes: 128 });
  const compressor = new Compressor(api.host.client, 1_000);
  api.histories.set("s", [user("u")]);
  const initial = await SessionMemory.open({ id: "s", host: api.host, options, compressor });
  await initial.close();
  let store = await Store.open(initial.memory.store.directory);
  const records = projectHistory(admitHistory([user("u", "s", 1, "unfinished long history ".repeat(100))], "s"));
  for (const record of records) store.append(record.kind, record.text, record.date, record.metadata);
  await store.close();
  try {
    await expect(SessionMemory.open({ id: "s", host: api.host, options, compressor })).rejects.toThrow("conflicts");
    expect(api.prompts).toBe(0);
    expect(api.sessions.size).toBe(2);
    store = await Store.open(initial.memory.store.directory);
    await store.close();
    const info = api.sessions.get("s");
    if (!info) throw new Error("fixture session missing");
    info.revert = { messageID: "u" };
    await expect(SessionMemory.open({ id: "s", host: api.host, options, compressor })).rejects.toThrow("reverted");
    expect(api.prompts).toBe(0);
  } finally { compressor.close(); api.close(); await rm(root, { recursive: true, force: true }); }
});

test("canonical steering ahead of the host snapshot is captured without poisoning the live turn", async () => {
  const root = await mkdtemp(join(tmpdir(), "optchat-steering-admit-"));
  const api = fixture(root);
  const firstUser = user("u", "s", 1, "original model context ".repeat(100));
  const steering = user("steer", "s", 4);
  if (steering.info.role === "user") steering.info.model.modelID = "later-steering-model";
  api.histories.set("s", [firstUser, steering]);
  const options = optionsSchema.parse({ directory: join(root, "memory"), nodeBytes: 128 });
  const compressor = new Compressor(api.host.client, 1_000);
  const owner = await SessionMemory.open({ id: "s", host: api.host, options, compressor });
  try {
    const first = [structuredClone(firstUser)];
    await owner.transform(first);
    expect(first).toHaveLength(1);
    expect(api.requestedModels.length).toBeGreaterThan(0);
    expect(api.requestedModels.every((model) => JSON.stringify(model) === JSON.stringify({ providerID: "fixture", modelID: "default-user-model" }))).toBe(true);
    const next = [structuredClone(firstUser), steering];
    await owner.transform(next);
    expect(next).toHaveLength(2);
    expect(owner.memory.store.messages).toHaveLength(2);
  } finally { compressor.close(); await owner.close(); api.close(); await rm(root, { recursive: true, force: true }); }
});

test("a crash orphan before a new user fails closed without advancing inference or dropping tool results", async () => {
  const root = await mkdtemp(join(tmpdir(), "optchat-orphan-admit-"));
  const api = fixture(root);
  const tools = assistant("tools");
  if (tools.info.role === "assistant") tools.info.finish = "tool-calls";
  tools.parts = [{ type: "tool", id: "t", sessionID: "s", messageID: "tools", callID: "c", tool: "date",
    state: { status: "completed", input: { id: 0 }, output: "2026-01-01", title: "date", metadata: {}, time: { start: 2, end: 3 } } }];
  const orphan = assistant("orphan");
  if (orphan.info.role === "assistant") { delete orphan.info.time.completed; delete orphan.info.finish; }
  orphan.parts = [];
  const input = [user("u"), tools, orphan, user("resumed", "s", 4)];
  api.histories.set("s", structuredClone(input));
  const compressor = new Compressor(api.host.client, 1_000);
  const owner = await SessionMemory.open({ id: "s", host: api.host, options: optionsSchema.parse({ directory: join(root, "memory") }), compressor });
  try {
    const before = structuredClone(input);
    await expect(owner.transform(input)).rejects.toThrow("incomplete historical assistant");
    expect(input).toEqual(before);
    expect(owner.memory.store.messages.map((record) => record.kind)).toEqual(["user", "tool", "echo"]);
    expect(api.prompts).toBe(0);
  } finally { compressor.close(); await owner.close(); api.close(); await rm(root, { recursive: true, force: true }); }
});

test("tool admission suspended in an SDK lookup cannot open a store after disposal", async () => {
  const root = await mkdtemp(join(tmpdir(), "optchat-dispose-admit-"));
  const api = fixture(root);
  const gate = api.holdGet("s");
  const hooks = await plugin(api.host, { directory: join(root, "memory") });
  const date = hooks.tool?.date;
  if (!date) throw new Error("date tool missing");
  const request = date.execute({ id: 0 }, { sessionID: "s", messageID: "u", agent: "build", directory: root,
    worktree: root, abort: new AbortController().signal, metadata() {}, async ask() {} }).then(
      () => ({ status: "fulfilled" as const }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    );
  try {
    await gate.entered;
    await hooks.dispose?.();
    gate.release();
    const outcome = await request;
    if (outcome.status !== "rejected" || !(outcome.error instanceof Error)) throw new Error("expected admission rejection");
    expect(outcome.error.message).toContain("closing");
    expect(await readdir(root)).toEqual([]);
  } finally { gate.release(); api.close(); await rm(root, { recursive: true, force: true }); }
});

test("a title marker cannot authorize unowned child bypass or deletion", async () => {
  const root = await mkdtemp(join(tmpdir(), "optchat-child-admit-"));
  const api = fixture(root);
  const compressor = new Compressor(api.host.client, 1_000);
  try {
    const child = api.sessions.get("other");
    if (!child) throw new Error("fixture child missing");
    child.parentID = "s";
    expect(await compressor.bypass("other")).toBe(false);
    child.title = `${SCRATCH_MARKER} 01234567-0123-4567-89ab-0123456789ab`;
    await expect(compressor.bypass("other")).rejects.toThrow("unowned");
    expect(api.deleted).toHaveLength(0);
  } finally { compressor.close(); api.close(); await rm(root, { recursive: true, force: true }); }
});

test("a project symlink and a nested invocation reopen the same canonical session store", async () => {
  const root = await mkdtemp(join(tmpdir(), "optchat-project-admit-"));
  const project = join(root, "project");
  await mkdir(join(project, "nested"), { recursive: true });
  await symlink(project, join(root, "alias"));
  const api = fixture(project);
  api.histories.set("s", [user("u")]);
  const options = optionsSchema.parse({ directory: join(root, "memory") });
  const compressor = new Compressor(api.host.client, 1_000);
  const first = await SessionMemory.open({ id: "s", host: api.host, options, compressor });
  await first.transform([user("u")]);
  await first.close();
  const second = await SessionMemory.open({ id: "s", host: { ...api.host, worktree: join(root, "alias"), directory: join(project, "nested") }, options, compressor });
  try {
    expect(second.memory.store.directory).toBe(first.memory.store.directory);
    expect(second.memory.store.messages).toHaveLength(1);
  } finally { compressor.close(); await second.close(); api.close(); await rm(root, { recursive: true, force: true }); }
});
