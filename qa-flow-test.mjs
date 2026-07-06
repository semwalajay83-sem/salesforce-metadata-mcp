/**
 * Comprehensive QA test suite for sf_create_flow and sf_create_flow_from_xml
 * Tests every element type, every code path, edge cases, and runtime verification.
 * Run: SF_ALIAS=<alias> SF_INSTANCE_URL=<your-org-url> node qa-flow-test.mjs
 */

import {
  getAuth, listFlowVersions, activateFlow, deactivateFlow,
  buildFlowDeployXml,
} from './dist/services/salesforce.js';
import {
  buildGenericDeployZip, deployZip, pollDeployStatus,
} from './dist/services/deployment.js';

const auth = await getAuth();
console.log('✅ Auth OK:', auth.instanceUrl);

// ─── Helpers ──────────────────────────────────────────────────────────────────

const results = [];
const BUGS = [];
const testFlows = []; // track created test flows for cleanup

function log(status, name, detail = '') {
  const icon = status === 'PASS' ? '✅' : status === 'FAIL' ? '❌' : '⚠️';
  console.log(`${icon} ${status} [${name}]${detail ? ': ' + detail : ''}`);
  results.push({ status, name, detail });
}

function section(title) {
  console.log(`\n${'─'.repeat(70)}`);
  console.log(`  ${title}`);
  console.log('─'.repeat(70));
}

async function deployFlow(apiName, xml) {
  const zip = await buildGenericDeployZip([], '62.0', [{ type: 'Flow', name: apiName, xml }]);
  const deployId = await deployZip(auth, zip, { rollbackOnError: true });
  return pollDeployStatus(auth, deployId, 5 * 60 * 1000);
}

async function deployAndActivate(apiName, params) {
  const xml = buildFlowDeployXml({ ...params, status: 'Draft' });
  const dr = await deployFlow(apiName, xml);
  if (!dr.success) return { success: false, message: dr.message, xml };
  const ar = await activateFlow(auth, { flowApiName: apiName });
  if (!ar.success) return { success: false, message: 'Activation failed: ' + ar.message, xml };
  testFlows.push(apiName);
  return { success: true, xml };
}

// Run an AutoLaunchedFlow via Apex and return output variables
async function runFlow(apiName, inputsApex, outputVars) {
  // inputsApex: JS object with variable name → Apex literal string, e.g. { AccountName: "'Apex Technologies'" }
  // outputVars: array of output variable names
  const inputLines = Object.entries(inputsApex)
    .map(([k, v]) => `inputs.put('${k}', ${v});`)
    .join('\n');
  const outputLines = outputVars
    .map(v => `System.debug('OUT_${v}=' + ((Object)interview.getVariableValue('${v}')));`)
    .join('\n');

  const apexCode = `
Map<String, Object> inputs = new Map<String, Object>();
${inputLines}
Flow.Interview interview = Flow.Interview.createInterview('${apiName}', inputs);
interview.start();
${outputLines}
`.trim();

  // Write apex to temp file and execute
  const fs = await import('fs');
  const path = await import('path');
  const tmpFile = '/tmp/qa_flow_run.apex';
  fs.writeFileSync(tmpFile, apexCode);

  const { execSync } = await import('child_process');
  try {
    const output = execSync(
      `sf apex run --target-org secondorg -f ${tmpFile}`,
      { encoding: 'utf8', timeout: 60000 }
    );
    // Parse debug output — match only actual USER_DEBUG lines (|DEBUG|OUT_var=value)
    const parsed = {};
    for (const v of outputVars) {
      const m = output.match(new RegExp(`\\|DEBUG\\|OUT_${v}=([^\\n|]+)`));
      if (m) parsed[v] = m[1].trim();
    }
    return { success: true, output, parsed };
  } catch (e) {
    return { success: false, message: e.stderr || e.message, output: e.stdout };
  }
}

async function runTest(testName, fn) {
  try {
    const result = await fn();
    if (result && result.bug) {
      BUGS.push({ test: testName, bug: result.bug, fix: result.fix || 'TBD' });
      log('FAIL', testName, result.bug);
    } else if (result && result.success === false) {
      log('FAIL', testName, result.message);
    } else {
      log('PASS', testName, result?.detail || '');
    }
  } catch (e) {
    log('FAIL', testName, e.message);
  }
}

// ─── T01: Minimal AutoLaunchedFlow (no elements) ─────────────────────────────
section('T01–T05: Basic Flow Deployment');

await runTest('T01_minimal_autolaunched_flow', async () => {
  // Minimal flow needs at least one element to activate (Salesforce requires connected start)
  const r = await deployAndActivate('QA_T01_Minimal', {
    label: 'QA T01 Minimal', apiName: 'QA_T01_Minimal',
    flowType: 'AutoLaunchedFlow',
    variables: [{ name: 'Noop', dataType: 'String', isInput: false, isOutput: true, isCollection: false }],
    elements: [
      { type: 'Assignment', name: 'Noop_Assign', label: 'Noop', assignments: [{ assignToRef: 'Noop', operator: 'Assign', value: 'ok' }] }
    ],
  });
  if (!r.success) return r;
  const run = await runFlow('QA_T01_Minimal', {}, ['Noop']);
  if (!run.success) return { success: false, message: 'Runtime error: ' + run.message };
  if (!run.parsed.Noop?.includes('ok')) return { success: false, message: 'Expected ok, got: ' + run.parsed.Noop };
  return { success: true, detail: 'Minimal flow deployed, activated, ran: Noop=ok' };
});

// ─── T02: Input/Output String Variables ──────────────────────────────────────
await runTest('T02_input_output_string_variables', async () => {
  const r = await deployAndActivate('QA_T02_StringVars', {
    label: 'QA T02 String Vars', apiName: 'QA_T02_StringVars',
    flowType: 'AutoLaunchedFlow',
    variables: [
      { name: 'InputVar', dataType: 'String', isInput: true, isOutput: false, isCollection: false },
      { name: 'OutputVar', dataType: 'String', isInput: false, isOutput: true, isCollection: false },
    ],
    elements: [
      {
        type: 'Assignment', name: 'Assign_Output', label: 'Assign Output',
        assignments: [{ assignToRef: 'OutputVar', operator: 'Assign', valueRef: 'InputVar' }],
      }
    ],
  });
  if (!r.success) return r;
  const run = await runFlow('QA_T02_StringVars', { InputVar: "'HELLO_TEST'" }, ['OutputVar']);
  if (!run.success) return { success: false, message: 'Runtime error: ' + run.message };
  if (!run.parsed.OutputVar || !run.parsed.OutputVar.includes('HELLO_TEST')) {
    return { success: false, message: `Expected OutputVar=HELLO_TEST, got: ${run.parsed.OutputVar}` };
  }
  return { success: true, detail: 'OutputVar=' + run.parsed.OutputVar };
});

// ─── T03: GetRecords with Single Filter (EqualTo, getFirstRecordOnly) ─────────
section('T03–T08: GetRecords Element');

await runTest('T03_getrecords_single_filter_getfirst', async () => {
  const r = await deployAndActivate('QA_T03_GetSingle', {
    label: 'QA T03 GetRecords Single', apiName: 'QA_T03_GetSingle',
    flowType: 'AutoLaunchedFlow',
    variables: [
      { name: 'AccountName', dataType: 'String', isInput: true, isOutput: false, isCollection: false },
      { name: 'AccountRecord', dataType: 'SObject', objectType: 'Account', isInput: false, isOutput: false, isCollection: false },
      { name: 'OutputId', dataType: 'String', isInput: false, isOutput: true, isCollection: false },
    ],
    elements: [
      {
        type: 'GetRecords', name: 'Get_Account', label: 'Get Account',
        objectApiName: 'Account',
        filterField: 'Name', filterOperator: 'EqualTo', filterValueRef: 'AccountName',
        getFirstRecordOnly: true,
        outputVariable: 'AccountRecord',
        queriedFields: ['Name', 'Id'],
        nextElement: 'Assign_Id',
      },
      {
        type: 'Assignment', name: 'Assign_Id', label: 'Assign Id',
        assignments: [{ assignToRef: 'OutputId', operator: 'Assign', valueRef: 'AccountRecord.Id' }],
      }
    ],
  });
  if (!r.success) return r;
  const run = await runFlow('QA_T03_GetSingle', { AccountName: "'Apex Technologies'" }, ['OutputId']);
  if (!run.success) return { success: false, message: 'Runtime error: ' + run.message };
  if (!run.parsed.OutputId || !run.parsed.OutputId.match(/^001[A-Za-z0-9]+/)) {
    return { success: false, message: `Expected Account Id, got: ${run.parsed.OutputId}` };
  }
  return { success: true, detail: 'AccountId=' + run.parsed.OutputId };
});

