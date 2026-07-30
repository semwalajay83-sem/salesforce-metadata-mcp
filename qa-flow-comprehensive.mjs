/**
 * Comprehensive Flow QA — exercises sf_create_flow across every element type, resource type,
 * flow type, and guardrail, on BOTH XML builders.
 *
 * Why both builders: sf_create_flow calls buildFlowXml (SOAP/upsertMetadata), while
 * sf_create_flow_from_xml and the older suites call buildFlowDeployXml (ZIP/deploy). They are two
 * independent ~300-line generators. A bug fixed in one is not fixed in the other, and the v2.8.2
 * regression run validated only the ZIP path — which is why the processType defect reached users.
 *
 * Run: SF_ALIAS=demo-org SF_INSTANCE_URL=<org-url> node qa-flow-comprehensive.mjs
 */
import {
  getAuth, createFlow, buildFlowDeployXml, activateFlow, deactivateFlow,
  listFlowVersions, createRecord, updateRecord, queryRecords,
} from './dist/services/salesforce.js';
import { buildGenericDeployZip, deployZip, pollDeployStatus } from './dist/services/deployment.js';
import { executeAnonymousApex } from './dist/services/tooling.js';

const API_VERSION = '66.0';
const TS = Date.now().toString().slice(-6);
const auth = await getAuth();
console.log('Auth OK:', auth.instanceUrl, '\n');

const results = [];
let pass = 0, fail = 0;
function record(section, name, path, ok, detail = '') {
  results.push({ section, name, path, ok, detail });
  if (ok) { pass++; console.log(`  PASS [${path}] ${name}`); }
  else { fail++; console.log(`  FAIL [${path}] ${name} :: ${String(detail).slice(0, 220)}`); }
}
function section(t) { console.log(`\n${'─'.repeat(72)}\n  ${t}\n${'─'.repeat(72)}`); }

async function deployViaZip(apiName, params) {
  const xml = buildFlowDeployXml(params);
  const zip = await buildGenericDeployZip([], API_VERSION, [{ type: 'Flow', name: apiName, xml }]);
  return pollDeployStatus(auth, await deployZip(auth, zip, { rollbackOnError: true }), 10 * 60 * 1000);
}

/** Runs one flow definition through both builders unless `paths` narrows it. */
async function check(sec, name, params, opts = {}) {
  const paths = opts.paths ?? ['soap', 'zip'];
  const expectFail = opts.expectFail ?? false;
  for (const p of paths) {
    const apiName = params.apiName + (p === 'zip' ? 'z' : 's');
    const scoped = { ...params, apiName };
    try {
      const r = p === 'soap' ? await createFlow(auth, scoped) : await deployViaZip(apiName, scoped);
      const ok = expectFail ? !r.success : r.success;
      record(sec, name, p, ok, ok ? '' : (r.message ?? 'no message'));
      if (r.success && opts.keep) opts.keep.push(apiName);
    } catch (e) {
      record(sec, name, p, expectFail, e.message ?? String(e));
    }
  }
}

const el = (o) => ({ nextElement: null, ...o });
const strVar = (n, extra = {}) => ({ name: n, dataType: 'String', isInput: false, isOutput: false, isCollection: false, ...extra });

// ─── Seed data ────────────────────────────────────────────────────────────────
section('SEED DATA');
const seedAcct = await createRecord(auth, { objectApiName: 'Account', fields: { Name: `QA Seed Account ${TS}`, Industry: 'Technology', Rating: 'Cold' } });
const acctId = seedAcct.fullName;
console.log('  seed Account:', acctId, seedAcct.success ? 'OK' : seedAcct.message);
const seedOpp = await createRecord(auth, { objectApiName: 'Opportunity', fields: { Name: `QA Seed Opp ${TS}`, StageName: 'Prospecting', CloseDate: '2026-12-31', AccountId: acctId, Amount: 5000 } });
console.log('  seed Opportunity:', seedOpp.fullName, seedOpp.success ? 'OK' : seedOpp.message);

// ─── A. Flow type & structure ─────────────────────────────────────────────────
section('A. FLOW TYPE & STRUCTURE');
const trivial = [el({ type: 'Assignment', name: 'A', label: 'A', assignments: [{ assignToRef: 'V', operator: 'Assign', value: 'x' }] })];
await check('A', 'AutoLaunchedFlow deploys', { label: 'QA A1', apiName: `QA_A1_${TS}`, flowType: 'AutoLaunchedFlow', status: 'Draft', variables: [strVar('V')], elements: trivial });
await check('A', 'Screen flow (Flow) deploys', { label: 'QA A2', apiName: `QA_A2_${TS}`, flowType: 'Flow', status: 'Draft', variables: [strVar('V')],
  elements: [el({ type: 'Screen', name: 'S1', label: 'S1', screenFields: [{ name: 'Msg', fieldType: 'DisplayText', label: 'Hello' }] })] });
