import { expect, test } from "bun:test";
import { Headroom, type AdmissionTicket } from "../src/opencode/headroom.ts";
import { assistant, user } from "./opencode-fixture.ts";

const model = (context = 64_000, input?: number) => ({ id: "chat", providerID: "fixture", limit: { context, output: 4_096, input } });
const admission = (ticket: AdmissionTicket, value = model()) => ({ ticket, userID: "u", agent: "build", model: value, outputTokens: 4_096 });
const observe = (headroom: Headroom): AdmissionTicket => {
  const messages = [user("u")];
  const ticket = headroom.begin("s", messages);
  headroom.messages(ticket, messages);
  headroom.system(ticket, model(), []);
  return ticket;
};

test("capacity accounts for visible messages, observed systems, tools and effective output allocation", () => {
  const headroom = new Headroom(16_384);
  const ticket = observe(headroom);
  const system = ["system ".repeat(1_000)];
  headroom.system(ticket, model(), system);
  headroom.tool("fixture", { description: "tool", parameters: { payload: "schema ".repeat(1_000) } });
  headroom.tool("fixture", { description: "smaller later definition", parameters: {} });
  expect(() => headroom.admit(admission(ticket, model(25_000)))).toThrow("headroom");
  expect(() => headroom.admit(admission(ticket, model(64_000, 20_000)))).toThrow("headroom");
  system.push("later system plugin ".repeat(4_000));
  expect(() => headroom.admit(admission(ticket))).toThrow("headroom");
  system.pop();
  expect(() => headroom.admit(admission(ticket))).not.toThrow();
  expect(() => headroom.admit(admission(ticket))).toThrow("snapshot");
});

test("admission rejects unresolved, stale and opaque media requests without dropping tool groups", () => {
  const headroom = new Headroom(1_024);
  const messages = [user("u"), assistant("a")];
  const before = structuredClone(messages);
  const ticket = headroom.begin("s", messages);
  headroom.messages(ticket, messages);
  headroom.system(ticket, model(), []);
  expect(() => headroom.admit({ ...admission(ticket), userID: "different" })).toThrow("snapshot");
  expect(() => headroom.admit({ ...admission(ticket), model: model(0) })).toThrow();
  expect(() => headroom.admit({ ...admission(ticket), outputTokens: undefined })).toThrow("output");
  expect(() => headroom.admit(admission(ticket, model(1_100)))).toThrow("headroom");
  expect(messages).toEqual(before);
  const attachment = user("file-user");
  attachment.parts.push({ type: "file", id: "file", sessionID: "s", messageID: "file-user", mime: "image/png", url: "https://example.invalid/image.png" });
  const media = headroom.begin("s", [attachment]);
  expect(() => headroom.messages(media, [attachment])).toThrow("attachment");
  const pruned = assistant("pruned");
  pruned.parts.push({ type: "tool", id: "t", messageID: "pruned", sessionID: "s", tool: "bash", callID: "c",
    state: { status: "completed", input: {}, output: "canonical result", title: "result", metadata: {}, time: { start: 1, end: 2, compacted: 3 } } });
  const prunedInput = [user("u"), pruned];
  expect(() => headroom.messages(headroom.begin("s", prunedInput), prunedInput)).toThrow("pruned");
});

test("each generation invalidates old system accounting and project reserve is preserved", () => {
  const headroom = new Headroom(1_024);
  headroom.reserved(60_000);
  const first = observe(headroom);
  expect(() => headroom.admit(admission(first))).toThrow("headroom");
  const second = headroom.begin("s", [user("u")]);
  expect(() => headroom.messages(first, [user("u")])).toThrow("stale");
  expect(() => headroom.system(first, model(), ["late system"])).toThrow("stale");
  expect(() => headroom.admit(admission(second))).toThrow("snapshot");
  headroom.clear();
  expect(() => headroom.assert(second)).toThrow("snapshot");
});

test("opaque provider reasoning is rejected while ordinary text and signatures remain measurable", () => {
  const headroom = new Headroom(1_024);
  for (const metadata of [
    { openai: { reasoningEncryptedContent: "opaque" } },
    { openai: { itemId: "rs_opaque" } },
    { anthropic: { redactedData: "opaque" } },
    { bedrock: { redactedContent: "opaque" } },
    { customProvider: { redactedData: "opaque" } },
  ]) {
    const response = assistant("a");
    response.parts.push({ type: "reasoning", id: "r", sessionID: "s", messageID: "a", text: "visible", time: { start: 1, end: 2 }, metadata });
    const input = [user("u"), response];
    expect(() => headroom.messages(headroom.begin("s", input), input)).toThrow("opaque provider reasoning");
  }
  const response = assistant("a");
  response.parts.push({ type: "reasoning", id: "r", sessionID: "s", messageID: "a", text: "visible", time: { start: 1, end: 2 },
    metadata: { anthropic: { signature: "signed" }, openai: { reasoningEncryptedContent: null } } });
  const input = [user("u"), response];
  expect(() => headroom.messages(headroom.begin("s", input), input)).not.toThrow();
});

test("background title observations cannot replace or consume the main request", () => {
  const headroom = new Headroom(1_024);
  const ticket = observe(headroom);
  const main = ["large main system ".repeat(4_000)];
  headroom.system(ticket, model(), main);
  headroom.system(ticket, model(), ["small auxiliary title"]);
  expect(() => headroom.admit({ ...admission(ticket), agent: "title" })).toThrow("auxiliary");
  expect(headroom.current("s")).toBe(ticket);
  expect(() => headroom.admit(admission(ticket))).toThrow("headroom");
  expect(headroom.compressorOutput({ ...model(), limit: { context: 10_000, output: 1_024 } }, 4_096)).toBe(1_024);
});
