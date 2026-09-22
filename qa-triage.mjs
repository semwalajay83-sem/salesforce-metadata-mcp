#!/usr/bin/env node
/**
 * Triage helper: groups sweep failures by signature so product bugs are separable from
 * fixture mistakes at a glance.
 *
 *   SCHEMA-REJECT  the server refused the arguments before any org call. Almost always the
 *                  fixture sent the wrong shape — the tool behaved correctly by refusing, and
 *                  the message names the exact offending path. Worth a second look only when
 *                  the rejected shape is the obvious way to call the tool.
 *   ORG-REJECT     the call reached Salesforce and Salesforce refused it. These are the real
 *                  candidates: the tool built a payload the platform will not accept.
 *   UNAVAILABLE    org genuinely lacks the feature.
 */
import { readFileSync } from "node:fs";

const report = JSON.parse(readFileSync(process.argv[2] ?? "qa-sweep-report.json", "utf8"));
const bugs = report.results.filter((r) => r.verdict === "BUG");

const clean = (d) => String(d).replace(/\s+/g, " ").trim();
const classify = (d) => {
  const s = clean(d);
  if (/MCP error -32602|Input validation error/.test(s)) return "SCHEMA-REJECT";
  if (/Salesforce API error|INVALID_|error occurred|must be|Required field|not found|must have/i.test(s)) return "ORG-REJECT";
  return "OTHER";
};

const groups = { "SCHEMA-REJECT": [], "ORG-REJECT": [], OTHER: [] };
for (const b of bugs) {
  const s = clean(b.detail);
  let msg = s;
  const m = s.match(/"message":\s*"(.*?)"(,|\s*\})/);
  if (m) msg = m[1];
  else {
    const v = s.match(/Input validation error: Invalid arguments for tool \S+: (.*)/);
    if (v) msg = v[1];
  }
  groups[classify(b.detail)].push({ tool: b.tool, phase: b.phase, msg: msg.slice(0, 160) });
}

for (const [k, list] of Object.entries(groups)) {
  if (!list.length) continue;
  console.log(`\n### ${k} (${list.length})`);
  for (const e of list) console.log(`  p${e.phase} ${e.tool.padEnd(36)} ${e.msg}`);
}

const counts = report.results.reduce((a, r) => ((a[r.verdict] = (a[r.verdict] ?? 0) + 1), a), {});
console.log(`\ntotals: ${JSON.stringify(counts)}  of ${report.results.length}`);

// Re-judge with the current signal lists, so a report captured under older rules can be read
// honestly without re-running the whole sweep (~50 min against a real org).
const LIMIT = [/reached (the )?maximum/i, /exceeded the maximum/i, /License Limit Exceeded/i, /limit exceeded/i, /already in use by another/i];
const UNAVAIL = [/not available (for \w+ )?for this organization/i, /not (available|enabled|supported) in (this|your) org/i, /is not enabled/i, /not licensed/i, /is not a valid metadata type for reading/i, /INVALID_TYPE/i, /Dev ?Hub/i, /OmniStudio|Vlocity|DevOps Center|Salesforce CPQ/i];
let nLimit = 0, nUnavail = 0;
const realList = [];
for (const b of bugs) {
  const d = clean(b.detail);
  if (LIMIT.some((r) => r.test(d))) nLimit++;
  else if (UNAVAIL.some((r) => r.test(d))) nUnavail++;
  else realList.push(b.tool);
}
console.log(`\nof the ${bugs.length} BUGs, re-judged with current rules:`);
console.log(`  org capacity / licence limits : ${nLimit}`);
console.log(`  feature absent from this org  : ${nUnavail}`);
console.log(`  genuinely worth chasing       : ${realList.length}`);
console.log(`  -> ${realList.join(", ")}`);
