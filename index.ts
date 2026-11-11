import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import * as acp from "@agentclientprotocol/sdk";
import { createAssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { toolWireSchema } from "@oh-my-pi/pi-ai/utils/schema/wire";
import type { ExtensionAPI, ExtensionModelQuery } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { AssistantMessage, Model as OmpModel, Tool as OmpTool, ToolCall } from "@oh-my-pi/pi-ai";
type ModelMetadataOverride = {
  contextWindow?: number;
  maxTokens?: number;
  cost?: Partial<Model["cost"]>;
};
type AgentConfig = {
  id: string;
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  contextWindow: number;
  maxTokens: number;
  metadataProvider?: string;
  modelOverrides: Record<string, ModelMetadataOverride>;
};
type Model = {
  id: string; name: string; api: string; provider: string; baseUrl: string;
  reasoning: boolean; input: ("text" | "image")[]; cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number; maxTokens: number;
};
const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 16_384;

const API = "omp-acp-agent";
const COST_KEYS = ["input", "output", "cacheRead", "cacheWrite"] as const;
const AUTO_AGENT_PRESETS: Record<string, Pick<AgentConfig, "id" | "name" | "command" | "args"> & Partial<AgentConfig>> = {
  auggie: { id: "auggie", name: "Auggie", command: "auggie", args: ["--acp"], env: { AUGMENT_DISABLE_AUTO_UPDATE: "1" } },
  bob: { id: "bob", name: "IBM Bob", command: "bob", args: ["acp"] },
  claude: { id: "claude", name: "Claude Agent", command: "claude-agent-acp", args: [], metadataProvider: "anthropic" },
  cline: { id: "cline", name: "Cline", command: "cline", args: ["--acp"] },
  codebuddy: { id: "codebuddy", name: "CodeBuddy", command: "codebuddy", args: ["--acp"], metadataProvider: "codebuddy" },
  codex: { id: "codex", name: "Codex", command: "codex-acp", args: [], metadataProvider: "openai" },
  copilot: { id: "copilot", name: "GitHub Copilot", command: "copilot", args: ["--acp"], metadataProvider: "github-copilot" },
  cursor: { id: "cursor", name: "Cursor", command: "cursor-agent", args: ["acp"], metadataProvider: "cursor" },
  gemini: { id: "gemini", name: "Gemini CLI", command: "gemini", args: ["--acp"], metadataProvider: "google" },
  goose: { id: "goose", name: "Goose", command: "goose", args: ["acp"] },
  kimi: { id: "kimi", name: "Kimi Code", command: "kimi", args: ["acp"], metadataProvider: "moonshot" },
  kiro: { id: "kiro", name: "Kiro CLI", command: "kiro-cli", args: ["acp", "--agent-engine=v3"] },
  minimax: { id: "minimax", name: "MiniMax Code", command: "mcode", args: ["acp"], metadataProvider: "minimax" },
  mistral: { id: "mistral", name: "Mistral Vibe", command: "vibe-acp", args: [], metadataProvider: "mistral" },
  opencode: { id: "opencode", name: "OpenCode", command: "opencode", args: ["acp"], metadataProvider: "opencode" },
  qwen: { id: "qwen", name: "Qwen Code", command: "qwen", args: ["--acp", "--experimental-skills"], metadataProvider: "alibaba" },
};
const zeroUsage = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

type OmpToolRequest = { name: string; arguments: Record<string, unknown> };
type OmpToolBridge = { mcpServer: acp.McpServer; close: () => Promise<void> };
const MAX_TOOL_BRIDGE_REQUEST_BYTES = 1024 * 1024;

function sendBridgeResponse(
  response: ServerResponse,
  status: number,
  body?: unknown,
  headers: Record<string, string> = {},
): void {
  const responseHeaders: Record<string, string> = {
    "cache-control": "no-store",
    "connection": "close",
    "x-content-type-options": "nosniff",
    ...headers,
  };
  if (body !== undefined) responseHeaders["content-type"] = "application/json; charset=utf-8";
  response.writeHead(status, responseHeaders);
  response.end(body === undefined ? undefined : JSON.stringify(body));
}

function bridgeRequestAuthorized(request: IncomingMessage, expected: Buffer, host: string, origin: string): boolean {
  const address = request.socket.remoteAddress;
  if (address !== "127.0.0.1" && address !== "::ffff:127.0.0.1") return false;
  if (request.headers.host !== host) return false;
  if (request.headers.origin !== undefined && request.headers.origin !== origin) return false;
  const authorization = request.headers.authorization;
  if (typeof authorization !== "string") return false;
  const actual = Buffer.from(authorization);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function readBridgeRequestBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_TOOL_BRIDGE_REQUEST_BYTES) throw new RangeError("Tool request exceeds the size limit");
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function mcpResponse(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: "2.0", id, result };
}

function mcpError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function hasJsonRpcId(message: Record<string, unknown>): boolean {
  return Object.hasOwn(message, "id");
}

