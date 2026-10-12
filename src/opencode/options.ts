import { isAbsolute } from "node:path";
import { Model } from "@opencode/plugin/effect";
import { Schema } from "effect";

const integer = (min: number, max: number) => Schema.Int.check(Schema.isBetween({ minimum: min, maximum: max }));
const schema = Schema.Struct({
  directory: Schema.String.check(Schema.isMinLength(1), Schema.makeFilter(isAbsolute)),
  model: Schema.optionalKey(Model.Ref),
  nodeBytes: Schema.optionalKey(integer(32, 32_768)),
  viewBytes: Schema.optionalKey(integer(128, 16_777_216)),
  compressionTimeoutMs: Schema.optionalKey(integer(100, 600_000)),
  contextReserveBytes: Schema.optionalKey(integer(1_024, 16_777_216)),
  enabled: Schema.optionalKey(Schema.Boolean),
});

export function parseOptions(input: unknown) {
  const parsed = Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(input);
  return { nodeBytes: 512, viewBytes: 128_000, compressionTimeoutMs: 60_000,
    contextReserveBytes: 16_384, enabled: true, ...parsed };
}
export type Options = ReturnType<typeof parseOptions>;

export class OptChatError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(`OptChat: ${message}`, options);
    this.name = "OptChatError";
  }
}
export class HistoryConflictError extends OptChatError {}

export function deadline<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new OptChatError("operation cancelled or timed out"));
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

export function assertNever(value: never): never {
  throw new OptChatError("unsupported host variant", { cause: value });
}
