import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import type { Hooks, PluginInput } from "@opencode-ai/plugin";
import { Memory } from "../memory.js";
import { Store, type Message } from "../store.js";
import { Compressor } from "./compressor.js";
import { deadline, failure, OptChatError, type ModelSelection, type Options } from "./options.js";
import { activeAnchor, admitHistory, projectHistory, type CanonicalHistory, type CapturedRecord } from "./projection.js";
import { settledPrefix } from "./prefix.js";

type Transform = NonNullable<Hooks["experimental.chat.messages.transform"]>;
export type HostMessages = Parameters<Transform>[1]["messages"];
const hash = (value: string): string => createHash("sha256").update(value).digest("hex");

function validatePrefix(stored: readonly Message[], records: readonly CapturedRecord[]): void {
  if (stored.length > records.length) throw new OptChatError("canonical history was removed or became incomplete; use a new session");
  for (const [index, prior] of stored.entries()) {
    const next = records[index];
    const a = prior.metadata?.source;
    const b = next?.metadata.source;
    if (!next || !a || !b || a.host !== b.host || a.sessionID !== b.sessionID || a.messageID !== b.messageID ||
      a.partID !== b.partID || a.slot !== b.slot || prior.kind !== next.kind || prior.text !== next.text ||
      prior.date !== next.date.toISOString() || JSON.stringify(prior.metadata?.work) !== JSON.stringify(next.metadata.work)) {
      throw new OptChatError("canonical history conflicts with the durable prefix; use a new session");
    }
  }
  const identities = new Set(records.map((record) => JSON.stringify(record.metadata.source)));
  if (identities.size !== records.length) throw new OptChatError("duplicate canonical source identity");
}

export function reconcile(memory: Memory, records: readonly CapturedRecord[]): void {
  const stored = memory.store.messages;
  validatePrefix(stored, records);
  for (const record of records.slice(stored.length)) memory.append(record.kind, record.text, record.date, record.metadata);
}

export class SessionMemory {
  private tail: Promise<void> = Promise.resolve();
  private failed: Error | undefined;
  private closing = false;
  private closePromise: Promise<void> | undefined;
  private frozen: { readonly anchor: string; readonly view: string } | undefined;
  private model: ModelSelection | undefined;

  private constructor(readonly id: string, readonly memory: Memory, private readonly host: PluginInput,
    private readonly options: Options, private readonly controller: AbortController) {}

  static async open(input: { readonly id: string; readonly host: PluginInput; readonly options: Options; readonly compressor: Compressor }): Promise<SessionMemory> {
    const { id, host, options, compressor } = input;
    const signal = AbortSignal.timeout(options.compressionTimeoutMs);
    const [snapshot, info] = await deadline(Promise.all([
      host.client.session.messages({ path: { id }, signal }), host.client.session.get({ path: { id }, signal }),
    ]), signal);
    if (!info.data || info.data.id !== id || info.data.revert) throw new OptChatError("session unavailable or reverted; use a new session");
    const history = admitHistory(snapshot.data, id);
    const records = projectHistory(history);
    const latest = history.findLast((row) => row.info.role === "user");
    const initialModel = latest?.info.role === "user" ? latest.info.model : undefined;
    const project = await realpath(host.worktree && host.worktree !== "/" ? host.worktree : host.directory);
    const store = await Store.open(join(options.directory, hash(project), hash(id)));
    const controller = new AbortController();
    let session: SessionMemory | undefined;
    const summarize = compressor.forSession(id, () => {
      const model = options.model ?? session?.model;
      if (!model) throw new OptChatError("no persisted user model is available for compression");
      return model;
    });
    try {
      validatePrefix(store.messages, records);
      const memory = new Memory(store, summarize, { nodeBytes: options.nodeBytes, viewBytes: options.viewBytes, jobs: 2 });
      session = new SessionMemory(id, memory, host, options, controller);
      session.model = initialModel;
      return session;
    } catch (error) {
      await store.close();
      throw error;
    }
  }

  run<T>(action: () => Promise<T>, poison = true): Promise<T> {
    if (this.closing) return Promise.reject(new OptChatError("session is closing"));
    const result = this.tail.then(async () => {
      if (this.failed) throw this.failed;
      return action();
    });
    this.tail = result.then(() => undefined, (error: unknown) => { if (poison) this.failed = failure(error); });
    return result;
  }