await check('A', 'RecordTriggeredFlow deploys', { label: 'QA A3', apiName: `QA_A3_${TS}`, flowType: 'RecordTriggeredFlow', status: 'Draft', triggerObject: 'Account', triggerType: 'RecordBeforeSave',
  elements: [el({ type: 'Assignment', name: 'A', label: 'A', assignments: [{ assignToRef: '$Record.Rating', operator: 'Assign', value: 'Hot' }] })] });
await check('A', 'ScheduledFlow deploys with schedule', { label: 'QA A4', apiName: `QA_A4_${TS}`, flowType: 'ScheduledFlow', status: 'Draft', scheduleFrequency: 'Daily', scheduleStartTime: '03:00:00.000Z', variables: [strVar('V')], elements: trivial });
await check('A', 'description persists', { label: 'QA A5', apiName: `QA_A5_${TS}`, flowType: 'AutoLaunchedFlow', status: 'Draft', description: 'QA description', variables: [strVar('V')], elements: trivial });

// ─── B. Record-trigger configuration ──────────────────────────────────────────
section('B. RECORD-TRIGGER CONFIGURATION');
for (const [n, tt] of [['RecordBeforeSave', 'RecordBeforeSave'], ['RecordAfterSave', 'RecordAfterSave'], ['RecordBeforeDelete', 'RecordBeforeDelete']]) {
  await check('B', `triggerType ${n}`, { label: `QA B ${n}`, apiName: `QA_B_${n}_${TS}`, flowType: 'RecordTriggeredFlow', status: 'Draft', triggerObject: 'Account', triggerType: tt, variables: [strVar('V')], elements: trivial });
}
for (const rtt of ['Create', 'Update', 'CreateAndUpdate']) {
  await check('B', `recordTriggerType ${rtt}`, { label: `QA B ${rtt}`, apiName: `QA_BR_${rtt}_${TS}`, flowType: 'RecordTriggeredFlow', status: 'Draft', triggerObject: 'Account', triggerType: 'RecordAfterSave', recordTriggerType: rtt, variables: [strVar('V')], elements: trivial });
}
await check('B', 'custom object trigger', { label: 'QA B custom', apiName: `QA_BC_${TS}`, flowType: 'RecordTriggeredFlow', status: 'Draft', triggerObject: 'Dryrun_Test__c', triggerType: 'RecordBeforeSave',
  elements: [el({ type: 'Assignment', name: 'A', label: 'A', assignments: [{ assignToRef: '$Record.Name', operator: 'Assign', value: 'set' }] })] });
await check('B', 'triggerFilterFormula', { label: 'QA B filter', apiName: `QA_BF_${TS}`, flowType: 'RecordTriggeredFlow', status: 'Draft', triggerObject: 'Opportunity', triggerType: 'RecordBeforeSave', triggerFilterFormula: "ISPICKVAL({!$Record.StageName},'Closed Won')",
  elements: [el({ type: 'Assignment', name: 'A', label: 'A', assignments: [{ assignToRef: '$Record.Description', operator: 'Assign', value: 'won' }] })] });
await check('B', 'fieldUpdates literal', { label: 'QA B fu', apiName: `QA_BFU_${TS}`, flowType: 'RecordTriggeredFlow', status: 'Draft', triggerObject: 'Account', triggerType: 'RecordBeforeSave', fieldUpdates: [{ field: 'Rating', value: 'Warm' }] });
await check('B', 'fieldUpdates formula', { label: 'QA B fuf', apiName: `QA_BFUF_${TS}`, flowType: 'RecordTriggeredFlow', status: 'Draft', triggerObject: 'Opportunity', triggerType: 'RecordBeforeSave', fieldUpdates: [{ field: 'CloseDate', formula: 'TODAY() + 30' }] });

// ─── C. Variables & resources ─────────────────────────────────────────────────
section('C. VARIABLES & RESOURCES');
for (const dt of ['String', 'Number', 'Boolean', 'Date', 'DateTime']) {
  await check('C', `variable dataType ${dt}`, { label: `QA C ${dt}`, apiName: `QA_C_${dt}_${TS}`, flowType: 'AutoLaunchedFlow', status: 'Draft',
    variables: [{ name: 'V', dataType: dt, isInput: true, isOutput: true, isCollection: false }],
    elements: [el({ type: 'Assignment', name: 'A', label: 'A', assignments: [{ assignToRef: 'V', operator: 'Assign', valueRef: 'V' }] })] });
}
await check('C', 'SObject variable', { label: 'QA C sobj', apiName: `QA_CS_${TS}`, flowType: 'AutoLaunchedFlow', status: 'Draft',
  variables: [{ name: 'acc', dataType: 'SObject', objectType: 'Account', isInput: true, isOutput: false, isCollection: false }],
  elements: [el({ type: 'Assignment', name: 'A', label: 'A', assignments: [{ assignToRef: 'acc.Rating', operator: 'Assign', value: 'Hot' }] })] });
await check('C', 'SObject collection', { label: 'QA C coll', apiName: `QA_CC_${TS}`, flowType: 'AutoLaunchedFlow', status: 'Draft',
  variables: [{ name: 'accs', dataType: 'SObject', objectType: 'Account', isInput: false, isOutput: true, isCollection: true }],
  elements: [el({ type: 'GetRecords', name: 'G', label: 'G', objectApiName: 'Account', filterField: 'Industry', filterOperator: 'EqualTo', filterValue: 'Technology', outputVariable: 'accs', queriedFields: ['Name'] })] });