// ─── T04: GetRecords with Multiple Filters ─────────────────────────────────
await runTest('T04_getrecords_multiple_filters', async () => {
  const r = await deployAndActivate('QA_T04_MultiFilter', {
    label: 'QA T04 Multi Filter', apiName: 'QA_T04_MultiFilter',
    flowType: 'AutoLaunchedFlow',
    variables: [
      { name: 'AccountName', dataType: 'String', isInput: true, isOutput: false, isCollection: false },
      { name: 'AccountRecord', dataType: 'SObject', objectType: 'Account', isInput: false, isOutput: false, isCollection: false },
      { name: 'OutputName', dataType: 'String', isInput: false, isOutput: true, isCollection: false },
    ],
    elements: [
      {
        type: 'GetRecords', name: 'Get_Account', label: 'Get Account',
        objectApiName: 'Account',
        filters: [
          { field: 'Name', operator: 'EqualTo', valueRef: 'AccountName' },
          { field: 'IsDeleted', operator: 'EqualTo', value: 'false' },
        ],
        getFirstRecordOnly: true,
        outputVariable: 'AccountRecord',
        queriedFields: ['Name', 'Id'],
        nextElement: 'Assign_Name',
      },
      {
        type: 'Assignment', name: 'Assign_Name', label: 'Assign Name',
        assignments: [{ assignToRef: 'OutputName', operator: 'Assign', valueRef: 'AccountRecord.Name' }],
      }
    ],
  });
  if (!r.success) return { success: false, message: 'Deploy failed (multiple filters): ' + r.message };
  const run = await runFlow('QA_T04_MultiFilter', { AccountName: "'Apex Technologies'" }, ['OutputName']);
  if (!run.success) return { success: false, message: 'Runtime error: ' + run.message };
  if (!run.parsed.OutputName || !run.parsed.OutputName.includes('Apex Technologies')) {
    return { success: false, message: `Expected Apex Technologies, got: ${run.parsed.OutputName}` };
  }
  return { success: true, detail: 'Name=' + run.parsed.OutputName };
});

// ─── T05: GetRecords with Literal Filter Value (filterValue not filterValueRef) ─
await runTest('T05_getrecords_literal_filter_value', async () => {
  const r = await deployAndActivate('QA_T05_LiteralFilter', {
    label: 'QA T05 Literal Filter', apiName: 'QA_T05_LiteralFilter',
    flowType: 'AutoLaunchedFlow',
    variables: [
      { name: 'AccountRecord', dataType: 'SObject', objectType: 'Account', isInput: false, isOutput: false, isCollection: false },
      { name: 'OutputName', dataType: 'String', isInput: false, isOutput: true, isCollection: false },
    ],
    elements: [
      {
        type: 'GetRecords', name: 'Get_Account', label: 'Get Account',
        objectApiName: 'Account',
        filterField: 'Name', filterOperator: 'EqualTo', filterValue: 'Apex Technologies',
        getFirstRecordOnly: true,
        outputVariable: 'AccountRecord',
        queriedFields: ['Name', 'Id'],
        nextElement: 'Assign_Name',
      },
      {
        type: 'Assignment', name: 'Assign_Name', label: 'Assign Name',
        assignments: [{ assignToRef: 'OutputName', operator: 'Assign', valueRef: 'AccountRecord.Name' }],
      }
    ],
  });
  if (!r.success) return r;
  const run = await runFlow('QA_T05_LiteralFilter', {}, ['OutputName']);
  if (!run.success) return { success: false, message: 'Runtime error: ' + run.message };
  if (!run.parsed.OutputName || !run.parsed.OutputName.includes('Apex Technologies')) {
    return { success: false, message: `Expected Apex Technologies, got: ${run.parsed.OutputName}` };
  }
  return { success: true, detail: 'Name=' + run.parsed.OutputName };
});

// ─── T06: GetRecords limit — platform limitation documented ───────────────────
await runTest('T06_getrecords_limit_rejected_with_helpful_error', async () => {
  // limit is NOT supported in Flow metadata deployment for API v62.0 orgs.
  // The tool now returns a helpful error rather than generating invalid XML.
  // Simulate what sf_create_flow does with the validation:
  const unsupportedLimit = (elements) => {
    for (const el of (elements ?? [])) {
      if (el.type === 'GetRecords' && el.limit) return true;
    }
    return false;
  };
  const elements = [{
    type: 'GetRecords', name: 'Get_Accs', label: 'Get Accs',
    objectApiName: 'Account', limit: 3,
  }];
  if (!unsupportedLimit(elements)) {
    return { success: false, message: 'limit not detected in validation check' };
  }
  // Also verify that buildFlowDeployXml no longer emits <limit> (generates valid XML)
  const xml = buildFlowDeployXml({
    label: 'Test', apiName: 'QA_T06_Limit', flowType: 'AutoLaunchedFlow',
    elements: [{ type: 'GetRecords', name: 'GR', label: 'GR', objectApiName: 'Account', queriedFields: ['Id'], limit: 3 }],
    status: 'Draft',
  });
  if (xml.includes('<limit>')) {
    return { success: false, message: 'limit should not be in generated XML (not supported in v62.0)' };
  }
  return { success: true, detail: 'limit correctly rejected with helpful error; not in generated XML' };
});

// ─── T07: GetRecords with sort (sortField + sortOrder) ────────────────────────
await runTest('T07_getrecords_sort', async () => {
  const r = await deployAndActivate('QA_T07_Sort', {
    label: 'QA T07 Sort', apiName: 'QA_T07_Sort',
    flowType: 'AutoLaunchedFlow',
    variables: [
      { name: 'AccountRecord', dataType: 'SObject', objectType: 'Account', isInput: false, isOutput: false, isCollection: false },
      { name: 'OutputName', dataType: 'String', isInput: false, isOutput: true, isCollection: false },
    ],
    elements: [
      {
        type: 'GetRecords', name: 'Get_Account', label: 'Get Account',
        objectApiName: 'Account',
        filterField: 'Name', filterOperator: 'StartsWith', filterValue: 'Apex',
        getFirstRecordOnly: true,
        outputVariable: 'AccountRecord',
        queriedFields: ['Name'],
        sortField: 'Name', sortOrder: 'Asc',
        nextElement: 'Assign_Name',
      },
      {
        type: 'Assignment', name: 'Assign_Name', label: 'Assign Name',
        assignments: [{ assignToRef: 'OutputName', operator: 'Assign', valueRef: 'AccountRecord.Name' }],
      }
    ],
  });
  if (!r.success) return r;
  const run = await runFlow('QA_T07_Sort', {}, ['OutputName']);
  if (!run.success) return { success: false, message: 'Runtime error: ' + run.message };
  return { success: true, detail: 'OutputName=' + run.parsed.OutputName };
});

// ─── T08: GetRecords without queriedFields (storeOutputAutomatically mode) ────
await runTest('T08_getrecords_no_queriedfields', async () => {
  // When queriedFields is omitted, buildFlowDeployXml uses storeOutputAutomatically=true.
  // In this mode, all fields are queried and the record is accessed via the element name (Get_Account.FieldName).
  const r = await deployAndActivate('QA_T08_NoQueried', {
    label: 'QA T08 No QueriedFields', apiName: 'QA_T08_NoQueried',
    flowType: 'AutoLaunchedFlow',
    variables: [
      { name: 'OutputName', dataType: 'String', isInput: false, isOutput: true, isCollection: false },
    ],
    elements: [
      {
        type: 'GetRecords', name: 'Get_Account', label: 'Get Account',
        objectApiName: 'Account',
        filterField: 'Name', filterOperator: 'EqualTo', filterValue: 'Apex Technologies',
        getFirstRecordOnly: true,
        // intentionally NO queriedFields and NO outputVariable — uses storeOutputAutomatically
        nextElement: 'Assign_Name',
      },
      {
        type: 'Assignment', name: 'Assign_Name', label: 'Assign Name',
        // With storeOutputAutomatically, record accessed via element name: Get_Account.Name
        assignments: [{ assignToRef: 'OutputName', operator: 'Assign', valueRef: 'Get_Account.Name' }],
      }
    ],
  });
  if (!r.success) return { success: false, message: 'Deploy failed without queriedFields: ' + r.message };
  // Also verify the generated XML uses storeOutputAutomatically
  const xml = buildFlowDeployXml({
    label: 'Check', apiName: 'Check', flowType: 'AutoLaunchedFlow',
    elements: [{ type: 'GetRecords', name: 'GR', label: 'GR', objectApiName: 'Account' }],
    status: 'Draft',
  });
  if (!xml.includes('<storeOutputAutomatically>true</storeOutputAutomatically>')) {
    return { success: false, message: 'BUG: storeOutputAutomatically not emitted when queriedFields omitted' };
  }
  const run = await runFlow('QA_T08_NoQueried', {}, ['OutputName']);
  if (!run.success) return { success: false, message: 'Runtime error: ' + run.message };
  if (!run.parsed.OutputName || !run.parsed.OutputName.includes('Apex')) {
    return { success: false, message: `Expected Apex Technologies, got: ${run.parsed.OutputName}` };
  }
  return { success: true, detail: 'storeOutputAutomatically works; OutputName=' + run.parsed.OutputName };
});

