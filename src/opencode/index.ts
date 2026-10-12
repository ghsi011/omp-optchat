import { Plugin, type Model } from "@opencode/plugin/effect";
import type { SessionContext } from "@opencode/plugin/effect/session";
import { Effect, Stream } from "effect";
import { deadline, OptChatError, parseOptions } from "./options.js";
import { SessionMemory, type SessionHost } from "./session.js";
import { memoryTools } from "./tools.js";

export default Plugin.define({ id: "optchat", effect: (ctx) => Effect.gen(function* () {
  let blocked: Error | undefined;
  let options: ReturnType<typeof parseOptions> | undefined;
  try { options = parseOptions(ctx.options); } catch (error) {
    blocked = error instanceof Error ? error : new OptChatError("invalid plugin options", { cause: error });
  }
  if (options && !options.enabled) return;
  if (ctx.app.version !== "2.0.27") blocked = new OptChatError("this adapter requires OpenCode 2.0.27");
  if (process.platform !== "linux") blocked = new OptChatError("run OpenCode in Linux/WSL with storage on its private Linux filesystem");
  const runtime = yield* Effect.context<never>();
  const run = Effect.runPromiseWith(runtime);
  const sessions = new Map<SessionContext["sessionID"], Promise<SessionMemory>>();
  let closing = false;
  const check = () => {
    if (blocked) throw blocked;
    if (closing) throw new OptChatError("plugin is closing");
    if (!options) throw new OptChatError("plugin options are unavailable");
    return options;
  };
  const limits = async (model: Model.Ref, signal: AbortSignal) => {
    const catalog = await deadline(run(ctx.model.list({ location: { directory: ctx.location.directory } }), { signal }), signal);
    const resolved = catalog.data.find((entry) => entry.providerID === model.providerID && entry.id === model.id);
    if (!resolved) throw new OptChatError("selected model is absent from the resolved catalog");
    return resolved.limit;
  };
  const host: SessionHost = {
    project: ctx.location.directory,
    history: (sessionID, signal) => run(ctx.session.context({ sessionID }), { signal }),
    generate: async (input, signal) => {
      const limit = await limits(input.model, signal);
      const size = Buffer.byteLength(JSON.stringify({ prompt: input.prompt }), "utf8") + check().contextReserveBytes;
      const capacity = Math.min(limit.input ?? limit.context, limit.context - limit.output);
      if (!Number.isSafeInteger(capacity) || capacity <= 0 || size > capacity) {
        throw new OptChatError(`compressor prompt exceeds conservative model capacity (inputBytes=${size}, capacity=${capacity})`);
      }
      return (await run(ctx.generate.text(input), { signal })).text;
    },
  };
  const session = async (id: SessionContext["sessionID"], model?: Model.Ref, signal?: AbortSignal): Promise<SessionMemory> => {
    const config = check();
    let owner = sessions.get(id);
    if (!owner) {
      if (!model) throw new OptChatError("memory has not been opened by a context request");
      owner = SessionMemory.open({ id, host, options: config, model }, signal);
      sessions.set(id, owner);
      owner.catch(() => { if (sessions.get(id) === owner) sessions.delete(id); });
    }
    return owner;
  };
  yield* Effect.addFinalizer(() => Effect.promise(async () => {
    closing = true;
    const results = await Promise.allSettled([...sessions.values()].map(async (owner) => (await owner).close(true)));
    const errors = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
    if (errors.length) throw new AggregateError(errors, "OptChat disposal failed");
  }));
  yield* ctx.session.hook("context", (event) => Effect.tryPromise({
    try: async (signal) => {
      check();
      const owner = await deadline(session(event.sessionID, event.model, signal), signal);
      await owner.transform(event, await limits(event.model, signal), signal);
    },
    catch: (error) => error instanceof Error ? error : new OptChatError("context admission failed", { cause: error }),
  }).pipe(Effect.orDie));
  yield* ctx.session.hook("compaction", () => Effect.die(new OptChatError("host compaction is unsupported; configure compaction.auto=false")));
  yield* ctx.tool.transform((editor) => memoryTools(editor, session));
  yield* ctx.event.subscribe().pipe(Stream.runForEach((event) => {
    if (event.type !== "session.execution.succeeded" && event.type !== "session.execution.failed" &&
      !(event.type === "session.execution.interrupted" && event.data.reason !== "shutdown")) return Effect.void;
    const owner = sessions.get(event.data.sessionID);
    if (!owner || closing) return Effect.void;
    return Effect.tryPromise({
      try: async () => { await (await owner).capture(); },
      catch: (error) => error instanceof Error ? error : new OptChatError("idle capture failed", { cause: error }),
    }).pipe(
      Effect.catch((error) => Effect.sync(() => console.warn("OptChat: idle capture deferred to the next context",
        { sessionID: event.data.sessionID, error: error.name }))),
    );
  }), Effect.catch((error) => Effect.sync(() => console.warn("OptChat: event stream ended; context reconciliation remains active",
    error instanceof Error ? error.name : "unknown error"))), Effect.forkScoped);
}) });
