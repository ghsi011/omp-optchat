import { createHash } from "node:crypto";
import type { Plugin } from "@opencode/plugin/effect";
import type { SessionContext } from "@opencode/plugin/effect/session";
import { DateTime, type Effect } from "effect";
import type { MessageMetadata, SourceIdentity } from "../archive.js";
import type { Kind } from "../store.js";
import { assertNever, HistoryConflictError } from "./options.js";

export type History = Effect.Success<ReturnType<Plugin.Context["session"]["context"]>>;
export interface CapturedRecord {
  readonly kind: Kind;
  readonly text: string;
  readonly date: Date;
  readonly metadata: MessageMetadata & { readonly source: SourceIdentity };
}

export function activeStart(history: History): number {
  return history.findLastIndex((row) => row.type === "idle") + 1;
}

export function stableJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object") return `{${Object.entries(value).filter(([, entry]) => entry !== undefined)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(",")}}`;
  throw new HistoryConflictError("public history contains non-JSON data");
}

function filePointer(item: { readonly type: "file"; readonly uri: string; readonly mime: string; readonly name?: string }): string {
  const uri = item.uri.startsWith("data:") ? `sha256:${createHash("sha256").update(item.uri).digest("hex")}` : item.uri;
  return `[attachment pointer-only] ${stableJson({ ...item, uri })}`;
}

export function projectHistory(history: History, sessionID: SessionContext["sessionID"]): CapturedRecord[] {
  const ids = new Set<string>();
  for (const row of history) {
    if (ids.has(row.id)) throw new HistoryConflictError("duplicate canonical message identity");
    ids.add(row.id);
    if (row.type === "compaction" && row.status === "completed") {
      throw new HistoryConflictError("prior host compaction is unsupported; use a new session");
    }
  }
  const records: CapturedRecord[] = [];
  rows: for (const row of history) {
    const append = (kind: Kind, text: string, part: { readonly id: string; readonly slot: SourceIdentity["slot"] }) => {
      const source: SourceIdentity = { host: "opencode", sessionID, messageID: row.id, partID: part.id, slot: part.slot };
      const work = kind === "work" ? { source: "task" as const, completeness: "pointer-only" as const, id: part.id.slice(5) } : undefined;
      records.push({ kind, text, date: new Date(DateTime.toEpochMillis(row.time.created)),
        metadata: work ? { source, work } : { source } });
    };
    switch (row.type) {
      case "user":
        append("user", row.text, { id: "text", slot: "text" });
        if (row.agents?.length) append("note", stableJson(row.agents), { id: "agents", slot: "text" });
        for (const [index, skill] of (row.skills ?? []).entries()) {
          append("note", stableJson(skill), { id: `skill:${index}`, slot: "text" });
        }
        for (const [index, file] of (row.files ?? []).entries()) {
          const { data, ...pointer } = file;
          append("note", `[attachment pointer-only] ${stableJson({ ...pointer,
            sha256: createHash("sha256").update(data).digest("hex") })}`, { id: `file:${index}`, slot: "file" });
        }
        break;
      case "assistant":
        if (row.time.completed === undefined || row.content.some((part) => part.type === "tool" &&
          (part.state.status === "running" || part.state.status === "streaming"))) break rows;
        for (const [index, part] of row.content.entries()) {
          switch (part.type) {
            case "reasoning": break;
            case "text": append("talk", part.text, { id: `content:${index}`, slot: "text" }); break;
            case "tool": {
              const state = part.state;
              if (state.status === "running" || state.status === "streaming") break rows;
              append("tool", `${part.name} ${stableJson(state.input)}`, { id: `tool:${part.id}`, slot: "call" });
              const content = (state.content ?? []).map((item) => item.type === "text"
                ? item.text : filePointer(item)).join("\n");
              const text = state.status === "error" ? `[tool error] ${stableJson(state.error)}\n${content}` : content;
              append(part.name === "subagent" ? "work" : "echo", text, { id: `tool:${part.id}`, slot: "result" });
              break;
            }
            default: assertNever(part);
          }
        }
        break;
      case "synthetic": case "system": case "skill":
        append("note", row.text, { id: row.type, slot: "text" }); break;
      case "shell":
        if (row.time.completed === undefined) break rows;
        append("tool", row.command, { id: row.shellID, slot: "call" });
        append("echo", stableJson({ status: row.status, exit: row.exit, output: row.output }), { id: row.shellID, slot: "result" });
        break;
      case "agent-switched":
        append("note", stableJson({ type: row.type, agent: row.agent, previous: row.previous }), { id: row.type, slot: "text" }); break;
      case "model-switched":
        append("note", stableJson({ type: row.type, model: row.model, previous: row.previous }), { id: row.type, slot: "text" }); break;
      case "location-switched":
        append("note", stableJson({ type: row.type, location: row.location, previous: row.previous }), { id: row.type, slot: "text" }); break;
      case "idle":
        append("note", stableJson({ type: row.type, outcome: row.outcome }), { id: row.type, slot: "text" }); break;
      case "compaction": break;
      default: assertNever(row);
    }
  }
  const sources = records.map((record) => stableJson(record.metadata.source));
  if (new Set(sources).size !== sources.length) throw new HistoryConflictError("duplicate canonical source identity");
  return records;
}
