import { expect, test } from "bun:test";
import { admitContext, CapacityError } from "../src/opencode/headroom.ts";
import { context, limits, prompt } from "./opencode-fixture.ts";

test("one draft measures system, full external tool schemas, messages, options and output reserve", () => {
  const event = context([prompt("u")]);
  const budget = admitContext(event, limits, 1_024);
  expect(budget.inputBytes).toBe(budget.messageBytes + budget.systemBytes + budget.toolBytes + budget.optionBytes + 1_024);
  expect(budget.capacity).toBe(120_000);
  event.tools.external = { description: "external schema", input: { type: "object", description: "x".repeat(125_000) } };
  expect(() => admitContext(event, limits, 1_024)).toThrow(CapacityError);
  event.tools = {};
  event.system.push({ type: "text", text: "x".repeat(125_000) });
  expect(() => admitContext(event, limits, 1_024)).toThrow(CapacityError);
});

test("UTF-8 bytes and the resolved output cap bound the usable context", () => {
  const event = context([prompt("u", "界".repeat(400))]);
  const budget = admitContext(event, { context: 4_000, output: 2_000 }, 1_024);
  expect(budget.messageBytes).toBeGreaterThan(1_200);
  expect(budget.capacity).toBe(2_976);
  event.options.maxTokens = 2_000;
  expect(() => admitContext(event, { context: 4_000, output: 2_000 }, 1_024)).toThrow(CapacityError);
});

test("opaque provider state, active files and missing caps fail closed", () => {
  const event = context([prompt("u")]);
  event.messages[0] = { ...prompt("u"), native: { previous_response_id: "opaque" } };
  expect(() => admitContext(event, limits, 1_024)).toThrow("opaque");
  event.messages = [{ role: "tool", content: [{ type: "tool-result", id: "c", name: "read", result: {
    type: "content", value: [{ type: "file", uri: "file:///large.png", mime: "image/png" }],
  } }] }];
  expect(() => admitContext(event, limits, 1_024)).toThrow("attachment");
  event.messages = [prompt("u")];
  delete event.options.maxTokens;
  expect(() => admitContext(event, limits, 1_024)).toThrow("output allowance");
  event.options = { maxTokens: 1_024, previous_response_id: "opaque remote history" };
  expect(() => admitContext(event, limits, 1_024)).toThrow("provider-specific");
});
