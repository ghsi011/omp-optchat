import { expect, test } from "bun:test";
import { Model } from "@opencode/plugin/effect";
import { summarizer } from "../src/opencode/compressor.ts";
import { parseOptions } from "../src/opencode/options.ts";

test("native generation receives complete structured feedback on a compression retry", async () => {
  let received: unknown;
  const summarize = summarizer(async ({ prompt }) => {
    received = JSON.parse(prompt.slice(prompt.lastIndexOf("\n\n") + 2));
    return "corrected summary";
  }, () => Model.Ref.parse("fixture/compact"), parseOptions({ directory: "/tmp/unused" }));
  const result = await summarize({ context: "archived payload", instruction: "compression task", feedback: [
    { reply: "prior oversized reply\nwith a second line", instruction: "correction for first reply" },
    { reply: "second oversized reply", instruction: "correction for second reply" },
  ] }, new AbortController().signal);
  expect(received).toEqual([
    { reply: "prior oversized reply\nwith a second line", instruction: "correction for first reply" },
    { reply: "second oversized reply", instruction: "correction for second reply" },
  ]);
  expect(result).toBe("corrected summary");
});
