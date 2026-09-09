#!/usr/bin/env node
/**
 * Regression suite for the 2026-09-09 report: `sf_query_records` ignored its own `limit`.
 *
 * `queryRecords` only ever interpolated `params.limit` into the SOQL it *builds* from
 * objectApiName/fields/whereClause. Every call through `sf_query_records` passes `query`, which
 * takes the other branch, so the parameter was inert — including its documented `default: 200`.
 * The failure was silent and open: no error, no truncation notice, and `message` reported the real
 * row count as though it were the requested one.
 *
 * Two things are asserted here, and the second is the one that is easy to skip: a cap that is
 * applied but not *reported* turns an unbounded result into a silently truncated one, which is a
 * different bug of the same family rather than a fix. So every capped response must say what cap
 * was applied, where it came from, and whether rows were actually cut off.
 *
 * Also covers the reported error-message truncation, which lives in the same REST path.
 *
 * Needs a live org. Run: node qa-query-limit.mjs
 */
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, "dist", "index.js");

const ORG_ALIAS = process.env.SF_ALIAS || "demo-org";
const ORG_URL = (() => {
  if (process.env.SF_INSTANCE_URL) return process.env.SF_INSTANCE_URL;
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

if (!ORG_URL) {
  console.error("No live org resolved — this suite needs one. Set SF_ALIAS / SF_INSTANCE_URL.");
  process.exit(2);
}
console.log(`Live org: ${ORG_ALIAS}`);

let pass = 0;
let fail = 0;
const failures = [];
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

// ─── Minimal stdio MCP client ────────────────────────────────────────────────
const child = spawn(process.execPath, [SERVER], {
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, SF_ALIAS: ORG_ALIAS, SF_INSTANCE_URL: ORG_URL },
});
const frames = [];
let buf = "";
child.stdout.on("data", (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    try {
      const m = JSON.parse(line);
      if (!m.method) frames.push(m);
    } catch {
      /* not json */
    }
  }
});
child.stderr.on("data", () => {});

let nextId = 1;
function request(method, params) {
  const id = nextId++;
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      const f = frames.find((x) => x.id === id);
      if (f) {
        clearInterval(iv);
        resolve(f);
      } else if (Date.now() - t0 > 60000) {
        clearInterval(iv);
        reject(new Error(`timeout on ${method}`));
      }
    }, 20);
  });
}
async function callTool(name, args) {
  const res = await request("tools/call", { name, arguments: args });
  try {
    return JSON.parse(res.result.content[0].text);
  } catch {
    return { _raw: res };
  }
}

await request("initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "qa-query-limit", version: "1" },
});
child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

// EntityDefinition is present in every org with well over 200 rows, so no seeding is needed and
// the assertions do not depend on data this suite created.
const BIG = "SELECT QualifiedApiName FROM EntityDefinition ORDER BY QualifiedApiName";

console.log("\nA. the reported bug — limit must actually cap");
{
  const r = await callTool("sf_query_records", { query: BIG, limit: 3 });
  check("limit: 3 returns exactly 3 records", r.records?.length === 3, `got ${r.records?.length} (totalSize ${r.totalSize})`);
  check("totalSize agrees with what was returned", r.totalSize === 3, `got ${r.totalSize}`);
}

console.log("\nB. the documented default must be real");
{
  const r = await callTool("sf_query_records", { query: BIG });
  check("omitted limit caps at the documented 200", r.records?.length === 200, `got ${r.records?.length}`);
}

console.log("\nC. precedence must be defined and the guardrail must not be raisable");
{
  const tight = await callTool("sf_query_records", { query: `${BIG} LIMIT 5`, limit: 100 });
  check("a tighter LIMIT in the SOQL wins over a looser param", tight.records?.length === 5, `got ${tight.records?.length}`);

  const loose = await callTool("sf_query_records", { query: `${BIG} LIMIT 500`, limit: 10 });
  check("a looser LIMIT in the SOQL cannot raise the param guardrail", loose.records?.length === 10, `got ${loose.records?.length}`);
}

console.log("\nD. a capped result must never look like a complete one");
{
  const capped = await callTool("sf_query_records", { query: BIG, limit: 3 });
  check("response reports the cap it applied", capped.appliedLimit === 3, `appliedLimit=${capped.appliedLimit}`);
  check("response names where the cap came from", typeof capped.limitSource === "string", `limitSource=${capped.limitSource}`);
  check("response flags that rows were cut off", capped.truncated === true, `truncated=${capped.truncated}`);
  check("message states the result is capped", /cap|truncat|more/i.test(capped.message ?? ""), capped.message);

  // A result that fits under the cap must NOT be flagged — a false truncation warning is its own
  // failure, and would make the flag useless by crying wolf on every complete result.
  const complete = await callTool("sf_query_records", {
    query: "SELECT QualifiedApiName FROM EntityDefinition WHERE QualifiedApiName = 'Account'",
    limit: 50,
  });
  check("a complete result is not flagged as truncated", complete.truncated === false, `truncated=${complete.truncated}`);
  check("a complete result still reports success", complete.success === true, JSON.stringify(complete).slice(0, 140));
}

console.log("\nE. aggregate and OFFSET queries must not be broken by the cap");
{
  const agg = await callTool("sf_query_records", { query: "SELECT COUNT() FROM EntityDefinition", limit: 5 });
  check("COUNT() query still succeeds", agg.success === true, JSON.stringify(agg).slice(0, 160));

  // GROUP BY aggregates are documented on the tool and take a different path from COUNT(): they
  // return many rows, so they ARE capped, and appending LIMIT to them must stay valid SOQL.
  const grouped = await callTool("sf_query_records", {
    query: "SELECT Type, COUNT(Id) FROM Account GROUP BY Type",
    limit: 5,
  });
  check("GROUP BY aggregate query still succeeds", grouped.success === true, JSON.stringify(grouped).slice(0, 160));
  check("GROUP BY aggregate respects the cap", (grouped.records?.length ?? 0) <= 5, `got ${grouped.records?.length}`);

  // A LIMIT inside a parenthesised subquery must not be mistaken for the outer one.
  const sub = await callTool("sf_query_records", {
    query: "SELECT Id, (SELECT Id FROM Contacts LIMIT 2) FROM Account",
    limit: 4,
  });
  check("subquery LIMIT is not treated as the outer LIMIT", sub.success === true && (sub.records?.length ?? 0) <= 4, JSON.stringify(sub).slice(0, 160));

  const offset = await callTool("sf_query_records", { query: `${BIG} LIMIT 10 OFFSET 5`, limit: 100 });
  check("LIMIT + OFFSET query still succeeds", offset.success === true, JSON.stringify(offset).slice(0, 160));
  check("LIMIT + OFFSET still honours its own limit", offset.records?.length === 10, `got ${offset.records?.length}`);
}

console.log("\nF. Salesforce error text must not be cut mid-sentence");
{
  // The reported case: this error runs past 300 characters and its useful pointer is at the end.
  const r = await callTool("sf_query_records", { query: "SELECT Id FROM GenAiFunction", limit: 5 });
  check("query against an unsupported sObject fails", r.success === false);
  const msg = r.message ?? "";
  check("error text is not truncated at 300 chars", msg.length > 320 || /\.\s*$|\)$/.test(msg.trim()), `len=${msg.length}: ...${msg.slice(-60)}`);
  check("the tail of the error survives", /reference|documentation|__c/i.test(msg), `...${msg.slice(-80)}`);
}

child.kill();
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log("Failures:\n  - " + failures.join("\n  - "));
  process.exit(1);
}
