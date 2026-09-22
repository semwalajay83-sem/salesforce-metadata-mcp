#!/usr/bin/env node
/**
 * Pins the Workflow child-component fix (2026-09-22).
 *
 * Five tools — sf_create_workflow_rule, sf_create_workflow_field_update, sf_create_field_update,
 * sf_create_email_alert, sf_create_outbound_message — used to wrap their component in a
 * `met:Workflow` upsert keyed on the OBJECT. A Workflow upsert replaces the object's entire
 * workflow, so each call would have destroyed every other rule, alert, field update and outbound
 * message on that object. Salesforce refused them all with a 500 UNKNOWN_EXCEPTION, which is the
 * only reason nothing was lost.
 *
 * Getting them to succeed is therefore only half the test. The half that matters is that creating
 * a SECOND workflow child leaves the FIRST one standing — that is the property the old code would
 * have violated the moment Salesforce accepted it.
 *
 * Run: node qa-workflow-children.mjs
 */
import { startServer, SERVER_ENV } from "./qa-lib.mjs";
Object.assign(process.env, SERVER_ENV);

const T = Date.now().toString().slice(-7);
const OBJ = `QAWf${T}__c`;
let pass = 0, fail = 0;
const check = (label, ok, detail) => {
  if (ok) { pass++; console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ""}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`); }
};

const s = startServer({ env: { SF_TOOLSETS: "all" } });
await s.initialize();

console.log(`1. scaffold an object to hang workflow off (${OBJ})`);
let r = await s.call("sf_create_custom_object", { fullName: OBJ, label: `QA WF ${T}`, pluralLabel: `QA WF ${T}s` });
check("object created", r.ok, r.ok ? "" : r.error);
r = await s.call("sf_create_custom_field", { objectName: OBJ, fieldName: "Notes__c", label: "Notes", type: "Text", length: 100 });
check("text field created", r.ok, r.ok ? "" : r.error);
r = await s.call("sf_create_email_template", {
  fullName: `unfiled$public/QAWfEt${T}`, name: `QAWfEt${T}`, label: `QA WF ET ${T}`,
  subject: "QA", body: "QA body",
});
check("email template created", r.ok, r.ok ? "" : r.error);

console.log("\n2. each of the five workflow children must now deploy");
const made = [];
r = await s.call("sf_create_workflow_field_update", {
  objectName: OBJ, actionName: `QAFuA${T}`, label: `QA FU A ${T}`, field: "Notes__c", literalValue: "A",
});
check("sf_create_workflow_field_update", r.ok, r.ok ? "" : r.error);
if (r.ok) made.push(["WorkflowFieldUpdate", `${OBJ}.QAFuA${T}`]);

r = await s.call("sf_create_field_update", {
  objectName: OBJ, fullName: `QAFuB${T}`, name: `QA FU B ${T}`, field: "Notes__c",
  operation: "Literal", literalValue: "B",
});
check("sf_create_field_update", r.ok, r.ok ? "" : r.error);
if (r.ok) made.push(["WorkflowFieldUpdate", `${OBJ}.QAFuB${T}`]);

r = await s.call("sf_create_workflow_rule", {
  objectName: OBJ, fullName: `QAWr${T}`, triggerType: "onCreateOnly", formula: "LEN(Name) > 0",
});
check("sf_create_workflow_rule", r.ok, r.ok ? "" : r.error);
if (r.ok) made.push(["WorkflowRule", `${OBJ}.QAWr${T}`]);

r = await s.call("sf_create_email_alert", {
  objectName: OBJ, alertName: `QAEa${T}`, label: `QA EA ${T}`,
  template: `unfiled$public/QAWfEt${T}`, senderType: "CurrentUser",
  recipients: [{ type: "owner" }],
});
check("sf_create_email_alert", r.ok, r.ok ? "" : r.error);
if (r.ok) made.push(["WorkflowAlert", `${OBJ}.QAEa${T}`]);

r = await s.call("sf_create_outbound_message", {
  objectName: OBJ, fullName: `QAOm${T}`, name: `QA OM ${T}`,
  endpointUrl: "https://example.com/hook", fields: ["Id"],
});
check("sf_create_outbound_message", r.ok, r.ok ? "" : r.error);
if (r.ok) made.push(["WorkflowOutboundMessage", `${OBJ}.QAOm${T}`]);

console.log("\n3. THE REGRESSION: every child must still exist — later writes must not have");
console.log("   replaced the object's workflow and taken the earlier ones with them");
const { getAuth, readMetadataItem } = await import("./dist/services/salesforce.js");
const auth = await getAuth();
const wf = await readMetadataItem(auth, "Workflow", OBJ);
if (!wf.success) {
  check("read the object's Workflow back", false, wf.message);
} else {
  const raw = String(wf.rawXml);
  const has = (tag, name) => new RegExp(`<${tag}>[\\s\\S]*?<fullName>${name}</fullName>`, "i").test(raw)
    || raw.includes(`<fullName>${name}</fullName>`);
  check("field update A survived", has("fieldUpdates", `QAFuA${T}`), has("fieldUpdates", `QAFuA${T}`) ? "" : "GONE");
  check("field update B survived", has("fieldUpdates", `QAFuB${T}`), has("fieldUpdates", `QAFuB${T}`) ? "" : "GONE");
  check("workflow rule survived", has("rules", `QAWr${T}`), has("rules", `QAWr${T}`) ? "" : "GONE");
  check("email alert survived", has("alerts", `QAEa${T}`), has("alerts", `QAEa${T}`) ? "" : "GONE");
  check("outbound message survived", has("outboundMessages", `QAOm${T}`), has("outboundMessages", `QAOm${T}`) ? "" : "GONE");
  const counts = ["fieldUpdates", "rules", "alerts", "outboundMessages"]
    .map((t) => `${t}=${(raw.match(new RegExp(`<${t}>`, "gi")) ?? []).length}`).join(" ");
  console.log(`   workflow now holds: ${counts}`);
}

console.log("\n4. cleanup");
for (const [type, fullName] of made.reverse()) {
  const d = await s.call("sf_delete_metadata", { metadataType: type, fullNames: [fullName] });
  if (!d.ok) console.log(`   note: could not delete ${type} ${fullName} — ${String(d.error).slice(0, 90)}`);
}
await s.call("sf_delete_metadata", { metadataType: "EmailTemplate", fullNames: [`unfiled$public/QAWfEt${T}`] });
const dobj = await s.call("sf_delete_metadata", { metadataType: "CustomObject", fullNames: [OBJ] });
check("test object deleted", dobj.ok, dobj.ok ? "" : String(dobj.error).slice(0, 120));

console.log(`\n${"=".repeat(60)}\nPASS ${pass}  FAIL ${fail}`);
s.stop();
process.exit(fail ? 1 : 0);
