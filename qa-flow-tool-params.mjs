#!/usr/bin/env node
/**
 * Regression suite for two sf_create_flow bugs found by live skill testing on 2026-10-21.
 *
 *  A. A fieldUpdate carrying a formula on a custom field generated the resource name
 *     `FU_End_Date__c_Formula`. Salesforce rejects consecutive underscores in flow resource names,
 *     so every "set a custom field to a formula" flow failed to deploy.
 *  B. The tool handed buildFlowDeployXml a hand-picked subset of its params, silently dropping
 *     formulas, constants, textTemplates, recordTriggerType and the schedule fields. A flow whose
 *     assignment referenced a formula deployed as InvalidDraft; trigger choices were ignored.
 *
 * Bug B lived in the tool dispatch, not the XML builders, which is why qa-flow-comprehensive.mjs
 * (which calls the builders directly) never saw it. Everything here goes through tools/call.
 *
 * Needs a live dev org. Run: node qa-flow-tool-params.mjs
 */
import { spawnSync } from "node:child_process";
import { startServer, SERVER_ENV } from "./qa-lib.mjs";
import { fieldUpdateFormulaName } from "./dist/services/salesforce.js";

const OBJ = "QAFlowParams__c";
const FLOW_A = "QA_FlowParams_FieldUpdateFormula";
const FLOW_B = "QA_FlowParams_Formulas_Passthrough";
const PERMSET = "QA_FlowParams_Access";

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
}

function sf(args) {
  const r = spawnSync(`sf ${args} -o ${SERVER_ENV.SF_ALIAS} --json`, { encoding: "utf8", shell: true, timeout: 300000 });
  try { return JSON.parse(r.stdout); } catch { return { status: 1, raw: r.stdout + r.stderr }; }
}

function deleteFlowVersions(apiName) {
  const q = sf(`data query -t -q "SELECT Id FROM Flow WHERE Definition.DeveloperName='${apiName}'"`);
  for (const rec of q.result?.records ?? []) sf(`data delete record -t -s Flow -i ${rec.Id}`);
}

function cleanup() {
  // A permission set with live assignments can't be deleted, so unassign first.
  const a = sf(`data query -q "SELECT Id FROM PermissionSetAssignment WHERE PermissionSet.Name='${PERMSET}'"`);
  for (const rec of a.result?.records ?? []) sf(`data delete record -s PermissionSetAssignment -i ${rec.Id}`);
  deleteFlowVersions(FLOW_A);
  deleteFlowVersions(FLOW_B);
  spawnSync(
    `sf project delete source -o ${SERVER_ENV.SF_ALIAS} --metadata "PermissionSet:${PERMSET}" --metadata "CustomObject:${OBJ}" --no-prompt --json`,
    { encoding: "utf8", shell: true, timeout: 300000, cwd: process.env.QA_SFDX_PROJECT ?? undefined },
  );
}

async function flowXml(srv, apiName) {
  const r = await srv.call("sf_retrieve_metadata", { metadataType: "Flow", componentName: apiName });
  return r.payload?.files?.[0]?.content ?? "";
}

// ── Offline: the name helper itself ──────────────────────────────────────────────────────────
console.log("fieldUpdateFormulaName");
for (const field of ["End_Date__c", "Amount", "ns__Field__c", "_x__", "Weird Field!"]) {
  const n = fieldUpdateFormulaName(field);
  check(`${field} -> ${n} is a legal flow name`, /^[A-Za-z][A-Za-z0-9_]*$/.test(n) && !n.includes("__") && !n.endsWith("_"));
}

