import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import type { Model } from "@opencode/plugin/effect";
import type { SessionContext } from "@opencode/plugin/effect/session";
import { Memory } from "../memory.js";
import { Store, type Message } from "../store.js";
import { summarizer, type Generate } from "./compressor.js";
import { activeContext, GUIDE, incomingHistory, withView } from "./context.js";
import { admitContext } from "./headroom.js";
import { deadline, HistoryConflictError, OptChatError, type Options } from "./options.js";
import { projectHistory, stableJson, type History, type CapturedRecord } from "./projection.js";
import { settledPrefix } from "./prefix.js";

export interface SessionHost {
  readonly project: string;
  readonly history: (id: SessionContext["sessionID"], signal: AbortSignal) => Promise<History>;
  readonly generate: Generate;
}
export interface SessionInput {
  readonly id: SessionContext["sessionID"];
  readonly host: SessionHost;
  readonly options: Options;
  readonly model: Model.Ref;
}
const hash = (value: string): string => createHash("sha256").update(value).digest("hex");

export function validatePrefix(stored: readonly Message[], records: readonly CapturedRecord[]): void {
  if (stored.length > records.length) throw new HistoryConflictError("canonical history was removed or became incomplete; use a new session");
  for (const [index, prior] of stored.entries()) {
    const next = records[index];
    if (!next || !prior.metadata?.source || stableJson(prior.metadata) !== stableJson(next.metadata) ||
      prior.kind !== next.kind || prior.text !== next.text || prior.date !== next.date.toISOString()) {
      throw new HistoryConflictError("canonical history conflicts with the durable prefix; use a new session");
    }
  }
}

export function reconcile(memory: Memory, records: readonly CapturedRecord[]): void {
  validatePrefix(memory.store.messages, records);
  for (const record of records.slice(memory.store.messages.length)) memory.append(record.kind, record.text, record.date, record.metadata);
}

export class SessionMemory {
  private tail: Promise<void> = Promise.resolve();
  private conflict: HistoryConflictError | undefined;
  private closing = false;
  private closePromise: Promise<void> | undefined;
  private restart = false;
  private readonly controller = new AbortController();
  private frozen: { readonly anchor: string | undefined; readonly view: string } | undefined;
  private model: Model.Ref;
  private current: Memory | undefined;

  private constructor(private readonly input: SessionInput, readonly store: Store) {
    this.model = input.model;
  }

  get memory(): Memory {
    if (!this.current) throw new OptChatError("memory has not been initialized by context reconciliation");
    return this.current;
  }

  static async open(input: SessionInput, requestSignal = new AbortController().signal): Promise<SessionMemory> {
    const signal = AbortSignal.any([requestSignal, AbortSignal.timeout(input.options.compressionTimeoutMs)]);
    const records = projectHistory(await deadline(input.host.history(input.id, signal), signal), input.id);
    const project = await realpath(input.host.project);
    const store = await Store.open(join(input.options.directory, hash(project), hash(input.id)));
    try {
      validatePrefix(store.messages, records);
      return new SessionMemory(input, store);
    } catch (error) {
      await store.close();
      throw error;
    }
  }

  private createMemory(): Memory {
    const { options, host } = this.input;
    return new Memory(this.store, summarizer(host.generate, () => options.model ?? this.model, options),
      { nodeBytes: options.nodeBytes, viewBytes: options.viewBytes, jobs: 2 });
  }

  run<T>(action: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (this.closing) return Promise.reject(new OptChatError("session is closing"));
    const result = this.tail.then(async () => {
      if (this.conflict) throw this.conflict;
      if (signal?.aborted || this.closing) throw new OptChatError("operation cancelled or session closing");
      return action();
    });
    this.tail = result.then(() => undefined, (error: unknown) => {
      if (error instanceof HistoryConflictError) this.conflict = error;
    });
    return signal ? deadline(result, signal) : result;
  }

  private async snapshot(signal: AbortSignal) {
    const history = await deadline(this.input.host.history(this.input.id, signal), signal);
    const records = projectHistory(history, this.input.id);
    validatePrefix(this.store.messages, records);
    if (!this.current || this.restart) {
      this.current = this.createMemory();
      this.restart = false;
    }
    reconcile(this.memory, records);
    return { history, records };
  }

  capture(): Promise<void> {
    return this.run(async () => {
      const signal = AbortSignal.any([this.controller.signal, AbortSignal.timeout(this.input.options.compressionTimeoutMs)]);
      await this.snapshot(signal);
    });
  }

  transform(event: SessionContext, limit: Model.Info["limit"], requestSignal: AbortSignal): Promise<void> {
    return this.run(async () => {
      const signal = AbortSignal.any([requestSignal, this.controller.signal, AbortSignal.timeout(this.input.options.compressionTimeoutMs)]);
      this.model = event.model;
      try {
        if (event.sessionID !== this.input.id) throw new OptChatError("model context belongs to another session");
        const { records, history } = await this.snapshot(signal);
        const latestUser = event.messages.findLast((message) => message.role === "user" && message.id !== undefined);
        if (!latestUser || !records.some((record) => record.metadata.source.messageID === latestUser.id)) {
          throw new OptChatError("unsettled historical assistant blocks durable capture of the current prompt");
        }
        const active = activeContext(incomingHistory(history, event.messages), event.messages);
        const cutoff = records.findIndex((record) => active.ids.has(record.metadata.source.messageID));
        if (this.frozen?.anchor !== active.anchor) {
          this.frozen = { anchor: active.anchor, view: await settledPrefix(this.memory, cutoff < 0 ? records.length : cutoff, signal) };
        } else if (!await this.memory.settle(signal)) {
          throw new OptChatError("summary work failed or timed out; raw history remains durable");
        }
        const draft: SessionContext = { ...event, messages: withView(active, this.frozen.view),
          system: [...event.system, { type: "text", text: GUIDE }] };
        admitContext(draft, limit, this.input.options.contextReserveBytes);
        if (signal.aborted) throw new OptChatError("context admission cancelled");
        event.messages = draft.messages;
        event.system = draft.system;
      } catch (error) {
        await this.current?.close();
        this.restart = true;
        throw error;
      }
    }, requestSignal);
  }

  close(capture = false): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.controller.abort();
    this.closePromise = this.tail.then(async () => {
      try {
        if (capture && !this.conflict) {
          const signal = AbortSignal.timeout(5_000);
          await this.snapshot(signal);
        }
      } finally {
        await this.current?.close();
        await this.store.close();
      }
    });
    return this.closePromise;
  }
}