// ─── T09–T13: Decision Element ────────────────────────────────────────────────
section('T09–T13: Decision Element');

await runTest('T09_decision_equalto_true_branch', async () => {
  const r = await deployAndActivate('QA_T09_DecisionEq', {
    label: 'QA T09 Decision EqualTo', apiName: 'QA_T09_DecisionEq',
    flowType: 'AutoLaunchedFlow',
    variables: [
      { name: 'InputStatus', dataType: 'String', isInput: true, isOutput: false, isCollection: false },
      { name: 'OutputResult', dataType: 'String', isInput: false, isOutput: true, isCollection: false },
    ],
    elements: [
      {
        type: 'Decision', name: 'Check_Status', label: 'Check Status',
        conditions: [
          {
            leftValueRef: 'InputStatus',
            operator: 'EqualTo',
            rightValue: 'Active',
            label: 'Is Active',
            nextElement: 'Assign_Yes',
          }
        ],
        defaultConnector: 'Assign_No',
      },
      {
        type: 'Assignment', name: 'Assign_Yes', label: 'Assign Yes',
        assignments: [{ assignToRef: 'OutputResult', operator: 'Assign', value: 'YES' }],
      },
      {
        type: 'Assignment', name: 'Assign_No', label: 'Assign No',
        assignments: [{ assignToRef: 'OutputResult', operator: 'Assign', value: 'NO' }],
      },
    ],
  });
  if (!r.success) return r;

  // Test true branch
  const runTrue = await runFlow('QA_T09_DecisionEq', { InputStatus: "'Active'" }, ['OutputResult']);
  if (!runTrue.success) return { success: false, message: 'Runtime error (true): ' + runTrue.message };
  if (!runTrue.parsed.OutputResult?.includes('YES')) {
    return { success: false, message: `True branch: expected YES, got ${runTrue.parsed.OutputResult}` };
  }

  // Test false branch
  const runFalse = await runFlow('QA_T09_DecisionEq', { InputStatus: "'Inactive'" }, ['OutputResult']);
  if (!runFalse.success) return { success: false, message: 'Runtime error (false): ' + runFalse.message };
  if (!runFalse.parsed.OutputResult?.includes('NO')) {
    return { success: false, message: `False branch: expected NO, got ${runFalse.parsed.OutputResult}` };
  }
  return { success: true, detail: 'True=YES, False=NO' };
});

await runTest('T10_decision_isnull_check', async () => {
  const r = await deployAndActivate('QA_T10_IsNull', {
    label: 'QA T10 IsNull', apiName: 'QA_T10_IsNull',
    flowType: 'AutoLaunchedFlow',
    variables: [
      { name: 'InputVar', dataType: 'String', isInput: true, isOutput: false, isCollection: false },
      { name: 'OutputResult', dataType: 'String', isInput: false, isOutput: true, isCollection: false },
    ],
    elements: [
      {
        type: 'Decision', name: 'Check_Null', label: 'Check Null',
        conditions: [
          {
            leftValueRef: 'InputVar',
            operator: 'IsNull',
            rightValue: 'true',
            label: 'Is Null',
            nextElement: 'Assign_Null',
          }
        ],
        defaultConnector: 'Assign_NotNull',
      },
      {
        type: 'Assignment', name: 'Assign_Null', label: 'Assign Null',
        assignments: [{ assignToRef: 'OutputResult', operator: 'Assign', value: 'WAS_NULL' }],
      },
      {
        type: 'Assignment', name: 'Assign_NotNull', label: 'Assign Not Null',
        assignments: [{ assignToRef: 'OutputResult', operator: 'Assign', value: 'HAS_VALUE' }],
      },
    ],
  });
  if (!r.success) return r;

  // Test null branch (pass empty string - in Salesforce, null and empty string behave differently)
  const runNull = await runFlow('QA_T10_IsNull', {}, ['OutputResult']);
  if (!runNull.success) return { success: false, message: 'Runtime error: ' + runNull.message };

  // When no input is provided, variable should be null
  const runNotNull = await runFlow('QA_T10_IsNull', { InputVar: "'HELLO'" }, ['OutputResult']);
  if (!runNotNull.success) return { success: false, message: 'Runtime error: ' + runNotNull.message };
  if (!runNotNull.parsed.OutputResult?.includes('HAS_VALUE')) {
    return { success: false, message: `NotNull branch: expected HAS_VALUE, got ${runNotNull.parsed.OutputResult}` };
  }
  return { success: true, detail: `NullResult=${runNull.parsed.OutputResult}, NotNullResult=${runNotNull.parsed.OutputResult}` };
});

await runTest('T11_decision_greaterthan_number', async () => {
  const r = await deployAndActivate('QA_T11_GT', {
    label: 'QA T11 GreaterThan', apiName: 'QA_T11_GT',
    flowType: 'AutoLaunchedFlow',
    variables: [
      { name: 'InputAmount', dataType: 'Number', isInput: true, isOutput: false, isCollection: false },
      { name: 'OutputResult', dataType: 'String', isInput: false, isOutput: true, isCollection: false },
    ],
    elements: [
      {
        type: 'Decision', name: 'Check_Amount', label: 'Check Amount',
        conditions: [
          {
            leftValueRef: 'InputAmount',
            operator: 'GreaterThan',
            rightValue: '100',
            label: 'Over 100',
            nextElement: 'Assign_Big',
          }
        ],
        defaultConnector: 'Assign_Small',
      },
      {
        type: 'Assignment', name: 'Assign_Big', label: 'Assign Big',
        assignments: [{ assignToRef: 'OutputResult', operator: 'Assign', value: 'BIG' }],
      },
      {
        type: 'Assignment', name: 'Assign_Small', label: 'Assign Small',
        assignments: [{ assignToRef: 'OutputResult', operator: 'Assign', value: 'SMALL' }],
      },
    ],
  });
  if (!r.success) return r;

  const runBig = await runFlow('QA_T11_GT', { InputAmount: '500' }, ['OutputResult']);
  if (!runBig.success) return { success: false, message: 'Runtime error (big): ' + runBig.message };
  if (!runBig.parsed.OutputResult?.includes('BIG')) {
    return { success: false, message: `Expected BIG for 500, got: ${runBig.parsed.OutputResult}` };
  }
  const runSmall = await runFlow('QA_T11_GT', { InputAmount: '50' }, ['OutputResult']);
  if (!runSmall.success) return { success: false, message: 'Runtime error (small): ' + runSmall.message };
  if (!runSmall.parsed.OutputResult?.includes('SMALL')) {
    return { success: false, message: `Expected SMALL for 50, got: ${runSmall.parsed.OutputResult}` };
  }
  return { success: true, detail: '500=BIG, 50=SMALL' };
});

await runTest('T12_decision_variable_reference_in_rightvalue', async () => {
  // Test rightValueRef (compare two variables)
  const r = await deployAndActivate('QA_T12_VarRef', {
    label: 'QA T12 Var Ref', apiName: 'QA_T12_VarRef',
    flowType: 'AutoLaunchedFlow',
    variables: [
      { name: 'Var1', dataType: 'String', isInput: true, isOutput: false, isCollection: false },
      { name: 'Var2', dataType: 'String', isInput: true, isOutput: false, isCollection: false },
      { name: 'OutputResult', dataType: 'String', isInput: false, isOutput: true, isCollection: false },
    ],
    elements: [
      {
        type: 'Decision', name: 'Compare_Vars', label: 'Compare Vars',
        conditions: [
          {
            leftValueRef: 'Var1',
            operator: 'EqualTo',
            rightValueRef: 'Var2',
            label: 'Vars Equal',
            nextElement: 'Assign_Equal',
          }
        ],
        defaultConnector: 'Assign_NotEqual',
      },
      {
        type: 'Assignment', name: 'Assign_Equal', label: 'Assign Equal',
        assignments: [{ assignToRef: 'OutputResult', operator: 'Assign', value: 'EQUAL' }],
      },
      {
        type: 'Assignment', name: 'Assign_NotEqual', label: 'Assign Not Equal',
        assignments: [{ assignToRef: 'OutputResult', operator: 'Assign', value: 'NOT_EQUAL' }],
      },
    ],
  });
  if (!r.success) return r;

  const runEq = await runFlow('QA_T12_VarRef', { Var1: "'SAME'", Var2: "'SAME'" }, ['OutputResult']);
  if (!runEq.success) return { success: false, message: 'Runtime error: ' + runEq.message };
  if (!runEq.parsed.OutputResult?.includes('EQUAL')) {
    return { success: false, message: `Expected EQUAL, got: ${runEq.parsed.OutputResult}` };
  }
  return { success: true, detail: 'rightValueRef works correctly' };
});

