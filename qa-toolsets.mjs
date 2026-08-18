#!/usr/bin/env node
/**
 * qa-toolsets.mjs — end-to-end QA for lazy toolsets (v3.0.0), against a real org.
 *
 * Every other suite in this repo imports service functions from dist/services/* directly and never
 * speaks MCP, so none of them touch the layer this feature lives in. Toolset gating happens inside
 * the SDK's tools/list and tools/call handlers, which means a tool can be perfectly functional and
 * still be unreachable — exactly the regression the other suites cannot see.
 *
 * This drives the built server over stdio the way a real client does: list tools, get refused for a
 * gated tool, recover through sf_find_tool, then actually deploy metadata to the org through the
 * newly-loaded tool and clean up after itself.
 *
 * Usage:
 *   SF_ALIAS=demo-org SF_INSTANCE_URL=<org-url> node qa-toolsets.mjs
 */
import { spawn } from "child_process";

const INSTANCE = process.env.SF_INSTANCE_URL;
const ALIAS = process.env.SF_ALIAS;
if (!INSTANCE || !ALIAS) {
  console.error("Set SF_ALIAS and SF_INSTANCE_URL. Example:");
  console.error("  SF_ALIAS=demo-org SF_INSTANCE_URL=https://your-org.my.salesforce.com node qa-toolsets.mjs");
  process.exit(2);
}

const STAMP = Date.now().toString().slice(-6);
const FLOW_API = `QA_Toolset_Flow_${STAMP}`;

let pass = 0;
let fail = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) {
    pass++;
    console.log(`  PASS ${name}`);
  } else {
    fail++;
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
function section(t) {
  console.log(`\n${"─".repeat(72)}\n  ${t}\n${"─".repeat(72)}`);
}

/** Minimal MCP stdio client — enough to initialize, list and call. */
function client(env = {}) {
  const proc = spawn("node", ["dist/index.js"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, SF_INSTANCE_URL: INSTANCE, SF_ALIAS: ALIAS, ...env },
  });
  let buf = "";
  let nextId = 100;
  const waiting = new Map();
  let notifications = 0;
  proc.stderr.on("data", () => {});
  proc.stdout.on("data", (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.method === "notifications/tools/list_changed") {
        notifications++;
        continue;
      }
      const w = waiting.get(msg.id);
      if (w) {
        waiting.delete(msg.id);
        w(msg);
      }
    }
  });
  const rpc = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      waiting.set(id, resolve);
      proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      setTimeout(() => {
        if (waiting.has(id)) {
          waiting.delete(id);
          reject(new Error(`timeout on ${method}`));
        }
      }, 120000);
    });
  return {
    notifications: () => notifications,
    async start() {
      await rpc("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "qa-toolsets", version: "1" },
      });
      proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    },
    async list() {
      const r = await rpc("tools/list", {});
      return r.result.tools;
    },
    /** Returns { text, isError, errorMessage } — protocol errors and tool errors both land here. */
    async call(name, args) {
      const r = await rpc("tools/call", { name, arguments: args });
      if (r.error) return { errorMessage: r.error.message, isError: true };
      const text = r.result?.content?.[0]?.text ?? "";
      return { text, isError: !!r.result?.isError };
    },
    stop() {
      try {
        proc.kill();
      } catch {
        /* already gone */
      }
    },
  };
}

const json = (s) => {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
};

