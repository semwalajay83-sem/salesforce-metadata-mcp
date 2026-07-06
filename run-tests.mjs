/**
 * Full test suite for salesforce-metadata-mcp against the dev org
 * Run: node run-tests.mjs (credentials from .env.local or environment)
 */

import { getAuth, buildFlowDeployXml, activateFlow, deactivateFlow } from './dist/services/salesforce.js';
import { buildGenericDeployZip, deployZip, pollDeployStatus } from './dist/services/deployment.js';

const API_VERSION = '66.0';

// Deploy flow via ZIP (matches what sf_create_flow MCP tool does)
async function createFlowViaZip(auth, params) {
  const flowXml = buildFlowDeployXml({ ...params, status: params.status ?? 'Draft' });
  return deployFlowXml(auth, params.apiName, flowXml, false);
}

import { readFileSync, existsSync } from 'node:fs';
if (existsSync('.env.local')) {
  for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}
for (const k of ['SF_INSTANCE_URL', 'SF_JWT_CLIENT_ID', 'SF_JWT_KEY_FILE', 'SF_JWT_USERNAME']) {
  if (!process.env[k]) { console.error(`Missing ${k} — set it in .env.local or the environment`); process.exit(1); }
}

const TS = Date.now().toString().slice(-6);
let passed = 0, failed = 0;
const failures = [];

function log(msg) { console.log(msg); }
function pass(name) { passed++; log(`  ✅ PASS  ${name}`); }
function fail(name, err) {
  failed++;
  const msg = typeof err === 'string' ? err : (err?.message ?? String(err));
  failures.push({ name, msg });
  log(`  ❌ FAIL  ${name}  →  ${msg.slice(0, 300)}`);
}

async function deployFlowXml(auth, flowApiName, flowXml, activate = true) {
  const base64Zip = await buildGenericDeployZip(
    [],
    API_VERSION,
    [{ type: 'Flow', name: flowApiName, xml: flowXml }]
  );
  const deployId = await deployZip(auth, base64Zip, { rollbackOnError: true });
  const result = await pollDeployStatus(auth, deployId, 10 * 60 * 1000);
  if (!result.success) return result;
  if (activate) {
    return activateFlow(auth, { flowApiName });
  }
  return result;
}

// ─── TEST 1: Simple AutoLaunchedFlow via sf_create_flow (SOAP) ────────────────
async function test1(auth) {
  log('\n═══════════ TEST 1: Simple AutoLaunchedFlow (sf_create_flow) ═══════════');
  const apiName = `Test_Simple_Flow_${TS}`;
  const result = await createFlowViaZip(auth, {
    label: `Test Simple Flow ${TS}`,
    apiName,
    flowType: 'AutoLaunchedFlow',
    status: 'Draft',
    variables: [
      { name: 'InputVar', dataType: 'String', isInput: true, isOutput: false, isCollection: false },
      { name: 'OutputVar', dataType: 'String', isInput: false, isOutput: true, isCollection: false },
    ],
    elements: [
      {
        type: 'Assignment',
        name: 'Assign1',
        label: 'Assign Output',
        assignments: [{ assignToRef: 'OutputVar', operator: 'Assign', value: 'Hello World' }],
        nextElement: null,
      },
    ],
  });
  if (!result.success) { fail('TEST1: create', result.message); return; }
  const actResult = await activateFlow(auth, { flowApiName: apiName });
  if (!actResult.success) { fail('TEST1: activate', actResult.message); return; }
  pass('TEST1: Simple AutoLaunchedFlow');
  return apiName;
}

