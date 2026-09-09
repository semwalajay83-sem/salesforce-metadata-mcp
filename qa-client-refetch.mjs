#!/usr/bin/env node
/**
 * Regression suite for the 2026-09-09 "loaded tools never become callable" bug.
 *
 * The server was protocol-correct the whole time: it declares tools.listChanged, emits exactly one
 * notifications/tools/list_changed per sf_load_toolset, and tools/list genuinely changes. The bug
 * was that a real first-party client (Claude Desktop) never re-fetched, so the entire write surface
 * of the server stayed unreachable while every status payload reported success.
 *
 * So this suite tests two clients, not one:
 *
 *   REFETCHING  — honours list_changed. Proves the protocol path works.
 *   FROZEN      — caches tools/list at handshake and never refetches, which is what a model on a
 *                 broken client actually sees. Proves the escape hatch works without any refetch.
 *
 * The FROZEN case is the one that matters: it is the only assertion in this repo that would have
 * failed during the reported session. Asserting on loadedToolsets or residentTools passes cleanly
 * throughout the entire bug, which is exactly why it went undiagnosed for a session.
 *
 * Run: node qa-client-refetch.mjs
 */
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, "dist", "index.js");

/**
 * Resolves a live org so the end-to-end assertions exercise a real call rather than an auth error.
 * The suite still runs without one — the org-dependent checks report as skipped instead of failing,
 * because the protocol behaviour under test does not need Salesforce.
 */
const ORG_ALIAS = process.env.SF_ALIAS || "demo-org";
const ORG_URL = (() => {
  if (process.env.SF_INSTANCE_URL) return process.env.SF_INSTANCE_URL;
  // The alias reaches a shell (sf is a .cmd on Windows), so it is allowlisted the same way
  // src/services/salesforce.ts allowlists SF_ALIAS before interpolating it into a CLI call.
  if (!/^[A-Za-z0-9_-]+$/.test(ORG_ALIAS)) return null;
  try {
    const r = spawnSync(`sf org display --target-org ${ORG_ALIAS} --json`, {
      encoding: "utf8",
      shell: true,
      timeout: 60000,
    });
    return JSON.parse(r.stdout).result.instanceUrl;
  } catch {
    return null;
  }
})();
const ORG_ENV = ORG_URL ? { SF_ALIAS: ORG_ALIAS, SF_INSTANCE_URL: ORG_URL } : {};
console.log(ORG_URL ? `Live org: ${ORG_ALIAS} (${ORG_URL})` : "No live org resolved — org-dependent checks will be skipped.");

let pass = 0;
let fail = 0;
const failures = [];

let skipped = 0;
function skip(label, why) {
  skipped++;
  console.log(`  SKIP  ${label} — ${why}`);
}

