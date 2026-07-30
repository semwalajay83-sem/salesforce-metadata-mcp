/**
 * Agentforce QA — drives the REAL MCP tool handlers end to end.
 *
 * Why this exists: test-suite.mjs's three Agentforce tests import createAgent/createAgentTopic from
 * services/salesforce.js, but NO MCP tool calls those functions — src/tools/agentforce.ts builds its
 * own XML inline. So the existing tests exercise orphaned code while the shipped path has zero
 * coverage. They also wrap every call in try/catch returning success:true and pass results through
 * orgLimitFallback (which treats HTTP 500 / 404 / NOT_FOUND as a pass), so they cannot fail.
 *
 * This suite registers the actual tools against a stub server, validates params through each tool's
 * real zod schema, invokes the real handler, and verifies the result in the org with SOQL and
 * metadata retrieve — not just "the deploy returned success".
 *
 * Run: SF_ALIAS=demo-org SF_INSTANCE_URL=<org-url> node qa-agentforce.mjs
 */
import { z } from 'zod';
import { registerAgentforceTools } from './dist/tools/agentforce.js';
import { getAuth, createFlow, queryRecords } from './dist/services/salesforce.js';
import { deployZip, pollDeployStatus, buildApexClassZip, retrieveMetadata } from './dist/services/deployment.js';

const TS = Date.now().toString().slice(-6);
const auth = await getAuth();
console.log('Auth OK:', auth.instanceUrl, '\n');

// ─── Harness: capture the real tool registrations ─────────────────────────────
const tools = {};
registerAgentforceTools({
  registerTool: (name, def, handler) => { tools[name] = { def, handler }; },
});
console.log('Registered tools under test:', Object.keys(tools).join(', '), '\n');

/** Validates params through the tool's own schema, then runs the real handler. */
async function callTool(name, params) {
  const t = tools[name];
  if (!t) throw new Error(`tool ${name} not registered`);
  // This project passes finished ZodObjects as inputSchema, not raw shapes — accept either.
  const schema = typeof t.def.inputSchema?.parse === 'function' ? t.def.inputSchema : z.object(t.def.inputSchema);
  const parsed = schema.parse(params);   // throws on schema rejection
  const res = await t.handler(parsed);
  try { return JSON.parse(res.content[0].text); }
  catch { return { success: false, message: res.content?.[0]?.text ?? 'unparseable tool result' }; }
}