  async refresh(signal = AbortSignal.any([this.controller.signal, AbortSignal.timeout(this.options.compressionTimeoutMs)]), throughID?: string): Promise<{ readonly records: CapturedRecord[]; readonly anchor: string; readonly history: CanonicalHistory }> {
    const [session, messages] = await deadline(Promise.all([
      this.host.client.session.get({ path: { id: this.id }, signal }),
      this.host.client.session.messages({ path: { id: this.id }, signal }),
    ]), signal);
    if (!session.data || session.data.id !== this.id || session.data.revert) {
      throw new OptChatError("session unavailable or reverted; use a new session");
    }
    if (!messages.data) throw new OptChatError("canonical history could not be read");
    const canonical = admitHistory(messages.data, this.id);
    const through = throughID === undefined ? canonical.length - 1 : canonical.findIndex((row) => row.info.id === throughID);
    if (through < 0) throw new OptChatError("incoming model snapshot is absent from canonical history");
    const history = canonical.slice(0, through + 1);
    const user = history.findLast((row) => row.info.role === "user");
    if (user?.info.role === "user") this.model = user.info.model;
    const records = projectHistory(canonical);
    reconcile(this.memory, records);
    return { records, anchor: activeAnchor(history), history };
  }

  transform(messages: HostMessages): Promise<void> {
    return this.run(async () => {
      const { records, anchor, history } = await this.refresh(undefined, messages.at(-1)?.info.id);
      const latestUser = messages.findLast((row) => row.info.role === "user");
      if (!latestUser || !records.some((record) => record.metadata.source.messageID === latestUser.info.id)) {
        throw new OptChatError("incomplete historical assistant blocks durable capture; use a new session");
      }
      const at = messages.findIndex((row) => row.info.id === anchor && row.info.role === "user");
      const current = messages[at];
      if (at < 0 || !current || current.info.role !== "user") throw new OptChatError("active raw turn is absent from model context");
      if (messages.some((row) => row.info.sessionID !== this.id)) throw new OptChatError("mixed-session model context");
      let previous = at - 1;
      for (const row of history.slice(history.findIndex((entry) => entry.info.id === anchor))) {
        const publicParts = row.parts.filter((part) => part.type === "text" || part.type === "file" || part.type === "tool");
        if (publicParts.length === 0) continue;
        const index = messages.findIndex((entry) => entry.info.id === row.info.id);
        const incoming = messages[index];
        if (index <= previous || !incoming || publicParts.some((part) => !incoming.parts.some((entry) => entry.id === part.id))) {
          throw new OptChatError("active raw tool loop is incomplete or reordered in model context");
        }
        previous = index;
      }
      if (this.frozen?.anchor !== anchor) {
        const cutoff = records.findIndex((record) => record.metadata.source.messageID === anchor);
        if (cutoff < 0) throw new OptChatError("active user has no durable public record");
        const signal = AbortSignal.any([this.controller.signal, AbortSignal.timeout(this.options.compressionTimeoutMs)]);
        this.frozen = { anchor, view: await settledPrefix(this.memory, cutoff, signal) };
      } else if (!await this.memory.settle(AbortSignal.any([this.controller.signal, AbortSignal.timeout(this.options.compressionTimeoutMs)]))) {
        throw new OptChatError("summary work failed or timed out; raw history remains durable");
      }
      const view = this.frozen.view;
      const suffix = messages.slice(at);
      const replacement: HostMessages = view === "<chat>\n</chat>" ? suffix : [{
        info: { ...current.info, id: `optchat-view-${anchor}` },
        parts: [{ type: "text", id: `optchat-view-part-${anchor}`, messageID: `optchat-view-${anchor}`,
          sessionID: this.id, text: view, synthetic: true }],
      }, ...suffix];
      messages.splice(0, messages.length, ...replacement);
    });
  }

  close(capture = false): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.controller.abort();
    this.closePromise = this.tail.then(async () => {
      try {
        if (capture) await this.refresh(AbortSignal.timeout(5_000));
      } finally {
        await this.memory.close();
        await this.memory.store.close();
      }
    });
    return this.closePromise;
  }
}
