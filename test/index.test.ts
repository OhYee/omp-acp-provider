import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ompAcpProvider, { __testing } from "../index";
import type { ExtensionAPI, ExtensionModelQuery, ProviderConfig } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";

import type { AssistantMessage, Model as OmpModel } from "@oh-my-pi/pi-ai";

function textOf(message: AssistantMessage): string {
  return message.content.flatMap(part => part.type === "text" ? [part.text] : []).join("");
}

describe("ACP provider config and prompt", () => {
  test("registers separate agents and preserves client-specific arguments", () => {
    const dir = mkdtempSync(join(tmpdir(), "omp-acp-provider-"));
    const path = join(dir, "config.json");
    try {
      writeFileSync(path, JSON.stringify({ agents: [
        { id: "first", command: "agent-a", args: ["acp"], contextWindow: 64000 },
        { id: "second", name: "Second", command: "agent-b", args: ["--acp", "--tools", ""] },
      ] }));
      const agents = __testing.readAgents(path);
      expect(agents.map(agent => agent.id)).toEqual(["first", "second"]);
      expect(agents[1]?.args).toEqual(["--acp", "--tools", ""]);
      expect(agents[0]?.contextWindow).toBe(64000);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  test("expands built-in ACP shortcuts and merges model metadata overrides", () => {
    const dir = mkdtempSync(join(tmpdir(), "omp-acp-provider-"));
    const path = join(dir, "config.json");
    try {
      writeFileSync(path, JSON.stringify({
        auto: Object.fromEntries([
          "auggie", "bob", "claude", "cline", "codebuddy", "codex", "copilot", "cursor",
          "gemini", "goose", "kimi", "kiro", "minimax", "mistral", "opencode", "qwen",
        ].map(id => [id, true])),
        agents: [{
          id: "codebuddy",
          modelOverrides: { "glm-5.3": { contextWindow: 96000, maxTokens: 8192, cost: { input: 0.5 } } },
        }],
      }));
      const agents = __testing.readAgents(path);
      expect(agents.map(agent => agent.id)).toEqual([
        "auggie", "bob", "claude", "cline", "codebuddy", "codex", "copilot", "cursor",
        "gemini", "goose", "kimi", "kiro", "minimax", "mistral", "opencode", "qwen",
      ]);
      expect(agents.find(agent => agent.id === "claude")?.metadataProvider).toBe("anthropic");
      expect(agents.find(agent => agent.id === "codebuddy")?.metadataProvider).toBe("codebuddy");
      expect(agents.find(agent => agent.id === "codex")?.metadataProvider).toBe("openai");
      expect(agents.find(agent => agent.id === "gemini")?.metadataProvider).toBe("google");
      expect(agents.map(agent => [agent.id, agent.command, agent.args])).toEqual([
        ["auggie", "auggie", ["--acp"]],
        ["bob", "bob", ["acp"]],
        ["claude", "claude-agent-acp", []],
        ["cline", "cline", ["--acp"]],
        ["codebuddy", "codebuddy", ["--acp", "--tools", ""]],
        ["codex", "codex-acp", []],
        ["copilot", "copilot", ["--acp"]],
        ["cursor", "cursor-agent", ["acp"]],
        ["gemini", "gemini", ["--acp"]],
        ["goose", "goose", ["acp"]],
        ["kimi", "kimi", ["acp"]],
        ["kiro", "kiro-cli", ["acp", "--agent-engine=v3"]],
        ["minimax", "mcode", ["acp"]],
        ["mistral", "vibe-acp", []],
        ["opencode", "opencode", ["acp"]],
        ["qwen", "qwen", ["--acp", "--experimental-skills"]],
      ]);
      const agent = agents.find(agent => agent.id === "codebuddy")!;
      expect(agent).toMatchObject({ contextWindow: 128000, maxTokens: 16384 });
      const catalogModel = {
        contextWindow: 128000,
        maxTokens: 4096,
        cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
        reasoning: true,
      } as unknown as OmpModel;
      const claudeAgent = agents.find(agent => agent.id === "claude")!;
      expect(__testing.findCatalogModel(claudeAgent, "claude-opus-4-6", {
        resolve: (id: string) => id === "anthropic/claude-opus-4-6" ? catalogModel : undefined,
      } as unknown as ExtensionModelQuery)).toBe(catalogModel);
      const runtimeModels = new Map([["glm-5.3", { contextWindow: 1_000_000, maxTokens: 48_000 }]]);
      const runtimeMetadata = __testing.getRuntimeModelMetadata(agent, "codebuddy/glm-5.3", runtimeModels);
      expect(__testing.getRuntimeModelMetadata(agent, "codebuddy/glm-5.3")).toBeUndefined();
      expect(runtimeMetadata).toEqual({ contextWindow: 1_000_000, maxTokens: 48_000 });
      const agentWithoutOverrides = { ...agent, modelOverrides: {} };
      const runtimeModel = __testing.agentModel(agentWithoutOverrides, "codebuddy/glm-5.3", "GLM", false, undefined, undefined, runtimeMetadata);
      expect(runtimeModel).toMatchObject({ contextWindow: 1_000_000, maxTokens: 48_000 });
      const observedModel = __testing.agentModel(agentWithoutOverrides, "codebuddy/glm-5.3", "GLM", false, undefined, 64000, runtimeMetadata);
      expect(observedModel.contextWindow).toBe(64000);
      const resolvedCodeBuddyModel = __testing.findCatalogModel(agentWithoutOverrides, "glm-5.3", {
        resolve: (id: string) => id === "codebuddy/glm-5.3" ? catalogModel : undefined,
      } as unknown as ExtensionModelQuery);
      expect(resolvedCodeBuddyModel).toBe(catalogModel);
      const model = __testing.agentModel(agent, "codebuddy/glm-5.3", "GLM", false, catalogModel, 64000, runtimeMetadata);
      expect(model).toMatchObject({
        contextWindow: 96000,
        maxTokens: 8192,
        reasoning: true,
        cost: { input: 0.5, output: 2, cacheRead: 3, cacheWrite: 4 },
      });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("allows native CodeBuddy arguments to override preset tool filtering", () => {
    const dir = mkdtempSync(join(tmpdir(), "omp-acp-provider-"));
    const path = join(dir, "config.json");
    try {
      writeFileSync(path, JSON.stringify({
        auto: { codebuddy: true },
        agents: [{ id: "codebuddy", args: ["--acp", "--tools", "Read,Glob"] }],
      }));
      expect(__testing.readAgents(path)[0]?.args).toEqual(["--acp", "--tools", "Read,Glob"]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("auto-approves ACP permission requests for one operation only", () => {
    const options = [
      { optionId: "allow-once", name: "Allow once", kind: "allow_once" as const },
      { optionId: "allow-always", name: "Allow always", kind: "allow_always" as const },
      { optionId: "reject-once", name: "Reject once", kind: "reject_once" as const },
    ];
    expect(__testing.allowPermissionRequest(options)).toEqual({ outcome: { outcome: "selected", optionId: "allow-once" } });
    expect(__testing.allowPermissionRequest([options[1]!, options[2]!])).toEqual({ outcome: { outcome: "cancelled" } });
  });

  test("discovers ACP models, selects the requested one, and streams its answer", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omp-acp-provider-"));
    const previous = process.env.PI_CODING_AGENT_DIR;
    const previousCodeBuddyConfigDir = process.env.CODEBUDDY_CONFIG_DIR;
    const previousXdgCacheHome = process.env.XDG_CACHE_HOME;
    const previousXdgConfigHome = process.env.XDG_CONFIG_HOME;
    const previousOpenCodeConfig = process.env.OPENCODE_CONFIG;
    const previousOpenCodeConfigDir = process.env.OPENCODE_CONFIG_DIR;
    const previousOpenCodeConfigContent = process.env.OPENCODE_CONFIG_CONTENT;
    const acpServer = `
      const readline = require("node:readline");
      process.stderr.write("diagnostic".repeat(100000));
      const send = value => process.stdout.write(JSON.stringify(value) + "\\n");
      let selected = "m1";
      let promptRequest;
      let permissionRequestId;
      readline.createInterface({ input: process.stdin }).on("line", line => {
        const request = JSON.parse(line);
        if (!("id" in request)) return;
        if (!("method" in request)) {
          if (request.id !== permissionRequestId) return;
          const allowed = request.result?.outcome?.optionId === "allow-once";
          const history = JSON.stringify(promptRequest.params.prompt).includes("prior answer") ? "replayed" : "missing";
          send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "test-session", update: {
            sessionUpdate: "tool_call_update", toolCallId: "mock-tool", title: "Mock read", status: allowed ? "completed" : "failed"
          } } });
          send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "test-session", update: {
            sessionUpdate: "agent_message_chunk", content: { type: "text",
              text: (selected === "m2" ? "selected model" : "default model") + "; permission " + (allowed ? "granted" : "denied") + "; history " + history }
          } } });
          send({ jsonrpc: "2.0", id: promptRequest.id, result: { stopReason: "end_turn" } });
          return;
        }
        if (request.method === "session/prompt") {
          promptRequest = request;
          permissionRequestId = "permission-" + request.id;
          send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "test-session", update: {
            sessionUpdate: "usage_update", used: 321, size: 32768, cost: { amount: 0.012, currency: "USD" }
          } } });
          send({ jsonrpc: "2.0", id: permissionRequestId, method: "session/request_permission", params: {
            sessionId: "test-session",
            toolCall: { toolCallId: "mock-tool", kind: "read", title: "Mock read", status: "pending" },
            options: [
              { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
              { optionId: "reject-once", name: "Reject once", kind: "reject_once" }
            ]
          } });
          return;
        }
        let result = {};
        if (request.method === "initialize") result = { protocolVersion: 1 };
        else if (request.method === "session/new") result = {
          sessionId: "test-session",
          configOptions: [{ id: "model", name: "Model", category: "model", type: "select", currentValue: "m1",
            options: [{ name: "Model 1", value: "m1" }, { name: "Model 2", value: "m2" }] }]
        };
        else if (request.method === "session/set_config_option") {
          selected = request.params.value;
          result = { configOptions: [] };
        }
        send({ jsonrpc: "2.0", id: request.id, result });
      });
    `;
    const noisyAgent = 'process.stderr.write("diagnostic-line\\\\n".repeat(1000)); process.exit(1);';
    try {
      const localStorage = join(dir, "local_storage");
      mkdirSync(localStorage);
      writeFileSync(join(localStorage, "entry_runtime.info"), JSON.stringify([
        { ts: 1, data: { models: [
          { id: "m2", maxInputTokens: 960_000, maxOutputTokens: 64_000, credits: "x0.00 credits" },
        ] } },
      ]));
      const openCodeCacheDirectory = join(dir, "opencode");
      mkdirSync(openCodeCacheDirectory);
      writeFileSync(join(openCodeCacheDirectory, "models.json"), JSON.stringify({
        openai: { models: {
          m2: {
            limit: { context: 960_000, output: 64_000 },
            cost: { input: 0.2, output: 0.8, cache_read: 0.02 },
          },
        } },
      }));
      writeFileSync(join(dir, "acp-provider.json"), JSON.stringify({ agents: [
        { id: "mock", command: process.execPath, args: ["-e", acpServer], contextWindow: 4096, metadataProvider: "test-catalog" },
        { id: "broken", command: join(dir, "missing-agent"), contextWindow: 8192 },
        { id: "noisy", command: process.execPath, args: ["-e", noisyAgent], contextWindow: 4096 },
        { id: "codebuddy", command: process.execPath, args: ["-e", acpServer], contextWindow: 128000 },
        { id: "opencode", command: process.execPath, args: ["-e", acpServer], contextWindow: 128000, metadataProvider: "openai" },
      ] }));
      process.env.PI_CODING_AGENT_DIR = dir;
      process.env.CODEBUDDY_CONFIG_DIR = dir;
      process.env.XDG_CACHE_HOME = dir;
      process.env.XDG_CONFIG_HOME = join(dir, "config");
      process.env.OPENCODE_CONFIG = "";
      process.env.OPENCODE_CONFIG_DIR = join(dir, "extra-config");
      process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
        providers: { openai: { models: { m2: { limit: { context: 1_200_000, output: 96_000 } } } } },
      });
      const registrations = new Map<string, ProviderConfig>();
      const registerProvider = (name: string, config: ProviderConfig) => { registrations.set(name, config); };
      let startHandler: ((event: unknown, context: { models: ExtensionModelQuery }) => void) | undefined;
      const catalogModel = {
        contextWindow: 64000,
        maxTokens: 2048,
        cost: { input: 1.25, output: 2.5, cacheRead: 0, cacheWrite: 0 },
        reasoning: false,
      } as unknown as OmpModel;
      ompAcpProvider({
        registerProvider,
        on: (_event: string, handler: (event: unknown, context: { models: ExtensionModelQuery }) => void) => { startHandler = handler; },
      } as unknown as ExtensionAPI);
      startHandler?.({}, {
        models: {
          list: () => [],
          current: () => undefined,
          resolve: id => id === "test-catalog/m2" ? catalogModel : undefined,
          family: () => "test",
        },
      });
      const registered = registrations.get("acp-mock");
      const broken = registrations.get("acp-broken");
      const codebuddy = registrations.get("acp-codebuddy");
      expect(registered?.models?.[0]?.contextWindow).toBe(4096);
      expect(broken?.models?.[0]?.contextWindow).toBe(8192);
      const models = await registered?.fetchDynamicModels?.("unused");
      const model = models?.find(candidate => candidate.id === "mock/m2");
      expect(model).toMatchObject({ contextWindow: 64000, maxTokens: 2048, cost: { input: 1.25, output: 2.5 } });
      const codebuddyModels = await codebuddy?.fetchDynamicModels?.("unused");
      const codebuddyModel = codebuddyModels?.find(candidate => candidate.id === "codebuddy/m2");
      expect(codebuddyModel).toMatchObject({ contextWindow: 960_000, maxTokens: 64_000 });
      const opencode = registrations.get("acp-opencode");
      const opencodeModels = await opencode?.fetchDynamicModels?.("unused");
      const opencodeModel = opencodeModels?.find(candidate => candidate.id === "opencode/m2");
      expect(opencodeModel).toMatchObject({
        contextWindow: 1_200_000,
        maxTokens: 96_000,
        cost: { input: 0.2, output: 0.8, cacheRead: 0.02, cacheWrite: 0 },
      });
      if (!registered?.streamSimple || !model) {
        throw new Error("Configured ACP provider or discovered model was not registered");
      }
      const context = {
        systemPrompt: ["system rule"],
        messages: [{ role: "user", content: "first request" }],
      } as Parameters<NonNullable<ProviderConfig["streamSimple"]>>[1];
      const stream = registered.streamSimple(
        model as Parameters<NonNullable<ProviderConfig["streamSimple"]>>[0],
        context,
        { cwd: dir },
      );
      const result = await stream.result();
      const resultText = textOf(result);
      expect(resultText).toContain("selected model");
      expect(resultText).toContain("permission granted");
      expect(resultText).toContain("✓ Mock read");
      expect(result.usage).toMatchObject({ contextTokens: 321, cost: { total: 0.012 } });
      const updatedModels = await registered.fetchDynamicModels?.("unused");
      expect(updatedModels?.find(candidate => candidate.id === "mock/m2")?.contextWindow).toBe(32768);

      const continued = {
        systemPrompt: ["system rule"],
        messages: [
          { role: "user", content: "first request" },
          { role: "assistant", content: "prior answer" },
          { role: "user", content: "follow-up" },
        ],
      } as Parameters<NonNullable<ProviderConfig["streamSimple"]>>[1];
      const secondResult = await registered.streamSimple(
        model as Parameters<NonNullable<ProviderConfig["streamSimple"]>>[0],
        continued,
        { cwd: dir },
      ).result();
      expect(textOf(secondResult)).toContain("history replayed");


      if (!broken?.streamSimple || !broken.models?.[0]) throw new Error("Second ACP provider was not registered");
      const failed = await broken.streamSimple(broken.models[0] as Parameters<NonNullable<ProviderConfig["streamSimple"]>>[0], context, { cwd: dir }).result();
      expect(failed.stopReason).toBe("error");
      expect(failed.errorMessage).toContain("missing-agent");
      const noisy = registrations.get("acp-noisy");
      if (!noisy?.streamSimple || !noisy.models?.[0]) throw new Error("Noisy ACP provider was not registered");
      const noisyResult = await noisy.streamSimple(noisy.models[0] as Parameters<NonNullable<ProviderConfig["streamSimple"]>>[0], context, { cwd: dir }).result();
      expect(noisyResult.stopReason).toBe("error");
      expect(noisyResult.errorMessage?.length).toBeLessThan(600);
      expect(noisyResult.errorMessage).toContain("diagnostic-line");
      expect(noisyResult.errorMessage).toContain("ACP stderr (last 5 lines, up to 400 chars)");
    } finally {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
      if (previousCodeBuddyConfigDir === undefined) delete process.env.CODEBUDDY_CONFIG_DIR;
      else process.env.CODEBUDDY_CONFIG_DIR = previousCodeBuddyConfigDir;
      if (previousXdgCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
      else process.env.XDG_CACHE_HOME = previousXdgCacheHome;
      if (previousXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previousXdgConfigHome;
      if (previousOpenCodeConfig === undefined) delete process.env.OPENCODE_CONFIG;
      else process.env.OPENCODE_CONFIG = previousOpenCodeConfig;
      if (previousOpenCodeConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR;
      else process.env.OPENCODE_CONFIG_DIR = previousOpenCodeConfigDir;
      if (previousOpenCodeConfigContent === undefined) delete process.env.OPENCODE_CONFIG_CONTENT;
      else process.env.OPENCODE_CONFIG_CONTENT = previousOpenCodeConfigContent;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects duplicate IDs and invalid context limits", () => {
    const dir = mkdtempSync(join(tmpdir(), "omp-acp-provider-"));
    const path = join(dir, "config.json");
    try {
      writeFileSync(path, JSON.stringify({ agents: [
        { id: "same", command: "agent-a" }, { id: "same", command: "agent-b" },
      ] }));
      expect(() => __testing.readAgents(path)).toThrow("must be unique");
      writeFileSync(path, JSON.stringify({ agents: [{ id: "bad", command: "agent", contextWindow: 0 }] }));
      expect(() => __testing.readAgents(path)).toThrow("contextWindow must be a positive integer");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("replays system instructions and conversation while marking images omitted", () => {
    const prompt = __testing.flattenPrompt({ systemPrompt: "Use concise answers", messages: [
      { role: "user", content: "first turn", timestamp: 1 },
      { role: "assistant", content: [{ type: "text", text: "prior answer" }], timestamp: 2 },
      { role: "user", content: [{ type: "text", text: "next" }, { type: "image", data: "abc", mimeType: "image/png" }], timestamp: 3 },
    ] });
    expect(prompt).toContain("[System instructions]\nUse concise answers");
    expect(prompt).toContain("[Assistant]\nprior answer");
    expect(prompt).toContain("[image attachment not forwarded to ACP]");
  });
});