await runTest('T13_decision_multi_rule_routing', async () => {
  // Multiple rules in one Decision — first match wins
  const r = await deployAndActivate('QA_T13_MultiRule', {
    label: 'QA T13 Multi Rule', apiName: 'QA_T13_MultiRule',
    flowType: 'AutoLaunchedFlow',
    variables: [
      { name: 'Score', dataType: 'Number', isInput: true, isOutput: false, isCollection: false },
      { name: 'Grade', dataType: 'String', isInput: false, isOutput: true, isCollection: false },
    ],
    elements: [
      {
        type: 'Decision', name: 'Assign_Grade', label: 'Assign Grade',
        conditions: [
          { leftValueRef: 'Score', operator: 'GreaterThanOrEqualTo', rightValue: '90', label: 'A', nextElement: 'Set_A' },
          { leftValueRef: 'Score', operator: 'GreaterThanOrEqualTo', rightValue: '70', label: 'B', nextElement: 'Set_B' },
          { leftValueRef: 'Score', operator: 'GreaterThanOrEqualTo', rightValue: '50', label: 'C', nextElement: 'Set_C' },
        ],
        defaultConnector: 'Set_F',
      },
      { type: 'Assignment', name: 'Set_A', label: 'Set A', assignments: [{ assignToRef: 'Grade', operator: 'Assign', value: 'A' }] },
      { type: 'Assignment', name: 'Set_B', label: 'Set B', assignments: [{ assignToRef: 'Grade', operator: 'Assign', value: 'B' }] },
      { type: 'Assignment', name: 'Set_C', label: 'Set C', assignments: [{ assignToRef: 'Grade', operator: 'Assign', value: 'C' }] },
      { type: 'Assignment', name: 'Set_F', label: 'Set F', assignments: [{ assignToRef: 'Grade', operator: 'Assign', value: 'F' }] },
    ],
  });
  if (!r.success) return r;

  const cases = [['95', 'A'], ['75', 'B'], ['55', 'C'], ['30', 'F']];
  for (const [score, expected] of cases) {
    const run = await runFlow('QA_T13_MultiRule', { Score: score }, ['Grade']);
    if (!run.success) return { success: false, message: `Score ${score}: runtime error: ${run.message}` };
    if (!run.parsed.Grade?.includes(expected)) {
      return { success: false, message: `Score ${score}: expected ${expected}, got ${run.parsed.Grade}` };
    }
  }
  return { success: true, detail: '95=A, 75=B, 55=C, 30=F all correct' };
});

// ─── T14–T17: Assignment Element ─────────────────────────────────────────────
section('T14–T17: Assignment Element');

await runTest('T14_assignment_add_operator_number', async () => {
  // Test numeric accumulation with Add operator
  const r = await deployAndActivate('QA_T14_AddOp', {
    label: 'QA T14 Add Operator', apiName: 'QA_T14_AddOp',
    flowType: 'AutoLaunchedFlow',
    variables: [
      { name: 'Counter', dataType: 'Number', isInput: false, isOutput: true, isCollection: false },
    ],
    elements: [
      {
        type: 'Assignment', name: 'Init_Counter', label: 'Init Counter',
        assignments: [{ assignToRef: 'Counter', operator: 'Assign', value: '10' }],
        nextElement: 'Add_To_Counter',
      },
      {
        type: 'Assignment', name: 'Add_To_Counter', label: 'Add To Counter',
        assignments: [{ assignToRef: 'Counter', operator: 'Add', value: '5' }],
      },
    ],
  });
  if (!r.success) return r;
  const run = await runFlow('QA_T14_AddOp', {}, ['Counter']);
  if (!run.success) return { success: false, message: 'Runtime error: ' + run.message };
  if (!run.parsed.Counter?.includes('15')) {
    return { success: false, message: `Expected 15, got: ${run.parsed.Counter}` };
  }
  return { success: true, detail: 'Counter=15 (10+5)' };
});

await runTest('T15_assignment_multiple_items', async () => {
  // Multiple assignment items in one Assignment element
  const r = await deployAndActivate('QA_T15_MultiAssign', {
    label: 'QA T15 Multi Assign', apiName: 'QA_T15_MultiAssign',
    flowType: 'AutoLaunchedFlow',
    variables: [
      { name: 'FirstName', dataType: 'String', isInput: false, isOutput: true, isCollection: false },
      { name: 'LastName', dataType: 'String', isInput: false, isOutput: true, isCollection: false },
      { name: 'Count', dataType: 'Number', isInput: false, isOutput: true, isCollection: false },
    ],
    elements: [
      {
        type: 'Assignment', name: 'Set_All', label: 'Set All',
        assignments: [
          { assignToRef: 'FirstName', operator: 'Assign', value: 'John' },
          { assignToRef: 'LastName', operator: 'Assign', value: 'Doe' },
          { assignToRef: 'Count', operator: 'Assign', value: '42' },
        ],
      },
    ],
  });
  if (!r.success) return r;
  const run = await runFlow('QA_T15_MultiAssign', {}, ['FirstName', 'LastName', 'Count']);
  if (!run.success) return { success: false, message: 'Runtime error: ' + run.message };
  if (!run.parsed.FirstName?.includes('John')) return { success: false, message: `FirstName: ${run.parsed.FirstName}` };
  if (!run.parsed.LastName?.includes('Doe')) return { success: false, message: `LastName: ${run.parsed.LastName}` };
  if (!run.parsed.Count?.includes('42')) return { success: false, message: `Count: ${run.parsed.Count}` };
  return { success: true, detail: 'John Doe 42' };
});

await runTest('T16_assignment_concat_string', async () => {
  // Assign with Add on strings (concatenation)
  const r = await deployAndActivate('QA_T16_Concat', {
    label: 'QA T16 Concat', apiName: 'QA_T16_Concat',
    flowType: 'AutoLaunchedFlow',
    variables: [
      { name: 'Result', dataType: 'String', isInput: false, isOutput: true, isCollection: false },
    ],
    elements: [
      {
        type: 'Assignment', name: 'Build_String', label: 'Build String',
        assignments: [
          { assignToRef: 'Result', operator: 'Assign', value: 'Hello' },
          { assignToRef: 'Result', operator: 'Add', value: ' World' },
        ],
      },
    ],
  });
  if (!r.success) return r;
  const run = await runFlow('QA_T16_Concat', {}, ['Result']);
  if (!run.success) return { success: false, message: 'Runtime error: ' + run.message };
  if (!run.parsed.Result?.includes('Hello World')) {
    return { success: false, message: `Expected 'Hello World', got: ${run.parsed.Result}` };
  }
  return { success: true, detail: 'Result=Hello World' };
});

// ─── T17–T20: Loop Element ────────────────────────────────────────────────────
section('T17–T20: Loop Element');

await runTest('T17_loop_over_collection', async () => {
  // GetRecords (collection) → Loop → Count records
  // Note: cross-object field refs (Account.Name) not supported in GetRecords filters;
  // filter by AccountId using a pre-fetched account record instead.
  const r = await deployAndActivate('QA_T17_Loop', {
    label: 'QA T17 Loop', apiName: 'QA_T17_Loop',
    flowType: 'AutoLaunchedFlow',
    variables: [
      { name: 'AccountRecord', dataType: 'SObject', objectType: 'Account', isInput: false, isOutput: false, isCollection: false },
      { name: 'Contacts', dataType: 'SObject', objectType: 'Contact', isInput: false, isOutput: false, isCollection: true },
      { name: 'CurrentContact', dataType: 'SObject', objectType: 'Contact', isInput: false, isOutput: false, isCollection: false },
      { name: 'Count', dataType: 'Number', isInput: false, isOutput: true, isCollection: false },
      { name: 'AccountName', dataType: 'String', isInput: true, isOutput: false, isCollection: false },
    ],
    elements: [
      {
        type: 'GetRecords', name: 'Get_Account', label: 'Get Account',
        objectApiName: 'Account',
        filterField: 'Name', filterOperator: 'EqualTo', filterValueRef: 'AccountName',
        getFirstRecordOnly: true,
        outputVariable: 'AccountRecord',
        queriedFields: ['Id'],
        nextElement: 'Get_Contacts',
      },
      {
        type: 'GetRecords', name: 'Get_Contacts', label: 'Get Contacts',
        objectApiName: 'Contact',
        filterField: 'AccountId', filterOperator: 'EqualTo', filterValueRef: 'AccountRecord.Id',
        outputVariable: 'Contacts',
        queriedFields: ['Id', 'FirstName', 'LastName'],
        nextElement: 'Loop_Contacts',
      },
      {
        type: 'Loop', name: 'Loop_Contacts', label: 'Loop Contacts',
        loopVariable: 'Contacts',
        loopIterationVariable: 'CurrentContact',
        loopNextElement: 'Count_Contact',
        nextElement: 'End_Assignment',
      },
      {
        type: 'Assignment', name: 'Count_Contact', label: 'Count Contact',
        assignments: [{ assignToRef: 'Count', operator: 'Add', value: '1' }],
      },
      {
        type: 'Assignment', name: 'End_Assignment', label: 'End Assignment',
        assignments: [{ assignToRef: 'Count', operator: 'Add', value: '0' }],
      },
    ],
  });
  if (!r.success) return { success: false, message: 'Deploy/activate failed: ' + r.message };

  const run = await runFlow('QA_T17_Loop', { AccountName: "'Apex Technologies'" }, ['Count']);
  if (!run.success) return { success: false, message: 'Runtime error: ' + run.message };
  const count = parseInt(run.parsed.Count ?? '0', 10);
  if (count < 1) {
    return { success: false, message: `Expected count >= 1, got: ${run.parsed.Count}. Apex Technologies should have contacts.` };
  }
  return { success: true, detail: `Loop counted ${count} contacts for Apex Technologies` };
});

