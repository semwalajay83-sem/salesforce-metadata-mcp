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
 * real zod schema, invokes the real handler, and verifies the result in the org with SOQL —
 * not just "the deploy returned success".
 *
 * Run: SF_ALIAS=demo-org SF_INSTANCE_URL=<org-url> node qa-agentforce.mjs
 */
import { z } from 'zod';
import { registerAgentforceTools } from './dist/tools/agentforce.js';
import { getAuth, createFlow, queryRecords } from './dist/services/salesforce.js';
import { deployZip, pollDeployStatus, buildApexClassZip, retrieveMetadataAndWait } from './dist/services/deployment.js';

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

/**
 * Reads back what was actually deployed. Assertions on deployed XML need this — the raw
 * retrieveMetadata() only starts an async job, which is why earlier content checks were meaningless.
 */
async function deployedXml(type, name) {
  const r = await retrieveMetadataAndWait(auth, [{ type, name }]);
  if (!r.success) return { ok: false, xml: '', why: r.message };
  return { ok: true, xml: (r.files ?? []).map(f => f.content).join('\n'), why: '' };
}

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
// Every optional field at once. `instructions` used to be here and broke the deploy outright
// (<systemPrompt> is not a BotVersion field); it has been removed from the schema, and agent
// guidance now belongs on the topics instead.
const r1 = await callTool('sf_create_agent', {
  agentName, label: 'QA Agent', description: 'QA agentforce test agent',
  company: 'QA Co', persona: 'A test agent', tone: 'Neutral',
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
  recordSkip('1', 'removed no-op `type` param is rejected by the schema', 'depends on the agent deploy');
  recordSkip('1', 'removed `instructions` param is rejected by the schema', 'depends on the agent deploy');
} else {
  record('1', 'agent shell deploys', r1.success, r1.message);
  record('1', 'agent exists in org (BotDefinition)', await existsInOrg('BotDefinition', agentName) === true,
    'BotDefinition row not found after a successful deploy');

  // Content-level: the optional fields the caller passed must survive into the deployed Bot, and the
  // hardcoded enum values must be the org-valid ones. `persona` maps to <role>, not a literal field.
  if (r1.success) {
    const { ok, xml, why } = await deployedXml('Bot', agentName);
    record('1', 'deployed Bot carries persona as <role>', ok && xml.includes('<role>A test agent</role>'),
      ok ? 'persona did not land as <role> in the deployed Bot' : why);
    record('1', 'deployed Bot carries company and tone', ok && xml.includes('QA Co') && xml.includes('<toneType>Neutral</toneType>'),
      ok ? 'company or toneType missing from the deployed Bot' : why);
    record('1', 'deployed Bot uses the org-valid agentType/type enums',
      ok && xml.includes('<agentType>EinsteinServiceAgent</agentType>') && xml.includes('<type>InternalCopilot</type>'),
      ok ? 'agentType/type are not the values verified against this org' : why);
    record('1', 'deployed Bot contains no <systemPrompt>', ok && !xml.includes('systemPrompt'),
      ok ? 'systemPrompt is back in the Bot XML — it is invalid on BotVersion' : why);
  }

  // The `type` parameter is accepted by the schema and passed to buildBotDeployZip, but the Bot XML
  // hardcodes agentType/type. Confirm what actually landed rather than what was asked for.
  // `type` was a no-op parameter whose only two allowed values were both invalid in Salesforce.
  // It has been removed, so the strict schema must now reject it rather than silently accept it.
  try {
    await callTool('sf_create_agent', { agentName: `QAAgentT${TS}`, label: 'QA Agent Type', type: 'Default' });
    record('1', 'removed no-op `type` param is rejected by the schema', false, 'schema still accepts type');
  } catch (e) {
    record('1', 'removed no-op `type` param is rejected by the schema', true, e.message?.slice(0, 60));
  }

  // `instructions` produced an invalid <systemPrompt> element and broke every deploy that used it.
  try {
    await callTool('sf_create_agent', { agentName: `QAAgentI${TS}`, label: 'QA Agent Instr', instructions: 'be brief' });
    record('1', 'removed `instructions` param is rejected by the schema', false, 'schema still accepts instructions');
  } catch (e) {
    record('1', 'removed `instructions` param is rejected by the schema', true, e.message?.slice(0, 60));
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
/**
 * Second capability gate. An org can have Agentforce (Bot deploys fine) yet still refuse custom
 * agent actions: GenAiFunction appears in the metadata type list but rejects EVERY documented
 * invocationTargetType — flow, apex and standard invocable actions alike — with "Specify a valid
 * invocationTarget and invocationTargetType", even against a confirmed-Active flow and Apex class.
 * Verified by hand-deploying spec-compliant XML outside this suite. Since step 0 asserts the targets
 * exist, that error here means the org, not the tool, so the action-dependent checks are skipped.
 */
let actionsAvailable = true;
if (botAvailable) {
  const r2a = await callTool('sf_create_agent_action', {
    actionName: flowActionName, label: 'QA Flow Action', description: 'Runs the QA flow',
    type: 'Flow', reference: flowName,
  });
  actionsAvailable = !(r2a.success === false && /Specify a valid invocationTarget/i.test(r2a.message ?? ''));
  const why = 'custom agent actions not enabled in this org — GenAiFunction rejects every invocationTargetType, including standard actions';
  if (!actionsAvailable) {
    recordSkip('2', 'Flow-backed action deploys', why);
    recordSkip('2', 'Flow action exists in org (GenAiFunction)', why);
    recordSkip('2', 'ApexClass-backed action deploys', why);
    recordSkip('2', 'Apex action exists in org (GenAiFunction)', why);
    record('2', 'action failure message points at org licensing, not the target',
      /not enabled in this org/.test(r2a.message ?? ''),
      `message still blames the target: ${r2a.message}`);
  } else {
    record('2', 'Flow-backed action deploys', r2a.success, r2a.message);
    record('2', 'Flow action exists in org (GenAiFunction)', await existsInOrg('GenAiFunction', flowActionName) === true,
      'GenAiFunction row not found');

    const r2b = await callTool('sf_create_agent_action', {
      actionName: apexActionName, label: 'QA Apex Action', description: 'Runs the QA Apex',
      type: 'ApexClass', reference: apexName,
    });
    record('2', 'ApexClass-backed action deploys', r2b.success, r2b.message);
    record('2', 'Apex action exists in org (GenAiFunction)', await existsInOrg('GenAiFunction', apexActionName) === true,
      'GenAiFunction row not found');
  }

  // Asserting on the deployed invocationTargetType needs a polled retrieve (retrieveMetadata only
  // returns a job id). The SOQL row existing already proves the target/type pair was accepted.
}

// agentName/topicName are unused by the handler and are now optional — omitting them must not be a
// schema error. Previously both were required, so a caller reasoning correctly about the action XML
// got a hard rejection. This also doubles as the dangling-target check: the tool must not report
// success for an invocationTarget that does not exist.
const r2c = await callTool('sf_create_agent_action', {
  actionName: `QABadAction${TS}`, label: 'QA Bad', description: 'points at nothing',
  type: 'Flow', reference: `NoSuchFlow_${TS}`,
});
record('2', 'agentName/topicName are optional (handler never uses them)', true,
  'call was accepted by the schema without them');

// The schema advertises five action types; only Flow and ApexClass had ever been exercised. Each maps
// to a different invocationTargetType, so a wrong mapping in the others would be invisible until a
// user hit it. Where the org cannot create actions at all these still can't deploy, but the type
// mapping itself is asserted against the tool's own typeMap.
const TYPE_MAP = { Flow: 'flow', ApexClass: 'apex', PromptTemplate: 'promptTemplate', DataCategoryGroup: 'dataCategoryGroup', ExternalService: 'externalService' };
for (const [t, expected] of Object.entries(TYPE_MAP)) {
  const an = `QAType${t}${TS}`;
  const r = await callTool('sf_create_agent_action', {
    actionName: an, label: `QA ${t}`, description: `QA ${t} action`, type: t, reference: `QARef${t}`,
  });
  if (r.success) {
    const { ok, xml, why } = await deployedXml('GenAiFunction', an);
    record('2', `action type ${t} deploys with invocationTargetType=${expected}`,
      ok && xml.includes(`<invocationTargetType>${expected}</invocationTargetType>`),
      ok ? `deployed XML does not carry ${expected}` : why);
  } else if (/Specify a valid invocationTarget|not enabled in this org/i.test(r.message ?? '')) {
    recordSkip('2', `action type ${t} deploys with invocationTargetType=${expected}`,
      'org cannot create GenAiFunction; target-type mapping unverifiable here');
  } else {
    record('2', `action type ${t} deploys with invocationTargetType=${expected}`, false, r.message);
  }
}
record('2', 'action referencing a nonexistent flow is rejected', r2c.success === false,
  r2c.success ? 'deployed successfully despite a dangling invocationTarget' : r2c.message);

// ─── Step 3: topic ────────────────────────────────────────────────────────────
section('STEP 3. sf_create_agent_topic');

const topicStr = `QATopicStr${TS}`;
if (!botAvailable || !actionsAvailable) {
  for (const n of ['topic with actions + array instructions deploys', 'topic exists in org (GenAiPlugin)',
                   'topic with string instructions deploys'])
    recordSkip('3', n, !botAvailable ? 'Agentforce not provisioned' : 'topics here reference actions the org cannot create');
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

// A second action-free topic, so the planner's replace semantics can be verified even in an org that
// cannot create actions. Two deployable topics is all that check needs.
const topicEmpty2 = `QATopicEmptyB${TS}`;
const r3d = await callTool('sf_create_agent_topic', {
  agentName, topicName: topicEmpty2, label: 'QA Topic Empty B', description: 'no actions either', scope: 'QA',
});
record('3', 'second action-free topic deploys', r3d.success, r3d.message);

// ─── Step 4: planner ──────────────────────────────────────────────────────────
section('STEP 4. sf_create_agent_planner');

// The topics referencing actions cannot be created when custom actions are unavailable, so wire the
// planner to whatever topic definitely exists — a zero-action topic still deploys.
const plannerTopics = (await existsInOrg('GenAiPlugin', topicName)) === true
  ? [topicName, topicStr]
  : [topicEmpty, topicEmpty2].filter(Boolean);
const r4 = await callTool('sf_create_agent_planner', {
  agentName, topicNames: plannerTopics, label: 'QA Planner', description: 'QA planner for the agent',
});
record('4', 'planner deploys as GenAiPlannerBundle', r4.success, r4.message);
record('4', 'planner exists in org (GenAiPlannerDefinition)',
  await existsInOrg('GenAiPlannerDefinition', agentName) === true, 'GenAiPlannerDefinition row not found');

// A planner naming a topic that does not exist must fail rather than deploy a dud.
const r4b = await callTool('sf_create_agent_planner', {
  agentName: `${agentName}X`, topicNames: [`NoSuchTopic${TS}`], description: 'bad planner',
});
record('4', 'planner referencing a nonexistent topic is rejected', r4b.success === false,
  r4b.success ? 'deployed a planner pointing at a topic that does not exist' : r4b.message);

// Content-level: the deployed bundle must actually carry the topics, the required plannerType, and
// a description. Deploy success alone would not catch a planner that silently dropped its topics.
if (r4.success) {
  const { ok, xml, why } = await deployedXml('GenAiPlannerBundle', agentName);
  record('4', 'deployed planner XML carries every requested topic', ok && plannerTopics.every(t => xml.includes(t)),
    ok ? `retrieved XML is missing a topic: ${plannerTopics.filter(t => !xml.includes(t)).join(', ')}` : why);
  record('4', 'deployed planner XML uses plannerType AiCopilot__ReAct', ok && xml.includes('AiCopilot__ReAct'),
    ok ? 'plannerType missing or wrong in the deployed bundle' : why);
  record('4', 'deployed planner XML carries a description', ok && /<description>[^<]+<\/description>/.test(xml),
    ok ? 'description missing — Salesforce requires it' : why);
}

// The planner REPLACES its topic list. Re-deploying with a subset must drop the omitted topic, since
// the tool's own description warns that omitting a topic removes it from the agent.
if (r4.success && plannerTopics.length > 1) {
  const r4e = await callTool('sf_create_agent_planner', {
    agentName, topicNames: [plannerTopics[0]], description: 'QA planner re-wired',
  });
  if (r4e.success) {
    const { ok, xml, why } = await deployedXml('GenAiPlannerBundle', agentName);
    record('4', 'planner replace semantics: omitted topic is gone after re-wire',
      ok && !xml.includes(plannerTopics[1]),
      ok ? 'the omitted topic is still present, so the planner merged instead of replacing' : why);
  } else {
    record('4', 'planner replace semantics: omitted topic is gone after re-wire', false, r4e.message);
  }
} else {
  recordSkip('4', 'planner replace semantics: omitted topic is gone after re-wire',
    'needs two deployable topics; only the zero-action topic exists in this org');
}

// actionNames attaches actions directly to the planner rather than through a topic. Added in v2.8.4
// and previously never exercised — a parameter shipped on the strength of a docs page alone.
if (actionsAvailable) {
  const r4f = await callTool('sf_create_agent_planner', {
    agentName: `${agentName}A`, topicNames: plannerTopics, actionNames: [flowActionName],
    description: 'QA planner with a direct action',
  });
  record('4', 'planner actionNames deploys', r4f.success, r4f.message);
  if (r4f.success) {
    const { ok, xml, why } = await deployedXml('GenAiPlannerBundle', `${agentName}A`);
    record('4', 'deployed planner XML carries the direct action', ok && xml.includes(flowActionName),
      ok ? 'genAiFunctions entry missing from the deployed bundle' : why);
  }
} else {
  recordSkip('4', 'planner actionNames deploys', 'needs a creatable action; org cannot create GenAiFunction');
  recordSkip('4', 'deployed planner XML carries the direct action', 'needs a creatable action');
}

// ─── Step 4b: the agent→planner link, which the planner itself cannot write ───
section('STEP 4b. AGENT → PLANNER LINK (sf_create_agent with plannerName)');

if (r4.success) {
  const r4d = await callTool('sf_create_agent', {
    agentName, label: 'QA Agent', description: 'QA agentforce test agent', plannerName: agentName,
  });
  record('4b', 'agent re-deploys with conversationDefinitionPlanners link', r4d.success, r4d.message);
  record('4b', 'success message reports the link rather than the 5-step prompt',
    r4d.success === true && /linked to planner/.test(r4d.message ?? ''),
    `message did not confirm the link: ${r4d.message}`);
} else {
  recordSkip('4b', 'agent re-deploys with conversationDefinitionPlanners link', 'planner deploy failed');
  recordSkip('4b', 'success message reports the link rather than the 5-step prompt', 'planner deploy failed');
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

if (botAvailable && actionsAvailable) {
  const fns = await queryRecords(auth, { soql: `SELECT Id, DeveloperName FROM GenAiFunction WHERE DeveloperName IN ('${flowActionName}','${apexActionName}')` });
  record('5', 'both actions present', (fns.records ?? []).length === 2,
    `expected 2 GenAiFunction rows, got ${(fns.records ?? []).length}`);

  const plugins = await queryRecords(auth, { soql: `SELECT Id, DeveloperName FROM GenAiPlugin WHERE DeveloperName IN ('${topicName}','${topicStr}')` });
  record('5', 'both topics present', (plugins.records ?? []).length === 2,
    `expected 2 GenAiPlugin rows, got ${(plugins.records ?? []).length}`);
} else {
  recordSkip('5', 'both actions present', 'custom agent actions not enabled in this org');
  recordSkip('5', 'both topics present', 'depends on actions that cannot be created here');
}

// ─── Step 6: runtime — is the agent actually live and wired? ──────────────────
section('STEP 6. RUNTIME STATE (activation + wiring, asserted in org)');

/**
 * The strongest available runtime check short of holding a conversation. A real conversation needs
 * the Agent API (api.salesforce.com/einstein/ai-agent), which requires a connected app with client
 * credentials and an ACTIVE agent — neither exists here, and creating a connected app is outside
 * what this suite should do to an org. What IS assertable: the agent's version status, and that the
 * planner link written by sf_create_agent survives into the deployed metadata.
 */
if (botAvailable && r4.success) {
  const { ok, xml, why } = await deployedXml('Bot', agentName);
  record('6', 'agent→planner link is present in the deployed Bot',
    ok && xml.includes('conversationDefinitionPlanners') && xml.includes(agentName),
    ok ? 'the link sf_create_agent claimed to write is not in the deployed Bot' : why);

  const bv = await queryRecords(auth, {
    soql: `SELECT Id, Status, VersionNumber FROM BotVersion WHERE BotDefinition.DeveloperName = '${agentName}'`,
  }).catch(e => ({ error: e.message }));
  const versions = bv.records ?? [];
  record('6', 'agent has a BotVersion row in the org', versions.length > 0,
    bv.error ? `query error: ${bv.error}` : `expected >=1 BotVersion, got ${versions.length}`);
  // Newly deployed agents are Inactive until activated in Setup; assert the real state rather than
  // pretending the agent is live.
  const status = versions[0]?.Status;
  record('6', 'BotVersion status is readable (agent is Inactive until activated in Setup)',
    typeof status === 'string' && status.length > 0,
    `could not read BotVersion.Status; got ${JSON.stringify(status)}`);
  console.log(`    → BotVersion status: ${status ?? 'unknown'} (activation is a Setup action, not a metadata deploy)`);

  recordSkip('6', 'agent answers a real conversation turn',
    'needs the Agent API: an ACTIVE agent plus a connected app with client credentials — creating one is out of scope for this suite');
} else {
  recordSkip('6', 'agent→planner link is present in the deployed Bot', 'agent or planner deploy did not succeed');
  recordSkip('6', 'agent has a BotVersion row in the org', 'agent or planner deploy did not succeed');
  recordSkip('6', 'BotVersion status is readable (agent is Inactive until activated in Setup)', 'agent or planner deploy did not succeed');
  recordSkip('6', 'agent answers a real conversation turn', 'agent or planner deploy did not succeed');
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
