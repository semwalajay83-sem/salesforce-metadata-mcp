/**
 * Tests 6, 8, 9, 10 — complex flows via sf_create_flow and sf_create_flow_from_xml
 * Tests 12, 13 — Agentforce agent/topic creation
 */

import JSZip from './node_modules/jszip/dist/jszip.min.js';
import { getAuth, activateFlow, buildFlowDeployXml, x as xmlEscape, API_VERSION } from './dist/services/salesforce.js';
import { buildGenericDeployZip, deployZip, pollDeployStatus } from './dist/services/deployment.js';

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

let passed = 0, failed = 0;
const failures = [];

function log(msg) { console.log(msg); }
function pass(name) { passed++; log(`  ✅ PASS  ${name}`); }
function fail(name, err) {
  failed++;
  const msg = typeof err === 'string' ? err : (err?.message ?? String(err));
  failures.push({ name, msg });
  log(`  ❌ FAIL  ${name}  →  ${msg.slice(0, 400)}`);
}

async function deployAndActivate(auth, flowApiName, flowXml) {
  const base64Zip = await buildGenericDeployZip([], '62.0', [{ type: 'Flow', name: flowApiName, xml: flowXml }]);
  const deployId = await deployZip(auth, base64Zip, { rollbackOnError: true });
  log(`  Deploying ${flowApiName} (id: ${deployId})...`);
  const result = await pollDeployStatus(auth, deployId, 10 * 60 * 1000);
  if (!result.success) return result;
  return activateFlow(auth, { flowApiName });
}

