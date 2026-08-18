#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { createRequire } from "module";
import { registerTools } from "./tools/index.js";
import { registerToolsetTools, toolsetSummary } from "./toolsets.js";

// Single source of truth for the version. Hardcoding it here drifted from package.json across
// v2.11.0/v2.11.1 (the server advertised 2.10.0 to clients while the package said 2.11.1), so read
// it at runtime instead. dist/index.js → ../package.json resolves correctly both in the repo and
// when installed as node_modules/salesforce-metadata-mcp/dist/index.js.
const require = createRequire(import.meta.url);
const { version: VERSION } = require("../package.json") as { version: string };

const server = new McpServer({
  name: "salesforce-metadata-mcp",
  version: VERSION,
});

const registry = registerTools(server);
registerToolsetTools(server, registry);

// Lazy toolsets: a full tools/list is ~362KB (~98k tokens) with everything loaded, which is about
// half a 200k context window spent before the user types anything — and a 228-candidate list also
// hurts tool-selection accuracy. Every tool stays registered and callable; tools outside the active
// set are simply hidden from tools/list until sf_load_toolset or sf_find_tool switches them on.
// Set SF_TOOLSETS=all to restore the pre-3.0 behaviour of loading everything up front.
const initialToolsets = registry.resolveInitial(process.env["SF_TOOLSETS"]);
registry.setActive(initialToolsets);

// ─── Startup banner ───────────────────────────────────────────────────────────

function logStartup(kind: string): void {
  console.error(`Salesforce Metadata MCP server v${VERSION} running on ${kind}`);
  console.error(
    `Toolsets: ${registry.activeGroups().join(", ") || "none"} — ` +
      `${registry.residentTools()} of ${registry.totalTools()} tools loaded. ` +
      `Use sf_find_tool or sf_load_toolset to load more; SF_TOOLSETS=all loads everything.`,
  );
  if (process.env["SF_TOOLSETS_VERBOSE"] === "1") {
    console.error(toolsetSummary(registry));
  }
}

// ─── Transport: stdio ─────────────────────────────────────────────────────────

async function runStdio(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logStartup("stdio");
}

// ─── Transport: HTTP ──────────────────────────────────────────────────────────

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf-8");
        resolve(raw ? (JSON.parse(raw) as unknown) : {});
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

async function runHTTP(): Promise<void> {
  const port = parseInt(process.env["PORT"] ?? "3000", 10);
  // Defaults to localhost-only: this endpoint has no authentication of its own (any request that
  // reaches /mcp executes tools using whatever Salesforce credentials this process is configured
  // with), and Node's http.Server.listen(port) with no host binds to ALL interfaces by default —
  // found during the 2026-07-31 security audit. Set HOST explicitly (e.g. "0.0.0.0") to opt into
  // wider exposure — e.g. behind a reverse proxy that adds its own auth — rather than exposing this
  // unauthenticated by accident.
  const host = process.env["HOST"] ?? "127.0.0.1";

  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? "/";

    if (url === "/health" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", server: "salesforce-metadata-mcp", version: VERSION }));
      return;
    }

    if (url === "/mcp" && req.method === "POST") {
      let body: unknown;
      try {
        body = await readBody(req);
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON body" }));
        return;
      }
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      res.on("close", () => transport.close());
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  });

  httpServer.listen(port, host, () => {
    logStartup(`http://${host}:${port}/mcp`);
  });
}

// ─── Entry point ──────────────────────────────────────────────────────────────

const transport = process.env["TRANSPORT"] ?? "stdio";
if (transport === "http") {
  runHTTP().catch((err: unknown) => {
    console.error("Server error:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
} else {
  runStdio().catch((err: unknown) => {
    console.error("Server error:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
