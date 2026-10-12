import { tool, type Hooks } from "@opencode-ai/plugin";
import { MAX_ZOOM_DEPTH, MESSAGE_KINDS, SEARCH_MAX_LIMIT } from "../memory.js";
import { OptChatError } from "./options.js";
import type { SessionMemory } from "./session.js";

export function memoryTools(session: (id: string) => Promise<SessionMemory>): Hooks["tool"] {
  const z = tool.schema;
  const index = z.number().int().min(0);
  return {
    zoom: tool({ description: "Read a historical chat line. n is its power-of-two span; n=1 returns exact archived text. Use next as offset for another page.",
      args: { id: index, n: z.number().int().positive(), offset: index.optional(), depth: z.number().int().min(1).max(MAX_ZOOM_DEPTH).optional() },
      async execute(args, context) {
        const owner = await session(context.sessionID);
        return owner.run(async () => JSON.stringify(owner.memory.zoom(args.id, args.n, args.offset, args.depth)), false);
      } }),
    date: tool({ description: "Read the original timestamp of an archived chat record.", args: { id: index },
      async execute(args, context) {
        const owner = await session(context.sessionID);
        return owner.run(async () => owner.memory.date(args.id), false);
      } }),
    chat_search: tool({ description: "Search exact words in the durable public chat history. Results contain record IDs for zoom; use next as before for older results.",
      args: { query: z.string().min(1).max(200), kind: z.enum(MESSAGE_KINDS).optional(), limit: z.number().int().min(1).max(SEARCH_MAX_LIMIT).optional(), before: index.optional() },
      async execute(args, context) {
        const owner = await session(context.sessionID);
        return owner.run(async () => `[optchat search]\n${JSON.stringify(owner.memory.search(args.query, args))}`, false);
      } }),
    work: tool({ description: "List archived task reports, or read one report by numeric record id. Reports contain the canonical task output and may point to child sessions or files.",
      args: { id: index.optional(), offset: index.optional() },
      async execute(args, context) {
        const owner = await session(context.sessionID);
        return owner.run(async () => {
          if (args.id === undefined) return JSON.stringify(owner.memory.store.messages.filter((message) => message.kind === "work")
            .map((message) => ({ id: message.i, date: message.date, work: message.metadata?.work })));
          if (owner.memory.store.messages[args.id]?.kind !== "work") throw new OptChatError("record is not a task report");
          return JSON.stringify(owner.memory.zoom(args.id, 1, args.offset));
        }, false);
      } }),
  };
}