async function createOmpToolBridge(
  tools: OmpTool[],
  onToolCall: (call: OmpToolRequest) => void,
  transport: "http" | "stdio" = "http",
): Promise<OmpToolBridge> {
  const advertisedTools = tools.map(tool => ({
    name: tool.name,
    description: tool.description,
    inputSchema: toolWireSchema(tool),
  }));
  const toolsByName = new Map(advertisedTools.map(tool => [tool.name, tool]));
  if (toolsByName.size !== advertisedTools.length) throw new Error("OMP tool names must be unique for ACP bridging");

  const token = randomBytes(32).toString("hex");
  const expectedAuthorization = Buffer.from(`Bearer ${token}`);
  let acceptedCall = false;
  let closed = false;
  let bridgeHost = "";
  let bridgeOrigin = "";
  const supportedMcpVersions = new Set(["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"]);
  const handleMcpMessage = async (raw: unknown): Promise<Record<string, unknown> | undefined> => {
    if (!isRecord(raw) || raw.jsonrpc !== "2.0") {
      return mcpError(isRecord(raw) && hasJsonRpcId(raw) ? raw.id : null, -32600, "Invalid JSON-RPC request");
    }
    if (typeof raw.method !== "string") {
      if (Object.hasOwn(raw, "result") || Object.hasOwn(raw, "error")) return undefined;
      return mcpError(hasJsonRpcId(raw) ? raw.id : null, -32600, "Invalid JSON-RPC request");
    }
    if (!hasJsonRpcId(raw)) return undefined;
    const id = raw.id;
    const params = isRecord(raw.params) ? raw.params : {};
    switch (raw.method) {
      case "initialize": {
        const requestedVersion = params.protocolVersion;
        const protocolVersion = typeof requestedVersion === "string" && supportedMcpVersions.has(requestedVersion)
          ? requestedVersion
          : "2025-03-26";
        return mcpResponse(id, {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "omp-native-tools", version: "0.1.0" },
        });
      }
      case "notifications/initialized":
      case "ping":
        return mcpResponse(id, {});
      case "tools/list":
        return mcpResponse(id, { tools: advertisedTools });
      case "tools/call": {
        if (typeof params.name !== "string" || !params.name || !toolsByName.has(params.name)) {
          return mcpError(id, -32602, "Unknown OMP tool");
        }
        if (params.arguments !== undefined && !isRecord(params.arguments)) {
          return mcpError(id, -32602, "Tool arguments must be an object");
        }
        if (acceptedCall) return mcpError(id, -32002, "An OMP tool request is already pending");
        acceptedCall = true;
        try {
          onToolCall({ name: params.name, arguments: (params.arguments ?? {}) as Record<string, unknown> });
        } catch {
          acceptedCall = false;
          return mcpError(id, -32603, "OMP tool request failed");
        }
        return mcpResponse(id, {
          content: [{ type: "text", text: "Forwarded to OMP's native tool runner." }],
        });
      }
      default:
        return mcpError(id, -32601, "Method not found");
    }
  };
  const server = createServer({ maxHeaderSize: 8192 }, async (request, response) => {
    if (closed) {
      sendBridgeResponse(response, 410);
      return;
    }
    if (!bridgeRequestAuthorized(request, expectedAuthorization, bridgeHost, bridgeOrigin)) {
      sendBridgeResponse(response, 401);
      return;
    }
    if (transport === "http" && request.url === "/mcp" && request.method === "GET") {
      sendBridgeResponse(response, 405, undefined, { allow: "POST" });
      return;
    }
    if (transport === "http" && request.url === "/mcp" && request.method === "POST") {
      const acceptedTypes = new Set((request.headers.accept ?? "").split(",")
        .map(value => value.split(";", 1)[0]?.trim().toLowerCase()));
      if (!acceptedTypes.has("application/json") || !acceptedTypes.has("text/event-stream")) {
        sendBridgeResponse(response, 406);
        return;
      }
      if (request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
        sendBridgeResponse(response, 415);
        return;
      }
      let body: unknown;
      try {
        body = await readBridgeRequestBody(request);
      } catch (error) {
        sendBridgeResponse(response, error instanceof RangeError ? 413 : 400);
        return;
      }
      const messages = Array.isArray(body) ? body : [body];
      if (messages.length === 0 || messages.length > 64) {
        sendBridgeResponse(response, 400);
        return;
      }
      const responses: Record<string, unknown>[] = [];
      for (const message of messages) {
        const result = await handleMcpMessage(message);
        if (result) responses.push(result);
      }
      if (responses.length === 0) sendBridgeResponse(response, 202);
      else sendBridgeResponse(response, 200, Array.isArray(body) ? responses : responses[0]);
      return;
    }
    if (transport === "stdio" && request.method === "GET" && request.url === "/tools") {
      sendBridgeResponse(response, 200, { tools: advertisedTools });
      return;
    }
    if (transport === "stdio" && request.method === "POST" && request.url === "/call") {
      if (acceptedCall) {
        sendBridgeResponse(response, 409, { accepted: false });
        return;
      }
      if (request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
        sendBridgeResponse(response, 415, { accepted: false });
        return;
      }
      let body: unknown;
      try {
        body = await readBridgeRequestBody(request);
      } catch (error) {
        sendBridgeResponse(response, error instanceof RangeError ? 413 : 400, { accepted: false });
        return;
      }
      if (!isRecord(body) || typeof body.name !== "string" || !isRecord(body.arguments) || !toolsByName.has(body.name)) {
        sendBridgeResponse(response, 400, { accepted: false });
        return;
      }
      acceptedCall = true;
      onToolCall({ name: body.name, arguments: body.arguments });
      sendBridgeResponse(response, 202, { accepted: true });
      return;
    }
    sendBridgeResponse(response, 404);
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      rejectListen(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolveListen();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, "127.0.0.1");
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    await new Promise<void>(resolveClose => server.close(() => resolveClose()));
    throw new Error("Could not determine the ACP tool bridge address");
  }
  const bridgeUrl = `http://127.0.0.1:${address.port}`;
  bridgeHost = `127.0.0.1:${address.port}`;
  bridgeOrigin = bridgeUrl;
  const mcpServer: acp.McpServer = transport === "http"
    ? {
        type: "http",
        name: "omp-native-tools",
        url: `${bridgeUrl}/mcp`,
        headers: [{ name: "Authorization", value: `Bearer ${token}` }],
      }
    : {
        name: "omp-native-tools",
        command: process.execPath,
        args: [fileURLToPath(new URL("./mcp-bridge.js", import.meta.url))],
        env: [
          { name: "OMP_ACP_TOOL_BRIDGE_URL", value: bridgeUrl },
          { name: "OMP_ACP_TOOL_BRIDGE_TOKEN", value: token },
        ],
      };

  return {
    mcpServer,
    close: async () => {
      if (closed) return;
      closed = true;
      const finished = new Promise<void>(resolveClose => server.close(() => resolveClose()));
      server.closeAllConnections?.();
      await finished;
    },
  };
}