// ─── TEST 6: Full complex Account Overview (via buildFlowDeployXml) ────────────
async function test6(auth) {
  log('\n═══════════ TEST 6: Full complex Account Overview (sf_create_flow via zip deploy) ═══════════');
  const apiName = 'Get_Account_Overview';
  const flowXml = buildFlowDeployXml({
    label: 'Get Account Overview',
    apiName,
    description: 'Returns account overview including opportunities, cases, and contacts',
    flowType: 'AutoLaunchedFlow',
    status: 'Draft',
    variables: [
      { name: 'AccountName', dataType: 'String', isInput: true, isOutput: false, isCollection: false },
      { name: 'AccountSummary', dataType: 'String', isInput: false, isOutput: true, isCollection: false },
      { name: 'AccountRecord', dataType: 'SObject', objectType: 'Account', isInput: false, isOutput: false, isCollection: false },
      { name: 'Opportunities', dataType: 'SObject', objectType: 'Opportunity', isInput: false, isOutput: false, isCollection: true },
      { name: 'Cases', dataType: 'SObject', objectType: 'Case', isInput: false, isOutput: false, isCollection: true },
      { name: 'Contacts', dataType: 'SObject', objectType: 'Contact', isInput: false, isOutput: false, isCollection: true },
      { name: 'CurrentOpp', dataType: 'SObject', objectType: 'Opportunity', isInput: false, isOutput: false, isCollection: false },
      { name: 'CurrentCase', dataType: 'SObject', objectType: 'Case', isInput: false, isOutput: false, isCollection: false },
      { name: 'CurrentContact', dataType: 'SObject', objectType: 'Contact', isInput: false, isOutput: false, isCollection: false },
    ],
    elements: [
      { type: 'GetRecords', name: 'Get_Account', label: 'Get Account', objectApiName: 'Account', filterField: 'Name', filterOperator: 'EqualTo', filterValueRef: 'AccountName', outputVariable: 'AccountRecord', getFirstRecordOnly: true, queriedFields: ['Id', 'Name', 'Industry', 'AnnualRevenue'], nextElement: 'Decision_Account_Found' },
      { type: 'Decision', name: 'Decision_Account_Found', label: 'Account Found?', conditions: [{ leftValueRef: 'AccountRecord.Id', operator: 'IsNull', rightValue: 'false', label: 'Found', nextElement: 'Get_Opportunities' }], defaultConnector: 'Assign_Not_Found' },
      { type: 'Assignment', name: 'Assign_Not_Found', label: 'Assign Not Found', assignments: [{ assignToRef: 'AccountSummary', operator: 'Assign', value: 'Account not found.' }] },
      { type: 'GetRecords', name: 'Get_Opportunities', label: 'Get Opportunities', objectApiName: 'Opportunity', filterField: 'AccountId', filterOperator: 'EqualTo', filterValueRef: 'AccountRecord.Id', outputVariable: 'Opportunities', getFirstRecordOnly: false, queriedFields: ['Id', 'Name', 'StageName', 'Amount'], nextElement: 'Get_Cases' },
      { type: 'GetRecords', name: 'Get_Cases', label: 'Get Cases', objectApiName: 'Case', filterField: 'AccountId', filterOperator: 'EqualTo', filterValueRef: 'AccountRecord.Id', outputVariable: 'Cases', getFirstRecordOnly: false, queriedFields: ['Id', 'Subject', 'Status', 'Priority'], nextElement: 'Get_Contacts' },
      { type: 'GetRecords', name: 'Get_Contacts', label: 'Get Contacts', objectApiName: 'Contact', filterField: 'AccountId', filterOperator: 'EqualTo', filterValueRef: 'AccountRecord.Id', outputVariable: 'Contacts', getFirstRecordOnly: false, queriedFields: ['Id', 'Name', 'Title', 'Email'], nextElement: 'Assign_Header' },
      { type: 'Assignment', name: 'Assign_Header', label: 'Assign Header', assignments: [{ assignToRef: 'AccountSummary', operator: 'Assign', valueRef: 'AccountRecord.Name' }], nextElement: 'Loop_Opportunities' },
      { type: 'Loop', name: 'Loop_Opportunities', label: 'Loop Opportunities', loopVariable: 'Opportunities', loopIterationVariable: 'CurrentOpp', loopNextElement: 'Concat_Opp', nextElement: 'Loop_Cases' },
      { type: 'Assignment', name: 'Concat_Opp', label: 'Concat Opp', assignments: [{ assignToRef: 'AccountSummary', operator: 'Add', valueRef: 'CurrentOpp.Name' }], nextElement: 'Loop_Opportunities' },
      { type: 'Loop', name: 'Loop_Cases', label: 'Loop Cases', loopVariable: 'Cases', loopIterationVariable: 'CurrentCase', loopNextElement: 'Concat_Case', nextElement: 'Loop_Contacts' },
      { type: 'Assignment', name: 'Concat_Case', label: 'Concat Case', assignments: [{ assignToRef: 'AccountSummary', operator: 'Add', valueRef: 'CurrentCase.Subject' }], nextElement: 'Loop_Cases' },
      { type: 'Loop', name: 'Loop_Contacts', label: 'Loop Contacts', loopVariable: 'Contacts', loopIterationVariable: 'CurrentContact', loopNextElement: 'Concat_Contact', nextElement: null },
      { type: 'Assignment', name: 'Concat_Contact', label: 'Concat Contact', assignments: [{ assignToRef: 'AccountSummary', operator: 'Add', valueRef: 'CurrentContact.Name' }], nextElement: 'Loop_Contacts' },
    ],
  });
  const result = await deployAndActivate(auth, apiName, flowXml);
  if (!result.success) { fail('TEST6: deploy+activate', result.message); return; }
  pass('TEST6: Full complex Account Overview via buildFlowDeployXml');
  return apiName;
}