// ─── TEST 2: GetRecords with variable reference filter ────────────────────────
async function test2(auth) {
  log('\n═══════════ TEST 2: GetRecords with variable reference filter ═══════════');
  const apiName = `Test_GetRecords_Filter_${TS}`;
  const result = await createFlowViaZip(auth, {
    label: `Test GetRecords Filter ${TS}`,
    apiName,
    flowType: 'AutoLaunchedFlow',
    status: 'Draft',
    variables: [
      { name: 'AccountName', dataType: 'String', isInput: true, isOutput: false, isCollection: false },
      { name: 'AccountRecord', dataType: 'SObject', objectType: 'Account', isInput: false, isOutput: false, isCollection: false },
      { name: 'AccountNameOutput', dataType: 'String', isInput: false, isOutput: true, isCollection: false },
    ],
    elements: [
      {
        type: 'GetRecords',
        name: 'Get_Account',
        label: 'Get Account',
        objectApiName: 'Account',
        filterField: 'Name',
        filterOperator: 'EqualTo',
        filterValueRef: 'AccountName',
        outputVariable: 'AccountRecord',
        getFirstRecordOnly: true,
        queriedFields: ['Id', 'Name'],
        nextElement: 'Assign_Output',
      },
      {
        type: 'Assignment',
        name: 'Assign_Output',
        label: 'Assign Output',
        assignments: [{ assignToRef: 'AccountNameOutput', operator: 'Assign', valueRef: 'AccountRecord.Name' }],
      },
    ],
  });
  if (!result.success) { fail('TEST2: create', result.message); return; }
  const actResult = await activateFlow(auth, { flowApiName: apiName });
  if (!actResult.success) { fail('TEST2: activate', actResult.message); return; }
  pass('TEST2: GetRecords with variable reference filter');
  return apiName;
}

// ─── TEST 3: Multiple GetRecords elements chained ─────────────────────────────
async function test3(auth) {
  log('\n═══════════ TEST 3: Multiple GetRecords chained ═══════════');
  const apiName = `Test_Multi_GetRecords_${TS}`;
  const result = await createFlowViaZip(auth, {
    label: `Test Multi GetRecords ${TS}`,
    apiName,
    flowType: 'AutoLaunchedFlow',
    status: 'Draft',
    variables: [
      { name: 'AccountName', dataType: 'String', isInput: true, isOutput: false, isCollection: false },
      { name: 'AccountRecord', dataType: 'SObject', objectType: 'Account', isInput: false, isOutput: false, isCollection: false },
      { name: 'Opportunities', dataType: 'SObject', objectType: 'Opportunity', isInput: false, isOutput: false, isCollection: true },
      { name: 'Cases', dataType: 'SObject', objectType: 'Case', isInput: false, isOutput: false, isCollection: true },
      { name: 'OutputVar', dataType: 'String', isInput: false, isOutput: true, isCollection: false },
    ],
    elements: [
      {
        type: 'GetRecords',
        name: 'Get_Account',
        label: 'Get Account',
        objectApiName: 'Account',
        filterField: 'Name',
        filterOperator: 'EqualTo',
        filterValueRef: 'AccountName',
        outputVariable: 'AccountRecord',
        getFirstRecordOnly: true,
        queriedFields: ['Id', 'Name'],
        nextElement: 'Get_Opportunities',
      },
      {
        type: 'GetRecords',
        name: 'Get_Opportunities',
        label: 'Get Opportunities',
        objectApiName: 'Opportunity',
        filterField: 'AccountId',
        filterOperator: 'EqualTo',
        filterValueRef: 'AccountRecord.Id',
        outputVariable: 'Opportunities',
        getFirstRecordOnly: false,
        queriedFields: ['Id', 'Name', 'StageName'],
        nextElement: 'Get_Cases',
      },
      {
        type: 'GetRecords',
        name: 'Get_Cases',
        label: 'Get Cases',
        objectApiName: 'Case',
        filterField: 'AccountId',
        filterOperator: 'EqualTo',
        filterValueRef: 'AccountRecord.Id',
        outputVariable: 'Cases',
        getFirstRecordOnly: false,
        queriedFields: ['Id', 'Subject', 'Status'],
        nextElement: 'Assign_Output',
      },
      {
        type: 'Assignment',
        name: 'Assign_Output',
        label: 'Assign Output',
        assignments: [{ assignToRef: 'OutputVar', operator: 'Assign', value: 'done' }],
      },
    ],
  });
  if (!result.success) { fail('TEST3: create', result.message); return; }
  const actResult = await activateFlow(auth, { flowApiName: apiName });
  if (!actResult.success) { fail('TEST3: activate', actResult.message); return; }
  pass('TEST3: Multiple GetRecords chained');
  return apiName;
}