await check('C', 'defaultStringValue', { label: 'QA C def', apiName: `QA_CD_${TS}`, flowType: 'AutoLaunchedFlow', status: 'Draft',
  variables: [strVar('V', { defaultStringValue: 'seed' })], elements: trivial });
await check('C', 'formula resource', { label: 'QA C formula', apiName: `QA_CF_${TS}`, flowType: 'AutoLaunchedFlow', status: 'Draft',
  formulas: [{ name: 'Dbl', dataType: 'Number', expression: '2 * 21', scale: 0 }],
  variables: [{ name: 'N', dataType: 'Number', isInput: false, isOutput: true, isCollection: false }],
  elements: [el({ type: 'Assignment', name: 'A', label: 'A', assignments: [{ assignToRef: 'N', operator: 'Assign', valueRef: 'Dbl' }] })] });
await check('C', 'constant resource', { label: 'QA C const', apiName: `QA_CK_${TS}`, flowType: 'AutoLaunchedFlow', status: 'Draft',
  constants: [{ name: 'Greeting', dataType: 'String', value: 'hello' }, { name: 'MaxN', dataType: 'Number', value: '10' }, { name: 'Flag', dataType: 'Boolean', value: 'true' }],
  variables: [strVar('V', { isOutput: true })],
  elements: [el({ type: 'Assignment', name: 'A', label: 'A', assignments: [{ assignToRef: 'V', operator: 'Assign', valueRef: 'Greeting' }] })] });
await check('C', 'text template resource', { label: 'QA C tt', apiName: `QA_CT_${TS}`, flowType: 'AutoLaunchedFlow', status: 'Draft',
  textTemplates: [{ name: 'Body', text: 'Dear customer, thank you.' }], variables: [strVar('V')], elements: trivial });

// ─── D. Elements ──────────────────────────────────────────────────────────────
section('D. ELEMENTS');
// Assignment typed literals
for (const [dt, val] of [['String', 'abc'], ['Number', '42'], ['Boolean', 'true']]) {
  await check('D', `Assignment ${dt} literal`, { label: `QA D as ${dt}`, apiName: `QA_DA_${dt}_${TS}`, flowType: 'AutoLaunchedFlow', status: 'Draft',
    variables: [{ name: 'V', dataType: dt, isInput: false, isOutput: true, isCollection: false }],
    elements: [el({ type: 'Assignment', name: 'A', label: 'A', assignments: [{ assignToRef: 'V', operator: 'Assign', value: val }] })] });
}
await check('D', 'Assignment Add operator', { label: 'QA D add', apiName: `QA_DAD_${TS}`, flowType: 'AutoLaunchedFlow', status: 'Draft',
  variables: [{ name: 'N', dataType: 'Number', isInput: false, isOutput: true, isCollection: false }],
  elements: [el({ type: 'Assignment', name: 'A', label: 'A', assignments: [{ assignToRef: 'N', operator: 'Add', value: '1' }] })] });

// Decision operators
for (const op of ['EqualTo', 'NotEqualTo', 'GreaterThan', 'LessThan', 'GreaterThanOrEqualTo', 'LessThanOrEqualTo', 'StartsWith', 'EndsWith', 'Contains']) {
  const isNum = ['GreaterThan', 'LessThan', 'GreaterThanOrEqualTo', 'LessThanOrEqualTo'].includes(op);
  await check('D', `Decision ${op}`, { label: `QA D dec ${op}`, apiName: `QA_DD_${op}_${TS}`, flowType: 'AutoLaunchedFlow', status: 'Draft',
    variables: [{ name: 'V', dataType: isNum ? 'Number' : 'String', isInput: true, isOutput: false, isCollection: false }, strVar('R', { isOutput: true })],
    elements: [
      el({ type: 'Decision', name: 'D', label: 'D', conditions: [{ leftValueRef: 'V', operator: op, rightValue: isNum ? '5' : 'abc', nextElement: 'A' }], defaultConnector: 'A' }),
      el({ type: 'Assignment', name: 'A', label: 'A', assignments: [{ assignToRef: 'R', operator: 'Assign', value: 'hit' }] }),
    ] });
}
for (const op of ['IsNull', 'IsNotNull']) {
  await check('D', `Decision ${op}`, { label: `QA D dec ${op}`, apiName: `QA_DN_${op}_${TS}`, flowType: 'AutoLaunchedFlow', status: 'Draft',
    variables: [strVar('V', { isInput: true }), strVar('R', { isOutput: true })],
    elements: [
      el({ type: 'Decision', name: 'D', label: 'D', conditions: [{ leftValueRef: 'V', operator: op, rightValue: 'true', nextElement: 'A' }], defaultConnector: 'A' }),
      el({ type: 'Assignment', name: 'A', label: 'A', assignments: [{ assignToRef: 'R', operator: 'Assign', value: 'hit' }] }),
    ] });
}
await check('D', 'Decision multi-rule routing', { label: 'QA D multi', apiName: `QA_DM_${TS}`, flowType: 'AutoLaunchedFlow', status: 'Draft',
  variables: [strVar('V', { isInput: true }), strVar('R', { isOutput: true })],
  elements: [
    el({ type: 'Decision', name: 'D', label: 'D', conditions: [
      { leftValueRef: 'V', operator: 'EqualTo', rightValue: 'a', label: 'IsA', nextElement: 'A1' },
      { leftValueRef: 'V', operator: 'EqualTo', rightValue: 'b', label: 'IsB', nextElement: 'A2' },
    ], defaultConnector: 'A1' }),
    el({ type: 'Assignment', name: 'A1', label: 'A1', assignments: [{ assignToRef: 'R', operator: 'Assign', value: 'a' }] }),
    el({ type: 'Assignment', name: 'A2', label: 'A2', assignments: [{ assignToRef: 'R', operator: 'Assign', value: 'b' }] }),
  ] });