// ─── TEST 8: sf_create_flow_from_xml — Full Account Overview XML (grouped) ────
async function test8(auth) {
  log('\n═══════════ TEST 8: sf_create_flow_from_xml — Full Account Overview (grouped XML) ═══════════');
  const apiName = 'Get_Account_Overview';
  // Re-deploy with a new version using properly grouped XML (all same-type elements together)
  const flowXml = buildFlowDeployXml({
    label: 'Get Account Overview',
    apiName,
    description: 'Returns account overview including opportunities, cases, and contacts',
    flowType: 'AutoLaunchedFlow',
    status: 'Draft',
    variables: [
      { name: 'AccountName', dataType: 'String', isInput: true, isOutput: false, isCollection: false },
      { name: 'AccountSummary', dataType: 'String', isInput: false, isOutput: true, isCollection: false },
      { name: 'AccountRecord', dataType: 'SObject', objectType: 'Account', isInput: false, isOutput: false, isCollection: false },
      { name: 'Opportunities', dataType: 'SObject', objectType: 'Opportunity', isInput: false, isOutput: false, isCollection: true },
      { name: 'Cases', dataType: 'SObject', objectType: 'Case', isInput: false, isOutput: false, isCollection: true },
      { name: 'Contacts', dataType: 'SObject', objectType: 'Contact', isInput: false, isOutput: false, isCollection: true },
      { name: 'CurrentOpp', dataType: 'SObject', objectType: 'Opportunity', isInput: false, isOutput: false, isCollection: false },
      { name: 'CurrentCase', dataType: 'SObject', objectType: 'Case', isInput: false, isOutput: false, isCollection: false },
      { name: 'CurrentContact', dataType: 'SObject', objectType: 'Contact', isInput: false, isOutput: false, isCollection: false },
    ],
    elements: [
      { type: 'GetRecords', name: 'Get_Account', label: 'Get Account', objectApiName: 'Account', filterField: 'Name', filterOperator: 'EqualTo', filterValueRef: 'AccountName', outputVariable: 'AccountRecord', getFirstRecordOnly: true, queriedFields: ['Id', 'Name', 'Industry', 'AnnualRevenue'], nextElement: 'Decision_Account_Found' },
      { type: 'Decision', name: 'Decision_Account_Found', label: 'Account Found?', conditions: [{ leftValueRef: 'AccountRecord.Id', operator: 'IsNull', rightValue: 'false', label: 'Found', nextElement: 'Get_Opportunities' }], defaultConnector: 'Assign_Not_Found' },
      { type: 'Assignment', name: 'Assign_Not_Found', label: 'Assign Not Found', assignments: [{ assignToRef: 'AccountSummary', operator: 'Assign', value: 'Account not found.' }] },
      { type: 'GetRecords', name: 'Get_Opportunities', label: 'Get Opportunities', objectApiName: 'Opportunity', filterField: 'AccountId', filterOperator: 'EqualTo', filterValueRef: 'AccountRecord.Id', outputVariable: 'Opportunities', getFirstRecordOnly: false, queriedFields: ['Id', 'Name', 'StageName', 'Amount'], nextElement: 'Get_Cases' },
      { type: 'GetRecords', name: 'Get_Cases', label: 'Get Cases', objectApiName: 'Case', filterField: 'AccountId', filterOperator: 'EqualTo', filterValueRef: 'AccountRecord.Id', outputVariable: 'Cases', getFirstRecordOnly: false, queriedFields: ['Id', 'Subject', 'Status', 'Priority'], nextElement: 'Get_Contacts' },
      { type: 'GetRecords', name: 'Get_Contacts', label: 'Get Contacts', objectApiName: 'Contact', filterField: 'AccountId', filterOperator: 'EqualTo', filterValueRef: 'AccountRecord.Id', outputVariable: 'Contacts', getFirstRecordOnly: false, queriedFields: ['Id', 'Name', 'Title', 'Email'], nextElement: 'Assign_Header' },
      { type: 'Assignment', name: 'Assign_Header', label: 'Assign Header', assignments: [{ assignToRef: 'AccountSummary', operator: 'Assign', valueRef: 'AccountRecord.Name' }], nextElement: 'Loop_Opportunities' },
      { type: 'Loop', name: 'Loop_Opportunities', label: 'Loop Opportunities', loopVariable: 'Opportunities', loopIterationVariable: 'CurrentOpp', loopNextElement: 'Concat_Opp', nextElement: 'Loop_Cases' },
      { type: 'Assignment', name: 'Concat_Opp', label: 'Concat Opp', assignments: [{ assignToRef: 'AccountSummary', operator: 'Add', valueRef: 'CurrentOpp.Name' }], nextElement: 'Loop_Opportunities' },
      { type: 'Loop', name: 'Loop_Cases', label: 'Loop Cases', loopVariable: 'Cases', loopIterationVariable: 'CurrentCase', loopNextElement: 'Concat_Case', nextElement: 'Loop_Contacts' },
      { type: 'Assignment', name: 'Concat_Case', label: 'Concat Case', assignments: [{ assignToRef: 'AccountSummary', operator: 'Add', valueRef: 'CurrentCase.Subject' }], nextElement: 'Loop_Cases' },
      { type: 'Loop', name: 'Loop_Contacts', label: 'Loop Contacts', loopVariable: 'Contacts', loopIterationVariable: 'CurrentContact', loopNextElement: 'Concat_Contact', nextElement: null },
      { type: 'Assignment', name: 'Concat_Contact', label: 'Concat Contact', assignments: [{ assignToRef: 'AccountSummary', operator: 'Add', valueRef: 'CurrentContact.Name' }], nextElement: 'Loop_Contacts' },
    ],
  });
  const result = await deployAndActivate(auth, apiName, flowXml);
  if (!result.success) { fail('TEST8: deploy+activate', result.message); return; }
  pass('TEST8: sf_create_flow_from_xml Full Account Overview (grouped XML)');
  return apiName;
}