function positiveInteger(value: unknown, fallback: number, label: string): number {
  const result = value ?? fallback;
  if (typeof result !== "number" || !Number.isSafeInteger(result) || result <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return result;
}

function readModelOverrides(value: unknown, label: string): Record<string, ModelMetadataOverride> {
  if (!isRecord(value)) throw new Error(`${label} must map model IDs to metadata`);
  const result: Record<string, ModelMetadataOverride> = {};
  for (const [modelId, rawOverride] of Object.entries(value)) {
    if (!modelId || !isRecord(rawOverride)) throw new Error(`${label}.${modelId} must be an object`);
    const override: ModelMetadataOverride = {};
    if (rawOverride.contextWindow !== undefined) override.contextWindow = positiveInteger(rawOverride.contextWindow, 0, `${label}.${modelId}.contextWindow`);
    if (rawOverride.maxTokens !== undefined) override.maxTokens = positiveInteger(rawOverride.maxTokens, 0, `${label}.${modelId}.maxTokens`);
    if (rawOverride.cost !== undefined) {
      if (!isRecord(rawOverride.cost)) throw new Error(`${label}.${modelId}.cost must be an object`);
      const cost: Partial<Model["cost"]> = {};
      for (const [key, rawCost] of Object.entries(rawOverride.cost)) {
        if (!(COST_KEYS as readonly string[]).includes(key) || typeof rawCost !== "number" || !Number.isFinite(rawCost) || rawCost < 0) {
          throw new Error(`${label}.${modelId}.cost.${key} must be a non-negative number`);
        }
        cost[key as keyof Model["cost"]] = rawCost;
      }
      override.cost = cost;
    }
    result[modelId] = override;
  }
  return result;
}

function readAgents(path = resolve(process.env.PI_CODING_AGENT_DIR || `${homedir()}/.omp/agent`, "acp-provider.json")): AgentConfig[] {
  if (!existsSync(path)) return [];
  const data: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecord(data)) throw new Error(`${path}: expected an object`);
  const auto = data.auto ?? {};
  if (!isRecord(auto)) throw new Error(`${path}: auto must map built-in ACP names to booleans`);
  const configuredAgents = data.agents ?? [];
  if (!Array.isArray(configuredAgents)) throw new Error(`${path}: agents must be an array`);
  const agents = new Map<string, AgentConfig>();
  for (const [id, enabled] of Object.entries(auto)) {
    const preset = AUTO_AGENT_PRESETS[id];
    if (!preset || typeof enabled !== "boolean") throw new Error(`${path}: auto.${id} must be a supported ACP name with a boolean value`);
    if (enabled) {
      agents.set(id, {
        id: preset.id, name: preset.name, command: preset.command, args: [...preset.args], env: {},
        metadataProvider: preset.metadataProvider,
        contextWindow: DEFAULT_CONTEXT_WINDOW,
        maxTokens: DEFAULT_MAX_TOKENS,
        modelOverrides: {},
      });
    }
  }
  const configuredIds = new Set<string>();
  for (const [index, entry] of configuredAgents.entries()) {
    const label = `${path}: agents[${index}]`;
    if (!isRecord(entry)) throw new Error(`${label} must be an object`);
    const id = entry.id;
    if (typeof id !== "string" || !/^[a-zA-Z0-9_-]+$/.test(id) || configuredIds.has(id)) {
      throw new Error(`${label}.id must be unique and contain only letters, digits, _ or -`);
    }
    configuredIds.add(id);
    const previous = agents.get(id);
    const command = entry.command ?? previous?.command;
    if (typeof command !== "string" || !command.trim()) throw new Error(`${label}.command is required`);
    const rawArgs = entry.args ?? previous?.args ?? [];
    if (!Array.isArray(rawArgs) || !rawArgs.every(value => typeof value === "string")) throw new Error(`${label}.args must be strings`);
    const rawEnv = entry.env ?? previous?.env ?? {};
    if (!isRecord(rawEnv) || Object.entries(rawEnv).some(([key, value]) => !key || key.includes("=") || typeof value !== "string")) {
      throw new Error(`${label}.env must map names to strings`);
    }
    const env = Object.fromEntries(Object.entries(rawEnv).map(([key, value]) => [key, value as string]));
    const metadataProvider = entry.metadataProvider ?? previous?.metadataProvider;
    if (metadataProvider !== undefined && (typeof metadataProvider !== "string" || !metadataProvider.trim())) {
      throw new Error(`${label}.metadataProvider must be a non-empty string`);
    }
    const modelOverrides = readModelOverrides(entry.modelOverrides ?? {}, `${label}.modelOverrides`);
    agents.set(id, {
      id,
      name: typeof entry.name === "string" && entry.name.trim() ? entry.name : previous?.name ?? id,
      command,
      args: rawArgs,
      env,
      contextWindow: positiveInteger(entry.contextWindow, previous?.contextWindow ?? DEFAULT_CONTEXT_WINDOW, `${label}.contextWindow`),
      maxTokens: positiveInteger(entry.maxTokens, previous?.maxTokens ?? DEFAULT_MAX_TOKENS, `${label}.maxTokens`),
      modelOverrides: { ...previous?.modelOverrides, ...modelOverrides },
      ...(typeof metadataProvider === "string" ? { metadataProvider } : {}),
    });
  }
  return [...agents.values()];
}

type CatalogModel = OmpModel;


const MAX_CODEBUDDY_LOCAL_STORAGE_FILE_BYTES = 2 * 1024 * 1024;

function optionalPositiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function codeBuddyLocalStorageDirectory(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.CODEBUDDY_CONFIG_DIR?.trim() || resolve(homedir(), ".codebuddy"), "local_storage");
}