await check('D', 'Decision rightValueRef', { label: 'QA D ref', apiName: `QA_DR_${TS}`, flowType: 'AutoLaunchedFlow', status: 'Draft',
  variables: [strVar('V', { isInput: true }), strVar('W', { isInput: true }), strVar('R', { isOutput: true })],
  elements: [
    el({ type: 'Decision', name: 'D', label: 'D', conditions: [{ leftValueRef: 'V', operator: 'EqualTo', rightValueRef: 'W', nextElement: 'A' }], defaultConnector: 'A' }),
    el({ type: 'Assignment', name: 'A', label: 'A', assignments: [{ assignToRef: 'R', operator: 'Assign', value: 'hit' }] }),
  ] });

// GetRecords
await check('D', 'GetRecords multi-filter', { label: 'QA D get', apiName: `QA_DG_${TS}`, flowType: 'AutoLaunchedFlow', status: 'Draft',
  variables: [{ name: 'accs', dataType: 'SObject', objectType: 'Account', isInput: false, isOutput: true, isCollection: true }],
  elements: [el({ type: 'GetRecords', name: 'G', label: 'G', objectApiName: 'Account', filters: [{ field: 'Industry', operator: 'EqualTo', value: 'Technology' }, { field: 'Rating', operator: 'NotEqualTo', value: 'Hot' }], outputVariable: 'accs', queriedFields: ['Name', 'Rating'] })] });
await check('D', 'GetRecords sort + limit', { label: 'QA D sort', apiName: `QA_DS_${TS}`, flowType: 'AutoLaunchedFlow', status: 'Draft',
  variables: [{ name: 'accs', dataType: 'SObject', objectType: 'Account', isInput: false, isOutput: true, isCollection: true }],
  elements: [el({ type: 'GetRecords', name: 'G', label: 'G', objectApiName: 'Account', filterField: 'Industry', filterOperator: 'EqualTo', filterValue: 'Technology', outputVariable: 'accs', queriedFields: ['Name'], sortField: 'CreatedDate', sortOrder: 'Desc', limit: 5 })] });
await check('D', 'GetRecords getFirstRecordOnly', { label: 'QA D first', apiName: `QA_DF_${TS}`, flowType: 'AutoLaunchedFlow', status: 'Draft',
  variables: [{ name: 'acc', dataType: 'SObject', objectType: 'Account', isInput: false, isOutput: true, isCollection: false }],
  elements: [el({ type: 'GetRecords', name: 'G', label: 'G', objectApiName: 'Account', filterField: 'Industry', filterOperator: 'EqualTo', filterValue: 'Technology', outputVariable: 'acc', queriedFields: ['Name'], getFirstRecordOnly: true })] });
await check('D', 'GetRecords filterValueRef', { label: 'QA D gref', apiName: `QA_DGR_${TS}`, flowType: 'AutoLaunchedFlow', status: 'Draft',
  variables: [strVar('ind', { isInput: true }), { name: 'accs', dataType: 'SObject', objectType: 'Account', isInput: false, isOutput: true, isCollection: true }],
  elements: [el({ type: 'GetRecords', name: 'G', label: 'G', objectApiName: 'Account', filterField: 'Industry', filterOperator: 'EqualTo', filterValueRef: 'ind', outputVariable: 'accs', queriedFields: ['Name'] })] });

