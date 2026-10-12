import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseMetadata } from "../src/archive.ts";
import { Memory } from "../src/memory.ts";
import { exportJsonl, importHistory } from "../src/history.ts";
import { Store } from "../src/store.ts";

const source = { host: "opencode", sessionID: "s1", messageID: "m1", partID: "p1", slot: "text" } as const;

test("source identity survives durable replay and rejects unknown fields", async () => {
  expect(parseMetadata({ source })).toEqual({ source });
  expect(() => parseMetadata({ source: { ...source, extra: true } })).toThrow();
  expect(() => parseMetadata({ source: { ...source, partID: "" } })).toThrow();
  const root = await mkdtemp(join(tmpdir(), "optchat-source-"));
  let store = await Store.open(join(root, "chat"));
  try {
    store.append("user", "same payload", new Date(0), { source });
    await store.close();
    store = await Store.open(join(root, "chat"));
    expect(store.messages[0]?.metadata).toEqual({ source });
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("source metadata roundtrips through history export and import", async () => {
  const root = await mkdtemp(join(tmpdir(), "optchat-import-source-"));
  const first = await Store.open(join(root, "first"));
  const second = await Store.open(join(root, "second"));
  const a = new Memory(first, async () => "summary");
  const b = new Memory(second, async () => "summary");
  try {
    a.append("user", "archived user", new Date(0), { source });
    expect(importHistory(b, exportJsonl(a))).toBe(1);
    expect(second.messages[0]?.metadata?.source).toEqual(source);
  } finally {
    await a.close(); await b.close(); await first.close(); await second.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("prefix rejects unbuilt summaries and counts rendered envelope bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "optchat-prefix-bound-"));
  const store = await Store.open(join(root, "chat"));
  const memory = new Memory(store, async () => { throw new Error("fixture compression fails"); }, { nodeBytes: 32, viewBytes: 20 });
  try {
    memory.append("user", "long raw sentinel ".repeat(50));
    expect(() => memory.renderPrefix(1)).toThrow("not summarized");
    store.saveNode({ l: 0, i: 0, text: "short", size: 5 });
    expect(() => memory.renderPrefix(1)).toThrow("exceeds viewBytes");
  } finally { await memory.close(); await store.close(); await rm(root, { recursive: true, force: true }); }
});

test("prefix rendering splits a merged boundary without leaking its suffix", async () => {
  const root = await mkdtemp(join(tmpdir(), "optchat-prefix-"));
  const store = await Store.open(join(root, "chat"));
  for (let i = 0; i < 8; i++) {
    store.append("user", `record ${i}`);
    store.saveNode({ l: 0, i, text: `leaf-${i}`, size: 6 });
  }
  for (let l = 1; l <= 3; l++) {
    for (let i = 0; (i + 1) * 2 ** l <= 8; i++) {
      store.saveNode({ l, i, text: `merged-${l}-${i}`, size: 10 });
    }
  }
  store.saveView({ version: 2, length: 8, parts: [[3, 0]], compacting: false,
    compactor: { length: 8, parts: [[3, 0]], compacting: false } });
  const memory = new Memory(store, async () => "unused", { viewBytes: 100 });
  try {
    const before = memory.render();
    expect(memory.renderPrefix(5)).toBe("<chat>\n0+4|merged-2-0\n4+1|leaf-4\n</chat>");
    expect(memory.render()).toBe(before);
    expect(memory.renderPrefix(0)).toBe("<chat>\n</chat>");
    expect(() => memory.renderPrefix(9)).toThrow();
  } finally {
    await memory.close();
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
