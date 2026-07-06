#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { registerTools } from "./tools/index.js";

const server = new McpServer({
  name: "salesforce-metadata-mcp",
  version: "2.5.8",
});

registerTools(server);

// ─── Transport: stdio ─────────────────────────────────────────────────────────

async function runStdio(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Salesforce Metadata MCP server v2.5.8 running on stdio");
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

  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? "/";

    if (url === "/health" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", server: "salesforce-metadata-mcp", version: "2.5.8" }));
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

  httpServer.listen(port, () => {
    console.error(`Salesforce Metadata MCP server v2.5.8 running on http://localhost:${port}/mcp`);
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
