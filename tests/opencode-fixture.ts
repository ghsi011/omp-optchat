import { Model } from "@opencode/plugin/effect";
import type { SessionContext } from "@opencode/plugin/effect/session";
import { SessionMessage } from "@opencode/schema/session-message";
import { Session } from "@opencode/schema/session";
import { Agent } from "@opencode/schema/agent";
import { Schema } from "effect";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseOptions } from "../src/opencode/options.ts";
import { SessionMemory, type SessionHost } from "../src/opencode/session.ts";
import type { History } from "../src/opencode/projection.ts";

export const sessionID = Session.ID.make("ses_fixture");
export const model = Model.Ref.parse("fixture/main");
export const agent = Agent.ID.make("build");
export const raw = Schema.decodeUnknownSync(SessionMessage.Info);
export function user(id: string, text = id): SessionMessage.Info {
  return raw({ id: `msg_${id}`, type: "user", text, time: { created: 1_000 } });
}
export function assistant(id: string, text = id): SessionMessage.Info {
  return raw({ id: `msg_${id}`, type: "assistant", agent, model,
    content: [{ type: "text", text }], time: { created: 2_000, completed: 3_000 }, finish: "stop" });
}
export function idle(id = "idle"): SessionMessage.Info {
  return raw({ id: `msg_${id}`, type: "idle", outcome: "succeeded", time: { created: 4_000 } });
}
export function context(messages: SessionContext["messages"]): SessionContext {
  return { sessionID, agent, model, messages, system: [{ type: "text", text: "host system" }],
    tools: {}, options: { maxTokens: 1_024 } };
}
export function prompt(id: string, text = id): SessionContext["messages"][number] {
  return { id: `msg_${id}`, role: "user", content: [{ type: "text", text }] };
}
export function reply(id: string, text = id): SessionContext["messages"][number] {
  return { id: `msg_${id}`, role: "assistant", content: [{ type: "text", text }] };
}
export const limits = { context: 128_000, input: 120_000, output: 8_000 };

export async function fixture(initial: History, generate: SessionHost["generate"] = async () => "short public summary") {
  const root = await mkdtemp(join(tmpdir(), "optchat-v2-"));
  const state = { history: initial, generate };
  const host: SessionHost = { project: root, history: async () => state.history,
    generate: (input, signal) => state.generate(input, signal) };
  const options = parseOptions({ directory: join(root, "archive"), nodeBytes: 128, viewBytes: 512, contextReserveBytes: 1_024 });
  let owner = await SessionMemory.open({ id: sessionID, model, host, options });
  await owner.capture();
  return { state, host, options, get owner() { return owner; },
    async reopen() { await owner.close(); owner = await SessionMemory.open({ id: sessionID, model, host, options }); await owner.capture(); },
    async close() { await owner.close(); await rm(root, { recursive: true, force: true }); } };
}