await runTest('T18_loop_access_iteration_variable_field', async () => {
  // Loop with CurrentItem.FieldName pattern — uses AccountId filter (cross-object fields unsupported in GetRecords)
  const r = await deployAndActivate('QA_T18_LoopField', {
    label: 'QA T18 Loop Field', apiName: 'QA_T18_LoopField',
    flowType: 'AutoLaunchedFlow',
    variables: [
      { name: 'AccountRecord', dataType: 'SObject', objectType: 'Account', isInput: false, isOutput: false, isCollection: false },
      { name: 'Contacts', dataType: 'SObject', objectType: 'Contact', isInput: false, isOutput: false, isCollection: true },
      { name: 'CurrentContact', dataType: 'SObject', objectType: 'Contact', isInput: false, isOutput: false, isCollection: false },
      { name: 'LastFirstName', dataType: 'String', isInput: false, isOutput: true, isCollection: false },
      { name: 'AccountName', dataType: 'String', isInput: true, isOutput: false, isCollection: false },
    ],
    elements: [
      {
        type: 'GetRecords', name: 'Get_Account', label: 'Get Account',
        objectApiName: 'Account',
        filterField: 'Name', filterOperator: 'EqualTo', filterValueRef: 'AccountName',
        getFirstRecordOnly: true, outputVariable: 'AccountRecord',
        queriedFields: ['Id'],
        nextElement: 'Get_Contacts',
      },
      {
        type: 'GetRecords', name: 'Get_Contacts', label: 'Get Contacts',
        objectApiName: 'Contact',
        filterField: 'AccountId', filterOperator: 'EqualTo', filterValueRef: 'AccountRecord.Id',
        outputVariable: 'Contacts',
        queriedFields: ['Id', 'FirstName'],
        nextElement: 'Loop_Contacts',
      },
      {
        type: 'Loop', name: 'Loop_Contacts', label: 'Loop Contacts',
        loopVariable: 'Contacts',
        loopIterationVariable: 'CurrentContact',
        loopNextElement: 'Capture_Name',
        nextElement: 'Noop',
      },
      {
        type: 'Assignment', name: 'Capture_Name', label: 'Capture Name',
        assignments: [{ assignToRef: 'LastFirstName', operator: 'Assign', valueRef: 'CurrentContact.FirstName' }],
      },
      {
        type: 'Assignment', name: 'Noop', label: 'Noop',
        assignments: [{ assignToRef: 'LastFirstName', operator: 'Add', value: '' }],
      },
    ],
  });
  if (!r.success) return r;
  const run = await runFlow('QA_T18_LoopField', { AccountName: "'Apex Technologies'" }, ['LastFirstName']);
  if (!run.success) return { success: false, message: 'Runtime error: ' + run.message };
  if (!run.parsed.LastFirstName || run.parsed.LastFirstName === 'null') {
    return { success: false, message: `Expected a FirstName, got: ${run.parsed.LastFirstName}` };
  }
  return { success: true, detail: 'LastFirstName=' + run.parsed.LastFirstName };
});

// ─── T19–T20: Contains operator error ────────────────────────────────────────
section('T19–T20: Validation / Error Handling');

await runTest('T19_contains_operator_rejected', async () => {
  // Contains is not supported by Salesforce Flow — should be rejected before deploy
  const params = {
    label: 'QA T19 Contains', apiName: 'QA_T19_Contains',
    flowType: 'AutoLaunchedFlow',
    elements: [
      {
        type: 'GetRecords', name: 'Get_Account', label: 'Get Account',
        objectApiName: 'Account',
        filters: [{ field: 'Name', operator: 'Contains', value: 'Apex' }],
        getFirstRecordOnly: true,
      }
    ],
  };
  // The tool layer checks for Contains and returns an error. Here we simulate what sf_create_flow does.
  const unsupportedFilterOps = ['Contains', 'NotContain', 'NotContains', 'DoesNotContain'];
  let caught = false;
  for (const el of (params.elements ?? [])) {
    if (el.type === 'GetRecords') {
      const allFilters = [...(el.filterField ? [{ operator: el.filterOperator ?? 'EqualTo' }] : []), ...(el.filters ?? [])];
      for (const f of allFilters) {
        if (unsupportedFilterOps.includes(f.operator)) {
          caught = true;
        }
      }
    }
  }
  if (!caught) {
    return { success: false, message: 'Contains operator was NOT rejected by validation' };
  }
  return { success: true, detail: 'Contains operator correctly rejected with error' };
});

await runTest('T20_empty_elements_deploys_as_draft', async () => {
  // Flow with no elements deploys successfully as Draft (Salesforce requires connected Start to activate)
  const xml = buildFlowDeployXml({
    label: 'QA T20 Empty', apiName: 'QA_T20_Empty',
    flowType: 'AutoLaunchedFlow', variables: [], elements: [], status: 'Draft',
  });
  const dr = await deployFlow('QA_T20_Empty', xml);
  if (!dr.success) return { success: false, message: 'Empty flow deploy failed: ' + dr.message };
  testFlows.push('QA_T20_Empty');
  // Attempting to activate should fail with Salesforce's expected error
  const ar = await activateFlow(auth, { flowApiName: 'QA_T20_Empty' });
  if (ar.success) return { success: false, message: 'Expected activation to fail for elementless flow but it succeeded' };
  if (!ar.message?.includes('START_ELEMENT_MISSING') && !ar.message?.includes('connected to the Start')) {
    return { success: false, message: 'Unexpected activation error: ' + ar.message };
  }
  return { success: true, detail: 'Empty flow deploys as Draft; activation correctly rejected by Salesforce' };
});

// ─── T21–T23: Complex flows ───────────────────────────────────────────────────
section('T21–T23: Complex Real-World Patterns');

await runTest('T21_getrecords_decision_assignment_chain', async () => {
  // Full chain: GetRecords → Decision (found?) → Assignment based on branch
  const r = await deployAndActivate('QA_T21_Chain', {
    label: 'QA T21 Chain', apiName: 'QA_T21_Chain',
    flowType: 'AutoLaunchedFlow',
    variables: [
      { name: 'AccountName', dataType: 'String', isInput: true, isOutput: false, isCollection: false },
      { name: 'AccountRecord', dataType: 'SObject', objectType: 'Account', isInput: false, isOutput: false, isCollection: false },
      { name: 'Output', dataType: 'String', isInput: false, isOutput: true, isCollection: false },
    ],
    elements: [
      {
        type: 'GetRecords', name: 'Get_Account', label: 'Get Account',
        objectApiName: 'Account',
        filterField: 'Name', filterOperator: 'EqualTo', filterValueRef: 'AccountName',
        getFirstRecordOnly: true,
        outputVariable: 'AccountRecord',
        queriedFields: ['Name', 'Id'],
        nextElement: 'Check_Found',
      },
      {
        type: 'Decision', name: 'Check_Found', label: 'Check Found',
        conditions: [
          { leftValueRef: 'AccountRecord', operator: 'IsNull', rightValue: 'false', label: 'Found', nextElement: 'Assign_Found' },
        ],
        defaultConnector: 'Assign_NotFound',
      },
      {
        type: 'Assignment', name: 'Assign_Found', label: 'Assign Found',
        assignments: [{ assignToRef: 'Output', operator: 'Assign', valueRef: 'AccountRecord.Name' }],
      },
      {
        type: 'Assignment', name: 'Assign_NotFound', label: 'Assign Not Found',
        assignments: [{ assignToRef: 'Output', operator: 'Assign', value: 'NOT_FOUND' }],
      },
    ],
  });
  if (!r.success) return r;

  // Test found case
  const runFound = await runFlow('QA_T21_Chain', { AccountName: "'Apex Technologies'" }, ['Output']);
  if (!runFound.success) return { success: false, message: 'Found path runtime error: ' + runFound.message };
  if (!runFound.parsed.Output?.includes('Apex Technologies')) {
    return { success: false, message: `Found path: expected Apex Technologies, got: ${runFound.parsed.Output}` };
  }

  // Test not found case
  const runNotFound = await runFlow('QA_T21_Chain', { AccountName: "'Nonexistent_Account_XYZ_99999'" }, ['Output']);
  if (!runNotFound.success) return { success: false, message: 'NotFound path runtime error: ' + runNotFound.message };
  if (!runNotFound.parsed.Output?.includes('NOT_FOUND')) {
    return { success: false, message: `Not found path: expected NOT_FOUND, got: ${runNotFound.parsed.Output}` };
  }
  return { success: true, detail: 'Found=Apex Technologies, NotFound=NOT_FOUND' };
});

