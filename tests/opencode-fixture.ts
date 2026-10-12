import { createOpencodeClient, type AssistantMessage, type Session, type UserMessage } from "@opencode-ai/sdk";
import type { PluginInput } from "@opencode-ai/plugin";
import type { HostMessages } from "../src/opencode/session.ts";

export function user(id: string, sessionID = "s", time = 1, text = id): HostMessages[number] {
  const info: UserMessage = { id, sessionID, role: "user", agent: "build", time: { created: time },
    model: { providerID: "fixture", modelID: "default-user-model" } };
  return { info, parts: [{ id: `part-${id}`, messageID: id, sessionID, type: "text", text }] };
}

export function assistant(id: string, sessionID = "s", parentID = "u", text = id): HostMessages[number] {
  const info: AssistantMessage = { id, sessionID, parentID, role: "assistant", time: { created: 2, completed: 3 },
    modelID: "default-user-model", providerID: "fixture", mode: "build", path: { cwd: "/", root: "/" },
    cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, finish: "stop" };
  return { info, parts: [{ id: `part-${id}`, messageID: id, sessionID, type: "text", text }] };
}

export function fixture(directory: string) {
  const histories = new Map<string, HostMessages>();
  const sessions = new Map<string, Session>();
  const requestedModels: unknown[] = [];
  const deleted: string[] = [];
  const getGates = new Map<string, { readonly entered: ReturnType<typeof Promise.withResolvers<void>>; readonly release: ReturnType<typeof Promise.withResolvers<void>> }>();
  let prompts = 0;
  let hang = false;
  const sessionInfo = (id: string): Session => ({ id, projectID: "fixture", directory, title: id, version: "1.19.0", time: { created: 1, updated: 1 } });
  sessions.set("s", sessionInfo("s"));
  sessions.set("other", sessionInfo("other"));
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    const id = path.split("/")[2] ?? "";
    if (path === "/session" && request.method === "POST") {
      const body: unknown = await request.json();
      if (typeof body !== "object" || body === null || !("parentID" in body) || !("title" in body) ||
        typeof body.parentID !== "string" || typeof body.title !== "string") return new Response("invalid", { status: 400 });
      const child = { ...sessionInfo(`child-${sessions.size}`), parentID: body.parentID, title: body.title };
      sessions.set(child.id, child);
      return Response.json(child);
    }
    if (path.endsWith("/message") && request.method === "GET") return Response.json(histories.get(id) ?? []);
    if (path.endsWith("/message") && request.method === "POST") {
      prompts++;
      const body: unknown = await request.json();
      if (typeof body === "object" && body !== null && "model" in body) requestedModels.push(body.model);
      if (hang) return new Promise<Response>(() => undefined);
      return Response.json(assistant(`summary-${prompts}`, id, "child-user", "short memory summary"));
    }
    if (path.endsWith("/abort")) return Response.json(true);
    if (request.method === "DELETE") { deleted.push(id); sessions.delete(id); return Response.json(true); }
    const gate = getGates.get(id);
    if (gate) { gate.entered.resolve(); await gate.release.promise; }
    const info = sessions.get(id);
    return info ? Response.json(info) : new Response("missing", { status: 404 });
  } });
  const host: PluginInput = {
    client: createOpencodeClient({ baseUrl: server.url.toString() }), directory, worktree: directory,
    project: { id: "fixture", worktree: directory, time: { created: 1 } },
    experimental_workspace: { register() {} }, serverUrl: server.url, $: Bun.$,
  };
  return { host, histories, sessions, requestedModels, deleted, get prompts() { return prompts; },
    holdGet(id: string) {
      const gate = { entered: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() };
      getGates.set(id, gate);
      return { entered: gate.entered.promise, release: () => gate.release.resolve() };
    },
    set hang(value: boolean) { hang = value; }, close: () => server.stop(true) };
}