// Filter-level null operators. The Decision path translates IsNotNull; the filter path in both
// builders writes <operator> straight through, so this is where the FlowComparisonOperator enum
// rejection would still be reachable.
for (const op of ['IsNull', 'IsNotNull']) {
  await check('D', `GetRecords filter ${op}`, { label: `QA D gf ${op}`, apiName: `QA_DGF_${op}_${TS}`, flowType: 'AutoLaunchedFlow', status: 'Draft',
    variables: [{ name: 'accs', dataType: 'SObject', objectType: 'Account', isInput: false, isOutput: true, isCollection: true }],
    elements: [el({ type: 'GetRecords', name: 'G', label: 'G', objectApiName: 'Account', filters: [{ field: 'Industry', operator: op, value: 'true' }], outputVariable: 'accs', queriedFields: ['Name'] })] });
}
// IsNull with no explicit value — Salesforce needs a booleanValue here, not an empty stringValue.
await check('D', 'GetRecords filter IsNull without value', { label: 'QA D gfn', apiName: `QA_DGFN_${TS}`, flowType: 'AutoLaunchedFlow', status: 'Draft',
  variables: [{ name: 'accs', dataType: 'SObject', objectType: 'Account', isInput: false, isOutput: true, isCollection: true }],
  elements: [el({ type: 'GetRecords', name: 'G', label: 'G', objectApiName: 'Account', filters: [{ field: 'Industry', operator: 'IsNull' }], outputVariable: 'accs', queriedFields: ['Name'] })] });
await check('D', 'UpdateRecords filter IsNotNull', { label: 'QA D ufn', apiName: `QA_DUFN_${TS}`, flowType: 'AutoLaunchedFlow', status: 'Draft',
  elements: [el({ type: 'UpdateRecords', name: 'U', label: 'U', objectApiName: 'Account', filters: [{ field: 'Industry', operator: 'IsNotNull', value: 'true' }], inputAssignments: [{ field: 'Rating', value: 'Warm' }] })] });

// Create / Update / Delete
await check('D', 'CreateRecords literal + ref', { label: 'QA D cr', apiName: `QA_DCR_${TS}`, flowType: 'AutoLaunchedFlow', status: 'Draft',
  variables: [strVar('nm', { isInput: true })],
  elements: [el({ type: 'CreateRecords', name: 'C', label: 'C', objectApiName: 'Account', inputAssignments: [{ field: 'Name', valueRef: 'nm' }, { field: 'Rating', value: 'Cold' }] })] });
await check('D', 'UpdateRecords by criteria', { label: 'QA D upd', apiName: `QA_DU_${TS}`, flowType: 'AutoLaunchedFlow', status: 'Draft',
  elements: [el({ type: 'UpdateRecords', name: 'U', label: 'U', objectApiName: 'Account', filters: [{ field: 'Industry', operator: 'EqualTo', value: 'Technology' }], inputAssignments: [{ field: 'Rating', value: 'Warm' }] })] });
await check('D', 'UpdateRecords by reference', { label: 'QA D updr', apiName: `QA_DUR_${TS}`, flowType: 'AutoLaunchedFlow', status: 'Draft',
  variables: [{ name: 'acc', dataType: 'SObject', objectType: 'Account', isInput: true, isOutput: false, isCollection: false }],
  elements: [el({ type: 'UpdateRecords', name: 'U', label: 'U', inputReference: 'acc' })] });
await check('D', 'DeleteRecords', { label: 'QA D del', apiName: `QA_DDL_${TS}`, flowType: 'AutoLaunchedFlow', status: 'Draft',
  variables: [{ name: 'acc', dataType: 'SObject', objectType: 'Account', isInput: true, isOutput: false, isCollection: false }],
  elements: [el({ type: 'DeleteRecords', name: 'Dl', label: 'Dl', inputReference: 'acc' })] });

// Loop
await check('D', 'Loop over SObject collection', { label: 'QA D loop', apiName: `QA_DL_${TS}`, flowType: 'AutoLaunchedFlow', status: 'Draft',
  variables: [
    { name: 'accs', dataType: 'SObject', objectType: 'Account', isInput: false, isOutput: false, isCollection: true },
    { name: 'cur', dataType: 'SObject', objectType: 'Account', isInput: false, isOutput: false, isCollection: false },
    { name: 'names', dataType: 'String', isInput: false, isOutput: true, isCollection: true },
  ],
  elements: [
    el({ type: 'GetRecords', name: 'G', label: 'G', objectApiName: 'Account', filterField: 'Industry', filterOperator: 'EqualTo', filterValue: 'Technology', outputVariable: 'accs', queriedFields: ['Name'], nextElement: 'L' }),
    el({ type: 'Loop', name: 'L', label: 'L', loopVariable: 'accs', loopIterationVariable: 'cur', loopNextElement: 'A', nextElement: null }),
    el({ type: 'Assignment', name: 'A', label: 'A', assignments: [{ assignToRef: 'names', operator: 'Add', valueRef: 'cur.Name' }], nextElement: 'L' }),
  ] });
await check('D', 'Loop over primitive collection', { label: 'QA D loopp', apiName: `QA_DLP_${TS}`, flowType: 'AutoLaunchedFlow', status: 'Draft',
  variables: [
    { name: 'items', dataType: 'String', isInput: true, isOutput: false, isCollection: true },
    strVar('cur'), strVar('outv', { isOutput: true }),
  ],
  elements: [
    el({ type: 'Loop', name: 'L', label: 'L', loopVariable: 'items', loopIterationVariable: 'cur', loopNextElement: 'A', nextElement: null }),
    el({ type: 'Assignment', name: 'A', label: 'A', assignments: [{ assignToRef: 'outv', operator: 'Assign', valueRef: 'cur' }], nextElement: 'L' }),
  ] });