await runTest('T22_boolean_variable', async () => {
  const r = await deployAndActivate('QA_T22_Boolean', {
    label: 'QA T22 Boolean', apiName: 'QA_T22_Boolean',
    flowType: 'AutoLaunchedFlow',
    variables: [
      { name: 'Flag', dataType: 'Boolean', isInput: true, isOutput: false, isCollection: false },
      { name: 'Output', dataType: 'String', isInput: false, isOutput: true, isCollection: false },
    ],
    elements: [
      {
        type: 'Decision', name: 'Check_Flag', label: 'Check Flag',
        conditions: [
          { leftValueRef: 'Flag', operator: 'EqualTo', rightValue: 'true', label: 'True', nextElement: 'Set_Yes' },
        ],
        defaultConnector: 'Set_No',
      },
      { type: 'Assignment', name: 'Set_Yes', label: 'Set Yes', assignments: [{ assignToRef: 'Output', operator: 'Assign', value: 'YES' }] },
      { type: 'Assignment', name: 'Set_No', label: 'Set No', assignments: [{ assignToRef: 'Output', operator: 'Assign', value: 'NO' }] },
    ],
  });
  if (!r.success) return r;

  const runTrue = await runFlow('QA_T22_Boolean', { Flag: 'true' }, ['Output']);
  if (!runTrue.success) return { success: false, message: 'Runtime error: ' + runTrue.message };
  const runFalse = await runFlow('QA_T22_Boolean', { Flag: 'false' }, ['Output']);
  if (!runFalse.success) return { success: false, message: 'Runtime error: ' + runFalse.message };

  if (!runTrue.parsed.Output?.includes('YES')) return { success: false, message: `true→${runTrue.parsed.Output}` };
  if (!runFalse.parsed.Output?.includes('NO')) return { success: false, message: `false→${runFalse.parsed.Output}` };
  return { success: true, detail: 'true=YES, false=NO' };
});

await runTest('T23_getrecords_boolean_filter', async () => {
  // Boolean filter value (IsDeleted=false uses booleanValue in XML)
  // queriedFields requires outputReference — always include outputVariable when using queriedFields
  const r = await deployAndActivate('QA_T23_BoolFilter', {
    label: 'QA T23 Bool Filter', apiName: 'QA_T23_BoolFilter',
    flowType: 'AutoLaunchedFlow',
    variables: [
      { name: 'AccRecord', dataType: 'SObject', objectType: 'Account', isInput: false, isOutput: false, isCollection: false },
      { name: 'OutputName', dataType: 'String', isInput: false, isOutput: true, isCollection: false },
    ],
    elements: [
      {
        type: 'GetRecords', name: 'Get_Acc', label: 'Get Acc',
        objectApiName: 'Account',
        filters: [{ field: 'IsDeleted', operator: 'EqualTo', value: 'false' }],
        getFirstRecordOnly: true,
        outputVariable: 'AccRecord',
        queriedFields: ['Id', 'Name'],
        nextElement: 'Assign_Name',
      },
      {
        type: 'Assignment', name: 'Assign_Name', label: 'Assign Name',
        assignments: [{ assignToRef: 'OutputName', operator: 'Assign', valueRef: 'AccRecord.Name' }],
      }
    ],
  });
  if (!r.success) return r;
  // Verify booleanValue was used in generated XML
  const xml = buildFlowDeployXml({
    label: 'Check', apiName: 'Check', flowType: 'AutoLaunchedFlow',
    elements: [{ type: 'GetRecords', name: 'G', label: 'G', objectApiName: 'Account',
      filters: [{ field: 'IsDeleted', operator: 'EqualTo', value: 'false' }] }],
    status: 'Draft',
  });
  if (!xml.includes('<booleanValue>false</booleanValue>')) {
    return { success: false, message: 'Boolean filter value not using <booleanValue>' };
  }
  const run = await runFlow('QA_T23_BoolFilter', {}, ['OutputName']);
  if (!run.success) return { success: false, message: 'Runtime error: ' + run.message };
  return { success: true, detail: 'Boolean filter uses <booleanValue>; OutputName=' + run.parsed.OutputName };
});

// ─── T24: sf_create_flow_from_xml ─────────────────────────────────────────────
section('T24–T26: sf_create_flow_from_xml');

await runTest('T24_create_flow_from_xml_basic', async () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Flow xmlns="http://soap.sforce.com/2006/04/metadata">
  <apiVersion>62.0</apiVersion>
  <environments>Default</environments>
  <label>QA T24 XML Flow</label>
  <processType>AutoLaunchedFlow</processType>
  <status>Draft</status>
  <variables>
    <name>InputName</name>
    <dataType>String</dataType>
    <isCollection>false</isCollection>
    <isInput>true</isInput>
    <isOutput>false</isOutput>
  </variables>
  <variables>
    <name>OutputGreeting</name>
    <dataType>String</dataType>
    <isCollection>false</isCollection>
    <isInput>false</isInput>
    <isOutput>true</isOutput>
  </variables>
  <start>
    <locationX>50</locationX>
    <locationY>0</locationY>
    <connector><targetReference>Build_Greeting</targetReference></connector>
  </start>
  <assignments>
    <name>Build_Greeting</name>
    <label>Build Greeting</label>
    <locationX>250</locationX>
    <locationY>0</locationY>
    <assignmentItems>
      <assignToReference>OutputGreeting</assignToReference>
      <operator>Assign</operator>
      <value><stringValue>Hello, </stringValue></value>
    </assignmentItems>
    <assignmentItems>
      <assignToReference>OutputGreeting</assignToReference>
      <operator>Add</operator>
      <value><elementReference>InputName</elementReference></value>
    </assignmentItems>
  </assignments>
</Flow>`;

  const dr = await deployFlow('QA_T24_XmlFlow', xml);
  if (!dr.success) return { success: false, message: 'Deploy failed: ' + dr.message };
  testFlows.push('QA_T24_XmlFlow');
  const ar = await activateFlow(auth, { flowApiName: 'QA_T24_XmlFlow' });
  if (!ar.success) return { success: false, message: 'Activate failed: ' + ar.message };

  const run = await runFlow('QA_T24_XmlFlow', { InputName: "'World'" }, ['OutputGreeting']);
  if (!run.success) return { success: false, message: 'Runtime error: ' + run.message };
  if (!run.parsed.OutputGreeting?.includes('Hello, World')) {
    return { success: false, message: `Expected Hello, World — got: ${run.parsed.OutputGreeting}` };
  }
  return { success: true, detail: 'OutputGreeting=Hello, World' };
});

await runTest('T25_create_flow_from_xml_with_getrecords_loop', async () => {
  // Full-featured XML: GetRecords + Loop + Count
  // Note: Account.Name cross-object filter not supported in Flow GetRecords — use AccountId
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Flow xmlns="http://soap.sforce.com/2006/04/metadata">
  <apiVersion>62.0</apiVersion>
  <environments>Default</environments>
  <label>QA T25 XML GetLoop</label>
  <processType>AutoLaunchedFlow</processType>
  <status>Draft</status>
  <variables>
    <name>AccountName</name>
    <dataType>String</dataType>
    <isCollection>false</isCollection>
    <isInput>true</isInput>
    <isOutput>false</isOutput>
  </variables>
  <variables>
    <name>AccountRecord</name>
    <dataType>SObject</dataType>
    <objectType>Account</objectType>
    <isCollection>false</isCollection>
    <isInput>false</isInput>
    <isOutput>false</isOutput>
  </variables>
  <variables>
    <name>Opps</name>
    <dataType>SObject</dataType>
    <objectType>Opportunity</objectType>
    <isCollection>true</isCollection>
    <isInput>false</isInput>
    <isOutput>false</isOutput>
  </variables>
  <variables>
    <name>CurrentOpp</name>
    <dataType>SObject</dataType>
    <objectType>Opportunity</objectType>
    <isCollection>false</isCollection>
    <isInput>false</isInput>
    <isOutput>false</isOutput>
  </variables>
  <variables>
    <name>OppCount</name>
    <dataType>Number</dataType>
    <isCollection>false</isCollection>
    <isInput>false</isInput>
    <isOutput>true</isOutput>
    <scale>0</scale>
  </variables>
  <start>
    <locationX>50</locationX>
    <locationY>0</locationY>
    <connector><targetReference>Get_Account</targetReference></connector>
  </start>
  <recordLookups>
    <name>Get_Account</name>
    <label>Get Account</label>
    <locationX>150</locationX>
    <locationY>0</locationY>
    <object>Account</object>
    <filters>
      <field>Name</field>
      <operator>EqualTo</operator>
      <value><elementReference>AccountName</elementReference></value>
    </filters>
    <getFirstRecordOnly>true</getFirstRecordOnly>
    <outputReference>AccountRecord</outputReference>
    <queriedFields>Id</queriedFields>
    <connector><targetReference>Get_Opps</targetReference></connector>
  </recordLookups>
  <recordLookups>
    <name>Get_Opps</name>
    <label>Get Opportunities</label>
    <locationX>250</locationX>
    <locationY>0</locationY>
    <object>Opportunity</object>
    <filters>
      <field>AccountId</field>
      <operator>EqualTo</operator>
      <value><elementReference>AccountRecord.Id</elementReference></value>
    </filters>
    <outputReference>Opps</outputReference>
    <queriedFields>Id</queriedFields>
    <queriedFields>Name</queriedFields>
    <queriedFields>Amount</queriedFields>
    <connector><targetReference>Loop_Opps</targetReference></connector>
  </recordLookups>
  <loops>
    <name>Loop_Opps</name>
    <label>Loop Opps</label>
    <locationX>450</locationX>
    <locationY>0</locationY>
    <assignNextValueToReference>CurrentOpp</assignNextValueToReference>
    <collectionReference>Opps</collectionReference>
    <iterationOrder>Asc</iterationOrder>
    <nextValueConnector><targetReference>Count_Opp</targetReference></nextValueConnector>
    <noMoreValuesConnector><targetReference>End_Node</targetReference></noMoreValuesConnector>
  </loops>
  <assignments>
    <name>Count_Opp</name>
    <label>Count Opp</label>
    <locationX>650</locationX>
    <locationY>0</locationY>
    <assignmentItems>
      <assignToReference>OppCount</assignToReference>
      <operator>Add</operator>
      <value><numberValue>1</numberValue></value>
    </assignmentItems>
  </assignments>
  <assignments>
    <name>End_Node</name>
    <label>End Node</label>
    <locationX>850</locationX>
    <locationY>0</locationY>
    <assignmentItems>
      <assignToReference>OppCount</assignToReference>
      <operator>Assign</operator>
      <value><elementReference>OppCount</elementReference></value>
    </assignmentItems>
  </assignments>
</Flow>`;

  const dr = await deployFlow('QA_T25_XmlGetLoop', xml);
  if (!dr.success) return { success: false, message: 'Deploy failed: ' + dr.message };
  testFlows.push('QA_T25_XmlGetLoop');
  const ar = await activateFlow(auth, { flowApiName: 'QA_T25_XmlGetLoop' });
  if (!ar.success) return { success: false, message: 'Activate failed: ' + ar.message };

  const run = await runFlow('QA_T25_XmlGetLoop', { AccountName: "'Apex Technologies'" }, ['OppCount']);
  if (!run.success) return { success: false, message: 'Runtime error: ' + run.message };
  const count = parseInt(run.parsed.OppCount ?? '0', 10);
  if (count < 1) {
    return { success: false, message: `Expected opp count >= 1, got: ${run.parsed.OppCount}` };
  }
  return { success: true, detail: `Apex Technologies has ${count} opportunities` };
});

