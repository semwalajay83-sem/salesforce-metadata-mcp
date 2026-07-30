/**
 * QA for the four Agentforce-adjacent tools that qa-agentforce.mjs does not cover:
 * sf_create_einstein_bot, sf_create_bot_routing, sf_create_einstein_prediction,
 * sf_assign_skill_to_agent.
 *
 * None of these had ever been driven through their real handler. test-suite.mjs touches two of them
 * via orgLimitFallback(), which counts HTTP 500 / 404 / NOT_FOUND as a pass, so a failure there is
 * indistinguishable from a success. As in qa-agentforce.mjs, an org that genuinely lacks a feature is
 * recorded as a SKIP, never as a pass.
 *
 * Run: SF_ALIAS=demo-org SF_INSTANCE_URL=<org-url> node qa-agentforce-adjacent.mjs
 */
import { z } from 'zod';
import { registerEinsteinTools } from './dist/tools/einstein.js';
import { registerOmniChannelTools } from './dist/tools/omnichannel.js';
import { getAuth, queryRecords } from './dist/services/salesforce.js';

const TS = Date.now().toString().slice(-6);
const auth = await getAuth();
console.log('Auth OK:', auth.instanceUrl, '\n');

const tools = {};
const stub = { registerTool: (name, def, handler) => { tools[name] = { def, handler }; } };
registerEinsteinTools(stub);
registerOmniChannelTools(stub);

async function callTool(name, params) {
  const t = tools[name];
  if (!t) throw new Error(`tool ${name} not registered`);
  const schema = typeof t.def.inputSchema?.parse === 'function' ? t.def.inputSchema : z.object(t.def.inputSchema);
  const res = await t.handler(schema.parse(params));
  try { return JSON.parse(res.content[0].text); }
  catch { return { success: false, message: res.content?.[0]?.text ?? 'unparseable tool result' }; }
}