// Actions / subflow / screen
await check('D', 'Subflow call', { label: 'QA D sub', apiName: `QA_DSF_${TS}`, flowType: 'AutoLaunchedFlow', status: 'Draft',
  elements: [el({ type: 'Subflow', name: 'S', label: 'S', subflowApiName: `QA_A1_${TS}s` })] });
await check('D', 'Screen with typed input fields', { label: 'QA D scr', apiName: `QA_DSC_${TS}`, flowType: 'Flow', status: 'Draft',
  variables: [strVar('V')],
  elements: [el({ type: 'Screen', name: 'S', label: 'S', screenFields: [
    { name: 'Txt', fieldType: 'InputField', label: 'Your name', dataType: 'String' },
    { name: 'Num', fieldType: 'InputField', label: 'Amount', dataType: 'Number' },
    { name: 'Disp', fieldType: 'DisplayText', label: 'Welcome' },
  ] })] });
await check('D', 'Screen defaultValueRef', { label: 'QA D scrd', apiName: `QA_DSD_${TS}`, flowType: 'Flow', status: 'Draft',
  variables: [strVar('V', { defaultStringValue: 'hi' })],
  elements: [el({ type: 'Screen', name: 'S', label: 'S', screenFields: [{ name: 'Txt', fieldType: 'InputField', label: 'Name', dataType: 'String', defaultValueRef: 'V' }] })] });

// ─── E. Connectors, guardrails, safety ────────────────────────────────────────
section('E. CONNECTORS, GUARDRAILS & SAFETY');
await check('E', 'multi-element chain', { label: 'QA E chain', apiName: `QA_EC_${TS}`, flowType: 'AutoLaunchedFlow', status: 'Draft',
  variables: [strVar('V', { isOutput: true })],
  elements: [
    el({ type: 'Assignment', name: 'A1', label: 'A1', assignments: [{ assignToRef: 'V', operator: 'Assign', value: '1' }], nextElement: 'A2' }),
    el({ type: 'Assignment', name: 'A2', label: 'A2', assignments: [{ assignToRef: 'V', operator: 'Assign', value: '2' }], nextElement: 'A3' }),
    el({ type: 'Assignment', name: 'A3', label: 'A3', assignments: [{ assignToRef: 'V', operator: 'Assign', value: '3' }] }),
  ] });
await check('E', 'XML escaping in label/description', { label: 'QA E <&> "quoted" & more', apiName: `QA_EX_${TS}`, flowType: 'AutoLaunchedFlow', status: 'Draft',
  description: 'Handles < > & " \' safely', variables: [strVar('V')],
  elements: [el({ type: 'Assignment', name: 'A', label: 'A & B < C', assignments: [{ assignToRef: 'V', operator: 'Assign', value: 'x & y < z' }] })] });
await check('E', 'XML escaping in formula expression', { label: 'QA E formula esc', apiName: `QA_EFX_${TS}`, flowType: 'AutoLaunchedFlow', status: 'Draft',
  formulas: [{ name: 'Cmp', dataType: 'Boolean', expression: '5 < 10 && 3 > 1' }], variables: [strVar('V')], elements: trivial });
await check('E', 'dangling connector rejected', { label: 'QA E dangle', apiName: `QA_ED_${TS}`, flowType: 'AutoLaunchedFlow', status: 'Draft',
  variables: [strVar('V')],
  elements: [el({ type: 'Assignment', name: 'A', label: 'A', assignments: [{ assignToRef: 'V', operator: 'Assign', value: 'x' }], nextElement: 'DoesNotExist' })] }, { expectFail: true });
await check('E', 'GetRecords Contains rejected', { label: 'QA E contains', apiName: `QA_ECT_${TS}`, flowType: 'AutoLaunchedFlow', status: 'Draft',
  variables: [{ name: 'accs', dataType: 'SObject', objectType: 'Account', isInput: false, isOutput: true, isCollection: true }],
  elements: [el({ type: 'GetRecords', name: 'G', label: 'G', objectApiName: 'Account', filterField: 'Name', filterOperator: 'Contains', filterValue: 'QA', outputVariable: 'accs', queriedFields: ['Name'] })] }, { expectFail: true, paths: ['soap'] });
await check('E', 'UpdateRecords inputReference+inputAssignments rejected', { label: 'QA E updbad', apiName: `QA_EU_${TS}`, flowType: 'AutoLaunchedFlow', status: 'Draft',
  variables: [{ name: 'acc', dataType: 'SObject', objectType: 'Account', isInput: true, isOutput: false, isCollection: false }],
  elements: [el({ type: 'UpdateRecords', name: 'U', label: 'U', inputReference: 'acc', inputAssignments: [{ field: 'Rating', value: 'Hot' }] })] }, { expectFail: true, paths: ['soap'] });