// ─── TEST 4: Loop element ─────────────────────────────────────────────────────
async function test4(auth) {
  log('\n═══════════ TEST 4: Loop element ═══════════');
  const apiName = `Test_Loop_Flow_${TS}`;
  const result = await createFlowViaZip(auth, {
    label: `Test Loop Flow ${TS}`,
    apiName,
    flowType: 'AutoLaunchedFlow',
    status: 'Draft',
    variables: [
      { name: 'AccountId', dataType: 'String', isInput: true, isOutput: false, isCollection: false },
      { name: 'Contacts', dataType: 'SObject', objectType: 'Contact', isInput: false, isOutput: false, isCollection: true },
      { name: 'CurrentContact', dataType: 'SObject', objectType: 'Contact', isInput: false, isOutput: false, isCollection: false },
      { name: 'OutputNames', dataType: 'String', isInput: false, isOutput: true, isCollection: false },
    ],
    elements: [
      {
        type: 'GetRecords',
        name: 'Get_Contacts',
        label: 'Get Contacts',
        objectApiName: 'Contact',
        filterField: 'AccountId',
        filterOperator: 'EqualTo',
        filterValueRef: 'AccountId',
        outputVariable: 'Contacts',
        getFirstRecordOnly: false,
        queriedFields: ['Id', 'Name'],
        nextElement: 'Loop_Contacts',
      },
      {
        type: 'Loop',
        name: 'Loop_Contacts',
        label: 'Loop Contacts',
        loopVariable: 'Contacts',
        loopIterationVariable: 'CurrentContact',
        loopNextElement: 'Concat_Name',
        nextElement: 'Assign_Done',
      },
      {
        type: 'Assignment',
        name: 'Concat_Name',
        label: 'Concat Name',
        assignments: [{ assignToRef: 'OutputNames', operator: 'Add', valueRef: 'CurrentContact.Name' }],
        nextElement: 'Loop_Contacts',
      },
      {
        type: 'Assignment',
        name: 'Assign_Done',
        label: 'Assign Done',
        assignments: [{ assignToRef: 'OutputNames', operator: 'Add', value: ' [done]' }],
      },
    ],
  });
  if (!result.success) { fail('TEST4: create', result.message); return; }
  const actResult = await activateFlow(auth, { flowApiName: apiName });
  if (!actResult.success) { fail('TEST4: activate', actResult.message); return; }
  pass('TEST4: Loop element');
  return apiName;
}

// ─── TEST 5: Decision element ─────────────────────────────────────────────────
async function test5(auth) {
  log('\n═══════════ TEST 5: Decision element ═══════════');
  const apiName = `Test_Decision_Flow_${TS}`;
  const result = await createFlowViaZip(auth, {
    label: `Test Decision Flow ${TS}`,
    apiName,
    flowType: 'AutoLaunchedFlow',
    status: 'Draft',
    variables: [
      { name: 'InputVar', dataType: 'String', isInput: true, isOutput: false, isCollection: false },
      { name: 'OutputVar', dataType: 'String', isInput: false, isOutput: true, isCollection: false },
    ],
    elements: [
      {
        type: 'Decision',
        name: 'Check_Input',
        label: 'Check Input',
        conditions: [
          { leftValueRef: 'InputVar', operator: 'IsNull', rightValue: 'true', label: 'Is Null', nextElement: 'Assign_Null' },
        ],
        defaultConnector: 'Assign_Not_Null',
        nextElement: null,
      },
      {
        type: 'Assignment',
        name: 'Assign_Null',
        label: 'Assign Null',
        assignments: [{ assignToRef: 'OutputVar', operator: 'Assign', value: 'Input was null' }],
      },
      {
        type: 'Assignment',
        name: 'Assign_Not_Null',
        label: 'Assign Not Null',
        assignments: [{ assignToRef: 'OutputVar', operator: 'Assign', valueRef: 'InputVar' }],
      },
    ],
  });
  if (!result.success) { fail('TEST5: create', result.message); return; }
  const actResult = await activateFlow(auth, { flowApiName: apiName });
  if (!actResult.success) { fail('TEST5: activate', actResult.message); return; }
  pass('TEST5: Decision element');
  return apiName;
}