function readCodeBuddyRuntimeModels(directory = codeBuddyLocalStorageDirectory()): Map<string, ModelMetadataOverride> {
  const snapshots: Array<{
    timestamp: number;
    mtime: number;
    fileName: string;
    models: Map<string, ModelMetadataOverride>;
  }> = [];
  let fileNames: string[];
  try {
    fileNames = readdirSync(directory);
  } catch {
    return new Map();
  }

  for (const fileName of fileNames) {
    if (!fileName.startsWith("entry_") || !fileName.endsWith(".info")) continue;
    try {
      const path = resolve(directory, fileName);
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.size > MAX_CODEBUDDY_LOCAL_STORAGE_FILE_BYTES) continue;
      const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
      const records = Array.isArray(parsed) ? parsed : [parsed];
      for (const record of records) {
        if (!isRecord(record) || !isRecord(record.data) || !Array.isArray(record.data.models)) continue;
        const models = new Map<string, ModelMetadataOverride>();
        for (const rawModel of record.data.models) {
          if (!isRecord(rawModel) || typeof rawModel.id !== "string" || !rawModel.id.trim()) continue;
          const contextWindow = optionalPositiveInteger(rawModel.maxInputTokens)
            ?? optionalPositiveInteger(rawModel.maxAllowedSize);
          const maxTokens = optionalPositiveInteger(rawModel.maxOutputTokens);
          if (contextWindow === undefined && maxTokens === undefined) continue;
          models.set(rawModel.id.trim(), {
            ...(contextWindow === undefined ? {} : { contextWindow }),
            ...(maxTokens === undefined ? {} : { maxTokens }),
          });
        }
        const timestamp = typeof record.ts === "number" && Number.isFinite(record.ts) ? record.ts : stat.mtimeMs;
        snapshots.push({ timestamp, mtime: stat.mtimeMs, fileName, models });
      }
    } catch {
      // Runtime caches are optional and may be concurrently rewritten.
    }
  }

  snapshots.sort((a, b) => b.timestamp - a.timestamp || b.mtime - a.mtime || a.fileName.localeCompare(b.fileName));
  return snapshots[0]?.models ?? new Map();
}

const MAX_OPENCODE_MODEL_CATALOG_FILE_BYTES = 16 * 1024 * 1024;
const MAX_OPENCODE_CONFIG_FILE_BYTES = 2 * 1024 * 1024;

function optionalNonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function openCodeModelCatalogPath(env: NodeJS.ProcessEnv = process.env): string {
  const cacheHome = env.XDG_CACHE_HOME?.trim() || resolve(homedir(), ".cache");
  return resolve(cacheHome, "opencode", "models.json");
}

function openCodeConfigPaths(cwd = process.cwd(), env: NodeJS.ProcessEnv = process.env): string[] {
  const paths: string[] = [];
  const addDirectory = (directory: string) => {
    for (const name of ["opencode.json", "opencode.jsonc"]) paths.push(resolve(directory, name));
  };
  const configHome = env.XDG_CONFIG_HOME?.trim() || resolve(homedir(), ".config");
  addDirectory(resolve(configHome, "opencode"));
  if (env.OPENCODE_CONFIG?.trim()) paths.push(resolve(env.OPENCODE_CONFIG));

  const directories: string[] = [];
  let directory = resolve(cwd);
  for (;;) {
    directories.push(directory);
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  const ancestors = directories.reverse();
  for (const ancestor of ancestors) addDirectory(ancestor);
  for (const ancestor of ancestors) addDirectory(resolve(ancestor, ".opencode"));
  if (env.OPENCODE_CONFIG_DIR?.trim()) addDirectory(env.OPENCODE_CONFIG_DIR);

  if (process.platform === "darwin") addDirectory("/Library/Application Support/opencode");
  else if (process.platform === "win32") addDirectory(resolve(env.ProgramData || "C:\\ProgramData", "opencode"));
  else addDirectory("/etc/opencode");
  return [...new Set(paths)];
}

function readOpenCodeJsonFile(path: string, maxBytes: number, jsonc = false): unknown {
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > maxBytes) return undefined;
    const content = readFileSync(path, "utf8");
    return jsonc ? Bun.JSONC.parse(content) : JSON.parse(content);
  } catch {
    return undefined;
  }
}

function openCodeCost(value: unknown): Partial<Model["cost"]> | undefined {
  if (!isRecord(value)) return undefined;
  const input = optionalNonNegativeNumber(value.input);
  const output = optionalNonNegativeNumber(value.output);
  const cacheRead = optionalNonNegativeNumber(value.cache_read);
  const cacheWrite = optionalNonNegativeNumber(value.cache_write);
  const cost = {
    ...(input === undefined ? {} : { input }),
    ...(output === undefined ? {} : { output }),
    ...(cacheRead === undefined ? {} : { cacheRead }),
    ...(cacheWrite === undefined ? {} : { cacheWrite }),
  };
  return Object.keys(cost).length === 0 ? undefined : cost;
}

function mergeOpenCodeConfig(models: Map<string, ModelMetadataOverride>, config: unknown): void {
  if (!isRecord(config) || !isRecord(config.providers)) return;
  for (const [providerId, provider] of Object.entries(config.providers)) {
    if (!isRecord(provider) || !isRecord(provider.models)) continue;
    for (const [modelId, model] of Object.entries(provider.models)) {
      if (!isRecord(model)) continue;
      const configuredModelId = typeof model.modelID === "string" && model.modelID.trim() ? model.modelID.trim() : modelId;
      const modelKey = `${providerId}/${modelId}`;
      const inherited = models.get(`${providerId}/${configuredModelId}`) ?? models.get(modelKey);
      const metadata: ModelMetadataOverride = { ...(inherited ?? {}) };
      const limit = isRecord(model.limit) ? model.limit : undefined;
      const contextWindow = optionalPositiveInteger(limit?.context);
      const maxTokens = optionalPositiveInteger(limit?.output);
      if (contextWindow !== undefined) metadata.contextWindow = contextWindow;
      if (maxTokens !== undefined) metadata.maxTokens = maxTokens;
      if (Object.keys(metadata).length > 0) models.set(modelKey, metadata);
    }
  }
}

