#!/usr/bin/env node
/**
 * Pins the fixes from the first full sweep against the qa-scratch org (2026-09-23).
 *
 * - sf_create_duplicate_rule: the default call (Allow on insert and update, active) was rejected
 *   because a bare Allow "has no effect". Allow now carries Report, like Salesforce's standard rule.
 * - sf_create_forecast_hierarchy: sent one half-empty forecasting type and crashed Salesforce.
 *   Now read-modify-write. The property that matters is that EVERY OTHER type survives unchanged.
 * - sf_create_experience_site: upserted a bare Network that could never be valid. Now uses the
 *   Connect API, which builds the site from a real template.
 *
 * Verification goes through the sf CLI, never the server under test.
 *
 * Run: SF_ALIAS=qa-scratch SF_INSTANCE_URL="$(cat .qa-scratch-url)" node qa-scratch-fixes.mjs
 */
import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, SERVER_ENV } from "./qa-lib.mjs";
Object.assign(process.env, SERVER_ENV);

const ALIAS = SERVER_ENV.SF_ALIAS;
const T = Date.now().toString().slice(-7);
let pass = 0, fail = 0;
const check = (label, ok, detail) => {
  if (ok) { pass++; console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ""}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`); }
};
const soql = (q) => JSON.parse(execSync(`sf data query -o ${ALIAS} --json -q "${q}"`, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })).result.records;
// Forecasting types as { name: active }, read with the CLI.
function forecastTypes() {
  const dir = mkdtempSync(join(tmpdir(), "qa-fc-"));
  execSync(`sf project retrieve start -o ${ALIAS} -m Settings:Forecasting --target-metadata-dir "${dir}" --unzip --json`, { cwd: "qa-scratch", stdio: ["ignore", "pipe", "ignore"] });
  const file = execSync(`find "${dir}" -name "Forecasting.settings"`, { encoding: "utf8", shell: "bash" }).trim();
  const xml = readFileSync(file, "utf8");
  const out = {};
  for (const blk of xml.match(/<forecastingTypeSettings>[\s\S]*?<\/forecastingTypeSettings>/g) ?? []) {
    out[blk.match(/<name>([^<]*)<\/name>/)[1]] = { active: blk.match(/<active>([^<]*)<\/active>/)[1], len: blk.length };
  }
  return out;
}

const s = startServer({ env: { SF_TOOLSETS: "all" } });
await s.initialize();

console.log("1. duplicate rule with the defaults (Allow / Allow, active)");
let r = await s.call("sf_create_duplicate_rule", {
  objectName: "Lead", ruleName: `QADr${T}`, label: `QA DR ${T}`,
  matchingRules: [{ matchingRule: "Standard_Lead_Match_Rule_v1_0" }],
});
check("tool succeeds", r.ok, r.ok ? "" : r.error);
const dr = soql(`SELECT DeveloperName, IsActive FROM DuplicateRule WHERE DeveloperName = 'QADr${T}'`);
check("rule exists and is active (CLI)", dr.length === 1 && dr[0].IsActive === true, JSON.stringify(dr));

console.log("2. forecast hierarchy is read-modify-write");
const before = forecastTypes();
const target = "OpportunityQuantity";
const flipTo = before[target]?.active === "true" ? false : true;
r = await s.call("sf_create_forecast_hierarchy", { forecastingType: target, isActive: flipTo });
check("tool succeeds", r.ok, r.ok ? "" : r.error);
const after = forecastTypes();
check(`${target} active is now ${flipTo}`, after[target]?.active === String(flipTo), JSON.stringify(after[target]));
const others = Object.keys(before).filter((n) => n !== target);
const changed = others.filter((n) => JSON.stringify(before[n]) !== JSON.stringify(after[n]));
check(`the other ${others.length} types are unchanged`, others.length > 0 && changed.length === 0, changed.join(", "));
r = await s.call("sf_create_forecast_hierarchy", { forecastingType: "ProductFamily" });
check("unknown type is refused with the org's list", !r.ok && /Available: .*OpportunityRevenue/.test(r.error), r.error?.slice(0, 120));
// put it back
await s.call("sf_create_forecast_hierarchy", { forecastingType: target, isActive: before[target]?.active === "true" });

console.log("3. experience site through the Connect API");
r = await s.call("sf_create_experience_site", { siteName: `QASite${T}`, label: `QA Site ${T}`, urlPathPrefix: `qa${T}`, template: "LWR" }, 180000);
check("tool succeeds", r.ok, r.ok ? r.payload?.message : r.error);
const net = soql(`SELECT Id, Name FROM Network WHERE Name = 'QA Site ${T}'`);
check("Network exists (CLI)", net.length === 1, JSON.stringify(net));
r = await s.call("sf_create_experience_site", { siteName: `QASite${T}`, label: `QA Site ${T}`, urlPathPrefix: `qa${T}`, template: "LWR" }, 180000);
check("second call is idempotent", r.ok && r.payload?.created === false, r.ok ? r.payload?.message : r.error);

s.stop();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