// ─── Tests 7-11 use sf_create_flow_from_xml (zip deploy) ─────────────────────

function buildFlowXmlForDeploy(params) {
  const NS = 'http://soap.sforce.com/2006/04/metadata';
  const vars = (params.variables ?? []).map(v => `
    <variables>
      <name>${v.name}</name>
      <dataType>${v.dataType}</dataType>
      ${v.objectType ? `<objectType>${v.objectType}</objectType>` : ''}
      <isCollection>${v.isCollection}</isCollection>
      <isInput>${v.isInput}</isInput>
      <isOutput>${v.isOutput}</isOutput>
    </variables>`).join('\n');

  const elements = params.elements ?? [];
  let body = '';
  for (const el of elements) {
    const conn = el.nextElement ? `<connector><targetReference>${el.nextElement}</targetReference></connector>` : '';
    if (el.type === 'Assignment') {
      const items = (el.assignments ?? []).map(a => `
        <assignmentItems>
          <assignToReference>${a.assignToRef}</assignToReference>
          <operator>${a.operator}</operator>
          <value>${a.valueRef ? `<elementReference>${a.valueRef}</elementReference>` : `<stringValue>${a.value ?? ''}</stringValue>`}</value>
        </assignmentItems>`).join('');
      body += `
    <assignments>
      <name>${el.name}</name>
      <label>${el.label}</label>
      <locationX>50</locationX><locationY>180</locationY>
      ${items}
      ${conn}
    </assignments>`;
    } else if (el.type === 'GetRecords') {
      const allFilters = [];
      if (el.filterField) allFilters.push({ field: el.filterField, operator: el.filterOperator ?? 'EqualTo', value: el.filterValue, valueRef: el.filterValueRef });
      for (const f of (el.filters ?? [])) allFilters.push(f);
      const filtersXml = allFilters.map(f => `
        <filters>
          <field>${f.field}</field>
          <operator>${f.operator}</operator>
          <value>${f.valueRef ? `<elementReference>${f.valueRef}</elementReference>` : `<stringValue>${f.value ?? ''}</stringValue>`}</value>
        </filters>`).join('');
      const queriedFields = ['Id', ...(el.queriedFields ?? [])].filter((v, i, a) => a.indexOf(v) === i);
      const qfXml = queriedFields.map(f => `<queriedFields>${f}</queriedFields>`).join('\n        ');
      body += `
    <recordLookups>
      <name>${el.name}</name>
      <label>${el.label}</label>
      <locationX>50</locationX><locationY>180</locationY>
      <object>${el.objectApiName}</object>
      ${filtersXml}
      ${el.getFirstRecordOnly ? '<getFirstRecordOnly>true</getFirstRecordOnly>' : ''}
      ${el.limit ? `<limit>${el.limit}</limit>` : ''}
      ${el.outputVariable ? `<outputReference>${el.outputVariable}</outputReference>` : ''}
      ${qfXml}
      ${el.sortField ? `<sortField>${el.sortField}</sortField>` : ''}
      ${el.sortField && el.sortOrder ? `<sortOrder>${el.sortOrder}</sortOrder>` : ''}
      ${conn}
    </recordLookups>`;
    } else if (el.type === 'Decision') {
      const rules = (el.conditions ?? []).map((c, i) => {
        const isNullOps = new Set(['IsNull', 'IsNotNull']);
        const rv = isNullOps.has(c.operator)
          ? `<booleanValue>${c.rightValue === 'false' ? 'false' : 'true'}</booleanValue>`
          : c.rightValueRef
            ? `<elementReference>${c.rightValueRef}</elementReference>`
            : `<stringValue>${c.rightValue ?? ''}</stringValue>`;
        const rconn = c.nextElement ? `<connector><targetReference>${c.nextElement}</targetReference></connector>` : '';
        return `
        <rules>
          <name>Rule_${i + 1}</name>
          <label>${c.label ?? `Rule_${i + 1}`}</label>
          <conditionLogic>and</conditionLogic>
          <conditions>
            <leftValueReference>${c.leftValueRef}</leftValueReference>
            <operator>${c.operator}</operator>
            <rightValue>${rv}</rightValue>
          </conditions>
          ${rconn}
        </rules>`;
      }).join('');
      const defaultConn = el.defaultConnector
        ? `<defaultConnector><targetReference>${el.defaultConnector}</targetReference></defaultConnector>
        <defaultConnectorLabel>Default Outcome</defaultConnectorLabel>`
        : '';
      body += `
    <decisions>
      <name>${el.name}</name>
      <label>${el.label}</label>
      <locationX>50</locationX><locationY>180</locationY>
      ${rules}
      ${defaultConn}
    </decisions>`;
    } else if (el.type === 'Loop') {
      const nextVal = el.loopNextElement ? `<nextValueConnector><targetReference>${el.loopNextElement}</targetReference></nextValueConnector>` : '';
      const noMore = el.nextElement ? `<noMoreValuesConnector><targetReference>${el.nextElement}</targetReference></noMoreValuesConnector>` : '';
      body += `
    <loops>
      <name>${el.name}</name>
      <label>${el.label}</label>
      <locationX>50</locationX><locationY>180</locationY>
      ${el.loopIterationVariable ? `<assignNextValueToReference>${el.loopIterationVariable}</assignNextValueToReference>` : ''}
      <collectionReference>${el.loopVariable}</collectionReference>
      <iterationOrder>Asc</iterationOrder>
      ${nextVal}
      ${noMore}
    </loops>`;
    }
  }

  const firstEl = elements[0]?.name;
  const startConn = firstEl ? `<connector><targetReference>${firstEl}</targetReference></connector>` : '';

  return `<?xml version="1.0" encoding="UTF-8"?>
<Flow xmlns="${NS}">
  <apiVersion>66.0</apiVersion>
  <status>Draft</status>
  <processType>${params.flowType ?? 'AutoLaunchedFlow'}</processType>
  <label>${params.label}</label>
  <environments>Default</environments>
  ${params.description ? `<description>${params.description}</description>` : ''}
  ${vars}
  <start>
    <locationX>50</locationX>
    <locationY>0</locationY>
    ${startConn}
  </start>
  ${body}
</Flow>`;
}

