import { expect, test } from "bun:test";
import { activeAnchor, admitHistory, projectHistory } from "../src/opencode/projection.ts";

const user = (name: string, time: number) => ({ info: { id: name, sessionID: "s", role: "user", time: { created: time },
  model: { providerID: "fixture", modelID: "chat" } }, parts: [{ id: `p-${name}`, sessionID: "s", messageID: name, type: "text", text: name }] });
const assistant = (name: string, parent: string, end: number, finish = "stop") => ({
  info: { id: name, sessionID: "s", role: "assistant", parentID: parent, time: { created: end - 1, completed: end }, finish },
  parts: [{ id: `p-${name}`, sessionID: "s", messageID: name, type: "text", text: name }],
});
const tool = (messageID: string, state: object = { status: "completed", input: { path: "x" }, output: "result" }) => ({
  id: `tool-${messageID}`, sessionID: "s", messageID, type: "tool", tool: "bash", callID: `call-${messageID}`, state,
});

test("only a verified final answer before a new user advances the raw anchor", () => {
  const final = assistant("a", "u", 3);
  expect(activeAnchor(admitHistory([user("u", 1), final, user("next", 4)], "s"))).toBe("next");
  for (const finish of ["tool-calls", "unknown"]) {
    expect(activeAnchor(admitHistory([user("u", 1), assistant("a", "u", 3, finish), user("steer", 4)], "s"))).toBe("u");
  }
  expect(activeAnchor(admitHistory([user("u", 1), { ...final, parts: [tool("a")] }, user("steer", 4)], "s"))).toBe("u");
  expect(activeAnchor(admitHistory([user("u", 1), final, user("steer", 2)], "s"))).toBe("u");
  expect(activeAnchor(admitHistory([user("u", 1), { ...final, parts: [tool("a", {
    status: "error", input: {}, error: "interrupted", metadata: { interrupted: true },
  })] }, user("next", 4)], "s"))).toBe("next");
});

test("canonical projection retains distinct equal parts and terminal tool errors, excluding reasoning", () => {
  const u = user("u", 1);
  const a = assistant("a", "u", 3);
  const records = projectHistory(admitHistory([u, { ...a, parts: [
    ...a.parts, { ...a.parts[0], id: "p-duplicate" },
    { id: "secret", messageID: "a", sessionID: "s", type: "reasoning", text: "private sentinel" },
    tool("a", { status: "error", input: { command: "false" }, error: "exit 1" }),
  ] }], "s"));
  expect(records.map((record) => record.kind)).toEqual(["user", "talk", "talk", "tool", "echo"]);
  expect(records.map((record) => record.text).join("\n")).not.toContain("private sentinel");
  expect(records.at(-1)?.text).toBe("[tool error] exit 1");
  expect(records[1]?.metadata.source.partID).not.toBe(records[2]?.metadata.source.partID);
});

test("incomplete assistant ends the appendable prefix and destructive host features fail closed", () => {
  const a = assistant("a", "u", 3);
  expect(projectHistory(admitHistory([user("u", 1), { ...a, info: { ...a.info, time: { created: 2 }, finish: undefined } }, user("steer", 4)], "s"))).toHaveLength(1);
  expect(() => admitHistory([{ ...a, info: { ...a.info, summary: true } }], "s")).toThrow("compaction");
  expect(() => admitHistory([{ ...user("u", 1), parts: [{ id: "p", messageID: "u", sessionID: "s", type: "future-public-content", text: "unknown" }] }], "s")).toThrow();
});

test("tool input key order does not manufacture a source conflict", () => {
  const a = assistant("a", "u", 3);
  const project = (input: object) => projectHistory(admitHistory([{ ...a, parts: [tool("a", { status: "completed", input, output: "same" })] }], "s"));
  expect(project({ a: 1, nested: { x: 2, y: 3 } })).toEqual(project({ nested: { y: 3, x: 2 }, a: 1 }));
});
