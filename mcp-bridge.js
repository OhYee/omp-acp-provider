const MAX_LINE_BYTES = 1024 * 1024;
const SUPPORTED_PROTOCOLS = new Set(["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"]);
const bridgeUrl = process.env.OMP_ACP_TOOL_BRIDGE_URL;
const bridgeToken = process.env.OMP_ACP_TOOL_BRIDGE_TOKEN;

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function sendError(id, code, message) {
  send({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
}

async function bridgeRequest(path, init = {}) {
  if (!bridgeUrl || !bridgeToken) throw new Error("OMP tool bridge is not configured");
  const response = await fetch(new URL(path, bridgeUrl), {
    ...init,
    headers: {
      authorization: `Bearer ${bridgeToken}`,
      accept: "application/json",
      ...init.headers,
    },
  });
  if (!response.ok) throw new Error(`OMP tool bridge returned ${response.status}`);
  return response.json();
}

async function handle(message) {
  if (!message || typeof message !== "object" || Array.isArray(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
    sendError(message && typeof message === "object" ? message.id : null, -32600, "Invalid JSON-RPC request");
    return;
  }

  const id = Object.hasOwn(message, "id") ? message.id : undefined;
  const params = message.params && typeof message.params === "object" && !Array.isArray(message.params) ? message.params : {};
  if (message.method === "notifications/initialized" || message.method.startsWith("notifications/")) return;
  if (id === undefined) return;

  try {
    if (message.method === "initialize") {
      const requestedVersion = params.protocolVersion;
      const protocolVersion = typeof requestedVersion === "string" && SUPPORTED_PROTOCOLS.has(requestedVersion)
        ? requestedVersion
        : "2025-03-26";
      send({ jsonrpc: "2.0", id, result: {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "omp-native-tools", version: "0.1.0" },
      } });
      return;
    }
    if (message.method === "ping") {
      send({ jsonrpc: "2.0", id, result: {} });
      return;
    }
    if (message.method === "tools/list") {
      const result = await bridgeRequest("/tools");
      send({ jsonrpc: "2.0", id, result });
      return;
    }
    if (message.method === "tools/call") {
      if (typeof params.name !== "string" || !params.name) {
        sendError(id, -32602, "Tool name is required");
        return;
      }
      const args = params.arguments === undefined ? {} : params.arguments;
      if (!args || typeof args !== "object" || Array.isArray(args)) {
        sendError(id, -32602, "Tool arguments must be an object");
        return;
      }
      const accepted = await bridgeRequest("/call", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: params.name, arguments: args }),
      });
      if (accepted.accepted !== true) {
        send({ jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text: "OMP rejected the tool request." }] } });
        return;
      }
      send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "Forwarded to OMP's native tool runner." }] } });
      return;
    }
    sendError(id, -32601, "Method not found");
  } catch {
    sendError(id, -32603, "OMP tool bridge request failed");
  }
}

let input = "";
let queue = Promise.resolve();
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
  input += chunk;
  let newline = input.indexOf("\n");
  while (newline !== -1) {
    const line = input.slice(0, newline);
    input = input.slice(newline + 1);
    if (Buffer.byteLength(line) > MAX_LINE_BYTES) {
      process.stderr.write("MCP request exceeded the size limit\n");
      process.exit(1);
      return;
    }
    if (line.trim()) {
      queue = queue.then(() => handle(JSON.parse(line))).catch(() => sendError(null, -32700, "Parse error"));
    }
    newline = input.indexOf("\n");
  }
  if (Buffer.byteLength(input) > MAX_LINE_BYTES) {
    process.stderr.write("MCP request exceeded the size limit\n");
    process.exit(1);
  }
});
process.stdin.on("end", () => { process.exitCode = 0; });
