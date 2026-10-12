import { expect, test } from "bun:test";
import { Session } from "@opencode/schema/session";
import { deadline } from "../src/opencode/options.ts";
import { SessionMemory } from "../src/opencode/session.ts";
import { context, fixture, idle, limits, model, prompt, user } from "./opencode-fixture.ts";

test("a compressor deadline fails admission without mutating the parent draft", async () => {
  const entered = Promise.withResolvers<void>();
  const aborted = Promise.withResolvers<void>();
  const f = await fixture([]);
  const id = Session.ID.make("ses_timeout");
  const long = "pending raw history ".repeat(100);
  const owner = await SessionMemory.open({ id, model, options: { ...f.options, compressionTimeoutMs: 1_000 }, host: {
    ...f.host, history: async () => [user("long", long), idle(), user("current")],
    generate: async (_input, signal) => {
      entered.resolve(); signal.addEventListener("abort", () => aborted.resolve(), { once: true });
      return deadline(new Promise<string>(() => undefined), signal);
    },
  } });
  try {
    const event = { ...context([prompt("long", long), prompt("current")]), sessionID: id };
    const original = JSON.stringify(event);
    const result = owner.transform(event, limits, new AbortController().signal).then(
      () => undefined, (error: unknown) => error,
    );
    await deadline(entered.promise, AbortSignal.timeout(5_000));
    expect(await deadline(result, AbortSignal.timeout(5_000))).toMatchObject({ message: expect.stringMatching(/failed|timed out/) });
    await deadline(aborted.promise, AbortSignal.timeout(5_000));
    expect(JSON.stringify(event)).toBe(original);
    expect(owner.store.messages[0]?.text).toBe(long);
  } finally { await owner.close(); await f.close(); }
}, 10_000);

test("queued cancellation never runs admission and leaves the session reusable", async () => {
  const f = await fixture([user("current")]);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  try {
    const blocking = f.owner.run(async () => { entered.resolve(); await release.promise; });
    await entered.promise;
    const controller = new AbortController();
    const event = context([prompt("current")]);
    const original = JSON.stringify(event);
    const waiting = f.owner.transform(event, limits, controller.signal);
    controller.abort();
    await expect(waiting).rejects.toThrow("cancelled");
    release.resolve();
    await blocking;
    const next = context([prompt("current")]);
    await f.owner.transform(next, limits, new AbortController().signal);
    expect(JSON.stringify(event)).toBe(original);
    expect(next.system.length).toBe(2);
  } finally { release.resolve(); await f.close(); }
});

test("simultaneous context requests serialize reconciliation without duplicate records", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<string>();
  const long = "serialized archive ".repeat(100);
  const f = await fixture([user("old", long), idle(), user("current")], async (_input, signal) => {
    entered.resolve(); return deadline(release.promise, signal);
  });
  try {
    const first = context([prompt("old", long), prompt("current")]);
    const second = context([prompt("old", long), prompt("current")]);
    const a = f.owner.transform(first, limits, new AbortController().signal);
    const b = f.owner.transform(second, limits, new AbortController().signal);
    await entered.promise;
    expect(first.system.length).toBe(1);
    expect(second.system.length).toBe(1);
    release.resolve("short archive");
    await Promise.all([a, b]);
    expect(first.messages).toEqual(second.messages);
    expect(f.owner.store.messages).toHaveLength(3);
  } finally { release.resolve("short"); await f.close(); }
});

test("cancellation returns to the caller while retry waits for owned generation cleanup", async () => {
  const entered = Promise.withResolvers<void>();
  const abortSeen = Promise.withResolvers<void>();
  const cleanup = Promise.withResolvers<void>();
  const long = "cleanup-owned source ".repeat(100);
  const f = await fixture([user("old", long), idle(), user("current")], async (_input, signal) => {
    entered.resolve();
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    abortSeen.resolve();
    await cleanup.promise;
    throw new Error("generation cleanup finished");
  });
  try {
    const controller = new AbortController();
    const pending = f.owner.transform(context([prompt("old", long), prompt("current")]), limits, controller.signal);
    await entered.promise;
    controller.abort();
    await expect(pending).rejects.toThrow("cancelled");
    await abortSeen.promise;
    let retried = false;
    f.state.generate = async () => { retried = true; return "recovered after cleanup"; };
    const retry = f.owner.transform(context([prompt("old", long), prompt("current")]), limits, new AbortController().signal);
    await Promise.resolve();
    expect(retried).toBe(false);
    cleanup.resolve();
    await retry;
    expect(retried).toBe(true);
  } finally { cleanup.resolve(); await f.close(); }
});