function check(label, ok, detail) {
  if (ok) {
    pass++;
    console.log(`  PASS  ${label}`);
  } else {
    fail++;
    failures.push(label);
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

/** A JSON-RPC client over stdio that models how a host exposes tools to the model. */
class Client {
  constructor({ refetches }) {
    this.refetches = refetches;
    this.frames = [];
    this.notifications = [];
    this.nextId = 1;
    this.buf = "";
    /** What the model can actually see and call. Only ever updated by refetch(). */
    this.visible = [];
  }

  async start(env = {}) {
    this.child = spawn(process.execPath, [SERVER], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...ORG_ENV, ...env },
    });
    this.child.stdout.on("data", (d) => {
      this.buf += d.toString();
      let i;
      while ((i = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, i).trim();
        this.buf = this.buf.slice(i + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.method) {
          this.notifications.push(msg);
          // A refetching client reacts to the notification; a frozen one ignores it entirely.
          if (msg.method === "notifications/tools/list_changed" && this.refetches) this.dirty = true;
        } else {
          this.frames.push(msg);
        }
      }
    });
    this.child.stderr.on("data", () => {});

    await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: this.refetches ? "refetching" : "frozen", version: "1" },
    });
    this.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    await this.refetch();
  }

  send(obj) {
    this.child.stdin.write(JSON.stringify(obj) + "\n");
  }

  request(method, params) {
    const id = this.nextId++;
    this.send({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolve, reject) => {
      const t0 = Date.now();
      const iv = setInterval(() => {
        const f = this.frames.find((x) => x.id === id);
        if (f) {
          clearInterval(iv);
          resolve(f);
        } else if (Date.now() - t0 > 30000) {
          clearInterval(iv);
          reject(new Error(`timeout on ${method}`));
        }
      }, 20);
    });
  }

  async refetch() {
    const res = await this.request("tools/list", {});
    this.visible = res.result.tools;
    this.dirty = false;
    return this.visible;
  }

  /** Mirrors the host: settle any pending refetch, then refuse to call what the model cannot see. */
  async call(name, args) {
    if (this.dirty) await this.refetch();
    if (!this.visible.some((t) => t.name === name)) {
      return { unreachable: true, reason: `${name} is not in the client's tool list` };
    }
    const res = await this.request("tools/call", { name, arguments: args });
    return res.result ?? res.error;
  }

  sees(name) {
    return this.visible.some((t) => t.name === name);
  }

  schemaFor(name) {
    return this.visible.find((t) => t.name === name)?.inputSchema;
  }

  payload(result) {
    try {
      return JSON.parse(result.content[0].text);
    } catch {
      return null;
    }
  }

  stop() {
    this.child.kill();
  }
}

const TARGET = "sf_execute_anonymous_apex";

// Count canaries: core+metadata tools plus the five always-on meta-tools (list/load/find/schema/call).
const HANDSHAKE_TOOLS = 20;
const AFTER_LOAD_TOOLS = 49;

// ─── Scenario 1: a client that honours list_changed ───────────────────────────
console.log("\nSCENARIO 1 — refetching client (protocol path)");
{
  const c = new Client({ refetches: true });
  await c.start();
  const atHandshake = c.visible.length;
  check("handshake list is the default toolsets only", atHandshake === HANDSHAKE_TOOLS, `got ${atHandshake}`);
  check(`${TARGET} hidden at handshake`, !c.sees(TARGET));

  const before = c.notifications.length;
  const load = await c.call("sf_load_toolset", { toolsets: ["apex", "data"] });
  check("sf_load_toolset reports success", c.payload(load)?.success === true);

  await new Promise((r) => setTimeout(r, 300));
  const notifs = c.notifications.filter((n) => n.method === "notifications/tools/list_changed");
  check("exactly one list_changed emitted (not one per tool)", notifs.length - before === 1, `got ${notifs.length - before}`);

  await c.refetch();
  check("tools/list grew after load", c.visible.length > atHandshake, `${atHandshake} -> ${c.visible.length}`);
  check(`${TARGET} present in tools/list`, c.sees(TARGET));
  check("sf_create_record present in tools/list", c.sees("sf_create_record"));
  check("sf_bulk_insert_records present in tools/list", c.sees("sf_bulk_insert_records"));
  c.stop();
}

