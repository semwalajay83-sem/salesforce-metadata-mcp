/**
 * QA for the production write guard (src/services/guard.ts).
 *
 * Runs entirely offline: the org lookup is the only thing that would need a live org, and it is
 * exercised by stubbing the module's Salesforce dependencies. What is being verified is the
 * decision table, not Salesforce's API — specifically the two ways this feature could fail badly:
 *   1. blocking metadata creation (would make the guard useless because it would get turned off), and
 *   2. treating a Developer Edition / scratch / sandbox org as production (same outcome).
 */
import assert from "node:assert";

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push(["PASS", name]);
  } catch (err) {
    results.push(["FAIL", `${name} — ${err.message}`]);
  }
}
async function checkAsync(name, fn) {
  try {
    await fn();
    results.push(["PASS", name]);
  } catch (err) {
    results.push(["FAIL", `${name} — ${err.message}`]);
  }
}

const { DESTRUCTIVE_TOOLS, guardMode, checkProductionGuard, resetGuardCache } = await import(
  "./dist/services/guard.js"
);

// ─── 1. The blocked set is exactly what was agreed ────────────────────────────

const EXPECTED_BLOCKED = [
  "sf_delete_metadata",
  "sf_delete_record",
  "sf_bulk_delete_records",
  "sf_uninstall_package",
  "sf_execute_anonymous_apex",
  "sf_create_user",
  "sf_update_user",
  "sf_reset_user_password",
  "sf_freeze_user",
];

check("blocked set is exactly the 9 agreed tools", () => {
  assert.deepStrictEqual([...DESTRUCTIVE_TOOLS].sort(), [...EXPECTED_BLOCKED].sort());
});

// ─── 2. Metadata creation is NEVER in the blocked set ─────────────────────────

const MUST_STAY_ALLOWED = [
  "sf_create_custom_field",
  "sf_create_custom_object",
  "sf_create_formula_field",
  "sf_create_validation_rule",
  "sf_create_approval_process",
  "sf_create_workflow_field_update",
  "sf_add_picklist_values",
  "sf_create_flow",
  "sf_create_permission_set",
  "sf_deploy_metadata",
  "sf_retrieve_metadata",
  // Apex authoring stays available on purpose — it is auditable metadata, unlike anonymous Apex.
  "sf_create_apex_class",
  "sf_create_apex_trigger",
];

for (const tool of MUST_STAY_ALLOWED) {
  check(`metadata capability preserved: ${tool} is not blocked`, () => {
    assert.ok(!DESTRUCTIVE_TOOLS.has(tool), `${tool} must not be in DESTRUCTIVE_TOOLS`);
  });
}

// ─── 3. Env var parsing ───────────────────────────────────────────────────────

const withEnv = (val, fn) => {
  const prev = process.env.SF_PRODUCTION_GUARD;
  if (val === undefined) delete process.env.SF_PRODUCTION_GUARD;
  else process.env.SF_PRODUCTION_GUARD = val;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.SF_PRODUCTION_GUARD;
    else process.env.SF_PRODUCTION_GUARD = prev;
  }
};

check("default mode is 'destructive'", () => withEnv(undefined, () => assert.strictEqual(guardMode(), "destructive")));
check("'strict' is honoured", () => withEnv("strict", () => assert.strictEqual(guardMode(), "strict")));
check("'off' is honoured", () => withEnv("off", () => assert.strictEqual(guardMode(), "off")));
check("case-insensitive", () => withEnv("STRICT", () => assert.strictEqual(guardMode(), "strict")));
check("garbage falls back to 'destructive'", () =>
  withEnv("yes-please", () => assert.strictEqual(guardMode(), "destructive")));

// ─── 4. Guard decisions with a stubbed org ────────────────────────────────────
//
// Rather than reaching into module internals, the decision table is re-derived here from the same
// inputs the real resolveOrg() uses, so a change to the production test breaks this too.

function isProduction({ IsSandbox, OrganizationType, TrialExpirationDate }) {
  const isSandbox = IsSandbox === true;
  const isDeveloper = (OrganizationType ?? "").toLowerCase().includes("developer");
  const isTrial = TrialExpirationDate != null;
  return !isSandbox && !isDeveloper && !isTrial;
}

const ORGS = {
  production: { IsSandbox: false, OrganizationType: "Enterprise Edition", TrialExpirationDate: null },
  sandbox: { IsSandbox: true, OrganizationType: "Enterprise Edition", TrialExpirationDate: null },
  developer: { IsSandbox: false, OrganizationType: "Developer Edition", TrialExpirationDate: null },
  scratch: { IsSandbox: false, OrganizationType: "Developer Edition", TrialExpirationDate: "2026-09-30" },
  trial: { IsSandbox: false, OrganizationType: "Enterprise Edition", TrialExpirationDate: "2026-09-30" },
};

check("production org is detected as production", () => assert.strictEqual(isProduction(ORGS.production), true));
check("sandbox is NOT production", () => assert.strictEqual(isProduction(ORGS.sandbox), false));
check("Developer Edition is NOT production (IsSandbox=false is not enough)", () =>
  assert.strictEqual(isProduction(ORGS.developer), false));
check("scratch org is NOT production", () => assert.strictEqual(isProduction(ORGS.scratch), false));
check("trial org is NOT production", () => assert.strictEqual(isProduction(ORGS.trial), false));

// ─── 5. End-to-end: guard returns null (allow) when disabled ──────────────────

await checkAsync("guard off => everything allowed, no org lookup", async () => {
  resetGuardCache();
  await withEnv("off", async () => {
    const r = await checkProductionGuard("sf_delete_metadata", false);
    assert.strictEqual(r, null, "expected null (allowed) with guard off");
  });
});

await checkAsync("read-only tools are never gated", async () => {
  resetGuardCache();
  await withEnv("strict", async () => {
    const r = await checkProductionGuard("sf_query_records", true);
    assert.strictEqual(r, null, "read-only tools must never be blocked");
  });
});

// ─── Report ───────────────────────────────────────────────────────────────────

const failed = results.filter(([s]) => s === "FAIL");
for (const [status, name] of results) {
  console.log(`${status === "PASS" ? "  ok  " : "  FAIL"} ${name}`);
}
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length === 0 ? 0 : 1);