// ─── TEST 9: Opportunity Details flow ─────────────────────────────────────────
async function test9(auth) {
  log('\n═══════════ TEST 9: Opportunity Details flow ═══════════');
  const apiName = 'Get_Opportunity_Details';
  const flowXml = buildFlowDeployXml({
    label: 'Get Opportunity Details',
    apiName,
    description: 'Returns opportunity details including tasks, contacts, and team members',
    flowType: 'AutoLaunchedFlow',
    status: 'Draft',
    variables: [
      { name: 'OpportunityName', dataType: 'String', isInput: true, isOutput: false, isCollection: false },
      { name: 'OpportunityDetail', dataType: 'String', isInput: false, isOutput: true, isCollection: false },
      { name: 'OppRecord', dataType: 'SObject', objectType: 'Opportunity', isInput: false, isOutput: false, isCollection: false },
      { name: 'Tasks', dataType: 'SObject', objectType: 'Task', isInput: false, isOutput: false, isCollection: true },
      { name: 'OppContactRoles', dataType: 'SObject', objectType: 'OpportunityContactRole', isInput: false, isOutput: false, isCollection: true },
      { name: 'CurrentTask', dataType: 'SObject', objectType: 'Task', isInput: false, isOutput: false, isCollection: false },
      { name: 'CurrentRole', dataType: 'SObject', objectType: 'OpportunityContactRole', isInput: false, isOutput: false, isCollection: false },
    ],
    elements: [
      { type: 'GetRecords', name: 'Get_Opportunity', label: 'Get Opportunity', objectApiName: 'Opportunity', filterField: 'Name', filterOperator: 'EqualTo', filterValueRef: 'OpportunityName', outputVariable: 'OppRecord', getFirstRecordOnly: true, queriedFields: ['Id', 'Name', 'StageName', 'Amount', 'CloseDate'], nextElement: 'Get_Tasks' },
      { type: 'GetRecords', name: 'Get_Tasks', label: 'Get Tasks', objectApiName: 'Task', filterField: 'WhatId', filterOperator: 'EqualTo', filterValueRef: 'OppRecord.Id', outputVariable: 'Tasks', getFirstRecordOnly: false, queriedFields: ['Id', 'Subject', 'Status'], nextElement: 'Get_ContactRoles' },
      { type: 'GetRecords', name: 'Get_ContactRoles', label: 'Get Contact Roles', objectApiName: 'OpportunityContactRole', filterField: 'OpportunityId', filterOperator: 'EqualTo', filterValueRef: 'OppRecord.Id', outputVariable: 'OppContactRoles', getFirstRecordOnly: false, queriedFields: ['Id', 'ContactId', 'Role'], nextElement: 'Assign_Header' },
      { type: 'Assignment', name: 'Assign_Header', label: 'Assign Header', assignments: [{ assignToRef: 'OpportunityDetail', operator: 'Assign', valueRef: 'OppRecord.Name' }], nextElement: 'Loop_Tasks' },
      { type: 'Loop', name: 'Loop_Tasks', label: 'Loop Tasks', loopVariable: 'Tasks', loopIterationVariable: 'CurrentTask', loopNextElement: 'Concat_Task', nextElement: 'Loop_Roles' },
      { type: 'Assignment', name: 'Concat_Task', label: 'Concat Task', assignments: [{ assignToRef: 'OpportunityDetail', operator: 'Add', valueRef: 'CurrentTask.Subject' }], nextElement: 'Loop_Tasks' },
      { type: 'Loop', name: 'Loop_Roles', label: 'Loop Roles', loopVariable: 'OppContactRoles', loopIterationVariable: 'CurrentRole', loopNextElement: 'Concat_Role', nextElement: null },
      { type: 'Assignment', name: 'Concat_Role', label: 'Concat Role', assignments: [{ assignToRef: 'OpportunityDetail', operator: 'Add', valueRef: 'CurrentRole.Role' }], nextElement: 'Loop_Roles' },
    ],
  });
  const result = await deployAndActivate(auth, apiName, flowXml);
  if (!result.success) { fail('TEST9: deploy+activate', result.message); return; }
  pass('TEST9: Opportunity Details flow');
  return apiName;
}

