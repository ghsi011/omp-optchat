import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Memory } from "../src/memory.ts";
import { Store } from "../src/store.ts";
import { deadline } from "../src/opencode/options.ts";
import { settledPrefix } from "../src/opencode/prefix.ts";

test("a settled leaf frontier waits for in-flight parent merges needed to fit the view", async () => {
  const root = await mkdtemp(join(tmpdir(), "optchat-parent-wait-"));
  const store = await Store.open(join(root, "chat"));
  const release = Promise.withResolvers<string>();
  let calls = 0;
  const memory = new Memory(store, async (_request, signal) => {
    calls++;
    return deadline(release.promise, signal);
  }, { nodeBytes: 64, viewBytes: 100 });
  try {
    for (let i = 0; i < 4; i++) memory.append("user", `${i} ${"x".repeat(45)}`);
    expect(await memory.settle()).toBe(true);
    expect(calls).toBeGreaterThan(0);
    expect(() => memory.renderPrefix(4)).toThrow("exceeds");
    let admitted = false;
    const waiting = settledPrefix(memory, 4, AbortSignal.timeout(2_000)).then((view) => { admitted = true; return view; });
    await Promise.resolve();
    expect(admitted).toBe(false);
    release.resolve("short merged history");
    const view = await waiting;
    expect(Buffer.byteLength(view)).toBeLessThanOrEqual(100);
    expect(view).not.toContain("not summarized");
  } finally { release.resolve("short"); await memory.close(); await store.close(); await rm(root, { recursive: true, force: true }); }
});

test("parent-merge waiting can be cancelled without dropping durable records", async () => {
  const root = await mkdtemp(join(tmpdir(), "optchat-parent-abort-"));
  const store = await Store.open(join(root, "chat"));
  const entered = Promise.withResolvers<void>();
  const memory = new Memory(store, async (_request, signal) => {
    entered.resolve();
    return deadline(new Promise<string>(() => undefined), signal);
  }, { nodeBytes: 64, viewBytes: 100 });
  try {
    for (let i = 0; i < 4; i++) memory.append("user", `${i} ${"x".repeat(45)}`);
    await entered.promise;
    expect(await memory.settle()).toBe(true);
    const controller = new AbortController();
    const waiting = settledPrefix(memory, 4, controller.signal).then(
      () => ({ status: "fulfilled" as const }), (error: unknown) => ({ status: "rejected" as const, error }),
    );
    await Promise.resolve();
    controller.abort();
    const outcome = await waiting;
    if (outcome.status !== "rejected" || !(outcome.error instanceof Error)) throw new Error("expected cancellation rejection");
    expect(outcome.error.message).toMatch(/cancelled|aborted/);
    expect(store.messages).toHaveLength(4);
  } finally { await memory.close(); await store.close(); await rm(root, { recursive: true, force: true }); }
});
