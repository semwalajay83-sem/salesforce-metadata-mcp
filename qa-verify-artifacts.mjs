#!/usr/bin/env node
/**
 * Second pass: for every tool the sweep recorded as PASS, prove the artifact is REALLY in the org.
 *
 * The sweep marks a tool PASS when it returns success, and only some fixtures carry an inline
 * verifier. "Returned success" is the weakest possible evidence — a tool that reports success
 * without doing the work is exactly the failure mode the 2026-08-19 audit found. This pass closes
 * that gap by listing metadata straight from the org with the sf CLI and checking each expected
 * component is present.
 *
 * Run: node qa-verify-artifacts.mjs   (reads qa-sweep-report.json)
 */
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const report = JSON.parse(readFileSync("qa-sweep-report.json", "utf8"));
const T = report.ts;
const OBJ = report.ctx.obj;
const passed = new Set(report.results.filter((r) => r.verdict === "PASS").map((r) => r.tool));

// tool -> [metadataType, fullName] that MUST exist in the org if that tool truly did its job
const EXPECT = {
  sf_create_custom_object:        ["CustomObject", OBJ],
  sf_create_custom_field:         ["CustomField", `${OBJ}.Notes__c`],
  sf_create_formula_field:        ["CustomField", `${OBJ}.NameLen__c`],
  sf_create_external_id_field:    ["CustomField", `${OBJ}.ExtId__c`],
  sf_create_validation_rule:      ["ValidationRule", `${OBJ}.QAVR${T}`],
  sf_create_record_type:          ["RecordType", `${OBJ}.QART${T}`],
  sf_create_page_layout:          ["Layout", `${OBJ}-QAPL${T}`],
  sf_create_compact_layout:       ["CompactLayout", `${OBJ}.QACL${T}`],
  sf_create_list_view:            ["ListView", `${OBJ}.QALV${T}`],
  sf_create_field_set:            ["FieldSet", `${OBJ}.QAFS${T}`],
  sf_create_custom_metadata_type: ["CustomObject", `QAMdt${T}__mdt`],
  sf_create_custom_label:         ["CustomLabel", `QALbl${T}`],
  sf_create_custom_setting:       ["CustomObject", `QASet${T}__c`],
  sf_create_global_value_set:     ["GlobalValueSet", `QAGvs${T}`],
  sf_create_business_process:     ["BusinessProcess", `Case.QABp${T}`],
  sf_create_quick_action:         ["QuickAction", `${OBJ}.QAQa${T}`],
  sf_create_global_action:        ["QuickAction", `QAGa${T}`],
  sf_create_custom_button:        ["WebLink", `${OBJ}.QABtn${T}`],
  sf_create_report_type:          ["ReportType", `QARt${T}`],
  sf_create_platform_event:       ["CustomObject", `QAEvt${T}__e`],
  sf_create_apex_class:           ["ApexClass", `QACls${T}`],
  sf_create_apex_test_class:      ["ApexClass", `QAClsTest${T}`],
  sf_create_apex_trigger:         ["ApexTrigger", `QATrg${T}`],
  sf_create_flow:                 ["Flow", `QAFlow${T}`],
  sf_create_flow_from_xml:        ["Flow", `QAFlowX${T}`],
  sf_create_lwc:                  ["LightningComponentBundle", `qaLwc${T}`],
  sf_create_aura_component:       ["AuraDefinitionBundle", `qaAura${T}`],
  sf_create_aura_app:             ["AuraDefinitionBundle", `qaAuraApp${T}`],
  sf_create_aura_event:           ["AuraDefinitionBundle", `qaAuraEvt${T}`],
  sf_create_visualforce_page:     ["ApexPage", `QAVf${T}`],
  sf_create_visualforce_component:["ApexComponent", `QAVfc${T}`],
  sf_create_static_resource:      ["StaticResource", `QASr${T}`],
  sf_create_lightning_app:        ["CustomApplication", `QALapp${T}`],
  sf_create_custom_application:   ["CustomApplication", `QACapp${T}`],
  sf_create_flexipage:            ["FlexiPage", `QAFp${T}`],
  sf_create_tab:                  ["CustomTab", `QATab${T}`],
  sf_create_custom_tab:           ["CustomTab", `QAWtab${T}`],
  sf_create_permission_set:       ["PermissionSet", `QAPs${T}`],
  sf_create_custom_permission:    ["CustomPermission", `QACp${T}`],
  sf_create_permission_set_group: ["PermissionSetGroup", `QAPsg${T}`],
  sf_create_role:                 ["Role", `QARole${T}`],
  sf_create_queue:                ["Queue", `QAQueue${T}`],
  sf_create_named_credential:     ["NamedCredential", `QANc${T}`],
  sf_create_group:                ["Group", `QAGrp${T}`],
  sf_create_public_group:         ["Group", `QAGrp${T}`],
  sf_create_letterhead:           ["Letterhead", `QALh${T}`],
  sf_create_remote_site_setting:  ["RemoteSiteSetting", `QARss${T}`],
  sf_create_connected_app:        ["ConnectedApp", `QACa${T}`],
  sf_create_external_data_source: ["ExternalDataSource", `QAEds${T}`],
  sf_create_auth_provider:        ["AuthProvider", `QAAuth${T}`],
  sf_create_email_template:       ["EmailTemplate", `unfiled$public/QAEt${T}`],
  sf_create_report_folder:        ["ReportFolder", `QARf${T}`],
  sf_create_workflow_field_update:["WorkflowFieldUpdate", `${OBJ}.QAFu${T}`],
  sf_create_email_alert:          ["WorkflowAlert", `${OBJ}.QAEa${T}`],
  sf_create_matching_rule:        ["MatchingRule", `Lead.QAMr${T}`],
  sf_create_sharing_rule:         ["SharingCriteriaRule", `${OBJ}.QASr${T}`],
  sf_create_path_assistant:       ["PathAssistant", `QAPath${T}`],
  sf_deploy_metadata:             ["CustomLabel", `QADep${T}`],
};

const cache = new Map();
function listMetadata(type) {
  if (cache.has(type)) return cache.get(type);
  let names = new Set();
  try {
    const out = execFileSync("sf", ["org", "list", "metadata", "-m", type, "-o", "demo-org", "--json"],
      { encoding: "utf8", timeout: 120000, shell: true });
    const j = JSON.parse(out.slice(out.indexOf("{")));
    names = new Set((j.result ?? []).map((x) => x.fullName));
  } catch { /* type unsupported in this org, or nothing of it exists */ }
  cache.set(type, names);
  return names;
}

let confirmed = 0, ghosts = 0, untested = 0;
const ghostList = [];
for (const [tool, [type, fullName]] of Object.entries(EXPECT)) {
  if (!passed.has(tool)) { untested++; continue; }
  const present = listMetadata(type).has(fullName);
  if (present) { confirmed++; console.log(`  OK    ${tool} -> ${type}:${fullName}`); }
  else {
    ghosts++; ghostList.push({ tool, type, fullName });
    console.log(`  GHOST ${tool} -> ${type}:${fullName} reported success but is NOT in the org`);
  }
}

console.log(`\n${"=".repeat(70)}`);
console.log(`confirmed in org: ${confirmed}   GHOST successes: ${ghosts}   not-passed/skipped: ${untested}`);
if (ghostList.length) {
  console.log(`\nGHOSTS — these tools claimed success without doing the work:`);
  for (const g of ghostList) console.log(`  - ${g.tool} (${g.type}: ${g.fullName})`);
}
process.exit(ghosts ? 1 : 0);