function readOpenCodeRuntimeModels(
  cacheFile = openCodeModelCatalogPath(),
  configFiles = openCodeConfigPaths(),
  configContent = process.env.OPENCODE_CONFIG_CONTENT,
): Map<string, ModelMetadataOverride> {
  const models = new Map<string, ModelMetadataOverride>();
  const catalog = readOpenCodeJsonFile(cacheFile, MAX_OPENCODE_MODEL_CATALOG_FILE_BYTES);
  if (isRecord(catalog)) {
    for (const [providerId, provider] of Object.entries(catalog)) {
      if (!isRecord(provider) || !isRecord(provider.models)) continue;
      for (const [modelId, model] of Object.entries(provider.models)) {
        if (!isRecord(model)) continue;
        const limit = isRecord(model.limit) ? model.limit : undefined;
        const contextWindow = optionalPositiveInteger(limit?.context);
        const maxTokens = optionalPositiveInteger(limit?.output);
        const cost = openCodeCost(model.cost);
        if (contextWindow === undefined && maxTokens === undefined && !cost) continue;
        models.set(`${providerId}/${modelId}`, {
          ...(contextWindow === undefined ? {} : { contextWindow }),
          ...(maxTokens === undefined ? {} : { maxTokens }),
          ...(cost ? { cost } : {}),
        });
      }
    }
  }

  for (const configFile of configFiles) {
    mergeOpenCodeConfig(models, readOpenCodeJsonFile(configFile, MAX_OPENCODE_CONFIG_FILE_BYTES, true));
  }
  if (typeof configContent === "string" && Buffer.byteLength(configContent) <= MAX_OPENCODE_CONFIG_FILE_BYTES) {
    try {
      mergeOpenCodeConfig(models, Bun.JSONC.parse(configContent));
    } catch {
      // Inline config is optional and can be invalid.
    }
  }
  return models;
}

function runtimeMetadataEnvironment(agent: AgentConfig): NodeJS.ProcessEnv {
  const names = [
    "CODEBUDDY_CONFIG_DIR", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "OPENCODE_CONFIG",
    "OPENCODE_CONFIG_DIR", "OPENCODE_CONFIG_CONTENT", "ProgramData",
  ];
  return Object.fromEntries(names.map(name => [name, agent.env[name] ?? process.env[name]])) as NodeJS.ProcessEnv;
}

function readAgentRuntimeModelMetadata(agent: AgentConfig, cwd = process.cwd()): Map<string, ModelMetadataOverride> | undefined {
  const env = runtimeMetadataEnvironment(agent);
  if (agent.id === "codebuddy") return readCodeBuddyRuntimeModels(codeBuddyLocalStorageDirectory(env));
  if (agent.id === "opencode") {
    return readOpenCodeRuntimeModels(openCodeModelCatalogPath(env), openCodeConfigPaths(cwd, env), env.OPENCODE_CONFIG_CONTENT);
  }
  return undefined;
}

function getRuntimeModelMetadata(
  agent: AgentConfig,
  modelId: string,
  runtimeModels?: ReadonlyMap<string, ModelMetadataOverride>,
  providerHint?: string,
): ModelMetadataOverride | undefined {
  if (!runtimeModels) return undefined;
  if (agent.id === "codebuddy") {
    const runtimeId = modelId.startsWith("codebuddy/") ? modelId.slice("codebuddy/".length) : modelId;
    return runtimeModels.get(runtimeId);
  }
  if (agent.id === "opencode") {
    const runtimeId = modelId.includes("/")
      ? modelId
      : providerHint?.trim()
        ? `${providerHint.trim()}/${modelId}`
        : agent.metadataProvider
          ? `${agent.metadataProvider}/${modelId}`
          : undefined;
    return runtimeId ? runtimeModels.get(runtimeId) : undefined;
  }
}

function currentModelProvider(
  options: acp.SessionConfigOption[] | undefined,
  configuredProvider?: string,
): string | undefined {
  const providerOption = options?.find(option => option.type === "select" && option.id === "provider");
  const selectedProvider = providerOption?.type === "select" ? providerOption.currentValue : undefined;
  if (selectedProvider?.trim()) return selectedProvider;
  return configuredProvider?.trim() ? configuredProvider : undefined;
}

function findCatalogModel(
  agent: AgentConfig,
  modelId: string,
  models?: ExtensionModelQuery,
  providerHint?: string,
): CatalogModel | undefined {
  if (!models) return undefined;
  const candidates = new Set<string>();
  if (agent.metadataProvider && !modelId.includes("/")) candidates.add(`${agent.metadataProvider}/${modelId}`);
  if (providerHint && !modelId.includes("/")) candidates.add(`${providerHint}/${modelId}`);
  candidates.add(modelId);
  for (const candidate of candidates) {
    const model = models.resolve(candidate);
    if (model) return model;
  }
}

function agentModel(agent: AgentConfig, modelId = agent.id, modelName = agent.name, reasoning = false,
  catalogModel?: CatalogModel, observedContextWindow?: number, runtimeModelMetadata?: ModelMetadataOverride): Model {
  const modelValue = modelId.startsWith(`${agent.id}/`) ? modelId.slice(agent.id.length + 1) : modelId;
  const override = agent.modelOverrides[modelValue] ?? agent.modelOverrides[modelId];
  return {
    id: modelId, name: modelName, api: API, provider: `acp-${agent.id}`, baseUrl: `acp://${agent.id}`,
    reasoning: reasoning || catalogModel?.reasoning === true,
    input: ["text"],
    cost: {
      input: override?.cost?.input ?? runtimeModelMetadata?.cost?.input ?? catalogModel?.cost.input ?? 0,
      output: override?.cost?.output ?? runtimeModelMetadata?.cost?.output ?? catalogModel?.cost.output ?? 0,
      cacheRead: override?.cost?.cacheRead ?? runtimeModelMetadata?.cost?.cacheRead ?? catalogModel?.cost.cacheRead ?? 0,
      cacheWrite: override?.cost?.cacheWrite ?? runtimeModelMetadata?.cost?.cacheWrite ?? catalogModel?.cost.cacheWrite ?? 0,
    },
    contextWindow: override?.contextWindow ?? observedContextWindow ?? runtimeModelMetadata?.contextWindow ?? catalogModel?.contextWindow ?? agent.contextWindow,
    maxTokens: override?.maxTokens ?? runtimeModelMetadata?.maxTokens ?? catalogModel?.maxTokens ?? agent.maxTokens,
  };
}

