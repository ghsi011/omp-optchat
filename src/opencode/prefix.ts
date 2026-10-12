import { setTimeout as delay } from "node:timers/promises";
import { Memory, ViewPrefixUnavailableError } from "../memory.js";
import { OptChatError } from "./options.js";

export async function settledPrefix(memory: Memory, cutoff: number, signal: AbortSignal): Promise<string> {
  if (!await memory.settle(signal)) throw new OptChatError("summary work failed or timed out; raw history remains durable");
  for (;;) {
    if (signal.aborted) throw new OptChatError("summary work cancelled or timed out; raw history remains durable");
    try {
      return memory.renderPrefix(cutoff);
    } catch (error) {
      if (!(error instanceof ViewPrefixUnavailableError) || memory.status().pending === 0) throw error;
      await delay(25, undefined, { signal });
    }
  }
}
