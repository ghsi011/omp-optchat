import { isAbsolute } from "node:path";
import { tool } from "@opencode-ai/plugin";

const z = tool.schema;
const identifier = z.string().min(1).max(256);
export const optionsSchema = z.object({
  directory: z.string().min(1).refine(isAbsolute, "directory must be an absolute Linux path"),
  model: z.object({ providerID: identifier, modelID: identifier }).strict().optional(),
  nodeBytes: z.number().int().min(32).max(32_768).default(512),
  viewBytes: z.number().int().min(128).max(16_777_216).default(128_000),
  compressionTimeoutMs: z.number().int().min(100).max(600_000).default(60_000),
  contextReserveBytes: z.number().int().min(1_024).max(16_777_216).default(16_384),
  enabled: z.boolean().default(true),
}).strict();

export type Options = ReturnType<typeof optionsSchema.parse>;
export type ModelSelection = NonNullable<Options["model"]>;

export class OptChatError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(`OptChat: ${message}`, options);
    this.name = "OptChatError";
  }
}

export function failure(error: unknown): Error {
  return error instanceof Error ? error : new OptChatError("operation failed", { cause: error });
}

export function deadline<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new OptChatError("operation cancelled or timed out"));
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