// ─── TEST 10: Account Quick Summary flow ──────────────────────────────────────
async function test10(auth) {
  log('\n═══════════ TEST 10: Account Quick Summary flow ═══════════');
  const apiName = 'Get_Account_Quick_Summary';
  const flowXml = buildFlowDeployXml({
    label: 'Get Account Quick Summary',
    apiName,
    description: 'Returns a quick account summary with open opps/cases and top contacts',
    flowType: 'AutoLaunchedFlow',
    status: 'Draft',
    variables: [
      { name: 'AccountName', dataType: 'String', isInput: true, isOutput: false, isCollection: false },
      { name: 'QuickSummary', dataType: 'String', isInput: false, isOutput: true, isCollection: false },
      { name: 'AccountRecord', dataType: 'SObject', objectType: 'Account', isInput: false, isOutput: false, isCollection: false },
      { name: 'OpenOpps', dataType: 'SObject', objectType: 'Opportunity', isInput: false, isOutput: false, isCollection: true },
      { name: 'OpenCases', dataType: 'SObject', objectType: 'Case', isInput: false, isOutput: false, isCollection: true },
      { name: 'TopContacts', dataType: 'SObject', objectType: 'Contact', isInput: false, isOutput: false, isCollection: true },
      { name: 'CurrentOpp', dataType: 'SObject', objectType: 'Opportunity', isInput: false, isOutput: false, isCollection: false },
      { name: 'CurrentCase', dataType: 'SObject', objectType: 'Case', isInput: false, isOutput: false, isCollection: false },
      { name: 'CurrentContact', dataType: 'SObject', objectType: 'Contact', isInput: false, isOutput: false, isCollection: false },
    ],
    elements: [
      { type: 'GetRecords', name: 'Get_Account', label: 'Get Account', objectApiName: 'Account', filterField: 'Name', filterOperator: 'EqualTo', filterValueRef: 'AccountName', outputVariable: 'AccountRecord', getFirstRecordOnly: true, queriedFields: ['Id', 'Name', 'Industry'], nextElement: 'Get_OpenOpps' },
      { type: 'GetRecords', name: 'Get_OpenOpps', label: 'Get Open Opps', objectApiName: 'Opportunity', filters: [{ field: 'AccountId', operator: 'EqualTo', valueRef: 'AccountRecord.Id' }, { field: 'IsClosed', operator: 'EqualTo', value: 'false' }], outputVariable: 'OpenOpps', getFirstRecordOnly: false, queriedFields: ['Id', 'Name', 'Amount', 'StageName'], nextElement: 'Get_OpenCases' },
      { type: 'GetRecords', name: 'Get_OpenCases', label: 'Get Open Cases', objectApiName: 'Case', filters: [{ field: 'AccountId', operator: 'EqualTo', valueRef: 'AccountRecord.Id' }, { field: 'IsClosed', operator: 'EqualTo', value: 'false' }], outputVariable: 'OpenCases', getFirstRecordOnly: false, queriedFields: ['Id', 'Subject', 'Priority'], nextElement: 'Get_TopContacts' },
      { type: 'GetRecords', name: 'Get_TopContacts', label: 'Get Top Contacts', objectApiName: 'Contact', filterField: 'AccountId', filterOperator: 'EqualTo', filterValueRef: 'AccountRecord.Id', outputVariable: 'TopContacts', getFirstRecordOnly: false, queriedFields: ['Id', 'Name', 'Title'], nextElement: 'Assign_Header' },
      { type: 'Assignment', name: 'Assign_Header', label: 'Assign Header', assignments: [{ assignToRef: 'QuickSummary', operator: 'Assign', valueRef: 'AccountRecord.Name' }], nextElement: 'Loop_OpenOpps' },
      { type: 'Loop', name: 'Loop_OpenOpps', label: 'Loop Open Opps', loopVariable: 'OpenOpps', loopIterationVariable: 'CurrentOpp', loopNextElement: 'Concat_Opp', nextElement: 'Loop_OpenCases' },
      { type: 'Assignment', name: 'Concat_Opp', label: 'Concat Opp', assignments: [{ assignToRef: 'QuickSummary', operator: 'Add', valueRef: 'CurrentOpp.Name' }], nextElement: 'Loop_OpenOpps' },
      { type: 'Loop', name: 'Loop_OpenCases', label: 'Loop Open Cases', loopVariable: 'OpenCases', loopIterationVariable: 'CurrentCase', loopNextElement: 'Concat_Case', nextElement: 'Loop_TopContacts' },
      { type: 'Assignment', name: 'Concat_Case', label: 'Concat Case', assignments: [{ assignToRef: 'QuickSummary', operator: 'Add', valueRef: 'CurrentCase.Subject' }], nextElement: 'Loop_OpenCases' },
      { type: 'Loop', name: 'Loop_TopContacts', label: 'Loop Top Contacts', loopVariable: 'TopContacts', loopIterationVariable: 'CurrentContact', loopNextElement: 'Concat_Contact', nextElement: null },
      { type: 'Assignment', name: 'Concat_Contact', label: 'Concat Contact', assignments: [{ assignToRef: 'QuickSummary', operator: 'Add', valueRef: 'CurrentContact.Name' }], nextElement: 'Loop_TopContacts' },
    ],
  });
  const result = await deployAndActivate(auth, apiName, flowXml);
  if (!result.success) { fail('TEST10: deploy+activate', result.message); return; }
  pass('TEST10: Account Quick Summary flow');
  return apiName;
}

