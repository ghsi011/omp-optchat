import { expect, test } from "bun:test";
import { activeContext } from "../src/opencode/context.ts";
import { agent, assistant, context, fixture, idle, limits, model, prompt, raw, reply, user } from "./opencode-fixture.ts";

test("reconciliation survives idle capture and restart without duplicating final replies", async () => {
  const f = await fixture([user("old"), assistant("answer", "complete final reply"), idle(), user("current")]);
  try {
    const event = context([prompt("old"), reply("answer", "complete final reply"), prompt("current")]);
    await f.owner.transform(event, limits, new AbortController().signal);
    expect(event.messages.at(-1)).toEqual(prompt("current"));
    expect(JSON.stringify(event.messages)).toContain("<chat>");
    await f.owner.capture();
    const before = f.owner.store.messages.map((message) => ({ ...message }));
    await f.reopen();
    await f.owner.capture();
    expect(f.owner.store.messages).toEqual(before);
    expect(f.owner.memory.zoom(1, 1).text).toBe("complete final reply");
    expect(f.owner.memory.date(1)).toBe(new Date(2_000).toLocaleString("en-US"));
    expect(f.owner.memory.search("complete final reply").hits[0]?.id).toBe(1);
  } finally { await f.close(); }
});

test("missing, changed, reordered and changed-timestamp archived sources reject before append", async () => {
  for (const replacement of [
    [user("old")],
    [user("old", "changed"), assistant("answer"), idle(), user("new")],
    [assistant("answer"), user("old"), idle(), user("new")],
    [raw({ id: "msg_old", type: "user", text: "old", time: { created: 9_000 } }), assistant("answer"), idle(), user("new")],
  ]) {
    const f = await fixture([user("old"), assistant("answer"), idle()]);
    try {
      const count = f.owner.store.messages.length;
      f.state.history = replacement;
      await expect(f.owner.capture()).rejects.toThrow(/removed|conflicts/);
      expect(f.owner.store.messages.length).toBe(count);
    } finally { await f.close(); }
  }
});

test("active native calls/results, steered prompts and id-less privileged updates stay raw", async () => {
  const tools = raw({ id: "msg_tools", type: "assistant", agent, model, time: { created: 2, completed: 3 }, content: [
    { type: "text", text: "calling" }, { type: "tool", id: "call_one", name: "read", time: { created: 2, completed: 3 },
      state: { status: "completed", input: { path: "one" }, content: [{ type: "text", text: "raw result" }] } },
  ] });
  const history = [user("old"), assistant("answer"), idle(), user("start"), tools, user("steer")];
  const call = { id: "msg_tools", role: "assistant" as const, content: [
    { type: "text" as const, text: "calling" }, { type: "tool-call" as const, id: "call_one", name: "read", input: { path: "one" } },
  ] };
  const result = { role: "tool" as const, content: [{ type: "tool-result" as const, id: "call_one", name: "read",
    result: { type: "text" as const, value: "raw result" } }] };
  const privileged = { role: "system" as const, content: [{ type: "text" as const, text: "Keep this operator instruction" }] };
  const effort = { role: "system" as const, content: [{ type: "effort" as const, effort: "high" as const }] };
  const f = await fixture(history);
  try {
    const event = context([prompt("old"), privileged, reply("answer"), effort, prompt("start"), call, result, prompt("steer")]);
    await f.owner.transform(event, limits, new AbortController().signal);
    expect(event.messages.slice(0, 2)).toEqual([privileged, effort]);
    expect(event.messages.slice(-4)).toEqual([prompt("start"), call, result, prompt("steer")]);
    expect(() => activeContext(history, [prompt("start"), call, prompt("steer")])).toThrow("tool result");
    expect(() => activeContext(history, [prompt("steer"), prompt("start"), call, result])).toThrow("reordered");
  } finally { await f.close(); }
});

test("shutdown captures a completed reply even without a live idle event", async () => {
  const f = await fixture([user("u")]);
  f.state.history = [user("u"), assistant("last", "reply before shutdown"), idle()];
  await f.owner.close(true);
  await f.reopen();
  try { expect(f.owner.memory.search("reply before shutdown").hits).toHaveLength(1); }
  finally { await f.close(); }
});

test("a later steered prompt outside the incoming snapshot does not move its active boundary", async () => {
  const f = await fixture([user("old"), assistant("answer"), idle(), user("current"), user("later")]);
  try {
    const event = context([prompt("old"), reply("answer"), prompt("current")]);
    await f.owner.transform(event, limits, new AbortController().signal);
    expect(event.messages.at(-1)).toEqual(prompt("current"));
    expect(JSON.stringify(event.messages)).not.toContain("later");
  } finally { await f.close(); }
});

test("an unfinished historical assistant prevents uncaptured prompts from admission", async () => {
  const unfinished = raw({ id: "msg_orphan", type: "assistant", agent, model,
    content: [{ type: "text", text: "unfinished" }], time: { created: 2 } });
  const f = await fixture([user("old"), unfinished, user("new")]);
  try {
    await expect(f.owner.transform(context([prompt("old"), reply("orphan", "unfinished"), prompt("new")]), limits,
      new AbortController().signal)).rejects.toThrow("unsettled historical assistant");
    expect(f.owner.store.messages.map((entry) => entry.text)).toEqual(["old"]);
  } finally { await f.close(); }
});
