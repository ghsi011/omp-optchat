import { expect, test } from "bun:test";
import { deadline, parseOptions } from "../src/opencode/options.ts";
import { SessionMemory } from "../src/opencode/session.ts";
import { Session } from "@opencode/schema/session";
import { assistant, context, fixture, idle, limits, model, prompt, reply, user } from "./opencode-fixture.ts";

test("slow summaries hold every request, including an already frozen prefix", async () => {
  const f = await fixture([user("old"), assistant("answer"), idle(), user("active")]);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<string>();
  try {
    const first = context([prompt("old"), reply("answer"), prompt("active")]);
    await f.owner.transform(first, limits, new AbortController().signal);
    const view = first.messages[0];
    f.state.generate = async (_input, signal) => { entered.resolve(); return deadline(release.promise, signal); };
    const long = "new public output ".repeat(200);
    f.state.history = [...f.state.history, assistant("long", long), user("steer")];
    const event = context([prompt("old"), reply("answer"), prompt("active"), reply("long", long), prompt("steer")]);
    const original = JSON.stringify(event);
    let admitted = false;
    const waiting = f.owner.transform(event, limits, new AbortController().signal).then(() => { admitted = true; });
    await entered.promise;
    expect(admitted).toBe(false);
    expect(JSON.stringify(event)).toBe(original);
    release.resolve("short new output");
    await waiting;
    expect(event.messages[0]).toEqual(view);
    expect(event.messages.slice(-3)).toEqual([prompt("active"), reply("long", long), prompt("steer")]);
  } finally { release.resolve("short"); await f.close(); }
});

test("failed compression refuses raw fallback and retries the same durable source without append", async () => {
  const long = "long archived narrative ".repeat(200);
  const f = await fixture([user("old", long), assistant("answer"), idle(), user("active")], async () => { throw new Error("offline"); });
  try {
    const event = context([prompt("old", long), reply("answer"), prompt("active")]);
    const original = JSON.stringify(event);
    await expect(f.owner.transform(event, limits, new AbortController().signal)).rejects.toThrow("summary work failed");
    expect(JSON.stringify(event)).toBe(original);
    const count = f.owner.store.messages.length;
    f.state.generate = async () => "recovered short summary";
    await f.owner.transform(event, limits, new AbortController().signal);
    expect(f.owner.store.messages.length).toBe(count);
    expect(JSON.stringify(event.messages)).not.toContain(long);
    expect(f.owner.memory.zoom(0, 1).text).toBe(long);
  } finally { await f.close(); }
});

test("cancellation interrupts compression, frees the queue and allows retry", async () => {
  const entered = Promise.withResolvers<void>();
  const cancelled = Promise.withResolvers<void>();
  const long = "cancelled source ".repeat(200);
  const f = await fixture([user("old", long), idle(), user("active")], async (_input, signal) => {
    entered.resolve();
    signal.addEventListener("abort", () => cancelled.resolve(), { once: true });
    return deadline(new Promise<string>(() => undefined), signal);
  });
  try {
    const controller = new AbortController();
    const event = context([prompt("old", long), prompt("active")]);
    const original = JSON.stringify(event);
    const result = f.owner.transform(event, limits, controller.signal);
    await entered.promise;
    controller.abort();
    await expect(result).rejects.toThrow("cancelled");
    await cancelled.promise;
    f.state.generate = async () => "retry succeeded";
    const retry = context([prompt("old", long), prompt("active")]);
    await f.owner.transform(retry, limits, new AbortController().signal);
    expect(JSON.stringify(event)).toBe(original);
    expect(JSON.stringify(retry.messages)).toContain("<chat>");
  } finally { await f.close(); }
});

test("one blocked session does not hold another session's admission", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<string>();
  const f = await fixture([user("old", "slow ".repeat(300)), idle(), user("active")], async (_input, signal) => {
    entered.resolve(); return deadline(release.promise, signal);
  });
  const other = await SessionMemory.open({ id: Session.ID.make("ses_other"), model, options: f.options,
    host: { ...f.host, history: async () => [user("independent")] } });
  try {
    const blocked = f.owner.transform(context([prompt("old", "slow ".repeat(300)), prompt("active")]), limits, new AbortController().signal);
    await entered.promise;
    const event = context([prompt("independent")]);
    await other.transform({ ...event, sessionID: Session.ID.make("ses_other") }, limits, new AbortController().signal);
    release.resolve("short history");
    await blocked;
  } finally { release.resolve("short"); await other.close(); await f.close(); }
});

test("v2 options accept native model refs and reject legacy compatibility keys", () => {
  expect(String(parseOptions({ directory: "/tmp/archive", model: { providerID: "fixture", id: "compact" } }).model?.id)).toBe("compact");
  expect(() => parseOptions({ directory: "/tmp/archive", model: { providerID: "fixture", modelID: "compact" } })).toThrow();
});