// ─── TEST 7: sf_create_flow_from_xml — Multiple same-named siblings ───────────
async function test7(auth) {
  log('\n═══════════ TEST 7: sf_create_flow_from_xml — Multiple siblings ═══════════');
  const apiName = `Test_XML_Multi_${TS}`;
  const xml = buildFlowXmlForDeploy({
    label: `Test XML Multi ${TS}`,
    flowType: 'AutoLaunchedFlow',
    variables: [
      { name: 'AccountName', dataType: 'String', isInput: true, isOutput: false, isCollection: false },
      { name: 'AccountRecord', dataType: 'SObject', objectType: 'Account', isInput: false, isOutput: false, isCollection: false },
      { name: 'Contacts', dataType: 'SObject', objectType: 'Contact', isInput: false, isOutput: false, isCollection: true },
      { name: 'CurrentContact', dataType: 'SObject', objectType: 'Contact', isInput: false, isOutput: false, isCollection: false },
      { name: 'Output', dataType: 'String', isInput: false, isOutput: true, isCollection: false },
    ],
    elements: [
      { type: 'GetRecords', name: 'Get_Account', label: 'Get Account', objectApiName: 'Account', filterField: 'Name', filterOperator: 'EqualTo', filterValueRef: 'AccountName', outputVariable: 'AccountRecord', getFirstRecordOnly: true, queriedFields: ['Id', 'Name'], nextElement: 'Get_Contacts' },
      { type: 'GetRecords', name: 'Get_Contacts', label: 'Get Contacts', objectApiName: 'Contact', filterField: 'AccountId', filterOperator: 'EqualTo', filterValueRef: 'AccountRecord.Id', outputVariable: 'Contacts', getFirstRecordOnly: false, queriedFields: ['Id', 'Name'], nextElement: 'Loop_Contacts' },
      { type: 'Loop', name: 'Loop_Contacts', label: 'Loop Contacts', loopVariable: 'Contacts', loopIterationVariable: 'CurrentContact', loopNextElement: 'Concat_Name', nextElement: 'Assign_Done' },
      { type: 'Assignment', name: 'Concat_Name', label: 'Concat Name', assignments: [{ assignToRef: 'Output', operator: 'Add', valueRef: 'CurrentContact.Name' }], nextElement: 'Loop_Contacts' },
      { type: 'Assignment', name: 'Assign_Done', label: 'Assign Done', assignments: [{ assignToRef: 'Output', operator: 'Add', value: ' [done]' }] },
    ],
  });
  const result = await deployFlowXml(auth, apiName, xml);
  if (!result.success) { fail('TEST7: deploy', result.message); return; }
  pass('TEST7: sf_create_flow_from_xml multiple siblings');
  return apiName;
}

