#!/usr/bin/env node
/**
 * Full-surface QA sweep: calls EVERY registered tool over a real MCP session against a real org.
 *
 * Deliberately not test-suite.mjs. That one imports the service functions straight out of
 * dist/services and never touches the MCP layer, so it cannot see schema-validation bugs,
 * registration bugs, or reachability bugs — which is precisely where this project's bugs live.
 * Here every tool goes through tools/call exactly as a client would send it.
 *
 * Verdicts:
 *   PASS      tool succeeded (and, where a verifier exists, the org confirms the work landed)
 *   UNAVAIL   tool failed, but the org genuinely lacks the feature AND the error says so clearly.
 *             This is a legitimate outcome, not a bug — but only if the message is actionable.
 *   LIMIT     the org is full, not the tool broken: platform-event cap, user licences, matching
 *             rules, external data sources. A dev org accumulates these over years of QA runs.
 *   BUG       anything else: a crash, an opaque error, a schema rejection of valid input, a
 *             success that did not actually happen in the org, or an "unavailable" that was
 *             reported so badly a user could not act on it.
 *
 * Run: node qa-full-sweep.mjs [--only <substr>] [--phase <n>] [--no-cleanup]
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";

// The sf CLI target for independent verification. Follows SF_ALIAS so a sweep can run against a
// scratch org without editing anything.
const SF_CLI_ORG = process.env.SF_ALIAS ?? "demo-org";
import { startServer } from "./qa-lib.mjs";
import { buildFixtures, verifiersRef } from "./qa-fixtures.mjs";

const argv = process.argv.slice(2);
const only = argv.includes("--only") ? argv[argv.indexOf("--only") + 1] : null;
const phaseOnly = argv.includes("--phase") ? Number(argv[argv.indexOf("--phase") + 1]) : null;
const noCleanup = argv.includes("--no-cleanup");

const TS = Date.now().toString().slice(-7);
const results = [];
const ctx = {
  TS,
  obj: `QA${TS}__c`,
  objLabel: `QA ${TS}`,
  created: [],          // {type, fullName} for cleanup
  recordIds: {},        // objectApiName -> [ids]
  vals: {},             // scratch values passed between fixtures
};

// ─── independent org verification (via the sf CLI, NOT via the server under test) ────────────
const mdCache = new Map();
function sfCli(args) {
  try {
    const out = execFileSync("sf", args, { encoding: "utf8", timeout: 120000, shell: true });
    const i = out.indexOf("{");
    return i >= 0 ? JSON.parse(out.slice(i)) : null;
  } catch (e) {
    const s = String(e.stdout ?? "") + String(e.stderr ?? "");
    const i = s.indexOf("{");
    try { return i >= 0 ? JSON.parse(s.slice(i)) : null; } catch { return null; }
  }
}
function listMetadata(type) {
  if (mdCache.has(type)) return mdCache.get(type);
  const r = sfCli(["org", "list", "metadata", "-m", type, "-o", SF_CLI_ORG, "--json"]);
  const names = new Set((r?.result ?? []).map((x) => x.fullName));
  mdCache.set(type, names);
  return names;
}
function soql(q) {
  const r = sfCli(["data", "query", "-q", `"${q.replace(/"/g, '\\"')}"`, "-o", SF_CLI_ORG, "--json"]);
  return r?.result?.records ?? null;
}
function toolingSoql(q) {
  const r = sfCli(["data", "query", "-q", `"${q.replace(/"/g, '\\"')}"`, "-t", "-o", SF_CLI_ORG, "--json"]);
  return r?.result?.records ?? null;
}
const verifiers = { listMetadata, soql, toolingSoql, invalidate: (t) => mdCache.delete(t) };
// fixtures that build args lazily (bulk update/delete) need to query the org too
Object.assign(verifiersRef, verifiers);

// ─── the "is this a clean unavailability?" judgement ─────────────────────────────────────────
// A feature the org does not have is fine. An error the user cannot act on is not.
const UNAVAIL_SIGNALS = [
  /not (available|enabled|supported) in (this|your) org/i,
  // Salesforce's actual wording for an absent feature licence — OmniStudio, Experience Cloud and
  // friends all answer with "for this organization", which the pattern above never matched, so a
  // whole licensed-feature cluster was being scored as bugs.
  /not available (for \w+ )?for this organization/i,
  /is not a valid metadata type for reading/i,
  /Unable to determine type mapping for type/i,
  /Type is illegal here/i,
  /is not enabled/i,
  /requires? (the |a )?(.*)(licen[cs]e|permission|feature|package)/i,
  /not licensed/i,
  /INVALID_TYPE.*(sObject type|is not supported)/i,
  /no such column|sObject type '.*' is not supported/i,
  /Dev ?Hub/i,
  /must be enabled/i,
  /OmniStudio|Vlocity|DevOps Center|Salesforce CPQ/i,
  // Newer orgs refuse connected apps outright and point at External Client Apps.
  /only allows External Client Apps/i,
];
const OPAQUE_SIGNALS = [
  /^undefined$/i, /^null$/i, /^\[object Object\]$/i, /^Cannot read propert/i,
  /^Unexpected token/i, /^fetch failed$/i, /^request to .* failed/i, /ECONNREFUSED/i,
  /is not a function/i, /TypeError/i, /^INVALID_SESSION_ID/i,
];
/**
 * The org being full is not the tool being broken. A Developer Edition org caps platform events at
 * 5, matching rules, user licences and external data sources — and years of QA runs use them up.
 * Scoring those as bugs buries the real ones.
 */
