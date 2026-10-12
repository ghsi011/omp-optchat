import type { ToolEditor } from "@opencode/plugin/effect/tool";
import { Tool } from "@opencode/schema/tool";
import { Effect, Schema } from "effect";
import { MAX_ZOOM_DEPTH, MESSAGE_KINDS, SEARCH_MAX_LIMIT } from "../memory.js";
import { OptChatError } from "./options.js";
import type { SessionMemory } from "./session.js";

const index = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const zoomInput = Schema.Struct({ id: index, n: Schema.Int.check(Schema.isGreaterThan(0)),
  offset: Schema.optionalKey(index), depth: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_ZOOM_DEPTH }))) });
const dateInput = Schema.Struct({ id: index });
const searchInput = Schema.Struct({ query: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  kind: Schema.optionalKey(Schema.Literals(MESSAGE_KINDS)),
  limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: SEARCH_MAX_LIMIT }))), before: Schema.optionalKey(index) });
const workInput = Schema.Struct({ id: Schema.optionalKey(index), offset: Schema.optionalKey(index) });

export function memoryTools(editor: ToolEditor, session: (id: Tool.Context["sessionID"]) => Promise<SessionMemory>): void {
  const execute = (id: Tool.Context["sessionID"], action: (owner: SessionMemory) => string) => Effect.tryPromise({
    try: async (signal) => {
      const owner = await session(id);
      return owner.run(async () => ({ content: action(owner) }), signal);
    },
    catch: (error) => new Tool.Error({ message: error instanceof Error ? error.message : "OptChat memory tool failed", error }),
  });
  editor.add({ name: "zoom", description: "Read a historical chat line. n is its power-of-two span; n=1 returns exact archived text. Use next as offset for another page.",
    input: zoomInput, options: { codemode: false },
    execute: (args, context) => execute(context.sessionID, (owner) => JSON.stringify(owner.memory.zoom(args.id, args.n, args.offset, args.depth))) });
  editor.add({ name: "date", description: "Read the original timestamp of an archived chat record.",
    input: dateInput, options: { codemode: false },
    execute: (args, context) => execute(context.sessionID, (owner) => owner.memory.date(args.id)) });
  editor.add({ name: "chat_search", description: "Search exact words in durable public chat history. Results include record IDs for zoom; use next as before for older results.",
    input: searchInput, options: { codemode: false },
    execute: (args, context) => execute(context.sessionID, (owner) => `[optchat search]\n${JSON.stringify(owner.memory.search(args.query, args))}`) });
  editor.add({ name: "work", description: "List archived subagent reports, or read one by numeric record id. Reports contain canonical output and may point to child sessions or files.",
    input: workInput, options: { codemode: false }, execute: (args, context) => execute(context.sessionID, (owner) => {
      if (args.id === undefined) return JSON.stringify(owner.store.messages.filter((message) => message.kind === "work")
        .map((message) => ({ id: message.i, date: message.date, work: message.metadata?.work })));
      if (owner.store.messages[args.id]?.kind !== "work") throw new OptChatError("record is not a subagent report");
      return JSON.stringify(owner.memory.zoom(args.id, 1, args.offset));
    }) });
}
