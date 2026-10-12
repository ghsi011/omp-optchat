import { expect, test } from "bun:test";
import { activeStart, projectHistory } from "../src/opencode/projection.ts";
import { agent, assistant, idle, model, raw, sessionID, user } from "./opencode-fixture.ts";

test("durable idle owns a complete turn, including steering and unfinished steps", () => {
  const history = [user("old"), assistant("oldanswer"), idle(), user("start"), assistant("step"), user("steer")];
  expect(activeStart(history)).toBe(3);
  expect(activeStart(history.slice(0, 2))).toBe(0);
});

test("public raw archive excludes private reasoning and uses stable tool identities", () => {
  const tool = raw({ id: "msg_tools", type: "assistant", agent, model, time: { created: 2_000, completed: 3_000 }, content: [
    { type: "reasoning", text: "private thought" }, { type: "text", text: "public response" },
    { type: "tool", id: "call_native", name: "subagent", time: { created: 2_000, completed: 3_000 },
      state: { status: "completed", input: { z: 2, a: 1 }, content: [{ type: "text", text: "full report" }] } },
  ] });
  const records = projectHistory([user("u"), tool], sessionID);
  expect(records.map((r) => [r.kind, r.text])).toEqual([
    ["user", "u"], ["talk", "public response"], ["tool", 'subagent {"a":1,"z":2}'], ["work", "full report"],
  ]);
  expect(records[1]?.metadata.source.partID).toBe("content:1");
  expect(records[2]?.metadata.source.partID).toBe("tool:call_native");
  expect(records[3]?.metadata.work).toEqual({ source: "task", completeness: "pointer-only", id: "call_native" });
  expect(records[1]?.date.toISOString()).toBe("1970-01-01T00:00:02.000Z");
});

test("unsettled assistant is not archived by unstable content ordinal", () => {
  const pending = raw({ id: "msg_pending", type: "assistant", agent, model,
    content: [{ type: "text", text: "partial" }], time: { created: 1, streamed: 2 } });
  expect(projectHistory([user("u"), pending, user("steer")], sessionID).map((r) => r.text)).toEqual(["u"]);
});

test("completed host checkpoints and duplicate identities fail before capture", () => {
  const checkpoint = raw({ id: "msg_compacted", type: "compaction", status: "completed", reason: "manual",
    summary: "missing past", recent: "", time: { created: 1 } });
  expect(() => projectHistory([checkpoint, user("u")], sessionID)).toThrow("compaction");
  expect(() => projectHistory([user("u"), user("u")], sessionID)).toThrow("duplicate");
});

test("inline tool files archive only a content hash and public pointer metadata", () => {
  const file = raw({ id: "msg_file", type: "assistant", agent, model, time: { created: 1, completed: 2 }, content: [
    { type: "tool", id: "file_call", name: "read", time: { created: 1, completed: 2 },
      state: { status: "completed", input: {}, content: [{ type: "file", mime: "image/png", uri: "data:image/png;base64,privatebytes" }] } },
  ] });
  const result = projectHistory([file], sessionID)[1]?.text;
  expect(result).toContain("sha256:");
  expect(result).not.toContain("privatebytes");
  expect(result).toContain("image/png");
});
