import { createHash } from "node:crypto";
import { tool } from "@opencode-ai/plugin";
import type { MessageMetadata, SourceIdentity } from "../archive.js";
import type { Kind } from "../store.js";
import { OptChatError } from "./options.js";

const z = tool.schema;
const id = z.string().min(1).max(256);
const identity = { id, sessionID: id, messageID: id };
const infoSchema = z.discriminatedUnion("role", [
  z.object({ id, sessionID: id, role: z.literal("user"), time: z.object({ created: z.number().finite() }),
    model: z.object({ providerID: id, modelID: id }) }),
  z.object({ id, sessionID: id, role: z.literal("assistant"), parentID: id,
    time: z.object({ created: z.number().finite(), completed: z.number().finite().optional() }),
    finish: z.string().optional(), error: z.unknown().optional(), summary: z.boolean().optional() }),
]);
const partSchema = z.discriminatedUnion("type", [
  z.object({ ...identity, type: z.literal("text"), text: z.string(), synthetic: z.boolean().optional(), ignored: z.boolean().optional() }),
  z.object({ ...identity, type: z.literal("file"), mime: z.string(), filename: z.string().optional(), url: z.string() }),
  z.object({ ...identity, type: z.literal("tool"), tool: id, callID: id,
    metadata: z.record(z.string(), z.unknown()).optional(),
    state: z.discriminatedUnion("status", [
      z.object({ status: z.literal("pending") }), z.object({ status: z.literal("running") }),
      z.object({ status: z.literal("completed"), input: z.record(z.string(), z.unknown()), output: z.string(),
        attachments: z.array(z.object({ mime: z.string(), filename: z.string().optional(), url: z.string() })).optional() }),
      z.object({ status: z.literal("error"), input: z.record(z.string(), z.unknown()), error: z.string(),
        metadata: z.record(z.string(), z.unknown()).optional() }),
    ]) }),
  z.object({ ...identity, type: z.literal("subtask"), prompt: z.string(), description: z.string(), agent: z.string() }),
  z.object({ ...identity, type: z.enum(["reasoning", "step-start", "step-finish", "snapshot", "patch", "agent", "retry", "compaction"]) }),
]);
const historySchema = z.array(z.object({ info: infoSchema, parts: z.array(partSchema) }));
export type CanonicalHistory = ReturnType<typeof historySchema.parse>;
export interface CapturedRecord {
  readonly kind: Kind;
  readonly text: string;
  readonly date: Date;
  readonly metadata: MessageMetadata & { readonly source: SourceIdentity };
}

export function admitHistory(value: unknown, sessionID: string): CanonicalHistory {
  const history = historySchema.parse(value);
  const messages = new Set<string>();
  const parts = new Set<string>();
  for (const row of history) {
    if (row.info.sessionID !== sessionID || messages.has(row.info.id)) throw new OptChatError("inconsistent canonical message identity");
    messages.add(row.info.id);
    if (row.info.role === "assistant" && row.info.summary) throw new OptChatError("prior host compaction is unsupported; use a new session");
    for (const part of row.parts) {
      if (part.sessionID !== sessionID || part.messageID !== row.info.id || parts.has(part.id)) {
        throw new OptChatError("inconsistent canonical part identity");
      }
      parts.add(part.id);
      if (part.type === "compaction") throw new OptChatError("host compaction is unsupported; use a new session");
    }
  }
  return history;
}

export function activeAnchor(history: CanonicalHistory): string {
  let anchor: string | undefined;
  let latestUser: string | undefined;
  let closedAt: number | undefined;
  for (const { info, parts } of history) {
    if (info.role === "user") {
      if (anchor === undefined || (closedAt !== undefined && closedAt <= info.time.created)) anchor = info.id;
      latestUser = info.id;
      closedAt = undefined;
    } else if (info.finish && info.finish !== "tool-calls" && info.finish !== "unknown" &&
      info.parentID === latestUser && info.time.completed !== undefined && !parts.some((part) =>
        part.type === "tool" && !part.metadata?.providerExecuted &&
        !(part.state.status === "error" && part.state.metadata?.interrupted === true))) {
      closedAt = info.time.completed;
    }
  }
  if (anchor === undefined) throw new OptChatError("canonical history has no user turn");
  return anchor;
}

function attachment(file: { readonly mime: string; readonly filename?: string; readonly url: string }): string {
  const location = file.url.startsWith("data:")
    ? `inline content sha256:${createHash("sha256").update(file.url).digest("hex")}` : file.url;
  return `[attachment pointer-only] ${JSON.stringify({ mime: file.mime, filename: file.filename, location })}`;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(",")}}`;
  throw new OptChatError("tool input is not canonical JSON");
}

export function projectHistory(history: CanonicalHistory): CapturedRecord[] {
  const records: CapturedRecord[] = [];
  for (const { info, parts } of history) {
    if (info.role === "assistant" && info.time.completed === undefined && info.error === undefined) break;
    for (const part of parts) {
      const source = { host: "opencode", sessionID: info.sessionID, messageID: info.id, partID: part.id } as const;
      const append = (kind: Kind, text: string, slot: SourceIdentity["slot"]): void => {
        records.push({ kind, text, date: new Date(info.time.created), metadata: { source: { ...source, slot } } });
      };
      if (part.type === "text" && "text" in part && !part.synthetic && !part.ignored) {
        append(info.role === "user" ? "user" : "talk", part.text, "text");
      } else if (part.type === "file" && "url" in part) {
        append("note", attachment(part), "file");
      } else if (part.type === "subtask" && "prompt" in part) {
        append("user", JSON.stringify({ agent: part.agent, description: part.description, prompt: part.prompt }), "text");
      } else if (part.type === "tool" && "state" in part) {
        const state = part.state;
        if (state.status !== "completed" && state.status !== "error") return records;
        append("tool", `${part.tool} ${stableJson(state.input)}`, "call");
        const output = state.status === "error" ? `[tool error] ${state.error}`
          : [state.output, ...(state.attachments ?? []).map(attachment)].join("\n");
        if (part.tool === "task") {
          records.push({ kind: "work", text: output, date: new Date(info.time.created), metadata: {
            source: { ...source, slot: "result" }, work: { source: "task", completeness: "pointer-only", id: part.callID },
          } });
        } else append("echo", output, "result");
      }
    }
  }
  return records;
}