// ─── Scenario 2: the reported bug — a client that never refetches ─────────────
console.log("\nSCENARIO 2 — frozen client (the reported failure mode)");
{
  const c = new Client({ refetches: false });
  await c.start();
  check("handshake list is the default toolsets only", c.visible.length === HANDSHAKE_TOOLS, `got ${c.visible.length}`);

  const load = await c.call("sf_load_toolset", { toolsets: ["apex", "data"] });
  const loadPayload = c.payload(load);
  check("sf_load_toolset still reports success", loadPayload?.success === true);
  check("server-side resident count still moves", loadPayload?.residentTools === AFTER_LOAD_TOOLS, `got ${loadPayload?.residentTools}`);

  // This is the bug, reproduced: every status signal is healthy, the tool is enabled server-side,
  // and the model still cannot reach it because its list never changed.
  check(`${TARGET} STILL invisible to a frozen client`, !c.sees(TARGET));
  const direct = await c.call(TARGET, { apexCode: "System.debug(1);" });
  check("direct call is unreachable (the reported dead end)", direct.unreachable === true);

  // ── The fix: the escape hatch must work with no refetch at all ──
  check("sf_call_tool is visible at handshake", c.sees("sf_call_tool"));
  check("sf_tool_schema is visible at handshake", c.sees("sf_tool_schema"));

  const loadWarned = loadPayload?.clientDidNotRefresh === true;
  check("sf_load_toolset warns that the client did not refresh", loadWarned, JSON.stringify(loadPayload?.message ?? "").slice(0, 120));

  const find = await c.call("sf_find_tool", { query: TARGET });
  const findPayload = c.payload(find);
  const match = findPayload?.matches?.find((m) => m.tool === TARGET);
  check("sf_find_tool finds the tool", !!match);
  check("sf_find_tool returns its input schema inline", !!match?.inputSchema?.properties?.apexCode);

  const schema = await c.call("sf_tool_schema", { tool: TARGET });
  check("sf_tool_schema returns a usable schema", !!c.payload(schema)?.inputSchema?.properties?.apexCode);

  // Validation must survive the proxy: bad args must be rejected, not passed to the handler.
  const bad = await c.call("sf_call_tool", { tool: TARGET, arguments: { wrongParam: 1 } });
  const badPayload = c.payload(bad);
  check("sf_call_tool rejects invalid arguments", badPayload?.success === false && /validation/i.test(badPayload?.message ?? ""), JSON.stringify(badPayload).slice(0, 160));

  const unknown = await c.call("sf_call_tool", { tool: "sf_not_a_real_tool", arguments: {} });
  check("sf_call_tool rejects an unknown tool name", c.payload(unknown)?.success === false);

  // The real thing: reach a write tool that never appeared in the tool list.
  const proxied = await c.call("sf_call_tool", { tool: TARGET, arguments: { apexCode: "System.debug('mcp repro');" } });
  check("sf_call_tool reaches the tool without any refetch", proxied.unreachable !== true, JSON.stringify(proxied).slice(0, 200));
  const proxiedPayload = c.payload(proxied);
  if (!ORG_URL) skip("proxied call actually executed against the org", "no live org");
  else
    check(
      "proxied call actually executed against the org",
      proxiedPayload?.success === true,
      JSON.stringify(proxiedPayload).slice(0, 220),
    );
  c.stop();
}

// ─── Scenario 3: the production guard must not be bypassable via the proxy ────
console.log("\nSCENARIO 3 — guard integrity through the proxy");
{
  // Uses the guard's org-override path (a gated tool carrying an explicit targetOrg is refused
  // before any org lookup), so this is deterministic and needs no production org.
  const GATED = "sf_uninstall_package";
  const ARGS = { packageId: "04t000000000000AAA", targetOrg: "some-other-org" };

  const c = new Client({ refetches: true });
  await c.start();
  await c.call("sf_load_toolset", { toolsets: ["devops"] });
  await c.refetch();

  const direct = await c.call(GATED, ARGS);
  const directMsg = c.payload(direct)?.message ?? "";
  check(
    "guard refuses the direct call",
    c.payload(direct)?.success === false && /production write guard/i.test(directMsg),
    JSON.stringify(c.payload(direct)).slice(0, 160),
  );

  const viaProxy = await c.call("sf_call_tool", { tool: GATED, arguments: ARGS });
  const proxyMsg = c.payload(viaProxy)?.message ?? "";
  check(
    "guard ALSO refuses the same call through sf_call_tool",
    c.payload(viaProxy)?.success === false && /production write guard/i.test(proxyMsg),
    JSON.stringify(c.payload(viaProxy)).slice(0, 160),
  );
  c.stop();
}

