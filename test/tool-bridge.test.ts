import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ompAcpProvider, { __testing } from "../index";
import type { ExtensionAPI, ProviderConfig } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { Tool } from "@oh-my-pi/pi-ai";

describe("OMP tool bridge", () => {
  test("authenticates requests and forwards only tools in the current OMP context", async () => {
    const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
    const bridge = await __testing.createOmpToolBridge([{
      name: "read",
      description: "Read a file",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
        additionalProperties: false,
      },
    } as unknown as Tool], call => calls.push(call), "stdio");
    try {
      if (!("command" in bridge.mcpServer)) throw new Error("Expected a stdio MCP server");
      const env = Object.fromEntries(bridge.mcpServer.env.map((entry: { name: string; value: string }) => [entry.name, entry.value]));
      const url = env.OMP_ACP_TOOL_BRIDGE_URL!;
      const authorization = `Bearer ${env.OMP_ACP_TOOL_BRIDGE_TOKEN}`;

      expect((await fetch(`${url}/tools`)).status).toBe(401);
      const listed = await fetch(`${url}/tools`, { headers: { authorization } });
      expect(listed.status).toBe(200);
      expect(await listed.json()).toMatchObject({ tools: [{ name: "read", inputSchema: { type: "object" } }] });

      const unknown = await fetch(`${url}/call`, {
        method: "POST",
        headers: { authorization, "content-type": "application/json" },
        body: JSON.stringify({ name: "shell", arguments: { command: "whoami" } }),
      });
      expect(unknown.status).toBe(400);
      expect(calls).toEqual([]);

      const invoked = await fetch(`${url}/call`, {
        method: "POST",
        headers: { authorization, "content-type": "application/json" },
        body: JSON.stringify({ name: "read", arguments: { path: "package.json" } }),
      });
      expect(invoked.status).toBe(202);
      expect(await invoked.json()).toEqual({ accepted: true });
      expect(calls).toEqual([{ name: "read", arguments: { path: "package.json" } }]);

      const duplicate = await fetch(`${url}/call`, {
        method: "POST",
        headers: { authorization, "content-type": "application/json" },
        body: JSON.stringify({ name: "read", arguments: { path: "README.md" } }),
      });
      expect(duplicate.status).toBe(409);
      expect(calls).toHaveLength(1);
    } finally {
      await bridge.close();
    }
  });


  test("serves standard Streamable HTTP MCP and accepts only registered OMP tools", async () => {
    const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
    const bridge = await __testing.createOmpToolBridge([{
      name: "read",
      description: "Read a file",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
        additionalProperties: false,
      },
    } as unknown as Tool], call => calls.push(call), "http");
    try {
      if (!("type" in bridge.mcpServer) || bridge.mcpServer.type !== "http") {
        throw new Error("Expected an HTTP MCP server");
      }
      const { url, headers } = bridge.mcpServer;
      const authorization = Object.fromEntries(headers.map(header => [header.name.toLowerCase(), header.value]));
      const request = (payload: unknown, auth = true, origin?: string) => fetch(url, {
        method: "POST",
        headers: {
          ...(auth ? authorization : {}),
          ...(origin ? { origin } : {}),
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      expect((await request({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, false)).status).toBe(401);
      expect((await request({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, true, "http://attacker.invalid")).status).toBe(401);

      const initialized = await request({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "test-client", version: "1" },
        },
      });
      expect((await initialized.json()).result.protocolVersion).toBe("2025-03-26");
      expect((await request({ jsonrpc: "2.0", method: "notifications/initialized" })).status).toBe(202);

      const listed = await request({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
      expect((await listed.json()).result.tools).toMatchObject([{ name: "read", inputSchema: { type: "object" } }]);

      const unknown = await request({
        jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "shell", arguments: { command: "whoami" } },
      });
      expect((await unknown.json()).error.code).toBe(-32602);
      expect(calls).toEqual([]);

      const invoked = await request({
        jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "read", arguments: { path: "package.json" } },
      });
      expect((await invoked.json()).result.content[0].text).toContain("OMP");
      expect(calls).toEqual([{ name: "read", arguments: { path: "package.json" } }]);
    } finally {
      await bridge.close();
    }
  });

 
  test("returns ACP MCP tool requests as native OMP tool calls", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omp-acp-tool-bridge-"));
    const previousDir = process.env.PI_CODING_AGENT_DIR;
    const acpAgent = String.raw`
      const readline = require("node:readline");
      const send = value => process.stdout.write(JSON.stringify(value) + "\n");
      let mcpUrl;
      let mcpHeaders;
      let nextMcpId = 1;
      async function mcpRequest(method, params, notification = false) {
        const message = { jsonrpc: "2.0", method, ...(notification ? {} : { id: nextMcpId++ }), ...(params ? { params } : {}) };
        const response = await fetch(mcpUrl, {
          method: "POST",
          headers: { ...mcpHeaders, accept: "application/json, text/event-stream", "content-type": "application/json" },
          body: JSON.stringify(message),
        });
        if (notification) {
          if (response.status !== 202) throw new Error("MCP notification was not accepted");
          return;
        }
        const body = await response.json();
        if (body.error) throw new Error(body.error.message);
        return body.result;
      }
      const input = readline.createInterface({ input: process.stdin });
      async function handle(request) {
        if (request.method === "initialize") {
          send({ jsonrpc: "2.0", id: request.id, result: {
            protocolVersion: 1, agentCapabilities: { mcpCapabilities: { http: true, sse: false } }
          } });
          return;
        }
        if (request.method === "session/new") {
          const config = request.params.mcpServers.find(server => server.name === "omp-native-tools");
          if (!config || config.type !== "http") throw new Error("OMP HTTP MCP server was not supplied");
          mcpUrl = config.url;
          mcpHeaders = Object.fromEntries(config.headers.map(header => [header.name, header.value]));
          await mcpRequest("initialize", {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "test-agent", version: "1" },
          });
          await mcpRequest("notifications/initialized", undefined, true);
          const listed = await mcpRequest("tools/list", {});
          if (!listed.tools.some(tool => tool.name === "read")) throw new Error("OMP read tool was not exposed");
          send({ jsonrpc: "2.0", id: request.id, result: { sessionId: "test-session" } });
          return;
        }
        if (request.method === "session/prompt") {
          send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "test-session", update: {
            sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Using OMP read." }
          } } });
          await mcpRequest("tools/call", { name: "read", arguments: { path: "package.json" } });
          return;
        }
        send({ jsonrpc: "2.0", id: request.id, result: {} });
      }
      input.on("line", line => {
        const request = JSON.parse(line);
        void handle(request).catch(error => send({ jsonrpc: "2.0", id: request.id, error: { code: -32000, message: String(error) } }));
      });
      process.on("SIGTERM", () => process.exit(0));
    `;
    try {
      writeFileSync(join(dir, "acp-provider.json"), JSON.stringify({ agents: [
        { id: "bridge", command: process.execPath, args: ["-e", acpAgent], contextWindow: 4096 },
      ] }));
      process.env.PI_CODING_AGENT_DIR = dir;
      const providers = new Map<string, ProviderConfig>();
      ompAcpProvider({
        registerProvider: (name: string, config: ProviderConfig) => providers.set(name, config),
        on: () => undefined,
      } as unknown as ExtensionAPI);
      const provider = providers.get("acp-bridge");
      const model = provider?.models?.[0];
      if (!provider?.streamSimple || !model) throw new Error("ACP test provider was not registered");
      const context = {
        systemPrompt: ["Use the provided OMP tools."],
        messages: [{ role: "user", content: "Read package.json." }],
        tools: [{
          name: "read",
          description: "Read a file",
          parameters: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
            additionalProperties: false,
          },
        }],
      } as unknown as Parameters<NonNullable<ProviderConfig["streamSimple"]>>[1];
      const result = await provider.streamSimple(
        model as Parameters<NonNullable<ProviderConfig["streamSimple"]>>[0],
        context,
        { cwd: dir },
      ).result();
      expect(result.errorMessage).toBeUndefined();
      expect(result.stopReason).toBe("toolUse");
      expect(result.content.some(part => part.type === "text" && part.text.includes("Using OMP read."))).toBe(true);
      expect(result.content.filter(part => part.type === "toolCall")).toMatchObject([
        { name: "read", arguments: { path: "package.json" } },
      ]);
    } finally {
      if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousDir;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