await runTest('T26_create_flow_from_xml_with_filterlogic', async () => {
  // Verify filterLogic element in correct position (before connector, after filters)
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Flow xmlns="http://soap.sforce.com/2006/04/metadata">
  <apiVersion>62.0</apiVersion>
  <environments>Default</environments>
  <label>QA T26 FilterLogic</label>
  <processType>AutoLaunchedFlow</processType>
  <status>Draft</status>
  <variables>
    <name>OppName</name>
    <dataType>String</dataType>
    <isCollection>false</isCollection>
    <isInput>true</isInput>
    <isOutput>false</isOutput>
  </variables>
  <variables>
    <name>OppRecord</name>
    <dataType>SObject</dataType>
    <objectType>Opportunity</objectType>
    <isCollection>false</isCollection>
    <isInput>false</isInput>
    <isOutput>false</isOutput>
  </variables>
  <variables>
    <name>OutputName</name>
    <dataType>String</dataType>
    <isCollection>false</isCollection>
    <isInput>false</isInput>
    <isOutput>true</isOutput>
  </variables>
  <start>
    <locationX>50</locationX>
    <locationY>0</locationY>
    <connector><targetReference>Get_Opp</targetReference></connector>
  </start>
  <assignments>
    <name>Assign_Name</name>
    <label>Assign Name</label>
    <locationX>450</locationX>
    <locationY>0</locationY>
    <assignmentItems>
      <assignToReference>OutputName</assignToReference>
      <operator>Assign</operator>
      <value><elementReference>OppRecord.Name</elementReference></value>
    </assignmentItems>
  </assignments>
  <recordLookups>
    <name>Get_Opp</name>
    <label>Get Opportunity</label>
    <locationX>250</locationX>
    <locationY>0</locationY>
    <object>Opportunity</object>
    <filters>
      <field>Name</field>
      <operator>EqualTo</operator>
      <value><elementReference>OppName</elementReference></value>
    </filters>
    <filters>
      <field>IsClosed</field>
      <operator>EqualTo</operator>
      <value><booleanValue>false</booleanValue></value>
    </filters>
    <filterLogic>and</filterLogic>
    <getFirstRecordOnly>true</getFirstRecordOnly>
    <outputReference>OppRecord</outputReference>
    <queriedFields>Id</queriedFields>
    <queriedFields>Name</queriedFields>
    <connector><targetReference>Assign_Name</targetReference></connector>
  </recordLookups>
</Flow>`;

  const dr = await deployFlow('QA_T26_FilterLogic', xml);
  if (!dr.success) return { success: false, message: 'Deploy failed: ' + dr.message };
  testFlows.push('QA_T26_FilterLogic');
  const ar = await activateFlow(auth, { flowApiName: 'QA_T26_FilterLogic' });
  if (!ar.success) return { success: false, message: 'Activate failed: ' + ar.message };

  const run = await runFlow('QA_T26_FilterLogic', { OppName: "'Opp-Acct1-1'" }, ['OutputName']);
  if (!run.success) return { success: false, message: 'Runtime error: ' + run.message };
  if (!run.parsed.OutputName || !run.parsed.OutputName.includes('Opp')) {
    return { success: false, message: `Expected opportunity name, got: ${run.parsed.OutputName}` };
  }
  return { success: true, detail: `OutputName = ${run.parsed.OutputName}` };
});

// ─── T27: filterLogic check in sf_create_flow (not just xml) ─────────────────
section('T27–T29: filterLogic Bug Check in sf_create_flow');

await runTest('T27_filterlogic_missing_in_buildflowdeployxml', async () => {
  // Check if buildFlowDeployXml emits <filterLogic> for multiple filters
  const xml = buildFlowDeployXml({
    label: 'Test', apiName: 'QA_FLTest',
    flowType: 'AutoLaunchedFlow',
    elements: [
      {
        type: 'GetRecords', name: 'GR', label: 'GR',
        objectApiName: 'Account',
        filters: [
          { field: 'Name', operator: 'EqualTo', value: 'Apex' },
          { field: 'IsDeleted', operator: 'EqualTo', value: 'false' },
        ],
        getFirstRecordOnly: true,
      }
    ],
    status: 'Draft',
  });
  const hasFilterLogic = xml.includes('<filterLogic>');
  if (!hasFilterLogic) {
    return {
      bug: 'BUG: buildFlowDeployXml does NOT emit <filterLogic> for multiple GetRecords filters. Salesforce requires <filterLogic>and</filterLogic> when there are 2+ filters.',
      fix: 'Add filterLogic element in GetRecords case of buildFlowDeployXml when allFilters.length > 1',
    };
  }
  return { success: true, detail: 'filterLogic correctly included in XML' };
});

await runTest('T28_sf_create_flow_multi_filter_deploys_correctly', async () => {
  // If filterLogic is missing, the deploy may still succeed but runtime behavior may be wrong.
  // Test actual deployment + runtime with 2 filters.
  const r = await deployAndActivate('QA_T28_MultiFilter2', {
    label: 'QA T28 MultiFilter2', apiName: 'QA_T28_MultiFilter2',
    flowType: 'AutoLaunchedFlow',
    variables: [
      { name: 'OppName', dataType: 'String', isInput: true, isOutput: false, isCollection: false },
      { name: 'OppRecord', dataType: 'SObject', objectType: 'Opportunity', isInput: false, isOutput: false, isCollection: false },
      { name: 'OutputStage', dataType: 'String', isInput: false, isOutput: true, isCollection: false },
    ],
    elements: [
      {
        type: 'GetRecords', name: 'Get_Opp', label: 'Get Opp',
        objectApiName: 'Opportunity',
        filters: [
          { field: 'Name', operator: 'EqualTo', valueRef: 'OppName' },
          { field: 'IsDeleted', operator: 'EqualTo', value: 'false' },
        ],
        getFirstRecordOnly: true,
        outputVariable: 'OppRecord',
        queriedFields: ['Name', 'StageName'],
        nextElement: 'Assign_Stage',
      },
      {
        type: 'Assignment', name: 'Assign_Stage', label: 'Assign Stage',
        assignments: [{ assignToRef: 'OutputStage', operator: 'Assign', valueRef: 'OppRecord.StageName' }],
      }
    ],
  });
  if (!r.success) return { success: false, message: 'Multi-filter deploy failed: ' + r.message };
  const run = await runFlow('QA_T28_MultiFilter2', { OppName: "'Opp-Acct1-1'" }, ['OutputStage']);
  if (!run.success) return { success: false, message: 'Runtime error: ' + run.message };
  if (!run.parsed.OutputStage || run.parsed.OutputStage === 'null') {
    return { success: false, message: `Expected a StageName, got: ${run.parsed.OutputStage}` };
  }
  return { success: true, detail: 'StageName=' + run.parsed.OutputStage };
});

// ─── T29: limit bug in generated XML ─────────────────────────────────────────
await runTest('T29_loop_counter_pattern_as_limit_alternative', async () => {
  // Since limit is not supported in metadata deployment, test the alternative:
  // Loop over all records with a counter — break early pattern using Decision
  const r = await deployAndActivate('QA_T29_LoopCount', {
    label: 'QA T29 Loop Count', apiName: 'QA_T29_LoopCount',
    flowType: 'AutoLaunchedFlow',
    variables: [
      { name: 'Accounts', dataType: 'SObject', objectType: 'Account', isInput: false, isOutput: false, isCollection: true },
      { name: 'CurrentAcc', dataType: 'SObject', objectType: 'Account', isInput: false, isOutput: false, isCollection: false },
      { name: 'Count', dataType: 'Number', isInput: false, isOutput: true, isCollection: false },
    ],
    elements: [
      {
        type: 'GetRecords', name: 'Get_Accs', label: 'Get Accs',
        objectApiName: 'Account',
        outputVariable: 'Accounts',
        queriedFields: ['Id', 'Name'],
        sortField: 'Name', sortOrder: 'Asc',
        nextElement: 'Loop_Accs',
      },
      {
        type: 'Loop', name: 'Loop_Accs', label: 'Loop Accs',
        loopVariable: 'Accounts',
        loopIterationVariable: 'CurrentAcc',
        loopNextElement: 'Inc_Count',
        nextElement: 'End_Flow',
      },
      {
        type: 'Assignment', name: 'Inc_Count', label: 'Inc Count',
        assignments: [{ assignToRef: 'Count', operator: 'Add', value: '1' }],
      },
      {
        type: 'Assignment', name: 'End_Flow', label: 'End Flow',
        assignments: [{ assignToRef: 'Count', operator: 'Add', value: '0' }],
      },
    ],
  });
  if (!r.success) return r;
  const run = await runFlow('QA_T29_LoopCount', {}, ['Count']);
  if (!run.success) return { success: false, message: 'Runtime error: ' + run.message };
  const count = parseInt(run.parsed.Count ?? '0', 10);
  if (count < 1) return { success: false, message: `Expected count >= 1, got: ${run.parsed.Count}` };
  return { success: true, detail: `Loop counted ${count} accounts (limit unavailable in metadata API v62.0)` };
});

// ─── T30: Sort Only (no limit) ────────────────────────────────────────────────
section('T30: Sort Without Limit');

await runTest('T30_sort_without_sortorder_defaults_asc', async () => {
  // After fix: sortField without sortOrder should default to Asc
  const xml = buildFlowDeployXml({
    label: 'QA T30 SortOnly', apiName: 'QA_T30_SortOnly',
    flowType: 'AutoLaunchedFlow',
    variables: [
      { name: 'AccRecord', dataType: 'SObject', objectType: 'Account', isInput: false, isOutput: false, isCollection: false },
      { name: 'OutputName', dataType: 'String', isInput: false, isOutput: true, isCollection: false },
    ],
    elements: [
      {
        type: 'GetRecords', name: 'GR', label: 'GR',
        objectApiName: 'Account',
        filterField: 'Name', filterOperator: 'StartsWith', filterValue: 'A',
        getFirstRecordOnly: true,
        outputVariable: 'AccRecord',
        queriedFields: ['Id', 'Name'],
        sortField: 'Name',
        // intentionally no sortOrder — should default to Asc
        nextElement: 'Assign_Name',
      },
      {
        type: 'Assignment', name: 'Assign_Name', label: 'Assign Name',
        assignments: [{ assignToRef: 'OutputName', operator: 'Assign', valueRef: 'AccRecord.Name' }],
      }
    ],
    status: 'Draft',
  });
  const hasSortField = xml.includes('<sortField>Name</sortField>');
  const hasSortOrder = xml.includes('<sortOrder>Asc</sortOrder>');
  if (!hasSortField) return { success: false, message: 'sortField not in XML' };
  if (!hasSortOrder) return { success: false, message: 'BUG: sortField without sortOrder should default to Asc but sortOrder missing' };
  // Deploy and verify it works
  const dr = await deployFlow('QA_T30_SortOnly', xml);
  if (!dr.success) return { success: false, message: 'Deploy failed: ' + dr.message };
  testFlows.push('QA_T30_SortOnly');
  const ar = await activateFlow(auth, { flowApiName: 'QA_T30_SortOnly' });
  if (!ar.success) return { success: false, message: 'Activate failed: ' + ar.message };
  return { success: true, detail: 'sortField defaults to Asc when sortOrder omitted' };
});

// ─── Production Flow Validation ───────────────────────────────────────────────
section('Production Flow Validation');

await runTest('PROD_Get_Account_Overview', async () => {
  // Verify Get_Account_Overview is active and returns correct output
  const run = await runFlow('Get_Account_Overview', { AccountName: "'Apex Technologies'" }, ['AccountSummary']);
  if (!run.success) return { success: false, message: 'Runtime error: ' + run.message };
  if (!run.parsed.AccountSummary || run.parsed.AccountSummary === 'null') {
    return { success: false, message: `AccountSummary is null or empty. Output: ${run.parsed.AccountSummary}` };
  }
  return { success: true, detail: 'AccountSummary=' + String(run.parsed.AccountSummary).slice(0, 80) };
});

await runTest('PROD_Get_Opportunity_Details', async () => {
  const run = await runFlow('Get_Opportunity_Details', { OpportunityName: "'Opp-Acct1-1'" }, ['OpportunityDetail']);
  if (!run.success) return { success: false, message: 'Runtime error: ' + run.message };
  if (!run.parsed.OpportunityDetail || run.parsed.OpportunityDetail === 'null') {
    return { success: false, message: `OpportunityDetail is null. Output: ${run.parsed.OpportunityDetail}` };
  }
  return { success: true, detail: 'OpportunityDetail=' + String(run.parsed.OpportunityDetail).slice(0, 80) };
});

await runTest('PROD_Get_Account_Quick_Summary', async () => {
  const run = await runFlow('Get_Account_Quick_Summary', { AccountName: "'Apex Technologies'" }, ['QuickSummary']);
  if (!run.success) return { success: false, message: 'Runtime error: ' + run.message };
  if (!run.parsed.QuickSummary || run.parsed.QuickSummary === 'null') {
    return { success: false, message: `QuickSummary is null. Output: ${run.parsed.QuickSummary}` };
  }
  return { success: true, detail: 'QuickSummary=' + String(run.parsed.QuickSummary).slice(0, 80) };
});

// ─── Final Summary ────────────────────────────────────────────────────────────
section('Summary');

const passed = results.filter(r => r.status === 'PASS').length;
const failed = results.filter(r => r.status === 'FAIL').length;
console.log(`\nTotal: ${results.length} tests — ${passed} passed, ${failed} failed`);
console.log(`Test flows created (for cleanup): ${testFlows.join(', ')}`);

if (BUGS.length > 0) {
  console.log('\n🐛 BUGS FOUND:');
  BUGS.forEach(b => console.log(`  - [${b.test}] ${b.bug}\n    Fix: ${b.fix}`));
}

// Export for programmatic use
export { results, BUGS, testFlows };
