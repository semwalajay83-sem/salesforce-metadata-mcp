#!/usr/bin/env node
/**
 * Regression check for the 2026-10-01 report: sf_execute_anonymous_apex never returned
 * System.debug output. The REST /tooling/executeAnonymous endpoint carries no log, so the old
 * `result.logs` branch could never fire while the tool description promised debug output.
 *
 * Over real MCP tools/call traffic, asserts that debug lines come back (including multi-line ones,
 * special characters, and lines written before a runtime exception), and that the three debugLog
 * modes do what they say.
 *
 * Read-only against the org (the Apex only calls System.debug). Run: node qa-anon-apex-debug.mjs
 */
import { startServer } from "./qa-lib.mjs";

let failures = 0;
const check = (label, cond, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${cond ? "" : `  -> ${String(detail).slice(0, 300)}`}`);
  if (!cond) failures++;
};

const server = startServer({ env: { SF_TOOLSETS: "all" } });
try {
  await server.initialize();
  const run = (apexCode, extra = {}) => server.call("sf_execute_anonymous_apex", { apexCode, ...extra }, 180000);

  const ok = await run(`System.debug('qa-marker-1');\nSystem.debug('a < b & "c"');\nSystem.debug('line one\\nline two');\nInteger n = [SELECT COUNT() FROM User];\nSystem.debug('users=' + (n > 0));`);
  const out = ok.payload?.debugOutput ?? [];
  check("default run succeeds", ok.ok, ok.error);
  check("debugOutput is returned", Array.isArray(ok.payload?.debugOutput), JSON.stringify(ok.payload).slice(0, 300));
  check("a plain debug line comes back", out.some((l) => l.includes("qa-marker-1")), JSON.stringify(out));
  check("special characters survive unescaped", out.some((l) => l.includes('a < b & "c"')), JSON.stringify(out));
  check("a multi-line message stays one entry", out.some((l) => l.includes("line one\nline two")), JSON.stringify(out));
  check("computed values come back", out.some((l) => l.includes("users=true")), JSON.stringify(out));
  check("only USER_DEBUG lines, not the raw log", out.length === 4 && !out.some((l) => /SOQL_EXECUTE|CODE_UNIT/.test(l)), JSON.stringify(out));
  check("message shows the debug output", /qa-marker-1/.test(ok.payload?.message ?? ""), ok.payload?.message);
  check("default mode does not return the raw log", ok.payload?.debugLog === undefined, "debugLog present");

  const boom = await run(`System.debug('before-the-throw');\nInteger z = 1 / 0;`);
  check("runtime exception is reported as failure", !boom.ok, "reported success");
  check("debug lines before the exception are kept", /before-the-throw/.test(boom.error ?? "") && (boom.payload?.debugOutput ?? []).some((l) => l.includes("before-the-throw")), boom.error);

  const full = await run(`System.debug('qa-full');`, { debugLog: "full" });
  check("full mode returns the raw log", typeof full.payload?.debugLog === "string" && /USER_DEBUG/.test(full.payload.debugLog), JSON.stringify(full.payload).slice(0, 300));

  const none = await run(`System.debug('qa-none');`, { debugLog: "none" });
  check("none mode returns no log", none.ok && none.payload?.debugOutput === undefined && !/qa-none/.test(none.payload?.message ?? ""), JSON.stringify(none.payload));

  const bad = await run(`Integer x = 'not a number';`);
  check("compile error is still reported", !bad.ok && /compile error/i.test(bad.error ?? ""), bad.error);
} finally {
  server.stop();
}

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
