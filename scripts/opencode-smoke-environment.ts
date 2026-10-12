import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { memoryTools } from "./opencode-smoke-fixture.js";

export async function environment(root: string, executable: string, port: number) {
  const temporary = await mkdtemp(join(tmpdir(), "optchat-opencode2-smoke-"));
  const memory = join(temporary, "memory");
  const workspace = join(temporary, "workspace");
  const home = join(temporary, "home");
  const config = join(temporary, "config");
  await Promise.all([memory, workspace, home, config].map((path) => mkdir(path, { recursive: true })));
  const model = { name: "Loopback fixture", limit: { context: 128_000, output: 4_096 },
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    compatibility: { reasoningField: "reasoning_content", maxTokensField: "max_tokens" } };
  const configuration = {
    model: "fixture/chat", update: "disable", share: "disabled", snapshots: false, warming: false,
    agents: { title: { model: "fixture/title" } },
    compaction: { auto: false },
    permissions: [{ action: "*", resource: "*", effect: "deny" },
      ...memoryTools.map((name) => ({ action: name, resource: "*", effect: "allow" }))],
    plugins: [{ package: pathToFileURL(join(root, "src/opencode")).href,
      options: { directory: memory, model: { providerID: "fixture", id: "compact" },
        nodeBytes: 128, viewBytes: 384, compressionTimeoutMs: 20_000 } }],
    providers: { fixture: { package: "@opencode/ai/providers/openai-compatible", name: "Loopback fixture",
      settings: { provider: "fixture", baseURL: `http://127.0.0.1:${port}/v1`, apiKey: "synthetic-fixture-key" },
      models: { chat: model, compact: model, title: model, near: { ...model, limit: { context: 24_000, output: 4_096 } } } } },
  };
  const env: NodeJS.ProcessEnv = {
    PATH: `${dirname(executable)}:${dirname(process.execPath)}:/usr/bin:/bin`, LANG: "C.UTF-8", TZ: "UTC", TERM: "dumb", NO_COLOR: "1",
    HOME: home, TMPDIR: temporary, XDG_CONFIG_HOME: config, XDG_CACHE_HOME: join(temporary, "cache"),
    XDG_STATE_HOME: join(temporary, "state"), XDG_DATA_HOME: join(temporary, "data"),
    OPENCODE_DISABLE_AUTOUPDATE: "true",
    OPENCODE_DISABLE_MODELS_FETCH: "true", OPENCODE_DISABLE_GLOBAL_CONFIG: "true",
    OPENCODE_DISABLE_EXTERNAL_SKILLS: "true", OPENCODE_DISABLE_CLAUDE_CODE: "true", OPENCODE_DISABLE_LSP_DOWNLOAD: "true",
    HTTP_PROXY: "http://127.0.0.1:9", HTTPS_PROXY: "http://127.0.0.1:9", NO_PROXY: "127.0.0.1,localhost",
    npm_config_registry: "http://127.0.0.1:9", npm_config_offline: "true",
  };
  await writeFile(join(workspace, "opencode.json"), JSON.stringify(configuration));
  return { temporary, memory, workspace, env };
}