async function main() {
  console.log(`Toolset QA against ${INSTANCE} (alias ${ALIAS})`);

  // ── A. Default startup ─────────────────────────────────────────────────────
  section("A. DEFAULT STARTUP");
  const c = client();
  await c.start();
  const def = await c.list();
  const defNames = def.map((t) => t.name);

  check("default list is small (< 30 tools)", def.length < 30, `${def.length} tools`);
  for (const t of [
    "sf_deploy_metadata",
    "sf_retrieve_metadata",
    "sf_query_records",
    "sf_describe_object",
    "sf_list_objects",
  ]) {
    check(`core tool present by default: ${t}`, defNames.includes(t));
  }
  for (const t of ["sf_list_toolsets", "sf_load_toolset", "sf_find_tool"]) {
    check(`meta-tool always on: ${t}`, defNames.includes(t));
  }
  check(
    "sf_create_flow NOT in default (it is the largest tool definition)",
    !defNames.includes("sf_create_flow"),
  );

  // ── B. A default tool really works against the org ─────────────────────────
  section("B. DEFAULT TOOL HITS THE REAL ORG");
  const desc = await c.call("sf_describe_object", { objectApiName: "Account" });
  check("sf_describe_object Account succeeds", !desc.isError, desc.errorMessage || desc.text?.slice(0, 120));
  check("describe returned real field metadata", /Name|fields|label/i.test(desc.text || ""));

  // ── C. Gating and recovery ─────────────────────────────────────────────────
  section("C. GATING AND RECOVERY");
  const gated = await c.call("sf_create_flow", { label: "x", apiName: "x" });
  check(
    "gated tool refused before load",
    /disabled/i.test(gated.errorMessage || gated.text || ""),
    gated.errorMessage || gated.text?.slice(0, 100),
  );

  const before = c.notifications();
  const found = await c.call("sf_find_tool", { query: "create flow" });
  const fj = json(found.text);
  check("sf_find_tool located sf_create_flow", (fj.matches || []).some((m) => m.tool === "sf_create_flow"));
  check("sf_find_tool auto-loaded a toolset", (fj.loadedToolsets || []).length > 0, JSON.stringify(fj.loadedToolsets));
  check("exactly one list_changed per load", c.notifications() - before === 1, `${c.notifications() - before}`);

  const after = await c.list();
  check("sf_create_flow now listed", after.map((t) => t.name).includes("sf_create_flow"));

  // ── D. The newly-loaded tool actually deploys to the org ───────────────────
  section("D. LOADED TOOL DEPLOYS FOR REAL");
  const created = await c.call("sf_create_flow", {
    label: `QA Toolset Flow ${STAMP}`,
    apiName: FLOW_API,
    description: "Temporary flow created by qa-toolsets.mjs. Safe to delete.",
    flowType: "AutoLaunchedFlow",
    status: "Draft",
    variables: [{ name: "inputText", dataType: "String", isInput: true }],
  });
  const cj = json(created.text);
  check(
    "sf_create_flow deployed after loading",
    !created.isError && cj.success !== false,
    created.errorMessage || created.text?.slice(0, 200),
  );

  // Verify independently, through a *different* tool than the one that created it, that the
  // metadata really landed in the org. sf_list_flow_versions is in the same `flows` toolset that
  // sf_find_tool just auto-loaded, so this doubles as a check that the load brought in the whole
  // group rather than only the searched tool.
  const q = await c.call("sf_list_flow_versions", { flowApiName: FLOW_API });
  check("flow verified present in org via sf_list_flow_versions", (q.text || "").includes(FLOW_API), (q.text || "").slice(0, 200));

  // ── E. Explicit load + unknown toolset handling ────────────────────────────
  section("E. EXPLICIT LOAD");
  const loaded = await c.call("sf_load_toolset", { toolsets: ["security", "definitely_not_a_toolset"] });
  const lj = json(loaded.text);
  check("known toolset loaded", (lj.newlyLoaded || []).includes("security"));
  check("unknown toolset reported, not silently ignored", (lj.unknownToolsets || []).includes("definitely_not_a_toolset"));
  const listed = await c.call("sf_list_toolsets", {});
  check("sf_list_toolsets reports totals", /"totalTools": *228/.test(listed.text || ""), (listed.text || "").slice(0, 120));

  // ── F. Cleanup ─────────────────────────────────────────────────────────────
  section("F. CLEANUP");
  const del = await c.call("sf_delete_metadata", { metadataType: "Flow", fullNames: [FLOW_API] });
  check("test flow deleted", !del.isError, del.errorMessage || (del.text || "").slice(0, 200));
  c.stop();

  // ── G. Back-compat: SF_TOOLSETS=all ────────────────────────────────────────
  section("G. BACK-COMPAT (SF_TOOLSETS=all)");
  const all = client({ SF_TOOLSETS: "all" });
  await all.start();
  const allTools = await all.list();
  check("all 228 tools + 3 meta-tools exposed", allTools.length === 231, `${allTools.length} tools`);
  check("no tool lost vs pre-3.0", allTools.filter((t) => t.name.startsWith("sf_")).length === 231);
  all.stop();

  const none = client({ SF_TOOLSETS: "none" });
  await none.start();
  const noneTools = await none.list();
  check("SF_TOOLSETS=none leaves only the 3 meta-tools", noneTools.length === 3, `${noneTools.length} tools`);
  none.stop();

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log(`\n${"═".repeat(72)}`);
  console.log(`  ${pass} passed, ${fail} failed`);
  if (fail > 0) {
    console.log("\n  Failures:");
    failures.forEach((f) => console.log(`   - ${f}`));
  }
  console.log(`${"═".repeat(72)}\n`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("\nQA ABORTED:", e.message);
  process.exit(1);
});