// ── Live ─────────────────────────────────────────────────────────────────────────────────────
const srv = startServer({ env: { SF_TOOLSETS: "core,metadata,flows,apex,security" } });
try {
  await srv.initialize();

  console.log("setup");
  let r = await srv.call("sf_create_custom_object", { fullName: OBJ, label: "QA Flow Params", pluralLabel: "QA Flow Params", nameFieldType: "Text", nameFieldLabel: "Name" });
  check("create test object", r.ok, r.error);
  r = await srv.call("sf_create_custom_field", { objectName: OBJ, fieldName: "Status__c", label: "Status", type: "Picklist", picklistValues: ["Planned", "Done"] });
  check("create Status__c", r.ok, r.error);
  r = await srv.call("sf_create_custom_field", { objectName: OBJ, fieldName: "End_Date__c", label: "End Date", type: "Date" });
  check("create End_Date__c", r.ok, r.error);
  r = await srv.call("sf_create_custom_field", { objectName: OBJ, fieldName: "Note__c", label: "Note", type: "Text", length: 100 });
  check("create Note__c", r.ok, r.error);
  // New fields are invisible to the running user — even to anonymous Apex at compile time — until
  // it has field-level security on them.
  r = await srv.call("sf_create_permission_set", {
    fullName: PERMSET, label: "QA Flow Params Access",
    objectPermissions: [{ object: OBJ, allowRead: true, allowCreate: true, allowEdit: true }],
    fieldPermissions: ["Status__c", "End_Date__c", "Note__c"].map((f) => ({ field: `${OBJ}.${f}`, readable: true, editable: true })),
  });
  check("create permission set", r.ok, r.error);
  const asg = sf(`org assign permset -n ${PERMSET}`);
  check("assign permission set to running user", asg.status === 0, JSON.stringify(asg).slice(0, 200));

  console.log("Bug A: fieldUpdates formula on a custom field");
  r = await srv.call("sf_create_flow", {
    apiName: FLOW_A, label: "QA FlowParams FieldUpdateFormula", flowType: "RecordTriggeredFlow",
    triggerType: "RecordBeforeSave", triggerObject: OBJ, recordTriggerType: "CreateAndUpdate",
    triggerFilterFormula: "AND(ISPICKVAL({!$Record.Status__c}, 'Done'), ISBLANK({!$Record.End_Date__c}))",
    fieldUpdates: [{ field: "End_Date__c", formula: "TODAY()", formulaDataType: "Date" }],
    status: "Active",
  }, 600000);
  check("deploys and activates", r.ok, r.error);
  let xml = await flowXml(srv, FLOW_A);
  check("formula resource uses the sanitised name", xml.includes(`<name>${fieldUpdateFormulaName("End_Date__c")}</name>`));
  check("status is Active", xml.includes("<status>Active</status>"), (xml.match(/<status>[^<]*<\/status>/) ?? [""])[0]);

  // Runtime: anonymous Apex runs in system mode, so the new fields are readable without FLS.
  r = await srv.call("sf_execute_anonymous_apex", {
    apexCode: `${OBJ} rec = new ${OBJ}(Name='qa', Status__c='Done'); insert rec;\n` +
      `System.debug('QA_END_DATE=' + [SELECT End_Date__c FROM ${OBJ} WHERE Id = :rec.Id].End_Date__c + ';TODAY=' + Date.today());`,
  }, 300000);
  const out = JSON.stringify(r.payload ?? r.error ?? "");
  const m = out.match(/QA_END_DATE=([0-9-]+)[^;]*;TODAY=([0-9-]+)/);
  check("flow sets End_Date__c to today at runtime", !!m && m[1] === m[2], m ? `${m[1]} vs ${m[2]}` : out.slice(0, 300));

  console.log("Bug B: formulas / constants / recordTriggerType reach the builder");
  r = await srv.call("sf_create_flow", {
    apiName: FLOW_B, label: "QA FlowParams Formulas Passthrough", flowType: "RecordTriggeredFlow",
    triggerType: "RecordBeforeSave", triggerObject: OBJ, recordTriggerType: "Create",
    formulas: [{ name: "Today_Date", dataType: "Date", expression: "TODAY()" }],
    constants: [{ name: "Note_Text", dataType: "String", value: "set by flow" }],
    elements: [{
      type: "Assignment", name: "Set_Fields", label: "Set Fields",
      assignments: [
        { assignToRef: "$Record.End_Date__c", operator: "Assign", valueRef: "Today_Date" },
        { assignToRef: "$Record.Note__c", operator: "Assign", valueRef: "Note_Text" },
      ],
    }],
    status: "Draft",
  }, 600000);
  check("deploys", r.ok, r.error);
  xml = await flowXml(srv, FLOW_B);
  check("formula is in the deployed flow", xml.includes("<name>Today_Date</name>") && xml.includes("<formulas>"));
  check("constant is in the deployed flow", xml.includes("<name>Note_Text</name>") && xml.includes("<constants>"));
  check("recordTriggerType=Create honoured", xml.includes("<recordTriggerType>Create</recordTriggerType>"), (xml.match(/<recordTriggerType>[^<]*<\/recordTriggerType>/) ?? ["missing"])[0]);
  check("status is Draft, not InvalidDraft", xml.includes("<status>Draft</status>"), (xml.match(/<status>[^<]*<\/status>/) ?? [""])[0]);
} catch (e) {
  fail++;
  console.log(`  FAIL harness: ${e.message}`);
} finally {
  // An active flow version can't be deleted, and the object can't be deleted while a flow uses it.
  try { await srv.call("sf_deactivate_flow", { flowApiName: FLOW_A }, 300000); } catch { /* cleanup is best effort */ }
  srv.stop();
  console.log("cleanup");
  cleanup();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
