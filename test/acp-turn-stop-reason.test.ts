import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ompAcpProvider from "../index";
import type { ExtensionAPI, ProviderConfig } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";

test("does not report ACP max_turn_requests as an OMP tool call", async () => {
  const dir = mkdtempSync(join(tmpdir(), "omp-acp-stop-reason-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const acpServer = `
    const readline = require("node:readline");
    const send = value => process.stdout.write(JSON.stringify(value) + "\\n");
    readline.createInterface({ input: process.stdin }).on("line", line => {
      const request = JSON.parse(line);
      if (!("id" in request)) return;
      if (request.method === "initialize") {
        send({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: 1 } });
      } else if (request.method === "session/new") {
        send({ jsonrpc: "2.0", id: request.id, result: { sessionId: "test-session" } });
      } else if (request.method === "session/prompt") {
        send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "test-session", update: {
          sessionUpdate: "agent_message_chunk", content: { type: "text", text: "partial answer" }
        } } });
        send({ jsonrpc: "2.0", id: request.id, result: { stopReason: "max_turn_requests" } });
      }
    });
  `;

  try {
    writeFileSync(join(dir, "acp-provider.json"), JSON.stringify({
      agents: [{ id: "mock", command: process.execPath, args: ["-e", acpServer] }],
    }));
    process.env.PI_CODING_AGENT_DIR = dir;

    const providers = new Map<string, ProviderConfig>();
    ompAcpProvider({
      on() {},
      registerProvider(id: string, config: ProviderConfig) { providers.set(id, config); },
    } as unknown as ExtensionAPI);
    const provider = providers.get("acp-mock");
    if (!provider?.streamSimple || !provider.models?.[0]) throw new Error("Mock ACP provider was not registered");

    const result = await provider.streamSimple(
      provider.models[0] as Parameters<NonNullable<ProviderConfig["streamSimple"]>>[0],
      { systemPrompt: ["system"], messages: [{ role: "user", content: "test" }] } as Parameters<NonNullable<ProviderConfig["streamSimple"]>>[1],
      { cwd: dir },
    ).result();

    expect(result.stopReason).toBe("stop");
    expect(result.content).toEqual([{ type: "text", text: "partial answer" }]);
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(dir, { recursive: true, force: true });
  }
});