// ─── Scenario 4: the proxy must be indistinguishable from a direct call ──────
console.log("\nSCENARIO 4 — sf_call_tool equivalence with the direct path");
{
  const c = new Client({ refetches: true });
  await c.start();
  await c.call("sf_load_toolset", { toolsets: ["apex"] });
  await c.refetch();

  // A read that needs no org, to prove equivalence even when Salesforce is unreachable: both paths
  // must produce the same outcome, whatever that outcome is.
  const args = { apexCode: "System.debug('equivalence probe');" };
  const direct = c.payload(await c.call(TARGET, args));
  const viaProxy = c.payload(await c.call("sf_call_tool", { tool: TARGET, arguments: args }));
  check(
    "direct and proxied calls agree on success",
    direct?.success === viaProxy?.success,
    `direct=${direct?.success} proxy=${viaProxy?.success}`,
  );
  check(
    "direct and proxied calls return the same result shape",
    JSON.stringify(Object.keys(direct ?? {}).sort()) === JSON.stringify(Object.keys(viaProxy ?? {}).sort()),
    `direct=${Object.keys(direct ?? {})} proxy=${Object.keys(viaProxy ?? {})}`,
  );

  // Validation parity: the same bad arguments must be rejected on both paths.
  const badDirect = await c.call(TARGET, { nope: 1 });
  const badProxy = c.payload(await c.call("sf_call_tool", { tool: TARGET, arguments: { nope: 1 } }));
  const directRejected = badDirect?.isError === true || /validation|required|invalid/i.test(JSON.stringify(badDirect));
  check("direct path rejects bad arguments", directRejected, JSON.stringify(badDirect).slice(0, 140));
  check(
    "proxy path rejects the same bad arguments",
    badProxy?.success === false && /validation/i.test(badProxy?.message ?? ""),
    JSON.stringify(badProxy).slice(0, 140),
  );

  // A conforming client must not be slowed down after the first probe resolves its verdict.
  const t0 = Date.now();
  await c.call("sf_load_toolset", { toolsets: ["ui"] });
  const elapsed = Date.now() - t0;
  check("no refetch probe delay once the client is known to refetch", elapsed < 250, `${elapsed}ms`);
  c.stop();
}

// ─── Scenario 5: the escape hatch must be complete and non-recursive ─────────
console.log("\nSCENARIO 5 — reachability floor and recursion safety");
{
  // SF_TOOLSETS=none is the worst case: nothing but the meta-tools is resident. If the whole
  // surface is reachable from here without a single refetch, it is reachable on any client.
  const c = new Client({ refetches: false });
  await c.start({ SF_TOOLSETS: "none" });
  check("only the meta-tools are resident", c.visible.length === 5, `got ${c.visible.length}`);

  const schema = c.payload(await c.call("sf_tool_schema", { tool: "sf_describe_object" }));
  check("sf_tool_schema reaches an unloaded tool's schema", schema?.success === true && !!schema.inputSchema);

  const probe = c.payload(await c.call("sf_call_tool", { tool: "sf_list_objects", arguments: {} }));
  if (!ORG_URL) skip("sf_call_tool reaches a core tool from SF_TOOLSETS=none", "no live org");
  else check("sf_call_tool reaches a core tool from SF_TOOLSETS=none", probe?.success === true, JSON.stringify(probe).slice(0, 160));

  // The meta-tools are registered outside the registry, so the proxy cannot invoke itself.
  const recurse = c.payload(await c.call("sf_call_tool", { tool: "sf_call_tool", arguments: { tool: "sf_list_objects" } }));
  check("sf_call_tool cannot invoke itself", recurse?.success === false, JSON.stringify(recurse).slice(0, 140));
  c.stop();
}

console.log(`\n${pass} passed, ${fail} failed${skipped ? `, ${skipped} skipped` : ""}`);
if (fail > 0) {
  console.log("Failures:\n  - " + failures.join("\n  - "));
  process.exit(1);
}