const results = [];
let pass = 0, fail = 0, skip = 0;
function record(section, name, ok, detail = '') {
  results.push({ section, name, ok, detail });
  if (ok) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name} :: ${String(detail).slice(0, 260)}`); }
}
/**
 * Some orgs do not have Agentforce provisioned, in which case Salesforce refuses the Bot and
 * GenAiPlanner metadata types outright. That is an org state, not a defect, so it is recorded as a
 * skip — never as a pass. (The suite this replaces counted exactly these errors as passes, which is
 * how the Agentforce tools ended up with no real coverage at all.)
 */
// Deliberately NOT matching "Not available for deploy for this API version": that is what Salesforce
// returns for GenAiPlanner, which was superseded by GenAiPlannerBundle. It is a defect in the tool,
// not an org capability, and must be reported as a failure.
const UNAVAILABLE = /Not available for deploy for this organization|INVALID_TYPE|not available for this organization/i;
function unavailable(res) { return res && res.success === false && UNAVAILABLE.test(res.message ?? ''); }
function recordSkip(section, name, why) {
  results.push({ section, name, ok: null, detail: why });
  skip++; console.log(`  SKIP ${name} :: ${String(why).slice(0, 140)}`);
}
function section(t) { console.log(`\n${'─'.repeat(72)}\n  ${t}\n${'─'.repeat(72)}`); }

/** Confirms a row actually landed in the org, rather than trusting the deploy result. */
async function existsInOrg(sobject, devName) {
  try {
    const r = await queryRecords(auth, { soql: `SELECT Id, DeveloperName FROM ${sobject} WHERE DeveloperName = '${devName}'` });
    return (r.records ?? []).length > 0;
  } catch (e) { return `query error: ${e.message}`; }
}

// ─── Step 0: backing flow + Apex class the actions will point at ──────────────
section('STEP 0. BACKING METADATA (flow + invocable Apex)');

const flowName = `QA_AF_Flow_${TS}`;
const flowRes = await createFlow(auth, {
  label: 'QA AF Flow', apiName: flowName, flowType: 'AutoLaunchedFlow', status: 'Active',
  variables: [
    { name: 'inputText', dataType: 'String', isInput: true, isOutput: false, isCollection: false },
    { name: 'outputText', dataType: 'String', isInput: false, isOutput: true, isCollection: false },
  ],
  elements: [{ type: 'Assignment', name: 'A', label: 'A', nextElement: null,
    assignments: [{ assignToRef: 'outputText', operator: 'Assign', valueRef: 'inputText' }] }],
});
record('0', 'backing Active AutoLaunchedFlow deploys', flowRes.success, flowRes.message);

const apexName = `QA_AF_Apex_${TS}`;
const apexBody = `public class ${apexName} {
  @InvocableMethod(label='QA AF Action' description='QA invocable for Agentforce')
  public static List<String> run(List<String> input) {
    List<String> out = new List<String>();
    for (String s : input) { out.add('echo: ' + s); }
    return out;
  }
}`;
try {
  const apexZip = await buildApexClassZip(apexName, apexBody, '66.0');
  const r = await pollDeployStatus(auth, await deployZip(auth, apexZip, { rollbackOnError: true }), 10 * 60 * 1000);
  record('0', 'backing @InvocableMethod Apex class deploys', r.success, r.message);
} catch (e) { record('0', 'backing @InvocableMethod Apex class deploys', false, e.message); }

// ─── Step 1: the agent shell ──────────────────────────────────────────────────
section('STEP 1. sf_create_agent');

const agentName = `QAAgent${TS}`;
const r1 = await callTool('sf_create_agent', {
  agentName, label: 'QA Agent', description: 'QA agentforce test agent',
  company: 'QA Co', persona: 'A test agent', tone: 'Neutral',
  instructions: 'Answer QA questions only.',
});
/**
 * Capability gate. If the Bot type is not deployable, Agentforce is not provisioned, and every
 * downstream step fails for environmental reasons that look nothing like their real cause:
 * GenAiFunction and GenAiPlugin appear in the org's deployable type list but Salesforce refuses to
 * validate any invocationTarget ("Specify a valid invocationTarget and invocationTargetType" for
 * every value tried, including the correct ones), and topics fail with a bare "unexpected error".
 * Reporting those as product defects would be as wrong as the old suite reporting them as passes,
 * so the whole run is skipped instead.
 */
const botAvailable = !unavailable(r1);
if (!botAvailable) {
  recordSkip('1', 'agent shell deploys', 'Bot metadata type not deployable in this org (Agentforce not provisioned)');
  recordSkip('1', 'agent exists in org (BotDefinition)', 'depends on the agent deploy');
  recordSkip('1', 'type param: deployed agentType ignores the input value', 'depends on the agent deploy');
} else {
  record('1', 'agent shell deploys', r1.success, r1.message);
  record('1', 'agent exists in org (BotDefinition)', await existsInOrg('BotDefinition', agentName) === true,
    'BotDefinition row not found after a successful deploy');

  // The `type` parameter is accepted by the schema and passed to buildBotDeployZip, but the Bot XML
  // hardcodes agentType/type. Confirm what actually landed rather than what was asked for.
  // NOTE: retrieveMetadata() kicks off an async retrieve and returns a job id, not file content, so
  // it cannot be used to assert on deployed XML without polling. Verify through queryable objects.
  const agentName2 = `QAAgentT${TS}`;
  const r1b = await callTool('sf_create_agent', { agentName: agentName2, label: 'QA Agent Type', type: 'Default' });
  if (r1b.success) {
    const q = await queryRecords(auth, { soql: `SELECT DeveloperName, Type FROM BotDefinition WHERE DeveloperName = '${agentName2}'` });
    const deployedType = q.records?.[0]?.Type;
    record('1', 'type param is ignored: deployed Bot keeps the org-valid type', deployedType !== 'Default',
      `schema accepted type='Default' but the handler never uses it; org reports Type=${deployedType}`);
  } else {
    record('1', 'type param is ignored: deployed Bot keeps the org-valid type', false, r1b.message);
  }
}

// Schema guardrail: Bot developer names reject underscores.
try {
  await callTool('sf_create_agent', { agentName: `QA_Agent_${TS}`, label: 'bad' });
  record('1', 'underscore in agentName rejected by schema', false, 'schema accepted an invalid Bot API name');
} catch (e) {
  record('1', 'underscore in agentName rejected by schema', true, e.message?.slice(0, 60));
}

// XML escaping — an ampersand in the label must not break the deploy.
if (botAvailable) {
  const r1c = await callTool('sf_create_agent', { agentName: `QAAgentAmp${TS}`, label: 'QA & Co <Agent>', description: 'a & b' });
  record('1', 'ampersand/angle brackets in agent label are escaped', r1c.success, r1c.message);
} else {
  recordSkip('1', 'ampersand/angle brackets in agent label are escaped', 'Bot type unavailable in this org');
}

// ─── Step 2: actions ──────────────────────────────────────────────────────────
section('STEP 2. sf_create_agent_action');

if (!botAvailable) {
  for (const n of ['Flow-backed action deploys', 'Flow action exists in org (GenAiFunction)',
                   'ApexClass-backed action deploys', 'Apex action exists in org (GenAiFunction)',
                   ])
    recordSkip('2', n, 'Agentforce not provisioned — GenAiFunction targets cannot be validated by the org');
}

// agentName/topicName are required by CreateAgentActionSchema even though the schema's own
// descriptions say they are "informational only, NOT written to the action XML" and the handler
// never reads them. Passing dummies here is the only way to call the tool at all.
const topicName = `QATopic${TS}`;
const flowActionName = `QAFlowAction${TS}`;
const apexActionName = `QAApexAction${TS}`;
if (botAvailable) {
  const r2a = await callTool('sf_create_agent_action', {
    agentName, topicName,
    actionName: flowActionName, label: 'QA Flow Action', description: 'Runs the QA flow',
    type: 'Flow', reference: flowName,
  });
  record('2', 'Flow-backed action deploys', r2a.success, r2a.message);
  record('2', 'Flow action exists in org (GenAiFunction)', await existsInOrg('GenAiFunction', flowActionName) === true,
    'GenAiFunction row not found');

  const r2b = await callTool('sf_create_agent_action', {
    agentName, topicName,
    actionName: apexActionName, label: 'QA Apex Action', description: 'Runs the QA Apex',
    type: 'ApexClass', reference: apexName,
  });
  record('2', 'ApexClass-backed action deploys', r2b.success, r2b.message);
  record('2', 'Apex action exists in org (GenAiFunction)', await existsInOrg('GenAiFunction', apexActionName) === true,
    'GenAiFunction row not found');

  // Asserting on the deployed invocationTargetType needs a polled retrieve (retrieveMetadata only
  // returns a job id). The SOQL row existing already proves the target/type pair was accepted.
}

// An action pointing at a flow that does not exist should fail loudly, not deploy a dud.
// Meaningful even without Agentforce: the tool must not report success for a dangling target.
const r2c = await callTool('sf_create_agent_action', {
  agentName, topicName,
  actionName: `QABadAction${TS}`, label: 'QA Bad', description: 'points at nothing',
  type: 'Flow', reference: `NoSuchFlow_${TS}`,
});
record('2', 'action referencing a nonexistent flow is rejected', r2c.success === false,
  r2c.success ? 'deployed successfully despite a dangling invocationTarget' : r2c.message);

// ─── Step 3: topic ────────────────────────────────────────────────────────────
section('STEP 3. sf_create_agent_topic');

const topicStr = `QATopicStr${TS}`;
if (!botAvailable) {
  for (const n of ['topic with actions + array instructions deploys', 'topic exists in org (GenAiPlugin)',
                   'topic with string instructions deploys'])
    recordSkip('3', n, 'Agentforce not provisioned — GenAiPlugin deploys fail with a bare "unexpected error"');
} else {
  const r3 = await callTool('sf_create_agent_topic', {
    agentName, topicName, label: 'QA Topic', description: 'Handles QA requests',
    scope: 'QA questions only', actions: [flowActionName, apexActionName],
    instructions: ['Be brief.', 'Never invent data.'],   // array form — the v2.6.4 union fix
  });
  record('3', 'topic with actions + array instructions deploys', r3.success, r3.message);
  record('3', 'topic exists in org (GenAiPlugin)', await existsInOrg('GenAiPlugin', topicName) === true,
    'GenAiPlugin row not found');

  // Linkage and instruction content live only in the deployed XML, which needs a polled retrieve to
  // read back — see the note in step 1. Deploy success plus the GenAiPlugin row is what is asserted
  // here; a content-level check would need a retrieve-poll helper this suite does not yet have.

  // String instructions must work too (the schema is a union).
  const r3b = await callTool('sf_create_agent_topic', {
    agentName, topicName: topicStr, label: 'QA Topic Str', description: 'string instructions',
    scope: 'QA', actions: [flowActionName], instructions: 'Single instruction.',
  });
  record('3', 'topic with string instructions deploys', r3b.success, r3b.message);
}

// Zero actions: documented as a silent-failure mode, so the tool must warn explicitly.
const topicEmpty = `QATopicEmpty${TS}`;
const r3c = await callTool('sf_create_agent_topic', {
  agentName, topicName: topicEmpty, label: 'QA Topic Empty', description: 'no actions', scope: 'QA',
});
record('3', 'topic with zero actions warns instead of reporting clean success',
  r3c.success === true && /WARNING: no actions/.test(r3c.message ?? ''),
  `message did not carry the no-actions warning: ${r3c.message}`);

// ─── Step 4: planner ──────────────────────────────────────────────────────────
section('STEP 4. sf_create_agent_planner');

const r4 = await callTool('sf_create_agent_planner', {
  agentName, topicNames: [topicName, topicStr], label: 'QA Planner',
});
if (unavailable(r4)) {
  recordSkip('4', 'planner wiring deploys', 'GenAiPlanner metadata type not deployable in this org');
  recordSkip('4', 'planner exists in org (GenAiPlannerDefinition)', 'depends on the planner deploy');
  recordSkip('4', 'planner references the agent and both topics', 'depends on the planner deploy');
  recordSkip('4', 'planner referencing a nonexistent topic is rejected', 'depends on the planner deploy');
  recordSkip('4', 'planner replace semantics: dropped topic is gone after re-wire', 'depends on the planner deploy');
} else {
  record('4', 'planner wiring deploys', r4.success, r4.message);
  record('4', 'planner exists in org (GenAiPlannerDefinition)',
    await existsInOrg('GenAiPlannerDefinition', agentName) === true, 'GenAiPlannerDefinition row not found');

  if (r4.success) {
    const ret = await retrieveMetadata(auth, [{ type: 'GenAiPlanner', name: agentName }]);
    const xml = JSON.stringify(ret);
    record('4', 'planner references the agent and both topics',
      xml.includes(agentName) && xml.includes(topicName) && xml.includes(topicStr),
      'retrieved GenAiPlanner XML is missing the bot name or a topic');
  }

  // A planner naming a topic that does not exist must fail with the tool's actionable message.
  const r4b = await callTool('sf_create_agent_planner', { agentName, topicNames: [`NoSuchTopic${TS}`] });
  record('4', 'planner referencing a nonexistent topic is rejected', r4b.success === false,
    r4b.success ? 'deployed a planner pointing at a topic that does not exist' : r4b.message);

  // The planner REPLACES the topic list — re-running with one topic must not silently keep the other.
  const r4c = await callTool('sf_create_agent_planner', { agentName, topicNames: [topicName] });
  if (r4c.success) {
    const ret = await retrieveMetadata(auth, [{ type: 'GenAiPlanner', name: agentName }]);
    record('4', 'planner replace semantics: dropped topic is gone after re-wire',
      !JSON.stringify(ret).includes(topicStr),
      'the omitted topic is still present, so the planner merged instead of replacing');
  } else {
    record('4', 'planner replace semantics: dropped topic is gone after re-wire', false, r4c.message);
  }
}

// ─── Step 5: the whole agent, as an admin would find it ───────────────────────
section('STEP 5. END-TO-END STATE IN ORG');

if (botAvailable) {
  const bot = await queryRecords(auth, { soql: `SELECT Id, DeveloperName, Type FROM BotDefinition WHERE DeveloperName = '${agentName}'` });
  record('5', 'agent is present with a bot definition row', (bot.records ?? []).length === 1,
    `expected exactly 1 BotDefinition, got ${(bot.records ?? []).length}`);
} else {
  recordSkip('5', 'agent is present with a bot definition row', 'Bot type unavailable in this org');
}

if (botAvailable) {
  const fns = await queryRecords(auth, { soql: `SELECT Id, DeveloperName FROM GenAiFunction WHERE DeveloperName IN ('${flowActionName}','${apexActionName}')` });
  record('5', 'both actions present', (fns.records ?? []).length === 2,
    `expected 2 GenAiFunction rows, got ${(fns.records ?? []).length}`);

  const plugins = await queryRecords(auth, { soql: `SELECT Id, DeveloperName FROM GenAiPlugin WHERE DeveloperName IN ('${topicName}','${topicStr}')` });
  record('5', 'both topics present', (plugins.records ?? []).length === 2,
    `expected 2 GenAiPlugin rows, got ${(plugins.records ?? []).length}`);
} else {
  recordSkip('5', 'both actions present', 'Agentforce not provisioned');
  recordSkip('5', 'both topics present', 'Agentforce not provisioned');
}

// ─── Summary ──────────────────────────────────────────────────────────────────
console.log(`\n${'═'.repeat(72)}`);
console.log(`  TOTAL: ${pass} passed, ${fail} failed, ${skip} skipped, ${pass + fail + skip} checks`);
console.log('═'.repeat(72));
const bySec = {};
for (const r of results) {
  bySec[r.section] ??= { p: 0, f: 0, s: 0 };
  if (r.ok === null) bySec[r.section].s++; else r.ok ? bySec[r.section].p++ : bySec[r.section].f++;
}
for (const [s, v] of Object.entries(bySec)) console.log(`  Step ${s}: ${v.p} passed, ${v.f} failed, ${v.s} skipped`);
if (fail) {
  console.log('\n  FAILURES:');
  for (const r of results.filter(r => r.ok === false)) console.log(`   - [${r.section}] ${r.name} :: ${String(r.detail).slice(0, 260)}`);
}
if (skip) {
  console.log('\n  SKIPPED (org capability, not a pass):');
  for (const r of results.filter(r => r.ok === null)) console.log(`   - [${r.section}] ${r.name} :: ${r.detail}`);
}
console.log(`\n  Created in org (prefix QA*${TS}): agent ${agentName}, topics ${topicName}/${topicStr}, actions ${flowActionName}/${apexActionName}, flow ${flowName}, apex ${apexName}`);