type PromptContext = { systemPrompt?: string | string[]; messages: unknown[] };
const OMP_TOOL_POLICY = "For workspace and environment actions, prefer the MCP tools advertised by `omp-native-tools` over ACP client built-in tools. Make actual tool calls; never imitate them with XML, JSON, or text. If an OMP tool you need is unavailable, say so without claiming to have used it.";

function promptInstructions(context: Pick<PromptContext, "systemPrompt">): string[] {
  const blocks = typeof context.systemPrompt === "string" ? [context.systemPrompt] : context.systemPrompt ?? [];
  return blocks.filter(text => text.trim().length > 0);
}

function composeOmpSystemPrompt(context: PromptContext, useOmpTools: boolean): string {
  return [...(useOmpTools ? [OMP_TOOL_POLICY] : []), ...promptInstructions(context)].join("\n\n").trim();
}

function hasExplicitSystemPrompt(args: string[]): boolean {
  return args.some(argument => ["--system-prompt", "--system-prompt-file"].some(option =>
    argument === option || argument.startsWith(`${option}=`)));
}

function shouldUseOmpSystemPrompt(agent: AgentConfig, systemPrompt: string): boolean {
  return agent.id === "codebuddy" && systemPrompt.trim().length > 0 && !hasExplicitSystemPrompt(agent.args);
}

const CODEBUDDY_TOOL_POLICY_OPTIONS = ["--tools", "--allowedTools", "--disallowedTools"] as const;

function hasExplicitToolPolicy(args: string[]): boolean {
  return args.some(argument => CODEBUDDY_TOOL_POLICY_OPTIONS.some(option =>
    argument === option || argument.startsWith(`${option}=`)));
}

