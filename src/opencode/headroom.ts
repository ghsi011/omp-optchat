import { tool } from "@opencode-ai/plugin";
import { OptChatError } from "./options.js";
import type { HostMessages } from "./session.js";

const z = tool.schema;
const positive = z.number().finite().int().positive().max(Number.MAX_SAFE_INTEGER);
const modelSchema = z.object({ id: z.string(), providerID: z.string(),
  limit: z.object({ context: positive, input: positive.optional(), output: positive }) });
interface Observation {
  readonly ticket: AdmissionTicket;
  messageBytes?: number;
  readonly systems: Map<string, Set<readonly string[]>>;
}
export interface AdmissionTicket {
  readonly sessionID: string;
  readonly generation: number;
  readonly userID: string;
  readonly agent: string;
}
interface ToolDefinition {
  readonly description: string;
  readonly parameters: unknown;
}
const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), "utf8");
const metadataSchema = z.record(z.string(), z.unknown());

function opaqueReasoning(metadata: unknown): boolean {
  const providers = metadataSchema.parse(metadata ?? {});
  for (const [provider, value] of Object.entries(providers)) {
    const parsed = metadataSchema.safeParse(value);
    if (!parsed.success) continue;
    const fields = parsed.data;
    if (fields.redactedData != null || fields.redactedContent != null) return true;
    if (provider === "openai" && (fields.reasoningEncryptedContent != null ||
      (typeof fields.itemId === "string" && fields.itemId.length > 0))) return true;
  }
  return false;
}

export class Headroom {
  private readonly observations = new Map<string, Observation>();
  private readonly tools = new Map<string, { readonly definition: ToolDefinition; readonly maximum: number }>();
  private reserve: number;
  private generation = 0;

  constructor(reserveBytes: number) { this.reserve = positive.parse(reserveBytes); }

  reserved(value: unknown): void {
    if (value !== undefined) this.reserve = Math.max(this.reserve, z.number().finite().int().nonnegative().parse(value));
  }

  begin(sessionID: string, messages: HostMessages): AdmissionTicket {
    const user = messages.findLast((message) => message.info.role === "user");
    if (!user || user.info.role !== "user" || messages.some((message) => message.info.sessionID !== sessionID)) throw new OptChatError("headroom snapshot has no consistent user identity");
    const ticket = { sessionID, generation: ++this.generation, userID: user.info.id, agent: user.info.agent };
    this.observations.set(sessionID, { ticket, systems: new Map() });
    return ticket;
  }

  current(sessionID: string): AdmissionTicket | undefined { return this.observations.get(sessionID)?.ticket; }

  assert(ticket: AdmissionTicket): Observation {
    const observation = this.observations.get(ticket.sessionID);
    if (!observation || observation.ticket.generation !== ticket.generation) throw new OptChatError("headroom snapshot is missing or stale");
    return observation;
  }

  messages(ticket: AdmissionTicket, messages: HostMessages): void {
    const observation = this.assert(ticket);
    if (messages.findLast((message) => message.info.role === "user")?.info.id !== ticket.userID) throw new OptChatError("headroom user changed during transform");
    for (const message of messages) {
      if (message.parts.some((part) => part.type === "reasoning" && opaqueReasoning(part.metadata))) {
        throw new OptChatError("opaque provider reasoning capacity cannot be accounted for; use a new text-only session");
      }
      if (message.parts.some((part) => part.type === "tool" && part.state.status === "completed" && part.state.time.compacted !== undefined)) {
        throw new OptChatError("active tool result was pruned by the host; use a new session");
      }
      if (message.parts.some((part) => part.type === "file" || (part.type === "tool" && part.state.status === "completed" && part.state.attachments?.length))) {
        throw new OptChatError("active attachment capacity cannot be accounted for; use a text-only turn");
      }
    }
    observation.messageBytes = bytes(messages);
  }

  system(ticket: AdmissionTicket, model: unknown, lines: readonly string[]): void {
    const observation = this.assert(ticket);
    const selected = modelSchema.parse(model);
    const key = JSON.stringify([selected.providerID, selected.id]);
    let existing = observation.systems.get(key);
    if (!existing) { existing = new Set(); observation.systems.set(key, existing); }
    if (existing.size >= 128) throw new OptChatError("too many system observations for one request");
    existing.add(lines);
  }

  tool(id: string, definition: ToolDefinition): void {
    const previous = this.tools.get(id);
    const maximum = Math.max(previous?.maximum ?? 0, previous ? bytes(previous.definition) : 0, bytes(definition));
    if (this.tools.size >= 4_096 && !previous) throw new OptChatError("too many tool definitions for bounded admission");
    this.tools.set(id, { definition: previous && bytes(previous.definition) > bytes(definition) ? previous.definition : definition, maximum });
  }

  compressorOutput(model: unknown, outputTokens: number | undefined): number {
    return Math.min(modelSchema.parse(model).limit.output, positive.parse(outputTokens), 4_096);
  }

  admit(request: { readonly ticket: AdmissionTicket; readonly userID: string; readonly agent: string; readonly model: unknown; readonly outputTokens: number | undefined }): void {
    const observation = this.assert(request.ticket);
    if (observation.ticket.agent !== request.agent) throw new OptChatError("unmeasured auxiliary model request is unsupported");
    if (observation.messageBytes === undefined || observation.ticket.userID !== request.userID) throw new OptChatError("headroom snapshot is missing or stale");
    const model = modelSchema.parse(request.model);
    const system = observation.systems.get(JSON.stringify([model.providerID, model.id]));
    if (!system) throw new OptChatError("headroom snapshot lacks the current model system");
    const output = positive.safeParse(request.outputTokens);
    if (!output.success || output.data > model.limit.output) throw new OptChatError("effective output allocation is unknown or exceeds the model limit");
    const capacity = Math.min(model.limit.input ?? model.limit.context, model.limit.context - output.data) - this.reserve;
    const toolBytes = [...this.tools.values()].reduce((total, value) => total + Math.max(value.maximum, bytes(value.definition)) + 1, 2);
    const observed = observation.messageBytes + Math.max(...[...system].map(bytes)) + toolBytes;
    if (observed > capacity) throw new OptChatError(`insufficient model headroom after OptChat settlement: ${observed} observed bytes + ${this.reserve} reserve, ${capacity + this.reserve} usable input units for ${model.providerID}/${model.id}; reduce the active text/tool payload or choose a larger model`);
    this.observations.delete(request.ticket.sessionID);
  }

  clear(): void { this.observations.clear(); this.tools.clear(); }
  remove(sessionID: string): void { this.observations.delete(sessionID); }
}
