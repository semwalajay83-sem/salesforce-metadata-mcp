/**
 * Shared MCP client harness for the QA sweeps.
 *
 * Speaks JSON-RPC to a real server process over stdio, the way a client does. Nothing here
 * imports from dist/services directly — the point of these sweeps is to exercise the whole
 * path (tools/call -> zod schema -> service -> org), because that is where the reachability
 * and schema bugs have actually lived.
 */
import { spawn } from "node:child_process";

// Point these at your own dev org with SF_INSTANCE_URL / SF_ALIAS rather than editing the file.
// Never run these sweeps against a production or customer org: they create and delete metadata.
export const SERVER_ENV = {
  SF_INSTANCE_URL: process.env.SF_INSTANCE_URL ?? "https://orgfarm-da9c760de3-dev-ed.develop.my.salesforce.com",
  SF_ALIAS: process.env.SF_ALIAS ?? "demo-org",
};

export function startServer({ env = {}, serverPath = "dist/index.js" } = {}) {
  const child = spawn(process.execPath, [serverPath], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...SERVER_ENV, ...env },
  });

  const pending = new Map();
  const stderr = [];
  let buf = "";

  child.stdout.on("data", (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let m;
      try { m = JSON.parse(line); } catch { continue; } // startup banner is plain text
      if (m.id != null && pending.has(m.id)) {
        const { resolve } = pending.get(m.id);
        pending.delete(m.id);
        resolve(m);
      }
    }
  });
  child.stderr.on("data", (d) => stderr.push(d.toString()));

  let id = 1;
  function req(method, params, timeoutMs = 120000) {
    const myId = id++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(myId);
        reject(new Error(`timeout after ${timeoutMs}ms: ${method} ${params?.name ?? ""}`));
      }, timeoutMs);
      pending.set(myId, {
        resolve: (m) => { clearTimeout(timer); resolve(m); },
      });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: myId, method, params }) + "\n");
    });
  }

  return {
    child,
    req,
    stderr,
    async initialize() {
      const r = await req("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "qa-full-sweep", version: "1" },
      });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
      return r.result;
    },
    async listTools() {
      const out = [];
      let cursor;
      do {
        const r = await req("tools/list", cursor ? { cursor } : {});
        out.push(...(r.result?.tools ?? []));
        cursor = r.result?.nextCursor;
      } while (cursor);
      return out;
    },
    /**
     * Calls a tool and normalises the reply into { ok, payload, error }.
     * An MCP-level error, isError:true, or a JSON body with success:false all count as failure —
     * the 2026-08-19 audit found the old suite treating the last of those as a pass.
     */
    async call(name, args, timeoutMs) {
      const r = await req("tools/call", { name, arguments: args ?? {} }, timeoutMs);
      if (r.error) return { ok: false, error: r.error.message ?? JSON.stringify(r.error), payload: null };
      const res = r.result ?? {};
      const text = (res.content ?? []).map((c) => c.text ?? "").join("\n");
      let payload = null;
      try { payload = JSON.parse(text); } catch { payload = null; }
      if (res.isError) return { ok: false, error: text || "isError", payload };
      if (payload && payload.success === false) {
        return { ok: false, error: payload.message ?? payload.error ?? text, payload };
      }
      return { ok: true, payload, text };
    },
    stop() {
      try { child.stdin.end(); } catch { /* already gone */ }
      child.kill();
    },
  };
}