function prepareAgentLaunch(agent: AgentConfig, systemPrompt?: string): { args: string[]; cleanup: () => void } {
  const args = [...agent.args];
  if (agent.id === "codebuddy" && !hasExplicitToolPolicy(args)) args.push("--tools", "");
  if (!systemPrompt || !shouldUseOmpSystemPrompt(agent, systemPrompt)) return { args, cleanup: () => {} };
  const directory = mkdtempSync(join(tmpdir(), "omp-acp-provider-"));
  try {
    const promptPath = join(directory, "system-prompt.txt");
    writeFileSync(promptPath, systemPrompt, { encoding: "utf8", mode: 0o600, flag: "wx" });
    args.push("--system-prompt-file", promptPath);
    return { args, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

function flattenPrompt(context: PromptContext, useOmpTools = false, omitSystemInstructions = false): string {
  const lines = omitSystemInstructions ? [] : useOmpTools ? [`[OMP tool policy]\n${OMP_TOOL_POLICY}`] : [];
  if (!omitSystemInstructions) lines.push(...promptInstructions(context).map(text => `[System instructions]\n${text}`));
  for (const raw of context.messages) {
    if (!raw || typeof raw !== "object") continue;
    const message = raw as { role?: string; content?: unknown; toolName?: string; toolCallId?: string; isError?: boolean };
    if (message.role === "system") continue;
    const role = message.role === "assistant" ? "Assistant" : message.role === "toolResult" ? `Tool result ${message.toolName ?? ""}` : "User";
    const content = typeof message.content === "string" ? message.content : Array.isArray(message.content)
      ? message.content.map((part: unknown) => {
        if (!part || typeof part !== "object") return "";
        const p = part as { type?: string; text?: string; name?: string; arguments?: unknown };
        if (p.type === "text") return p.text ?? "";
        if (p.type === "image") return "[image attachment not forwarded to ACP]";
        if (p.type === "toolCall") return `[OMP tool call ${p.name ?? "unknown"}]\n${JSON.stringify(p.arguments ?? {})}`;
        return "";
      }).filter(Boolean).join("\n") : "";
    if (content) lines.push(`[${role}]\n${content}`);
  }
  return lines.join("\n\n").trim();
}

function toolNotice(update: { sessionUpdate?: string; title?: string | null; status?: string | null }): string {
  if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update") return "";
  if (update.sessionUpdate === "tool_call") return `\n\n⚙ ${update.title ?? "ACP tool"} (${update.status ?? "pending"})\n`;
  if (update.status === "completed" || update.status === "failed") return `\n${update.status === "completed" ? "✓" : "✗"} ${update.title ?? "ACP tool"}\n`;
  return "";
}

function allowPermissionRequest(options: acp.RequestPermissionRequest["options"]): acp.RequestPermissionResponse {
  const choice = options.find(option => option.kind === "allow_once");
  return choice
    ? { outcome: { outcome: "selected", optionId: choice.optionId } }
    : { outcome: { outcome: "cancelled" } };
}

async function withAcp(agent: AgentConfig, cwd: string, signal: AbortSignal | undefined,
  run: (connection: acp.ClientConnection["agent"], capabilities: { mcpCapabilities?: { http?: boolean; sse?: boolean } }) => Promise<void>,
  permission: (params: acp.RequestPermissionRequest) => Promise<acp.RequestPermissionResponse>,
  systemPrompt?: string,
): Promise<void> {
  const launch = prepareAgentLaunch(agent, systemPrompt);
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(agent.command, launch.args, { cwd, env: { ...process.env, ...agent.env }, shell: false, stdio: ["pipe", "pipe", "pipe"] });
  } catch (error) {
    launch.cleanup();
    throw error;
  }
  let stderrTail = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", chunk => { stderrTail = (stderrTail + chunk).slice(-8192); });
  const { promise: spawned, resolve: markSpawned, reject: spawnFailed } = Promise.withResolvers<void>();
  const { promise: closed, resolve: markClosed } = Promise.withResolvers<void>();
  child.once("spawn", markSpawned);
  child.once("error", spawnFailed);
  child.once("close", markClosed);
  const client = acp.client({ name: "omp-acp-provider" }).onRequest(acp.methods.client.session.requestPermission, ctx => permission(ctx.params));
  const abort = () => child.kill("SIGTERM");
  signal?.addEventListener("abort", abort, { once: true });
  try {
    await spawned;
    const input = Writable.toWeb(child.stdin!);
    const output = Readable.toWeb(child.stdout!) as unknown as ReadableStream<Uint8Array>;
    await client.connectWith(acp.ndJsonStream(input, output), async ctx => {
      const initialized = await ctx.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION }, { cancellationSignal: signal });
      if (initialized.protocolVersion !== acp.PROTOCOL_VERSION) throw new Error(`ACP protocol mismatch: expected ${acp.PROTOCOL_VERSION}, got ${initialized.protocolVersion}`);
      if (signal?.aborted) throw new Error("Request aborted");
      await run(ctx, initialized.agentCapabilities ?? {});
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const stderrSummary = stderrTail.split(/\r?\n/).slice(-5).join("\n").slice(-400);
    throw new Error(stderrSummary ? `${detail}\nACP stderr (last 5 lines, up to 400 chars):\n${stderrSummary}` : detail, { cause: error });
  } finally {
    signal?.removeEventListener("abort", abort);
    child.kill("SIGTERM");
    const killTimer = child.pid === undefined ? undefined : setTimeout(() => child.kill("SIGKILL"), 1000);
    killTimer?.unref();
    await closed;
    clearTimeout(killTimer);
    launch.cleanup();
  }
}

async function discover(agent: AgentConfig, cwd: string, modelQuery?: ExtensionModelQuery,
  observedContextWindows?: ReadonlyMap<string, number>): Promise<Model[]> {
  const runtimeModels = readAgentRuntimeModelMetadata(agent, cwd);
  let found: Model[] = [agentModel(agent, agent.id, agent.name, false, undefined, observedContextWindows?.get(agent.id),
    getRuntimeModelMetadata(agent, agent.id, runtimeModels))];
  await withAcp(agent, cwd, undefined, async ctx => {
    const session = await ctx.buildSession(cwd).start();
    try {
      const options = session.newSessionResponse.configOptions ?? [];
      const providerHint = currentModelProvider(options, agent.id === "cline" ? agent.env.CLINE_PROVIDER : undefined);
      const modelOption = options.find(option => option.type === "select" && (option.category === "model" || option.id === "model"));
      if (modelOption?.type === "select") {
        const choices = modelOption.options.flatMap(option => "options" in option ? option.options : [option]);
        const supportsReasoning = options.some(option => option.category === "thought_level");
        found = [
          agentModel(agent, agent.id, agent.name, supportsReasoning, undefined, observedContextWindows?.get(agent.id),
            getRuntimeModelMetadata(agent, agent.id, runtimeModels, providerHint)),
          ...choices.map(choice => {
            const catalogModel = findCatalogModel(agent, choice.value, modelQuery, providerHint);
            return agentModel(agent, `${agent.id}/${choice.value}`, `${choice.name} (${agent.name})`, supportsReasoning,
              catalogModel, observedContextWindows?.get(choice.value), getRuntimeModelMetadata(agent, choice.value, runtimeModels, providerHint));
          }),
        ];
      }
      session.dispose();
    } catch (error) { session.dispose(); throw error; }
  }, async () => ({ outcome: { outcome: "cancelled" } }));
  return found;
}

export default function ompAcpProvider(pi: ExtensionAPI) {
  let modelQuery: ExtensionModelQuery | undefined;
  pi.on("session_start", (_event, context) => { modelQuery = context.models; });
  const agents = readAgents();
  for (const agent of agents) {
    const observedContextWindows = new Map<string, number>();
    const runtimeModels = readAgentRuntimeModelMetadata(agent);
    const initial = [agentModel(agent, agent.id, agent.name, false, undefined, undefined, getRuntimeModelMetadata(agent, agent.id, runtimeModels))];
    pi.registerProvider(`acp-${agent.id}`, {
      api: API,
      baseUrl: `acp://${agent.id}`,
      apiKey: "acp-agent-managed",
      models: initial,
      async fetchDynamicModels(_apiKey) {
        return discover(agent, process.cwd(), modelQuery, observedContextWindows);
      },
      streamSimple(model, context, options = {}) {
        const stream = createAssistantMessageEventStream();
        const message: AssistantMessage = { role: "assistant", content: [], api: API, provider: model.provider, model: model.id,
          usage: zeroUsage(), stopReason: "stop", timestamp: Date.now() };
        stream.push({ type: "start", partial: message });
        const append = (type: "text" | "thinking", text: string) => {
          if (!text) return;
          const previous = message.content.at(-1);
          if (previous?.type === type) {
            if (previous.type === "text") previous.text += text;
            else if (previous.type === "thinking") previous.thinking += text;
            else return;
          } else {
            if (previous?.type === "text") stream.push({ type: "text_end", contentIndex: message.content.length - 1, content: previous.text, partial: message });
            if (previous?.type === "thinking") stream.push({ type: "thinking_end", contentIndex: message.content.length - 1, content: previous.thinking, partial: message });
            const contentIndex = message.content.length;
            if (type === "text") {
              message.content.push({ type: "text", text });
              stream.push({ type: "text_start", contentIndex, partial: message });
            } else {
              message.content.push({ type: "thinking", thinking: text });
              stream.push({ type: "thinking_start", contentIndex, partial: message });
            }
          }
          stream.push({ type: `${type}_delta`, contentIndex: message.content.length - 1, delta: text, partial: message });
        };
        const selectedModel = model.id.startsWith(`${agent.id}/`) ? model.id.slice(agent.id.length + 1) : undefined;
        const observedModelId = selectedModel ?? agent.id;
        void (async () => {
          const outerSignal = options.signal;
          const acpController = new AbortController();
          const relayAbort = () => acpController.abort(outerSignal?.reason);
          let bridge: OmpToolBridge | undefined;
          let pendingToolCall: OmpToolRequest | undefined;
          if (outerSignal?.aborted) relayAbort();
          else outerSignal?.addEventListener("abort", relayAbort, { once: true });
          try {
            const tools = context.tools ?? [];
            const systemPrompt = composeOmpSystemPrompt(context, tools.length > 0);
            const useOmpSystemPrompt = shouldUseOmpSystemPrompt(agent, systemPrompt);
            const prompt = flattenPrompt(context, tools.length > 0, useOmpSystemPrompt);
            if (!prompt) throw new Error("ACP provider received an empty prompt");
            try {
              await withAcp(agent, options.cwd || process.cwd(), acpController.signal, async (ctx, capabilities) => {
                if (tools.length > 0) {
                  bridge = await createOmpToolBridge(tools, call => {
                    if (pendingToolCall || outerSignal?.aborted) return;
                    pendingToolCall = call;
                    acpController.abort();
                  }, capabilities.mcpCapabilities?.http ? "http" : "stdio");
                }
                const builder = ctx.buildSession(options.cwd || process.cwd());
                if (bridge) builder.withMcpServer(bridge.mcpServer);
                const session = await builder.start({ cancellationSignal: acpController.signal });
                try {
                  const modelOption = session.newSessionResponse.configOptions?.find(option => option.type === "select" && (option.category === "model" || option.id === "model"));
                  if (selectedModel && modelOption?.type === "select") {
                    await ctx.request(acp.methods.agent.session.setConfigOption, {
                      sessionId: session.sessionId, configId: modelOption.id, value: selectedModel,
                    }, { cancellationSignal: acpController.signal });
                  }
                  const run = session.prompt(prompt, { cancellationSignal: acpController.signal });
                  const updates = (async () => {
                    for (;;) {
                      const event = await session.nextUpdate();
                      if (event.kind === "stop") return;
                      const update = event.update;
                      if (update.sessionUpdate === "agent_message_chunk" && update.content?.type === "text") append("text", update.content.text);
                      else if (update.sessionUpdate === "agent_thought_chunk" && update.content?.type === "text") append("thinking", update.content.text);
                      else if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") append("text", toolNotice({ sessionUpdate: update.sessionUpdate, title: update.title, status: update.status }));
                      else if (update.sessionUpdate === "usage_update") {
                        if (Number.isInteger(update.size) && update.size > 0) observedContextWindows.set(observedModelId, update.size);
                        if (Number.isInteger(update.used) && update.used >= 0) message.usage.contextTokens = update.used;
                        if (update.cost && Number.isFinite(update.cost.amount) && update.cost.amount >= 0) {
                          if (update.cost.currency.toUpperCase() === "USD") message.usage.cost.total = update.cost.amount;
                          else if (update.cost.currency.toLowerCase() === "credits") message.usage.credits = { cost: update.cost.amount };
                        }
                      }
                    }
                  })();
                  const [result] = await Promise.all([run, updates]);
                  if (result.stopReason === "cancelled") throw new Error("ACP agent cancelled the turn");
                  if (result.stopReason === "refusal") throw new Error("ACP agent refused the prompt");
                  // ACP max_turn_requests is an agent-side request limit, not an OMP tool call.
                  message.stopReason = result.stopReason === "max_tokens" ? "length" : "stop";
                } finally { session.dispose(); }
              }, async params => allowPermissionRequest(params.options), useOmpSystemPrompt ? systemPrompt : undefined);
            } catch (error) {
              if (!pendingToolCall || outerSignal?.aborted) throw error;
            }
            const last = message.content.at(-1);
            if (last?.type === "text") stream.push({ type: "text_end", contentIndex: message.content.length - 1, content: last.text, partial: message });
            if (last?.type === "thinking") stream.push({ type: "thinking_end", contentIndex: message.content.length - 1, content: last.thinking, partial: message });
            if (pendingToolCall) {
              const toolCall: ToolCall = {
                type: "toolCall",
                id: randomUUID(),
                name: pendingToolCall.name,
                arguments: pendingToolCall.arguments,
              };
              const contentIndex = message.content.length;
              message.content.push(toolCall);
              stream.push({ type: "toolcall_start", contentIndex, partial: message });
              stream.push({ type: "toolcall_delta", contentIndex, delta: JSON.stringify(toolCall.arguments), partial: message });
              stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: message });
              message.stopReason = "toolUse";
            }
            stream.push({ type: "done", reason: message.stopReason === "length" || message.stopReason === "toolUse" ? message.stopReason : "stop", message });
          } catch (error) {
            const aborted = outerSignal?.aborted === true;
            message.stopReason = aborted ? "aborted" : "error";
            message.errorMessage = error instanceof Error ? error.message : String(error);
            stream.push({ type: "error", reason: message.stopReason, error: message });
          } finally {
            outerSignal?.removeEventListener("abort", relayAbort);
            await bridge?.close();
            stream.end(message);
          }
        })();
        return stream;
      },
    });
  }
}

export const __testing = {
  readAgents, agentModel, findCatalogModel, getRuntimeModelMetadata, readCodeBuddyRuntimeModels, readOpenCodeRuntimeModels,
  codeBuddyLocalStorageDirectory, currentModelProvider,
  flattenPrompt, promptInstructions, composeOmpSystemPrompt, shouldUseOmpSystemPrompt, prepareAgentLaunch, toolNotice, allowPermissionRequest, createOmpToolBridge,
};