await check('E', 'approval submit + action call contiguity', { label: 'QA E appr', apiName: `QA_EA_${TS}`, flowType: 'RecordTriggeredFlow', status: 'Draft',
  triggerObject: 'Opportunity', triggerType: 'RecordAfterSave', submitForApprovalProcessName: 'QA_Fake_Process',
  elements: [el({ type: 'ApexAction', name: 'AX', label: 'AX', apexClassName: 'QAFakeApex', apexMethodName: 'run' })] }, { expectFail: true });

// ─── F. Lifecycle ─────────────────────────────────────────────────────────────
section('F. LIFECYCLE (activate / versions)');
const lifeName = `QA_LIFE_${TS}`;
const lifeParams = { label: 'QA Life', apiName: lifeName, flowType: 'AutoLaunchedFlow', status: 'Draft', variables: [strVar('V')], elements: trivial };
const lifeCreate = await createFlow(auth, lifeParams);
record('F', 'create draft flow', 'soap', lifeCreate.success, lifeCreate.message);
if (lifeCreate.success) {
  const act = await activateFlow(auth, { flowApiName: lifeName });
  record('F', 'activateFlow', 'soap', act.success, act.message);
  const vers = await listFlowVersions(auth, { flowApiName: lifeName });
  record('F', 'listFlowVersions', 'soap', vers.success, vers.message);
  const deact = await deactivateFlow(auth, { flowApiName: lifeName });
  record('F', 'deactivateFlow', 'soap', deact.success, deact.message);
  const v2 = await createFlow(auth, { ...lifeParams, label: 'QA Life v2' });
  record('F', 'redeploy creates new version', 'soap', v2.success, v2.message);
}

// ─── G. RUNTIME VERIFICATION ──────────────────────────────────────────────────
section('G. RUNTIME VERIFICATION (real DML, asserted)');

// G1: before-save record-triggered flow actually stamps the record
const g1 = `QA_RT_STAMP_${TS}`;
const g1c = await createFlow(auth, { label: 'QA RT Stamp', apiName: g1, flowType: 'RecordTriggeredFlow', status: 'Active',
  triggerObject: 'Account', triggerType: 'RecordBeforeSave', recordTriggerType: 'Create',
  elements: [el({ type: 'Assignment', name: 'A', label: 'A', assignments: [{ assignToRef: '$Record.Rating', operator: 'Assign', value: 'Hot' }] })] });
if (!g1c.success) record('G', 'before-save stamps record', 'runtime', false, 'deploy: ' + g1c.message);
else {
  const rec = await createRecord(auth, { objectApiName: 'Account', fields: { Name: `QA RT Target ${TS}`, Rating: 'Cold' } });
  const back = await queryRecords(auth, { soql: `SELECT Rating FROM Account WHERE Id='${rec.fullName}'` });
  const got = back.records?.[0]?.Rating;
  record('G', 'before-save stamps record', 'runtime', got === 'Hot', `expected Rating=Hot, got ${got}`);
  await deactivateFlow(auth, { flowApiName: g1 });
}

// G2: after-save record-triggered flow creates a related record
const g2 = `QA_RT_TASK_${TS}`;
const g2c = await createFlow(auth, { label: 'QA RT Task', apiName: g2, flowType: 'RecordTriggeredFlow', status: 'Active',
  triggerObject: 'Account', triggerType: 'RecordAfterSave', recordTriggerType: 'Create',
  elements: [el({ type: 'CreateRecords', name: 'C', label: 'C', objectApiName: 'Task', inputAssignments: [{ field: 'Subject', value: `QA auto ${TS}` }, { field: 'WhatId', valueRef: '$Record.Id' }] })] });
if (!g2c.success) record('G', 'after-save creates related record', 'runtime', false, 'deploy: ' + g2c.message);
else {
  const rec = await createRecord(auth, { objectApiName: 'Account', fields: { Name: `QA RT Task Target ${TS}` } });
  const tasks = await queryRecords(auth, { soql: `SELECT Id, Subject FROM Task WHERE WhatId='${rec.fullName}'` });
  record('G', 'after-save creates related record', 'runtime', (tasks.totalSize ?? 0) > 0, `expected >=1 Task, got ${tasks.totalSize}`);
  await deactivateFlow(auth, { flowApiName: g2 });
}

// G3: triggerFilterFormula suppresses non-matching records
const g3 = `QA_RT_FILT_${TS}`;
const g3c = await createFlow(auth, { label: 'QA RT Filt', apiName: g3, flowType: 'RecordTriggeredFlow', status: 'Active',
  triggerObject: 'Account', triggerType: 'RecordBeforeSave', recordTriggerType: 'Create',
  // Industry is a picklist — Salesforce rejects a bare `=` comparison in entry criteria and
  // requires ISPICKVAL. That is a formula-authoring rule, not something the tool should rewrite.
  triggerFilterFormula: "ISPICKVAL({!$Record.Industry}, 'Banking')",
  elements: [el({ type: 'Assignment', name: 'A', label: 'A', assignments: [{ assignToRef: '$Record.Rating', operator: 'Assign', value: 'Hot' }] })] });