// ─── TEST 11: sf_deploy_metadata — componentsXml inline ──────────────────────
async function test11(auth) {
  log('\n═══════════ TEST 11: sf_deploy_metadata — componentsXml inline ═══════════');
  const apiName = `Test_Deploy_Inline_${TS}`;
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Flow xmlns="http://soap.sforce.com/2006/04/metadata">
  <apiVersion>66.0</apiVersion>
  <status>Draft</status>
  <processType>AutoLaunchedFlow</processType>
  <label>Test Deploy Inline ${TS}</label>
  <environments>Default</environments>
  <variables>
    <name>InputVar</name>
    <dataType>String</dataType>
    <isCollection>false</isCollection>
    <isInput>true</isInput>
    <isOutput>true</isOutput>
  </variables>
  <start>
    <locationX>50</locationX>
    <locationY>0</locationY>
  </start>
</Flow>`;
  // Test buildGenericDeployZip with componentsXml
  const base64Zip = await buildGenericDeployZip([], API_VERSION, [{ type: 'Flow', name: apiName, xml }]);
  const deployId = await deployZip(auth, base64Zip, { rollbackOnError: true });
  const result = await pollDeployStatus(auth, deployId, 10 * 60 * 1000);
  if (!result.success) { fail('TEST11: deploy', result.message); return; }
  pass('TEST11: sf_deploy_metadata componentsXml inline');
  return apiName;
}

// ─── Main runner ──────────────────────────────────────────────────────────────
async function main() {
  log('Starting flow tests against secondorg...\n');
  const auth = await getAuth();
  log(`Connected to: ${auth.instanceUrl}\n`);

  const t1 = await test1(auth);
  const t2 = await test2(auth);
  const t3 = await test3(auth);
  const t4 = await test4(auth);
  const t5 = await test5(auth);
  const t7 = await test7(auth);
  const t11 = await test11(auth);

  log(`\n${'═'.repeat(60)}`);
  log(`RESULTS: ${passed} passed, ${failed} failed`);
  if (failures.length) {
    log('\nFAILURES:');
    for (const f of failures) log(`  ❌ ${f.name}: ${f.msg.slice(0, 200)}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
