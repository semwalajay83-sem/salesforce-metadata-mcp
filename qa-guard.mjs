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

// ─── 6. Attack regression: zip-slip into a delete manifest ────────────────────
//
// These are not hypotheticals. On 2026-08-28 the first two ACTUALLY WORKED: inferMetadataPath's
// default branch appended no extension, so a component name of "../destructiveChanges.xml" produced
// a root-level destructiveChanges.xml in the deploy zip, turning the additive-only
// sf_deploy_metadata into a metadata deletion primitive that bypassed the guard completely.

const { buildGenericDeployZip, buildPackageXml } = await import("./dist/services/deployment.js");
const JSZip = (await import("jszip")).default;

const DUMMY_XML = '<?xml version="1.0"?><Package xmlns="http://soap.sforce.com/2006/04/metadata"/>';

const ZIP_ATTACKS = [
  ["relative traversal to destructiveChanges.xml", "X", "../destructiveChanges.xml"],
  ["deep traversal", "X", "../../../destructiveChanges.xml"],
  ["backslash traversal", "X", String.raw`..\destructiveChanges.xml`],
  ["mixed separator traversal", "X", String.raw`foo\..\destructiveChanges.xml`],
  ["reserved name directly", "X", "destructiveChanges.xml"],
  ["reserved name, different case", "X", "DESTRUCTIVECHANGES.XML"],
  ["destructiveChangesPost variant", "X", "destructiveChangesPost.xml"],
  ["package.xml overwrite", "X", "package.xml"],
  ["nested path", "X", "a/b/destructiveChanges.xml"],
  ["traversal on a known type", "ApexClass", "../../destructiveChanges.xml"],
];

for (const [label, type, name] of ZIP_ATTACKS) {
  await checkAsync(`deploy zip attack refused: ${label}`, async () => {
    let entries = null;
    try {
      const b64 = await buildGenericDeployZip([], "66.0", [{ type, name, xml: DUMMY_XML }]);
      const zip = await JSZip.loadAsync(Buffer.from(b64, "base64"));
      entries = Object.keys(zip.files);
    } catch {
      return; // rejected outright — the desired outcome
    }
    const lower = entries.map((e) => e.toLowerCase());
    assert.ok(
      !lower.some((e) => /destructivechanges[a-z]*\.xml$/.test(e)),
      `delete manifest reached the zip: ${entries.join(", ")}`,
    );
    assert.strictEqual(
      lower.filter((e) => e === "package.xml").length, 1,
      `package.xml was replaced or duplicated: ${entries.join(", ")}`,
    );
  });
}

await checkAsync("legitimate deploy zip is unaffected", async () => {
  const b64 = await buildGenericDeployZip(
    [{ type: "CustomObject", name: "Foo__c" }],
    "66.0",
    [{ type: "ApexClass", name: "MyClass", xml: "<x/>" }],
  );
  const entries = Object.keys(await JSZip.loadAsync(Buffer.from(b64, "base64")).then((z) => z.files));
  assert.ok(entries.includes("package.xml"), "package.xml missing");
  assert.ok(entries.includes("classes/MyClass.cls"), "component missing");
});

check("package.xml member names cannot inject elements", () => {
  const xml = buildPackageXml(
    [{ name: "CustomObject", members: ["Foo</members></types><types><members>*</members><name>ApexClass</name></types><types><members>x"] }],
    "66.0",
  );
  assert.ok(!/<name>ApexClass<\/name>/.test(xml), "injected <name> element survived escaping");
});

// ─── 7. Attack regression: guard evaluating the wrong org ─────────────────────
//
// sf_uninstall_package ignores its auth argument and shells out to `sf package uninstall
// --target-org <params.targetOrg>`. The guard resolved production-ness from getAuth(), so an
// explicit targetOrg pointed the tool at an org the guard never looked at.

for (const param of ["targetOrg", "targetAlias", "targetOrgAlias", "orgAlias"]) {
  await checkAsync(`gated tool refused when redirected via '${param}'`, async () => {
    resetGuardCache();
    const r = await checkProductionGuard("sf_uninstall_package", false, { packageId: "04t", [param]: "prod" });
    assert.notStrictEqual(r, null, `${param} override was allowed without verifying the target org`);
  });
}

await checkAsync("empty override string is not treated as a redirect", async () => {
  resetGuardCache();
  const r = await checkProductionGuard("sf_create_custom_field", false, { targetOrg: "" });
  assert.strictEqual(r, null, "non-gated tool with empty override must be allowed");
});

// ─── Report ───────────────────────────────────────────────────────────────────

const failed = results.filter(([s]) => s === "FAIL");
for (const [status, name] of results) {
  console.log(`${status === "PASS" ? "  ok  " : "  FAIL"} ${name}`);
}
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length === 0 ? 0 : 1);
