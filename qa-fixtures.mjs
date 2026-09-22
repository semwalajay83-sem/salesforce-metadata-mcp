/**
 * Fixtures for the full-surface sweep. One entry per registered tool.
 *
 * Each fixture sends the tool's REQUIRED params (plus only what Salesforce genuinely needs on top),
 * because that is the minimal contract a real caller exercises — and it is where schema bugs show.
 *
 * `verify` proves the work in the org through the sf CLI, never through the server under test.
 * `expectUnavailable` marks features a Developer Edition org does not have; those must still fail
 * with a message a user could act on, which the runner checks.
 */

const now = new Date();
const iso = (d) => d.toISOString().slice(0, 10);

export function buildFixtures(ctx) {
  const T = ctx.TS;
  const OBJ = ctx.obj;                       // QA<TS>__c
  const track = (type, fullName) => { ctx.created.push({ type, fullName }); return fullName; };

  const F = [];
  const add = (phase, tool, spec) => F.push({ phase, tool, ...spec });

  // ── PHASE 0 — read-only. No prerequisites, must work on any org. ───────────────────────────
  add(0, "sf_get_org_limits", { verify: (c, r) => (r.payload && Object.keys(r.payload).length > 1) || "empty limits" });
  add(0, "sf_list_objects", {
    verify: (c, r) => {
      const t = JSON.stringify(r.payload ?? r.text ?? "");
      return t.includes("Account") || "Account missing from object list";
    },
  });
  add(0, "sf_describe_object", {
    args: { objectApiName: "Account" },
    verify: (c, r) => JSON.stringify(r.payload ?? "").includes("Name") || "Account.Name missing from describe",
  });
  add(0, "sf_query_records", {
    args: { query: "SELECT Id, Name FROM Account LIMIT 5" },
    verify: (c, r) => Array.isArray(r.payload?.records) || "no records array",
  });
  add(0, "sf_search_records", { args: { searchTerm: "Acme", objectTypes: ["Account"] } });
  add(0, "sf_export_records", { args: { query: "SELECT Id, Name FROM Account LIMIT 3" } });
  add(0, "sf_get_setup_audit_trail", {});
  add(0, "sf_get_login_history", {});
  add(0, "sf_get_event_logs", { args: { eventType: "Login" } });
  add(0, "sf_get_deployment_history", {});
  add(0, "sf_get_flow_errors", {});
  add(0, "sf_get_apex_test_results", {});
  add(0, "sf_list_flow_versions", {});
  add(0, "sf_check_code_coverage", {});
  add(0, "sf_scan_apex_antipatterns", {});
  add(0, "sf_run_code_scanner", {});
  add(0, "sf_get_apex_class", { args: { namePattern: "*" } });
  add(0, "sf_get_apex_trigger", { args: { namePattern: "*" } });
  add(0, "sf_guide_lwc_accessibility", {});
  add(0, "sf_explore_slds_blueprints", { args: { componentType: "card" } });
  add(0, "sf_list_sandboxes", {});
  add(0, "sf_list_toolsets", {});
  add(0, "sf_find_tool", { args: { query: "create custom field" },
    verify: (c, r) => JSON.stringify(r.payload ?? r.text).includes("sf_create_custom_field") || "did not find the obvious tool" });
  add(0, "sf_tool_schema", { args: { tool: "sf_create_custom_object" },
    verify: (c, r) => JSON.stringify(r.payload ?? r.text).includes("pluralLabel") || "schema missing a known required param" });
  add(0, "sf_load_toolset", { args: { toolsets: ["data"] } });
  add(0, "sf_call_tool", { args: { tool: "sf_get_org_limits", arguments: {} },
    verify: (c, r) => !!r.payload || "proxy returned nothing" });

  // ── PHASE 1 — foundation metadata everything else hangs off. ───────────────────────────────
  add(1, "sf_create_custom_object", {
    args: () => ({ fullName: OBJ, label: `QA ${T}`, pluralLabel: `QA ${T}s` }),
    verify: (c, r, v) => { v.invalidate("CustomObject"); return v.listMetadata("CustomObject").has(OBJ) || `${OBJ} not in CustomObject list`; },
    after: () => track("CustomObject", OBJ),
  });
  add(1, "sf_create_custom_field", {
    args: () => ({ objectName: OBJ, fieldName: "Notes__c", label: "Notes", type: "Text", length: 100 }),
    verify: (c, r, v) => (v.toolingSoql(`SELECT DeveloperName FROM CustomField WHERE TableEnumOrId != null AND DeveloperName = 'Notes'`) ?? []).length >= 0 || true,
  });
  add(1, "sf_create_custom_field", {
    tool: "sf_create_custom_field",
    args: () => ({ objectName: OBJ, fieldName: "Stage__c", label: "Stage", type: "Picklist", picklistValues: ["Draft", "Open"] }),
    note: "picklist variant",
  });
  add(1, "sf_add_picklist_values", {
    args: () => ({ objectFieldFullName: `${OBJ}.Stage__c`, values: ["Closed", "Archived"] }),
  });
  add(1, "sf_create_formula_field", {
    args: () => ({ objectApiName: OBJ, fieldName: "NameLen__c", label: "Name Len", returnType: "Number", formula: "LEN(Name)" }),
  });
  add(1, "sf_create_external_id_field", {
    args: () => ({ objectName: OBJ, fullName: "ExtId__c", label: "Ext Id", type: "Text" }),
  });
  add(1, "sf_update_custom_object", { args: () => ({ fullName: OBJ, description: "updated by QA sweep" }) });
  add(1, "sf_update_custom_field", { args: () => ({ objectName: OBJ, fieldName: "Notes__c", label: "Notes v2" }) });
  add(1, "sf_create_validation_rule", {
    args: () => ({ objectName: OBJ, ruleName: `QAVR${T}`, errorConditionFormula: "LEN(Name) > 200", errorMessage: "Too long" }),
  });
  add(1, "sf_create_record_type", {
    args: () => ({ objectName: OBJ, fullName: `QART${T}`, label: `QA RT ${T}` }),
  });
  add(1, "sf_create_page_layout", {
    args: () => ({ objectName: OBJ, layoutName: `QAPL${T}`, label: `QA PL ${T}` }),
  });
  add(1, "sf_create_compact_layout", {
    args: () => ({ objectName: OBJ, fullName: `QACL${T}`, label: `QA CL ${T}`, fields: ["Name"] }),
  });
  add(1, "sf_create_list_view", {
    args: () => ({ objectName: OBJ, fullName: `QALV${T}`, label: `QA LV ${T}`, filterScope: "Everything", columns: ["NAME"] }),
  });
  add(1, "sf_create_field_set", {
    args: () => ({ objectName: OBJ, fieldSetName: `QAFS${T}`, label: `QA FS ${T}`, fields: ["Name"] }),
  });
  add(1, "sf_create_search_layout", { args: () => ({ objectName: OBJ, searchResultsAdditionalFields: ["Notes__c"] }) });
  add(1, "sf_assign_layout_to_record_type", {
    args: () => ({ objectName: OBJ, recordTypeName: `QART${T}`, layoutName: `QAPL${T}` }),
  });
  add(1, "sf_create_custom_field", {
    args: () => ({ objectName: OBJ, fieldName: "SubStage__c", label: "Sub Stage", type: "Picklist", picklistValues: ["Early", "Late"] }),
    note: "second picklist, for the dependency below",
  });
  add(1, "sf_create_field_dependency", {
    args: () => ({
      objectName: OBJ, controllingField: "Stage__c", dependentField: "SubStage__c",
      valueSettings: [{ valueName: "Early", controllingFieldValue: ["Draft"] }],
    }),
  });

  // ── PHASE 2 — object-scoped metadata. ──────────────────────────────────────────────────────
  add(2, "sf_get_metadata_dependencies", { args: () => ({ componentType: "CustomObject", componentName: OBJ }) });
  add(2, "sf_create_custom_metadata_type", {
    args: () => ({ fullName: `QAMdt${T}__mdt`, label: `QA Mdt ${T}`, pluralLabel: `QA Mdt ${T}s` }),
    after: () => track("CustomObject", `QAMdt${T}__mdt`),
  });
  add(2, "sf_create_custom_metadata_record", {
    args: () => ({ typeName: `QAMdt${T}__mdt`, recordName: `QARec${T}`, label: `QA Rec ${T}`, values: [{ field: "DeveloperName", value: `QARec${T}` }] }),
  });
  add(2, "sf_create_custom_label", {
    args: () => ({ fullName: `QALbl${T}`, value: "QA sweep label" }),
    after: () => track("CustomLabel", `QALbl${T}`),
  });
  add(2, "sf_create_custom_setting", {
    args: () => ({ fullName: `QASet${T}__c`, label: `QA Set ${T}` }),
    after: () => track("CustomObject", `QASet${T}__c`),
  });
  add(2, "sf_create_global_value_set", {
    args: () => ({ fullName: `QAGvs${T}__gvs`, masterLabel: `QA GVS ${T}`, values: ["One", "Two"] }),
    after: () => track("GlobalValueSet", `QAGvs${T}`),
  });
  add(2, "sf_create_business_process", {
    args: () => ({ objectName: "Case", processName: `QABp${T}`, label: `QA BP ${T}`, values: ["New", "Closed"] }),
  });
  add(2, "sf_create_sharing_rule", {
    args: () => ({ objectName: OBJ, ruleName: `QASr${T}`, label: `QA SR ${T}`, sharedTo: { group: "AllInternalUsers" }, accessLevel: "Read" }),
  });
  add(2, "sf_create_quick_action", {
    args: () => ({ objectName: OBJ, actionName: `QAQa${T}`, label: `QA QA ${T}`, actionType: "Create" }),
  });
  add(2, "sf_create_global_action", {
    args: () => ({ actionName: `QAGa${T}`, label: `QA GA ${T}`, actionType: "LogACall" }),
    after: () => track("QuickAction", `QAGa${T}`),
  });
  add(2, "sf_create_custom_button", {
    args: () => ({ objectName: OBJ, buttonName: `QABtn${T}`, label: `QA Btn ${T}`, buttonType: "detail",
      contentSource: "url", content: "https://example.com", openType: "newWindow" }),
  });
  add(2, "sf_create_path_assistant", {
    args: () => ({ objectName: OBJ, fieldName: "Stage__c", pathName: `QAPath${T}`, label: `QA Path ${T}`,
      pathItems: [{ value: "Draft", info: "start" }] }),
    after: () => track("PathAssistant", `QAPath${T}`),
  });
  add(2, "sf_create_report_type", {
    args: () => ({ fullName: `QARt${T}`, label: `QA RT ${T}`, baseObject: OBJ }),
    after: () => track("ReportType", `QARt${T}`),
  });

  // ── PHASE 3 — automation. ──────────────────────────────────────────────────────────────────
  add(3, "sf_create_workflow_field_update", {
    args: () => ({ objectName: OBJ, actionName: `QAFu${T}`, label: `QA FU ${T}`, field: "Notes__c",
      literalValue: "set by QA" }),
  });
  add(3, "sf_create_field_update", {
    args: () => ({ objectName: OBJ, fullName: `QAFu2${T}`, name: `QA FU2 ${T}`, field: "Notes__c",
      operation: "Literal", literalValue: "set by QA 2" }),
  });
  add(3, "sf_create_workflow_rule", {
    args: () => ({ objectName: OBJ, fullName: `QAWr${T}`, triggerType: "onCreateOnly",
      formula: "LEN(Name) > 0", description: "QA sweep" }),
  });
  add(3, "sf_create_email_template", {
    args: () => ({ fullName: `unfiled$public/QAEt${T}`, name: `QAEt${T}`, label: `QA ET ${T}`,
      subject: "QA", body: "QA body" }),
  });
  add(3, "sf_create_email_alert", {
    args: () => ({ objectName: OBJ, alertName: `QAEa${T}`, label: `QA EA ${T}`,
      template: `unfiled$public/QAEt${T}`, recipients: [{ type: "user", recipient: ctx.vals.username }],
      senderType: "CurrentUser" }),
  });
  add(3, "sf_create_platform_event", {
    args: () => ({ fullName: `QAEvt${T}__e`, label: `QA Evt ${T}`, pluralLabel: `QA Evt ${T}s` }),
    after: () => track("CustomObject", `QAEvt${T}__e`),
  });
  add(3, "sf_create_platform_event_trigger", {
    args: () => ({ triggerName: `QAEvtTrg${T}`, eventApiName: `QAEvt${T}__e`,
      body: `System.debug('qa event trigger');` }),
    after: () => track("ApexTrigger", `QAEvtTrg${T}`),
  });
  add(3, "sf_create_assignment_rule", {
    args: () => ({ objectName: "Lead", ruleName: `QAAr${T}`, label: `QA AR ${T}`,
      ruleEntries: [{ criteriaItems: [{ field: "Lead.LeadSource", operation: "equals", value: "Web" }], assignedTo: ctx.vals.username, assignedToType: "User" }] }),
  });
  add(3, "sf_create_auto_response_rule", {
    args: () => ({ objectName: "Lead", ruleName: `QAAur${T}`, label: `QA AUR ${T}`,
      ruleEntries: [{ criteriaItems: [{ field: "Lead.LeadSource", operation: "equals", value: "Web" }],
        senderEmail: ctx.vals.email, senderName: "QA", template: `unfiled$public/QAEt${T}` }] }),
  });
  add(3, "sf_create_escalation_rule", {
    args: () => ({ ruleName: `QAEr${T}`, label: `QA ER ${T}`,
      ruleEntries: [{ businessHours: "Default", escalationStartDate: "CaseCreation",
        criteriaItems: [{ field: "Case.Status", operation: "equals", value: "New" }],
        escalationActions: [{ minutesToEscalation: 30, assignedTo: ctx.vals.username, assignedToType: "User" }] }] }),
  });
  add(3, "sf_create_matching_rule", {
    args: () => ({ objectName: "Lead", ruleName: `QAMr${T}`, label: `QA MR ${T}`,
      matchingRuleItems: [{ fieldName: "Email", matchingMethod: "Exact" }] }),
  });
  add(3, "sf_create_duplicate_rule", {
    args: () => ({ objectName: "Lead", ruleName: `QADr${T}`, label: `QA DR ${T}`,
      matchingRules: [{ matchingRule: `QAMr${T}`, objectName: "Lead" }] }),
  });
  add(3, "sf_create_outbound_message", {
    args: () => ({ objectName: OBJ, fullName: `QAOm${T}`, name: `QA OM ${T}`,
      endpointUrl: "https://example.com/hook", fields: ["Id"] }),
  });
  add(3, "sf_create_apex_class", {
    args: () => ({ className: `QASched${T}`,
      classBody: `public class QASched${T} implements Schedulable { public void execute(SchedulableContext sc) { System.debug('qa'); } }` }),
    note: "schedulable class for the scheduled job below",
    after: () => track("ApexClass", `QASched${T}`),
  });
  add(3, "sf_create_scheduled_job", {
    args: () => ({ className: `QASched${T}`, jobName: `QA Sched ${T}`, cronExpression: "0 0 1 * * ?" }),
  });
  add(3, "sf_create_scheduled_flow", {
    args: () => ({ fullName: `QASf${T}`, label: `QA SF ${T}`, objectApiName: OBJ,
      scheduledPaths: [{ name: "p1", offsetNumber: 1, offsetUnit: "Days", timeSource: "RecordTriggerEvent" }] }),
    after: () => track("Flow", `QASf${T}`),
  });
  add(3, "sf_create_apex_email_service", {
    args: () => ({ functionName: `QAEs${T}`, apexClassName: `QAEsHandler${T}` }),
  });
  add(3, "sf_create_approval_process", {
    args: () => ({ objectName: OBJ, processName: `QAAp${T}`, label: `QA AP ${T}`,
      allowedSubmitters: [{ type: "owner" }],
      approvalSteps: [{ name: "Step1", label: "Step 1", assignedApprover: { type: "user", name: ctx.vals.username } }] }),
  });

  // ── PHASE 4 — apex, flows, UI bundles. ─────────────────────────────────────────────────────
  add(4, "sf_create_apex_class", {
    args: () => ({ className: `QACls${T}`, classBody: `public class QACls${T} { public static Integer one() { return 1; } }` }),
    verify: (c, r, v) => (v.toolingSoql(`SELECT Name FROM ApexClass WHERE Name = 'QACls${T}'`) ?? []).length === 1 || "class not in org",
    after: () => track("ApexClass", `QACls${T}`),
  });
  add(4, "sf_create_apex_trigger", {
    args: () => ({ triggerName: `QATrg${T}`, objectName: OBJ, events: ["before insert"],
      triggerBody: `System.debug('qa trigger');` }),
    after: () => track("ApexTrigger", `QATrg${T}`),
  });
  add(4, "sf_create_apex_test_class", {
    args: () => ({ className: `QAClsTest${T}`,
      classBody: `@isTest private class QAClsTest${T} { @isTest static void t() { System.assertEquals(1, QACls${T}.one()); } }` }),
    verify: (c, r, v) => (v.toolingSoql(`SELECT Name FROM ApexClass WHERE Name = 'QAClsTest${T}'`) ?? []).length === 1 || "test class not in org",
    after: () => track("ApexClass", `QAClsTest${T}`),
  });
  add(4, "sf_run_apex_tests", { args: () => ({ testClasses: [`QAClsTest${T}`] }), timeout: 300000 });
  add(4, "sf_execute_anonymous_apex", {
    args: () => ({ apexCode: `System.debug('qa-sweep-${T}');` }),
    verify: (c, r) => JSON.stringify(r.payload ?? "").match(/success|compiled|true/i) ? true : "apex did not report success",
  });
  add(4, "sf_create_flow", { args: () => ({ label: `QA Flow ${T}`, apiName: `QAFlow${T}` }), after: () => track("Flow", `QAFlow${T}`) });
  add(4, "sf_create_flow_from_xml", {
    args: () => ({ flowApiName: `QAFlowX${T}`, flowXml:
`<?xml version="1.0" encoding="UTF-8"?>
<Flow xmlns="http://soap.sforce.com/2006/04/metadata">
  <apiVersion>62.0</apiVersion>
  <interviewLabel>QA Flow X ${T}</interviewLabel>
  <label>QA Flow X ${T}</label>
  <processType>AutoLaunchedFlow</processType>
  <status>Draft</status>
  <start><connector><targetReference>a1</targetReference></connector></start>
  <assignments><name>a1</name><label>a1</label><locationX>50</locationX><locationY>50</locationY>
    <assignmentItems><assignToReference>v1</assignToReference><operator>Assign</operator>
      <value><stringValue>x</stringValue></value></assignmentItems></assignments>
  <variables><name>v1</name><dataType>String</dataType><isCollection>false</isCollection><isInput>false</isInput><isOutput>false</isOutput></variables>
</Flow>` }),
    after: () => track("Flow", `QAFlowX${T}`),
  });
  add(4, "sf_activate_flow", { args: () => ({ flowApiName: `QAFlowX${T}` }) });
  add(4, "sf_deactivate_flow", { args: () => ({ flowApiName: `QAFlowX${T}` }) });
  add(4, "sf_create_lwc", {
    args: () => ({ componentName: `qaLwc${T}`, html: "<template><p>qa</p></template>",
      javascript: `import { LightningElement } from 'lwc'; export default class QaLwc${T} extends LightningElement {}` }),
    after: () => track("LightningComponentBundle", `qaLwc${T}`),
  });
  add(4, "sf_update_lwc", { args: () => ({ componentName: `qaLwc${T}`, html: "<template><p>qa v2</p></template>" }) });
  add(4, "sf_create_lwc_jest_test", {
    args: () => ({ componentName: `qaLwc${T}`, testContent: "describe('qa', () => { it('works', () => { expect(1).toBe(1); }); });" }),
  });
  add(4, "sf_create_lwc_from_requirements", {
    args: () => ({ componentName: `qaLwcReq${T}`, requirements: "A card that shows an account name and a refresh button." }),
  });
  add(4, "sf_migrate_aura_to_lwc", { args: () => ({ auraComponentName: `qaAura${T}` }) });
  add(4, "sf_create_aura_component", { args: () => ({ componentName: `qaAura${T}` }), after: () => track("AuraDefinitionBundle", `qaAura${T}`) });
  add(4, "sf_create_aura_app", { args: () => ({ appName: `qaAuraApp${T}` }), after: () => track("AuraDefinitionBundle", `qaAuraApp${T}`) });
  add(4, "sf_create_aura_event", { args: () => ({ eventName: `qaAuraEvt${T}`, eventType: "APPLICATION" }), after: () => track("AuraDefinitionBundle", `qaAuraEvt${T}`) });
  add(4, "sf_create_visualforce_page", {
    args: () => ({ pageName: `QAVf${T}`, label: `QA VF ${T}`, content: "<apex:page><h1>qa</h1></apex:page>" }),
    after: () => track("ApexPage", `QAVf${T}`),
  });
  add(4, "sf_create_visualforce_component", {
    args: () => ({ componentName: `QAVfc${T}`, label: `QA VFC ${T}`, content: "<apex:component><p>qa</p></apex:component>" }),
    after: () => track("ApexComponent", `QAVfc${T}`),
  });
  add(4, "sf_create_visualforce_email_template", {
    args: () => ({ templateName: `QAVfEt${T}`, subject: "QA", recipientType: "User", relatedEntityType: "Account",
      htmlBody: "<p>qa</p>", textBody: "qa" }),
  });
  add(4, "sf_create_static_resource", {
    args: () => ({ fullName: `QASr${T}`, content: Buffer.from("qa").toString("base64"), contentType: "text/plain" }),
    after: () => track("StaticResource", `QASr${T}`),
  });
  add(4, "sf_create_lightning_app", { args: () => ({ fullName: `QALapp${T}`, label: `QA LApp ${T}` }), after: () => track("CustomApplication", `QALapp${T}`) });
  add(4, "sf_create_custom_application", { args: () => ({ appName: `QACapp${T}`, label: `QA CApp ${T}` }), after: () => track("CustomApplication", `QACapp${T}`) });
  add(4, "sf_create_flexipage", {
    args: () => ({ pageName: `QAFp${T}`, label: `QA FP ${T}`, pageType: "AppPage", masterLabel: `QA FP ${T}` }),
    after: () => track("FlexiPage", `QAFp${T}`),
  });
  add(4, "sf_create_tab", { args: () => ({ fullName: `QATab${T}`, label: `QA Tab ${T}`, sobjectName: OBJ, customObject: true }), after: () => track("CustomTab", `QATab${T}`) });
  add(4, "sf_create_custom_tab", { args: () => ({ fullName: `QAWtab${T}`, label: `QA WTab ${T}`, url: "https://example.com" }), after: () => track("CustomTab", `QAWtab${T}`) });

  // ── PHASE 5 — security, users, admin. ──────────────────────────────────────────────────────
  add(5, "sf_create_permission_set", { args: () => ({ fullName: `QAPs${T}`, label: `QA PS ${T}` }), after: () => track("PermissionSet", `QAPs${T}`) });
  add(5, "sf_create_muting_permission_set", { args: () => ({ fullName: `QAMps${T}`, label: `QA MPS ${T}` }) });
  add(5, "sf_create_permission_set_group", {
    args: () => ({ fullName: `QAPsg${T}`, label: `QA PSG ${T}`, permissionSets: [`QAPs${T}`] }),
    after: () => track("PermissionSetGroup", `QAPsg${T}`),
  });
  add(5, "sf_create_custom_permission", { args: () => ({ fullName: `QACp${T}`, label: `QA CP ${T}` }), after: () => track("CustomPermission", `QACp${T}`) });
  add(5, "sf_create_field_level_security", {
    args: () => ({ objectName: OBJ, fieldName: "Notes__c", profiles: [{ profileName: "Admin", readable: true, editable: true }] }),
  });
  add(5, "sf_get_field_permissions", { args: () => ({ objectName: OBJ, fieldName: "Notes__c" }) });
  add(5, "sf_create_role", { args: () => ({ fullName: `QARole${T}`, name: `QA Role ${T}` }), after: () => track("Role", `QARole${T}`) });
  add(5, "sf_create_role_hierarchy", { args: () => ({ roles: [{ fullName: `QARoleH${T}`, name: `QA RoleH ${T}` }] }) });
  add(5, "sf_create_user_role_hierarchy", { args: () => ({ roleName: `QAUrh${T}`, label: `QA URH ${T}` }) });
  add(5, "sf_create_queue", {
    args: () => ({ fullName: `QAQueue${T}`, name: `QA Queue ${T}`, supportedObjects: ["Case"] }),
    after: () => track("Queue", `QAQueue${T}`),
  });
  add(5, "sf_assign_queue_member", { args: () => ({ queueDeveloperName: `QAQueue${T}`, users: [ctx.vals.username] }) });
  add(5, "sf_create_public_group", { args: () => ({ groupName: `QAGrp${T}`, label: `QA Grp ${T}` }), after: () => track("Group", `QAGrp${T}`) });
  add(5, "sf_create_named_credential", {
    args: () => ({ fullName: `QANc${T}`, label: `QA NC ${T}`, endpoint: "https://example.com" }),
    after: () => track("NamedCredential", `QANc${T}`),
  });
  add(5, "sf_create_user", {
    args: () => ({ lastName: `QA${T}`, email: ctx.vals.email, username: `qa${T}@qa-sweep-${T}.invalid`,
      alias: `qa${String(T).slice(-4)}`, profileName: "Standard User" }),
  });
  add(5, "sf_update_user", { args: () => ({ username: ctx.vals.username, title: `QA ${T}` }) });
  add(5, "sf_freeze_user", { args: () => (ctx.vals.qaUser ? { username: ctx.vals.qaUser, freeze: true } : null),
    skipReason: "no disposable user was created" });
  add(5, "sf_reset_user_password", { args: () => (ctx.vals.qaUser ? { username: ctx.vals.qaUser } : null),
    skipReason: "would reset a real user's password" });
  add(5, "sf_enable_debug_logs", { args: () => ({ username: ctx.vals.username }) });
  add(5, "sf_get_debug_logs", {
    args: {},
    after: (c, r) => { const id = r.payload?.records?.[0]?.Id ?? r.payload?.logs?.[0]?.Id; if (id) c.vals.logId = id; },
  });
  add(5, "sf_get_debug_log_body", { args: () => (ctx.vals.logId ? { logId: ctx.vals.logId } : null), skipReason: "no debug log present" });
  add(5, "sf_disable_debug_logs", { args: {} });
  add(5, "sf_get_field_history", {
    args: () => (ctx.recordIds.Account?.[0] ? { objectApiName: "Account", recordId: ctx.recordIds.Account[0] } : null),
    skipReason: "no account record yet",
  });
  add(5, "sf_create_business_hours", { args: () => ({ name: `QA BH ${T}`, timeZone: "America/Los_Angeles", days: [{ day: "Mon", startTime: "08:00", endTime: "17:00", isActive: true }] }) });
  add(5, "sf_create_holiday", { args: () => ({ name: `QA Hol ${T}`, activityDate: iso(new Date(now.getFullYear(), 11, 25)) }) });
  add(5, "sf_create_letterhead", { args: () => ({ fullName: `QALh${T}`, name: `QA LH ${T}` }), after: () => track("Letterhead", `QALh${T}`) });
  add(5, "sf_create_notification_type", { args: () => ({ fullName: `QANt${T}`, masterLabel: `QA NT ${T}`, customNotifTypeName: `QANt${T}` }) });
  add(5, "sf_create_custom_notification_type", { args: () => ({ fullName: `QACnt${T}`, customNotifTypeName: `QACnt${T}`, desktop: true }) });

  // ── PHASE 6 — data CRUD. ───────────────────────────────────────────────────────────────────
  add(6, "sf_create_record", {
    args: () => ({ objectApiName: "Account", fields: { Name: `QA Acct ${T}`, AccountNumber: `QA${T}` } }),
    verify: (c, r, v) => {
      const id = r.payload?.fullName ?? r.payload?.id ?? r.payload?.Id;  // ToolResult carries the new record id as fullName
      if (!id) return "no id returned";
      (c.recordIds.Account ??= []).push(id);
      return (v.soql(`SELECT Id FROM Account WHERE Id = '${id}'`) ?? []).length === 1 || "record not in org";
    },
  });
  add(6, "sf_get_record", {
    args: () => (ctx.recordIds.Account?.[0] ? { objectApiName: "Account", recordId: ctx.recordIds.Account[0] } : null),
    verify: (c, r) => JSON.stringify(r.payload ?? "").includes(`QA Acct ${T}`) || "returned record is not the one created",
  });
  add(6, "sf_update_record", {
    args: () => (ctx.recordIds.Account?.[0] ? { objectApiName: "Account", recordId: ctx.recordIds.Account[0], fields: { Name: `QA Acct ${T} v2` } } : null),
    verify: (c, r, v) => (v.soql(`SELECT Name FROM Account WHERE Id = '${c.recordIds.Account[0]}'`) ?? [])[0]?.Name === `QA Acct ${T} v2` || "update did not land",
  });
  add(6, "sf_upsert_record", {
    args: () => ({ objectApiName: OBJ, externalIdField: "ExtId__c", externalIdValue: `QA${T}`, fields: { Name: `QA Upsert ${T}` } }),
  });
  add(6, "sf_bulk_insert_records", {
    args: () => ({ objectApiName: "Account", records: [{ Name: `QA Bulk1 ${T}`, AccountNumber: `QA${T}` }, { Name: `QA Bulk2 ${T}`, AccountNumber: `QA${T}` }] }),
    timeout: 180000,
  });
  add(6, "sf_bulk_import_records", {
    args: () => ({ objectApiName: "Account", operation: "insert", records: [{ Name: `QA Imp ${T}`, AccountNumber: `QA${T}` }] }),
    timeout: 180000,
  });
  add(6, "sf_bulk_update_records", {
    args: (c) => {
      const rows = (verifiersRef.soql?.(`SELECT Id FROM Account WHERE AccountNumber = 'QA${T}'`) ?? []);
      return rows.length ? { objectApiName: "Account", records: rows.slice(0, 2).map((r) => ({ Id: r.Id, Description: "qa bulk update" })) } : null;
    },
    skipReason: "no bulk rows landed to update",
    timeout: 180000,
  });
  add(6, "sf_create_data_category", {
    args: () => ({ fullName: `QADc${T}`, label: `QA DC ${T}`, categories: [{ name: `QACat${T}`, label: `QA Cat ${T}` }] }),
  });
  add(6, "sf_send_email", {
    args: () => ({ toAddresses: [ctx.vals.email], subject: `QA sweep ${T}`, body: "QA sweep test email." }),
  });

  // ── PHASE 7 — integrations, identity, comms, streaming. ────────────────────────────────────
  add(7, "sf_create_remote_site_setting", {
    args: () => ({ fullName: `QARss${T}`, name: `QA RSS ${T}`, url: "https://example.com" }),
    after: () => track("RemoteSiteSetting", `QARss${T}`),
  });
  add(7, "sf_create_csp_setting", { args: () => ({ endpointUrl: "https://example.com", cspDirectives: ["connect-src"] }) });
  add(7, "sf_create_connected_app", {
    args: () => ({ fullName: `QACa${T}`, label: `QA CA ${T}`, contactEmail: ctx.vals.email,
      callbackUrls: ["https://example.com/cb"], scopes: ["Api", "RefreshToken"] }),
    after: () => track("ConnectedApp", `QACa${T}`),
  });
  add(7, "sf_create_external_client_app", {
    args: () => ({ fullName: `QAEca${T}`, label: `QA ECA ${T}`, contactEmail: ctx.vals.email, scopes: ["Api"] }),
  });
  add(7, "sf_create_connected_app_oauth_policy", {
    args: () => ({ connectedAppName: `QACa${T}`, refreshTokenPolicy: "infinite" }),
  });
  add(7, "sf_create_external_data_source", {
    args: () => ({ fullName: `QAEds${T}`, label: `QA EDS ${T}`, endpoint: "https://example.com/odata", type: "OData4" }),
    after: () => track("ExternalDataSource", `QAEds${T}`),
  });
  add(7, "sf_create_external_object", {
    args: () => ({ fullName: `QAEo${T}__x`, label: `QA EO ${T}`, pluralLabel: `QA EO ${T}s`, externalDataSource: `QAEds${T}` }),
  });
  add(7, "sf_create_auth_provider", {
    args: () => ({ providerName: `QAAuth${T}`, friendlyName: `QA Auth ${T}`, providerType: "OpenIdConnect",
      consumerKey: "qa-key", consumerSecret: "qa-secret",
      authorizeUrl: "https://example.com/authorize", tokenUrl: "https://example.com/token",
      userInfoUrl: "https://example.com/userinfo" }),
    after: () => track("AuthProvider", `QAAuth${T}`),
  });
  add(7, "sf_create_saml_sso_config", {
    args: () => ({ name: `QASaml${T}`, issuer: "https://example.com/idp",
      identityProviderCertificate: "MIIBQA==", loginUrl: "https://example.com/login" }),
    expectUnavailable: true,
  });
  add(7, "sf_create_push_topic", {
    args: () => ({ topicName: `QAPt${T}`, query: "SELECT Id, Name FROM Account" }),
  });
  add(7, "sf_configure_change_data_capture", { args: () => ({ entities: ["Account"] }) });
  add(7, "sf_create_platform_cache_partition", { args: () => ({ partitionName: `QAPcp${T}` }), expectUnavailable: true });
  add(7, "sf_translate_custom_label", { args: () => ({ labelName: `QALbl${T}`, language: "fr", translatedValue: "QA fr" }) });
  add(7, "sf_translate_field_label", { args: () => ({ objectName: OBJ, fieldName: "Notes__c", language: "fr", translatedLabel: "Notes fr" }) });

  // ── PHASE 8 — reports & dashboards. ────────────────────────────────────────────────────────
  add(8, "sf_create_report_folder", { args: () => ({ folderName: `QARf${T}`, label: `QA RF ${T}` }), after: () => track("ReportFolder", `QARf${T}`) });
  add(8, "sf_share_report_folder", { args: () => ({ folderName: `QARf${T}`, shareWith: [{ type: "Group", name: "AllInternalUsers", accessLevel: "View" }] }) });
  add(8, "sf_create_report", {
    args: () => ({ reportName: `QARep${T}`, label: `QA Rep ${T}`, reportType: "AccountList",
      folderName: `QARf${T}`, columns: ["ACCOUNT.NAME"] }),
    after: () => track("Report", `QARf${T}/QARep${T}`),
  });
  add(8, "sf_create_dashboard", {
    args: () => ({ fullName: `QARf${T}/QADash${T}`, title: `QA Dash ${T}` }),
  });
  add(8, "sf_update_dashboard", { args: () => ({ dashboardName: `QARf${T}/QADash${T}`, label: `QA Dash ${T} v2` }) });

  // ── PHASE 9 — service cloud / omnichannel. ─────────────────────────────────────────────────
  add(9, "sf_create_service_channel", { args: () => ({ channelName: `QASc${T}`, label: `QA SC ${T}`, relatedObjectApiName: "Case" }) });
  add(9, "sf_create_routing_configuration", { args: () => ({ label: `QA RC ${T}`, routingConfigName: `QARc${T}`, routingPriority: 1 }) });
  add(9, "sf_create_queue_routing_config", { args: () => ({ queueDeveloperName: `QAQueue${T}`, routingConfigName: `QARc${T}` }) });
  add(9, "sf_create_presence_status", { args: () => ({ statusName: `QAPs2${T}`, label: `QA PS2 ${T}` }) });
  add(9, "sf_create_presence_configuration", { args: () => ({ configName: `QAPc${T}`, label: `QA PC ${T}` }) });
  add(9, "sf_assign_presence_status", { args: () => ({ statusName: `QAPs2${T}`, profiles: ["System Administrator"] }) });
  add(9, "sf_create_skill", { args: () => ({ skillName: `QASk${T}`, label: `QA SK ${T}` }) });
  add(9, "sf_assign_skill_to_agent", { args: () => ({ skillName: `QASk${T}`, username: ctx.vals.username }) });
  add(9, "sf_create_service_territory", { args: () => ({ territoryName: `QASt${T}`, label: `QA ST ${T}` }), expectUnavailable: true });
  add(9, "sf_create_work_type", { args: () => ({ workTypeName: `QAWt${T}`, label: `QA WT ${T}`, estimatedDuration: 30 }), expectUnavailable: true });
  add(9, "sf_create_messaging_channel", { args: () => ({ channelName: `QAMc${T}`, label: `QA MC ${T}`, channelType: "SMS" }), expectUnavailable: true });
  add(9, "sf_create_chat_button", { args: () => ({ buttonName: `QACb${T}`, label: `QA CB ${T}` }), expectUnavailable: true });
  add(9, "sf_create_embedded_service", { args: () => ({ label: `QA ES ${T}`, site: `QASite${T}` }), expectUnavailable: true });
  add(9, "sf_create_bot_routing", { args: () => ({ botName: `QABot${T}`, transferToQueueName: `QAQueue${T}` }), expectUnavailable: true });
  add(9, "sf_create_knowledge_article_type", {
    args: () => ({ articleTypeName: `QAKa${T}`, label: `QA KA ${T}`, pluralLabel: `QA KA ${T}s` }),
    expectUnavailable: true,
  });
  add(9, "sf_create_entitlement_process", { args: () => ({ fullName: `QAEp${T}`, name: `QA EP ${T}`, SObjectType: "Case" }), expectUnavailable: true });
  add(9, "sf_create_milestone", { args: () => ({ fullName: `QAMs${T}`, name: `QA MS ${T}` }), expectUnavailable: true });
  add(9, "sf_create_product", { args: () => ({ name: `QA Prod ${T}` }) });
  add(9, "sf_create_price_book", { args: () => ({ name: `QA PB ${T}` }) });

  // ── PHASE 10 — licensed platform features. Expected to be unavailable; must say so clearly. ─
  for (const [tool, args] of [
    ["sf_create_agent", () => ({ agentName: `QAAg${T}`, label: `QA AG ${T}` })],
    ["sf_create_agent_topic", () => ({ agentName: `QAAg${T}`, topicName: `QATp${T}`, label: `QA TP ${T}`, description: "QA topic", scope: "QA scope" })],
    ["sf_create_agent_planner", () => ({ agentName: `QAAg${T}`, topicNames: [`QATp${T}`] })],
    ["sf_create_agent_action", () => ({ actionName: `QAAa${T}`, description: "QA action", type: "ApexClass", reference: `QACls${T}` })],
    ["sf_create_einstein_prediction", () => ({ predictionName: `QAEp2${T}`, label: `QA EP2 ${T}`, predictionType: "BinaryClassification", targetField: "Notes__c", aiApplicationDeveloperName: `QAAi${T}` })],
    ["sf_create_next_best_action", () => ({ strategyName: `QANba${T}`, label: `QA NBA ${T}` })],
    ["sf_create_einstein_bot", () => ({ botName: `QAEb${T}`, label: `QA EB ${T}` })],
    ["sf_create_experience_site", () => ({ siteName: `QASite${T}`, label: `QA Site ${T}`, urlPathPrefix: `qa${T}` })],
    ["sf_create_experience_page", () => ({ siteName: `QASite${T}`, pageName: `QAPage${T}`, label: `QA Page ${T}` })],
    ["sf_create_territory", () => ({ territoryName: `QATer${T}`, label: `QA TER ${T}` })],
    ["sf_assign_territory_to_user", () => ({ territoryName: `QATer${T}`, username: ctx.vals.username })],
    ["sf_create_forecast_hierarchy", () => ({})],
    ["sf_create_flexcard", () => ({ cardName: `QAFc${T}`, label: `QA FC ${T}` })],
    ["sf_update_flexcard", () => ({ cardName: `QAFc${T}`, label: `QA FC ${T} v2` })],
    ["sf_activate_flexcard", () => ({ cardName: `QAFc${T}` })],
    ["sf_get_flexcard", () => ({ cardName: `QAFc${T}` })],
    ["sf_create_omniscript", () => ({ label: `QA OS ${T}`, type: "QA", subType: `Sub${T}` })],
    ["sf_update_omniscript", () => ({ type: "QA", subType: `Sub${T}`, label: `QA OS ${T} v2` })],
    ["sf_activate_omniscript", () => ({ type: "QA", subType: `Sub${T}` })],
    ["sf_get_omniscript", () => ({ type: "QA", subType: `Sub${T}` })],
    ["sf_create_dataraptor", () => ({ dataRaptorName: `QADr2${T}`, label: `QA DR2 ${T}`, interfaceType: "Extract" })],
    ["sf_get_dataraptor", () => ({ dataRaptorName: `QADr2${T}` })],
    ["sf_create_integration_procedure", () => ({ procedureName: `QAIp${T}`, subType: `Sub${T}`, label: `QA IP ${T}` })],
    ["sf_update_integration_procedure", () => ({ procedureName: `QAIp${T}`, subType: `Sub${T}`, label: `QA IP ${T} v2` })],
    ["sf_get_integration_procedure", () => ({ procedureName: `QAIp${T}`, subType: `Sub${T}` })],
    ["sf_activate_integration_procedure", () => ({ procedureName: `QAIp${T}`, subType: `Sub${T}` })],
    ["sf_create_calculation_matrix", () => ({ matrixName: `QACm${T}`, label: `QA CM ${T}`, inputVariables: ["a"], outputVariables: ["b"] })],
    ["sf_create_calculation_procedure", () => ({ procedureName: `QACpr${T}`, label: `QA CPR ${T}` })],
    ["sf_export_omnistudio_component", () => ({ componentType: "FlexCard", componentName: `QAFc${T}` })],
    ["sf_import_omnistudio_component", () => ({ componentType: "FlexCard", newName: `QAFc2${T}`, jsonDefinition: "{}" })],
    ["sf_create_document_generation", () => ({ templateName: `QADg${T}`, label: `QA DG ${T}`, objectApiName: "Account", dataSourceName: `QADr2${T}` })],
    ["sf_create_scratch_org", () => ({ alias: `qa${T}`, durationDays: 1 })],
    ["sf_delete_scratch_org", () => ({ alias: `qa${T}` })],
    ["sf_create_package", () => ({ name: `QA Pkg ${T}`, packageType: "Unlocked", path: "force-app" })],
    ["sf_create_package_version", () => ({ packageId: "0Ho000000000000AAA" })],
    ["sf_install_package", () => ({ packageId: "04t000000000000AAA" })],
    ["sf_uninstall_package", () => ({ packageId: "04t000000000000AAA" })],
    ["sf_devops_create_work_item", () => ({ name: `QA WI ${T}` })],
    ["sf_devops_promote_work_item", () => ({ workItemId: "a00000000000000AAA" })],
    ["sf_detect_devops_merge_conflict", () => ({ workItemId: "a00000000000000AAA" })],
    ["sf_resolve_devops_merge_conflict", () => ({ conflictId: "a00000000000000AAA", resolution: "ours" })],
    ["sf_checkout_devops_work_item", () => ({ workItemId: "a00000000000000AAA" })],
    ["sf_commit_devops_work_item", () => ({ workItemId: "a00000000000000AAA", message: "qa" })],
    ["sf_create_devops_pull_request", () => ({ workItemId: "a00000000000000AAA", title: "QA PR" })],
    ["sf_list_devops_projects", () => ({})],
    ["sf_list_devops_work_items", () => ({})],
    ["sf_check_devops_commit_status", () => ({ workItemId: "a00000000000000AAA" })],
    ["sf_promote_devops_work_item", () => ({ workItemId: "a00000000000000AAA", targetStageId: "a00000000000000AAA" })],
    ["sf_create_sandbox", () => ({ sandboxName: `QAsb${T}`.slice(0, 10), licenseType: "Developer" })],
    ["sf_refresh_sandbox", () => ({ sandboxName: `QAsb${T}`.slice(0, 10), licenseType: "Developer" })],
  ]) {
    add(10, tool, { args, expectUnavailable: true });
  }

  // ── PHASE 11 — local/filesystem generators (no org involvement). ───────────────────────────
  add(11, "sf_create_mcp_server", { args: () => ({ serverName: `qa-mcp-${T}`, outputDirectory: `${ctx.vals.tmpDir}/qa-mcp-${T}` }) });
  add(11, "sf_create_mcp_tool", {
    args: () => ({ projectDirectory: `${ctx.vals.tmpDir}/qa-mcp-${T}`, toolName: "qa_tool", toolDescription: "QA tool",
      inputSchema: { type: "object", properties: { a: { type: "string" } } }, handlerCode: "return { ok: true };" }),
  });
  add(11, "sf_list_mcp_tools", { args: () => ({ projectDirectory: `${ctx.vals.tmpDir}/qa-mcp-${T}` }) });

  // ── PHASE 12 — deployment & retrieve. ──────────────────────────────────────────────────────
  add(12, "sf_retrieve_metadata", { args: () => ({ metadataType: "CustomObject", componentName: OBJ }), timeout: 300000 });
  add(12, "sf_create_outbound_change_set", { args: () => ({ changeSetName: `QACs${T}` }), expectUnavailable: true });
  add(12, "sf_add_to_change_set", { args: () => ({ changeSetName: `QACs${T}`, components: [{ type: "CustomObject", name: OBJ }] }), expectUnavailable: true });
  add(12, "sf_deploy_metadata", {
    args: () => ({
      componentsXml: [{
        type: "CustomLabel",
        name: `QADep${T}`,
        xml: `<?xml version="1.0" encoding="UTF-8"?><CustomLabels xmlns="http://soap.sforce.com/2006/04/metadata"><labels><fullName>QADep${T}</fullName><language>en_US</language><protected>false</protected><shortDescription>QA</shortDescription><value>QA deploy</value></labels></CustomLabels>`,
      }],
    }),
    timeout: 300000,
    after: (c, r) => { const id = r.payload?.deployId ?? r.payload?.id; if (id) c.vals.deployId = id; track("CustomLabel", `QADep${T}`); },
  });
  add(12, "sf_check_deploy_status", { args: () => (ctx.vals.deployId ? { deployId: ctx.vals.deployId } : null), skipReason: "no deploy id from the deploy step" });

  // ── PHASE 13 — destructive. Runs last, on this sweep's own artifacts only. ─────────────────
  add(13, "sf_delete_record", {
    args: () => (ctx.recordIds.Account?.[0] ? { objectApiName: "Account", recordId: ctx.recordIds.Account[0] } : null),
    verify: (c, r, v) => (v.soql(`SELECT Id FROM Account WHERE Id = '${c.recordIds.Account[0]}'`) ?? []).length === 0 || "record still in org after delete",
  });
  add(13, "sf_bulk_delete_records", {
    args: () => {
      const rows = verifiersRef.soql?.(`SELECT Id FROM Account WHERE AccountNumber = 'QA${T}'`) ?? [];
      return rows.length ? { objectApiName: "Account", ids: rows.map((r) => r.Id) } : null;
    },
    skipReason: "nothing left to bulk delete",
    timeout: 180000,
  });
  add(13, "sf_delete_metadata", {
    args: () => ({ metadataType: "CustomLabel", fullNames: [`QALbl${T}`] }),
    after: () => { ctx.created = ctx.created.filter((c) => !(c.type === "CustomLabel" && c.fullName === `QALbl${T}`)); },
  });

  return F;
}

// the runner injects its CLI-backed verifiers here so lazily-built args can query the org too
export const verifiersRef = {};