// ─── TEST 12: Create Agentforce agent (Bot zip deploy) ────────────────────────
async function test12(auth) {
  log('\n═══════════ TEST 12: Create Agentforce agent ═══════════');
  const agentName = 'AccountIntelligenceAgent';
  const label = 'Account Intelligence Agent';
  const NS = 'http://soap.sforce.com/2006/04/metadata';

  // MDAPI format: BotVersion is embedded as <botVersions> in the single .bot file
  // File path: bots/{name}.bot (flat, not in a subdirectory)
  const botXml = `<?xml version="1.0" encoding="UTF-8"?>
<Bot xmlns="${NS}">
  <agentType>EinsteinServiceAgent</agentType>
  <botMlDomain>
    <label>${label}</label>
    <name>${agentName}</name>
  </botMlDomain>
  <botVersions>
    <fullName>v1</fullName>
    <botDialogs>
      <developerName>Welcome</developerName>
      <isPlaceholderDialog>false</isPlaceholderDialog>
      <label>Welcome</label>
      <showInFooterMenu>false</showInFooterMenu>
    </botDialogs>
    <citationsEnabled>false</citationsEnabled>
    <company>Acme</company>
    <entryDialog>Welcome</entryDialog>
    <intentDisambiguationEnabled>false</intentDisambiguationEnabled>
    <intentV3Enabled>false</intentV3Enabled>
    <knowledgeActionEnabled>false</knowledgeActionEnabled>
    <knowledgeFallbackEnabled>false</knowledgeFallbackEnabled>
    <role>Look up Salesforce account details including opportunities, cases, and contacts.</role>
    <smallTalkEnabled>false</smallTalkEnabled>
    <toneType>Formal</toneType>
  </botVersions>
  <description>Looks up Salesforce account details</description>
  <label>${label}</label>
  <logPrivateConversationData>false</logPrivateConversationData>
  <richContentEnabled>true</richContentEnabled>
  <sessionTimeout>0</sessionTimeout>
  <type>InternalCopilot</type>
</Bot>`;

  const packageXml = `<?xml version="1.0" encoding="UTF-8"?>
<Package xmlns="${NS}">
  <types>
    <members>${agentName}</members>
    <name>Bot</name>
  </types>
  <version>62.0</version>
</Package>`;

  const zip = new JSZip();
  zip.file('package.xml', packageXml);
  zip.file(`bots/${agentName}.bot`, botXml);
  const buf = await zip.generateAsync({ type: 'nodebuffer' });
  const base64 = buf.toString('base64');

  const deployId = await deployZip(auth, base64, { rollbackOnError: true });
  log(`  Deploying Bot (id: ${deployId})...`);
  const result = await pollDeployStatus(auth, deployId, 10 * 60 * 1000);
  if (!result.success) { fail('TEST12: deploy', result.message); return; }
  pass('TEST12: Create Agentforce agent');
  return agentName;
}