const LIMIT_SIGNALS = [
  /reached (the )?maximum/i,
  /reached the limit of/i,
  /exceeded the maximum/i,
  /License Limit Exceeded/i,
  /limit exceeded/i,
  /already in use by another/i,
  /storage limit/i,
];

function judge(err) {
  const e = String(err ?? "");
  if (OPAQUE_SIGNALS.some((r) => r.test(e.trim()))) return "BUG";
  if (LIMIT_SIGNALS.some((r) => r.test(e))) return "LIMIT";
  if (UNAVAIL_SIGNALS.some((r) => r.test(e))) return "UNAVAIL";
  return "BUG";
}

function record(tool, verdict, detail, phase) {
  results.push({ tool, verdict, detail: String(detail ?? "").slice(0, 400), phase });
  const tag = { PASS: "PASS ", UNAVAIL: "UNAV ", LIMIT: "LIMIT", BUG: "BUG  ", SKIP: "SKIP " }[verdict];
  console.log(`  ${tag} ${tool}${detail ? ` — ${String(detail).slice(0, 150)}` : ""}`);
}

// ─── run ─────────────────────────────────────────────────────────────────────────────────────
const s = startServer({ env: { SF_TOOLSETS: "all" } });
await s.initialize();
const live = await s.listTools();
const liveNames = new Set(live.map((t) => t.name));
console.log(`server exposes ${live.length} tools\n`);

// seed the running user + a scratch dir; several fixtures need a real username/email
const who = sfCli(["org", "display", "-o", SF_CLI_ORG, "--json"]);
ctx.vals.username = who?.result?.username ?? "";
ctx.vals.email = who?.result?.username ?? "";
const me = soql(`SELECT Email FROM User WHERE Username = '${ctx.vals.username}'`);
if (me?.[0]?.Email) ctx.vals.email = me[0].Email;
ctx.vals.tmpDir = (process.env.TEMP ?? "/tmp").replace(/\\/g, "/") + "/qa-sweep-" + TS;
mkdirSync(ctx.vals.tmpDir, { recursive: true });
console.log(`running as ${ctx.vals.username} (${ctx.vals.email})`);
console.log(`scratch dir ${ctx.vals.tmpDir}
`);

const fixtures = buildFixtures(ctx);
const covered = new Set(fixtures.map((f) => f.tool));
const uncovered = [...liveNames].filter((n) => !covered.has(n));
if (uncovered.length) console.log(`!! no fixture for ${uncovered.length}: ${uncovered.join(", ")}\n`);

for (const f of fixtures) {
  if (only && !f.tool.includes(only)) continue;
  if (phaseOnly != null && f.phase !== phaseOnly) continue;
  if (!liveNames.has(f.tool)) { record(f.tool, "BUG", "tool not exposed by server", f.phase); continue; }

  let args;
  try {
    args = typeof f.args === "function" ? f.args(ctx) : (f.args ?? {});
  } catch (e) {
    record(f.tool, "BUG", `fixture could not build args: ${e.message}`, f.phase);
    continue;
  }
  if (args === null) { record(f.tool, "SKIP", f.skipReason ?? "prerequisite missing", f.phase); continue; }

  let res;
  try {
    res = await s.call(f.tool, args, f.timeout ?? 120000);
  } catch (e) {
    record(f.tool, "BUG", `no reply: ${e.message}`, f.phase);
    continue;
  }

  if (!res.ok) {
    const j = judge(res.error);
    const verdict = f.expectUnavailable ? (j === "BUG" ? "BUG" : j) : j;
    record(f.tool, verdict, res.error, f.phase);
    continue;
  }

  // succeeded — now make the org prove it, where a verifier exists
  if (f.verify) {
    try {
      const v = await f.verify(ctx, res, verifiers);
      if (v === true) record(f.tool, "PASS", f.note ?? "verified in org", f.phase);
      else record(f.tool, "BUG", `reported success but org says: ${v}`, f.phase);
    } catch (e) {
      record(f.tool, "BUG", `verifier threw: ${e.message}`, f.phase);
    }
  } else {
    record(f.tool, "PASS", f.note ?? "returned success (no org verifier)", f.phase);
  }

  if (f.after) { try { await f.after(ctx, res, s); } catch { /* best effort */ } }
}

// ─── report ──────────────────────────────────────────────────────────────────────────────────
const by = (v) => results.filter((r) => r.verdict === v);
console.log(`\n${"=".repeat(70)}`);
console.log(`PASS ${by("PASS").length}   UNAVAIL ${by("UNAVAIL").length}   LIMIT ${by("LIMIT").length}   BUG ${by("BUG").length}   SKIP ${by("SKIP").length}   (of ${results.length})`);
if (by("BUG").length) {
  console.log(`\nBUGS:`);
  for (const b of by("BUG")) console.log(`  - ${b.tool}: ${b.detail}`);
}
writeFileSync("qa-sweep-report.json", JSON.stringify({ ts: TS, ctx: { obj: ctx.obj }, results, uncovered }, null, 2));
console.log(`\nreport -> qa-sweep-report.json`);

if (!noCleanup) {
  console.log(`\ncleanup: ${ctx.created.length} metadata items`);
  const byType = {};
  for (const c of ctx.created) (byType[c.type] ??= []).push(c.fullName);
  for (const [type, names] of Object.entries(byType)) {
    const r = await s.call("sf_delete_metadata", { metadataType: type, fullNames: names }, 180000);
    console.log(`  ${r.ok ? "ok  " : "FAIL"} ${type} x${names.length}${r.ok ? "" : ` — ${String(r.error).slice(0, 120)}`}`);
  }
}
s.stop();
process.exit(by("BUG").length ? 1 : 0);
