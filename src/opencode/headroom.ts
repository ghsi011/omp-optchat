import type { Model } from "@opencode/plugin/effect";
import type { SessionContext } from "@opencode/plugin/effect/session";
import { OptChatError } from "./options.js";

const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), "utf8");
const present = (value: object | undefined): boolean => value !== undefined && Object.keys(value).length > 0;
const generationOptions = new Set(["maxTokens", "temperature", "topP", "topK", "frequencyPenalty", "presencePenalty", "seed", "stop"]);
export interface Budget {
  readonly messageBytes: number;
  readonly systemBytes: number;
  readonly toolBytes: number;
  readonly optionBytes: number;
  readonly reserveBytes: number;
  readonly inputBytes: number;
  readonly capacity: number;
  readonly output: number;
}
export class CapacityError extends OptChatError {
  constructor(readonly budget: Budget) {
    super(`context exceeds conservative capacity; shorten the active turn or use a larger model (${JSON.stringify(budget)})`);
  }
}

export function admitContext(event: SessionContext, limit: Model.Info["limit"], reserveBytes: number): Budget {
  if (Object.keys(event.options).some((key) => !generationOptions.has(key))) {
    throw new OptChatError("provider-specific request options cannot be safely budgeted");
  }
  for (const message of event.messages) {
    if (present(message.native) || present(message.providerMetadata)) throw new OptChatError("opaque provider state cannot be budgeted");
    for (const part of message.content) {
      if (part.type === "media" || part.type === "compaction" || (part.type === "reasoning" && part.encrypted) ||
        ("providerMetadata" in part && present(part.providerMetadata))) {
        throw new OptChatError("active attachment or opaque provider state cannot be budgeted");
      }
      if (part.type === "tool-result" && part.result.type === "content" && part.result.value.some((item) => item.type === "file")) {
        throw new OptChatError("active tool attachment cannot be budgeted");
      }
    }
  }
  const output = event.options.maxTokens;
  if (!Number.isSafeInteger(output) || typeof output !== "number" || output <= 0 || output > limit.output ||
    !Number.isSafeInteger(limit.context) || limit.context <= 0 || !Number.isSafeInteger(limit.output) || limit.output <= 0 ||
    (limit.input !== undefined && (!Number.isSafeInteger(limit.input) || limit.input <= 0))) {
    throw new OptChatError("resolved model limits or output allowance are unavailable");
  }
  const messageBytes = bytes(event.messages), systemBytes = bytes(event.system), toolBytes = bytes(event.tools), optionBytes = bytes(event.options);
  const budget = { messageBytes, systemBytes, toolBytes, optionBytes, reserveBytes,
    inputBytes: messageBytes + systemBytes + toolBytes + optionBytes + reserveBytes,
    capacity: Math.min(limit.input ?? limit.context, limit.context - output), output };
  if (budget.inputBytes > budget.capacity) throw new CapacityError(budget);
  return budget;
}