// ─── TEST 13: Create agent topics (GenAiPlugin) ───────────────────────────────
async function test13(auth) {
  log('\n═══════════ TEST 13: Create agent topics ═══════════');
  const NS = 'http://soap.sforce.com/2006/04/metadata';
  const topics = [
    { name: 'Account_Lookup', label: 'Account Lookup', description: 'Handles account detail requests', scope: 'Retrieve and summarize account information from Salesforce' },
    { name: 'Opportunity_Details', label: 'Opportunity Details', description: 'Handles opportunity drill-down requests', scope: 'Retrieve and summarize opportunity details including tasks and team members' },
    { name: 'Account_Quick_Summary', label: 'Account Quick Summary', description: 'Handles quick summary requests', scope: 'Provide a quick account overview with key metrics' },
  ];
  let allPassed = true;
  for (const topic of topics) {
    const pluginXml = `<?xml version="1.0" encoding="UTF-8"?>
<GenAiPlugin xmlns="${NS}">
  <description>${topic.description}</description>
  <developerName>${topic.name}</developerName>
  <language>en_US</language>
  <masterLabel>${topic.label}</masterLabel>
  <pluginType>Topic</pluginType>
  <scope>${topic.scope}</scope>
</GenAiPlugin>`;
    const base64Zip = await buildGenericDeployZip([], '62.0', [{ type: 'GenAiPlugin', name: topic.name, xml: pluginXml }]);
    const deployId = await deployZip(auth, base64Zip, { rollbackOnError: true });
    log(`  Deploying topic ${topic.name} (id: ${deployId})...`);
    const result = await pollDeployStatus(auth, deployId, 10 * 60 * 1000);
    if (!result.success) {
      fail(`TEST13: create topic ${topic.name}`, result.message);
      allPassed = false;
    } else {
      log(`  Created topic: ${topic.name}`);
    }
  }
  if (allPassed) pass('TEST13: Create 3 agent topics');
}

// ─── TEST 14: Create agent actions (GenAiFunction) ────────────────────────────
async function test14(auth) {
  log('\n═══════════ TEST 14: Create agent actions (wire flows to topics) ═══════════');
  const NS = 'http://soap.sforce.com/2006/04/metadata';
  const actions = [
    { topicName: 'Account_Lookup', actionName: 'Get_Account_Overview_Action', label: 'Get Account Overview', description: 'Retrieves full account overview including opportunities, cases, and contacts', flowRef: 'Get_Account_Overview' },
    { topicName: 'Opportunity_Details', actionName: 'Get_Opportunity_Details_Action', label: 'Get Opportunity Details', description: 'Retrieves opportunity details including tasks and contact roles', flowRef: 'Get_Opportunity_Details' },
    { topicName: 'Account_Quick_Summary', actionName: 'Get_Account_Quick_Summary_Action', label: 'Get Account Quick Summary', description: 'Returns a quick account summary with open opps, cases, and top contacts', flowRef: 'Get_Account_Quick_Summary' },
  ];
  let allPassed = true;
  for (const action of actions) {
    const fullName = action.actionName;
    const functionXml = `<?xml version="1.0" encoding="UTF-8"?>
<GenAiFunction xmlns="${NS}">
  <description>${action.description}</description>
  <invocationTarget>${action.flowRef}</invocationTarget>
  <invocationTargetType>flow</invocationTargetType>
  <isConfirmationRequired>false</isConfirmationRequired>
  <masterLabel>${action.label}</masterLabel>
</GenAiFunction>`;
    const base64Zip = await buildGenericDeployZip([], '62.0', [{ type: 'GenAiFunction', name: fullName, xml: functionXml }]);
    const deployId = await deployZip(auth, base64Zip, { rollbackOnError: true });
    log(`  Deploying action ${fullName} (id: ${deployId})...`);
    const result = await pollDeployStatus(auth, deployId, 10 * 60 * 1000);
    if (!result.success) {
      fail(`TEST14: create action ${fullName}`, result.message);
      allPassed = false;
    } else {
      log(`  Created action: ${fullName}`);
    }
  }
  if (allPassed) pass('TEST14: Create 3 agent actions (flows wired to topics)');
}

// ─── Main runner ──────────────────────────────────────────────────────────────
async function main() {
  log('Starting complex flow tests against secondorg...\n');
  const auth = await getAuth();
  log(`Connected to: ${auth.instanceUrl}\n`);

  await test6(auth);
  await test8(auth);
  await test9(auth);
  await test10(auth);
  await test12(auth);
  await test13(auth);
  await test14(auth);

  log(`\n${'═'.repeat(60)}`);
  log(`RESULTS: ${passed} passed, ${failed} failed`);
  if (failures.length) {
    log('\nFAILURES:');
    for (const f of failures) log(`  ❌ ${f.name}: ${f.msg.slice(0, 300)}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