const results = [];
let pass = 0, fail = 0, skip = 0;
function record(section, name, ok, detail = '') {
  results.push({ section, name, ok, detail });
  if (ok) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name} :: ${String(detail).slice(0, 240)}`); }
}
function recordSkip(section, name, why) {
  results.push({ section, name, ok: null, detail: why });
  skip++; console.log(`  SKIP ${name} :: ${String(why).slice(0, 160)}`);
}
function section(t) { console.log(`\n${'─'.repeat(72)}\n  ${t}\n${'─'.repeat(72)}`); }

// "You don't have access to bots of type Bot" is an entitlement boundary: this org licenses
// Agentforce agents (EinsteinServiceAgent) but not classic Einstein Bots. Not a defect.
const UNAVAILABLE = /Could not find the Application Id|Not available for deploy for this (organization|API version)|INVALID_TYPE|not available for this organization|is not enabled|not supported|don&apos;t have access to bots|don't have access to bots/i;
const unavailable = (r) => r && r.success === false && UNAVAILABLE.test(r.message ?? '');

async function existsInOrg(sobject, devName, field = 'DeveloperName') {
  try {
    const r = await queryRecords(auth, { soql: `SELECT Id FROM ${sobject} WHERE ${field} = '${devName}'` });
    return (r.records ?? []).length > 0;
  } catch { return false; }
}

console.log('Tools under test:', ['sf_create_einstein_bot', 'sf_create_bot_routing', 'sf_create_einstein_prediction', 'sf_assign_skill_to_agent']
  .map(n => `${n}${tools[n] ? '' : ' (NOT REGISTERED)'}`).join(', '));

// ─── sf_create_einstein_bot ───────────────────────────────────────────────────
section('A. sf_create_einstein_bot');

const botName = `QAEBot_${TS}`;
const rBot = await callTool('sf_create_einstein_bot', {
  botName, label: 'QA Einstein Bot', description: 'QA classic Einstein bot',
  dialogs: [
    { name: 'Welcome', label: 'Welcome', type: 'Main' },
    { name: 'Goodbye', label: 'Goodbye', type: 'Main' },
  ],
});
if (unavailable(rBot)) {
  recordSkip('A', 'einstein bot deploys', rBot.message);
  recordSkip('A', 'einstein bot exists in org', 'depends on the deploy');
} else {
  record('A', 'einstein bot deploys', rBot.success, rBot.message);
  record('A', 'einstein bot exists in org', await existsInOrg('BotDefinition', botName),
    'BotDefinition row not found after a reported-successful deploy');
}

// Schema guardrail: the API name pattern must reject spaces.
try {
  await callTool('sf_create_einstein_bot', { botName: 'QA Bad Name', label: 'x', dialogs: [{ name: 'D', label: 'D' }] });
  record('A', 'invalid botName rejected by schema', false, 'schema accepted a name with spaces');
} catch (e) { record('A', 'invalid botName rejected by schema', true, e.message?.slice(0, 60)); }

// ─── sf_create_bot_routing ────────────────────────────────────────────────────
section('B. sf_create_bot_routing');

// Needs a real queue to transfer to; find one rather than assuming a name exists.
const queues = await queryRecords(auth, { soql: "SELECT DeveloperName FROM Group WHERE Type = 'Queue' LIMIT 1" })
  .catch(() => ({ records: [] }));
const queueName = queues.records?.[0]?.DeveloperName;

if (!queueName) {
  recordSkip('B', 'bot routing deploys', 'no Queue exists in this org to transfer to');
} else if (!rBot.success) {
  recordSkip('B', 'bot routing deploys', 'depends on the Einstein bot, which did not deploy');
} else {
  const rRoute = await callTool('sf_create_bot_routing', {
    botName, transferToQueueName: queueName, transferMessage: 'Connecting you to an agent',
    escalationConditions: [{ trigger: 'agentRequested', action: 'TransferToQueue' }],
  });
  if (unavailable(rRoute)) recordSkip('B', 'bot routing deploys', rRoute.message);
  else record('B', 'bot routing deploys', rRoute.success, rRoute.message);
}

// Routing against a bot that does not exist must fail rather than silently succeed.
if (queueName) {
  const rBad = await callTool('sf_create_bot_routing', {
    botName: `NoSuchBot_${TS}`, transferToQueueName: queueName,
  });
  record('B', 'routing for a nonexistent bot is rejected', rBad.success === false,
    rBad.success ? 'reported success for a bot that does not exist' : rBad.message);
} else {
  recordSkip('B', 'routing for a nonexistent bot is rejected', 'no Queue exists in this org');
}

// ─── sf_create_einstein_prediction ────────────────────────────────────────────
section('C. sf_create_einstein_prediction');

const predName = `QAPred_${TS}`;
const rPred = await callTool('sf_create_einstein_prediction', {
  predictionName: predName, label: 'QA Prediction', objectApiName: 'Opportunity',
  predictionType: 'BinaryClassification', targetField: 'IsWon',
  aiApplicationDeveloperName: `QAApp_${TS}`,
});
if (unavailable(rPred)) {
  recordSkip('C', 'einstein prediction deploys', rPred.message);
} else {
  record('C', 'einstein prediction deploys', rPred.success, rPred.message);
}

// The schema preprocesses the friendly 'Classification' into 'BinaryClassification'.
try {
  const rAlias = await callTool('sf_create_einstein_prediction', {
    predictionName: `QAPredAlias_${TS}`, label: 'QA Prediction Alias',
    objectApiName: 'Opportunity', predictionType: 'Classification', targetField: 'IsWon',
    aiApplicationDeveloperName: `QAApp_${TS}`,
  });
  record('C', "predictionType alias 'Classification' is accepted by the schema", true,
    `handler reached; deploy result: ${rAlias.success}`);
} catch (e) {
  record('C', "predictionType alias 'Classification' is accepted by the schema", false, e.message?.slice(0, 120));
}

// ─── sf_assign_skill_to_agent ─────────────────────────────────────────────────
section('D. sf_assign_skill_to_agent');

const skillName = `QASkill_${TS}`;
const rSkill = await callTool('sf_create_skill', { skillName, label: 'QA Skill' })
  .catch(e => ({ success: false, message: e.message }));
record('D', 'backing skill deploys', rSkill.success, rSkill.message);

const me = await queryRecords(auth, { soql: 'SELECT Username FROM User WHERE IsActive = true LIMIT 1' })
  .catch(() => ({ records: [] }));
const username = me.records?.[0]?.Username;

if (!rSkill.success || !username) {
  recordSkip('D', 'skill assignment succeeds', !username ? 'no active user found' : 'backing skill did not deploy');
} else {
  const rAssign = await callTool('sf_assign_skill_to_agent', { skillName, username, skillLevel: 7 });
  if (unavailable(rAssign)) recordSkip('D', 'skill assignment succeeds', rAssign.message);
  else record('D', 'skill assignment succeeds', rAssign.success, rAssign.message);
}

// Assigning to a user that does not exist must fail loudly.
const rBadUser = await callTool('sf_assign_skill_to_agent', {
  skillName, username: `nosuchuser_${TS}@example.invalid`, skillLevel: 5,
});
record('D', 'assignment to a nonexistent user is rejected', rBadUser.success === false,
  rBadUser.success ? 'reported success for a user that does not exist' : rBadUser.message);

// skillLevel is bounded 0-10.
try {
  await callTool('sf_assign_skill_to_agent', { skillName, username: username ?? 'x@y.z', skillLevel: 99 });
  record('D', 'out-of-range skillLevel rejected by schema', false, 'schema accepted skillLevel=99');
} catch (e) { record('D', 'out-of-range skillLevel rejected by schema', true, e.message?.slice(0, 60)); }

// ─── Summary ──────────────────────────────────────────────────────────────────
console.log(`\n${'═'.repeat(72)}`);
console.log(`  TOTAL: ${pass} passed, ${fail} failed, ${skip} skipped, ${pass + fail + skip} checks`);
console.log('═'.repeat(72));
const bySec = {};
for (const r of results) {
  bySec[r.section] ??= { p: 0, f: 0, s: 0 };
  if (r.ok === null) bySec[r.section].s++; else r.ok ? bySec[r.section].p++ : bySec[r.section].f++;
}
for (const [s, v] of Object.entries(bySec)) console.log(`  ${s}: ${v.p} passed, ${v.f} failed, ${v.s} skipped`);
if (fail) {
  console.log('\n  FAILURES:');
  for (const r of results.filter(r => r.ok === false)) console.log(`   - [${r.section}] ${r.name} :: ${String(r.detail).slice(0, 260)}`);
}
if (skip) {
  console.log('\n  SKIPPED (org capability, not a pass):');
  for (const r of results.filter(r => r.ok === null)) console.log(`   - [${r.section}] ${r.name} :: ${String(r.detail).slice(0, 200)}`);
}