if (!g3c.success) record('G', 'trigger filter suppresses non-match', 'runtime', false, 'deploy: ' + g3c.message);
else {
  const noMatch = await createRecord(auth, { objectApiName: 'Account', fields: { Name: `QA Filt No ${TS}`, Industry: 'Energy', Rating: 'Cold' } });
  const match = await createRecord(auth, { objectApiName: 'Account', fields: { Name: `QA Filt Yes ${TS}`, Industry: 'Banking', Rating: 'Cold' } });
  const a = await queryRecords(auth, { soql: `SELECT Rating FROM Account WHERE Id='${noMatch.fullName}'` });
  const b = await queryRecords(auth, { soql: `SELECT Rating FROM Account WHERE Id='${match.fullName}'` });
  const ok = a.records?.[0]?.Rating === 'Cold' && b.records?.[0]?.Rating === 'Hot';
  record('G', 'trigger filter suppresses non-match', 'runtime', ok, `non-match=${a.records?.[0]?.Rating} (want Cold), match=${b.records?.[0]?.Rating} (want Hot)`);
  await deactivateFlow(auth, { flowApiName: g3 });
}

// G4: autolaunched flow with Loop actually iterates (invoked via Apex)
const g4 = `QA_LOOP_RT_${TS}`;
const g4c = await createFlow(auth, { label: 'QA Loop RT', apiName: g4, flowType: 'AutoLaunchedFlow', status: 'Active',
  variables: [
    { name: 'accs', dataType: 'SObject', objectType: 'Account', isInput: false, isOutput: false, isCollection: true },
    { name: 'cur', dataType: 'SObject', objectType: 'Account', isInput: false, isOutput: false, isCollection: false },
  ],
  elements: [
    el({ type: 'GetRecords', name: 'G', label: 'G', objectApiName: 'Account', filterField: 'Name', filterOperator: 'StartsWith', filterValue: `QA Seed Account ${TS}`, outputVariable: 'accs', queriedFields: ['Name'], nextElement: 'L' }),
    el({ type: 'Loop', name: 'L', label: 'L', loopVariable: 'accs', loopIterationVariable: 'cur', loopNextElement: 'C', nextElement: null }),
    el({ type: 'CreateRecords', name: 'C', label: 'C', objectApiName: 'Task', inputAssignments: [{ field: 'Subject', value: `QA loop ${TS}` }, { field: 'WhatId', valueRef: 'cur.Id' }], nextElement: 'L' }),
  ] });
if (!g4c.success) record('G', 'Loop iterates at runtime', 'runtime', false, 'deploy: ' + g4c.message);
else {
  const apex = await executeAnonymousApex(auth, `Flow.Interview.${g4} f = new Flow.Interview.${g4}(new Map<String,Object>()); f.start();`);
  const tasks = await queryRecords(auth, { soql: `SELECT Id FROM Task WHERE Subject='QA loop ${TS}'` });
  record('G', 'Loop iterates at runtime', 'runtime', (tasks.totalSize ?? 0) > 0, `apex ok=${apex.success}, tasks=${tasks.totalSize}`);
  await deactivateFlow(auth, { flowApiName: g4 });
}

// G5: UpdateRecords by criteria actually updates
const g5 = `QA_UPD_RT_${TS}`;
const g5c = await createFlow(auth, { label: 'QA Upd RT', apiName: g5, flowType: 'AutoLaunchedFlow', status: 'Active',
  elements: [el({ type: 'UpdateRecords', name: 'U', label: 'U', objectApiName: 'Account', filters: [{ field: 'Name', operator: 'EqualTo', value: `QA Seed Account ${TS}` }], inputAssignments: [{ field: 'Rating', value: 'Warm' }] })] });
if (!g5c.success) record('G', 'UpdateRecords updates at runtime', 'runtime', false, 'deploy: ' + g5c.message);
else {
  const apex = await executeAnonymousApex(auth, `Flow.Interview.${g5} f = new Flow.Interview.${g5}(new Map<String,Object>()); f.start();`);
  const back = await queryRecords(auth, { soql: `SELECT Rating FROM Account WHERE Id='${acctId}'` });
  const got = back.records?.[0]?.Rating;
  record('G', 'UpdateRecords updates at runtime', 'runtime', got === 'Warm', `apex ok=${apex.success}, expected Warm got ${got}`);
  await deactivateFlow(auth, { flowApiName: g5 });
}

// ─── Summary ──────────────────────────────────────────────────────────────────
console.log(`\n${'═'.repeat(72)}`);
console.log(`  TOTAL: ${pass} passed, ${fail} failed, ${pass + fail} checks`);
console.log('═'.repeat(72));
const bySec = {};
for (const r of results) {
  bySec[r.section] ??= { p: 0, f: 0 };
  r.ok ? bySec[r.section].p++ : bySec[r.section].f++;
}
for (const [s, v] of Object.entries(bySec)) console.log(`  ${s}: ${v.p} passed, ${v.f} failed`);
if (fail) {
  console.log('\n  FAILURES:');
  for (const r of results.filter(r => !r.ok)) console.log(`   - [${r.section}/${r.path}] ${r.name} :: ${String(r.detail).slice(0, 200)}`);
}
