/**
 * Regression + smoke test for the 7 new tools added 2026-07-23
 * (sf_describe_object, sf_get_apex_class, sf_get_apex_trigger,
 *  sf_enable_debug_logs, sf_get_debug_logs, sf_get_debug_log_body,
 *  sf_get_field_permissions) plus a couple of pre-existing tools whose
 * code path was touched (sf_query_records description only) or whose
 * output the new tools depend on (create apex class/trigger).
 *
 * Run: node test-new-tools.mjs (credentials from .env.local)
 */

import { readFileSync, existsSync } from 'node:fs';
if (existsSync('.env.local')) {
  for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}

import {
  getAuth, queryRecords, describeObject, getApexClass, getApexTrigger,
  enableDebugLogs, getApexLogs, getApexLogBody, getFieldPermissions,
} from './dist/services/salesforce.js';
import { executeAnonymousApex } from './dist/services/tooling.js';
import { buildApexClassZip, buildApexTriggerZip, deployZip, pollDeployStatus } from './dist/services/deployment.js';

const TS = Date.now().toString().slice(-6);
let passed = 0, failed = 0;
const failures = [];
function pass(name, extra = '') { passed++; console.log(`  ✅ PASS  ${name}${extra ? '  (' + extra + ')' : ''}`); }
function fail(name, err) { failed++; const msg = typeof err === 'string' ? err : (err?.message ?? JSON.stringify(err)); failures.push({ name, msg }); console.log(`  ❌ FAIL  ${name}  →  ${String(msg).slice(0, 300)}`); }

async function main() {
  const auth = await getAuth();
  console.log(`Authenticated against ${auth.instanceUrl}\n`);

  // ── Regression: pre-existing sf_query_records still works (description-only edit) ──
  console.log('═══ REGRESSION: sf_query_records (existing tool, touched description only) ═══');
  {
    const r = await queryRecords(auth, { query: 'SELECT Id, Name FROM Account LIMIT 3' });
    if (r.success) pass('sf_query_records basic SELECT', `${r.totalSize ?? r.records?.length ?? 0} record(s)`);
    else fail('sf_query_records basic SELECT', r.message);
  }
  {
    const r = await queryRecords(auth, { query: 'SELECT Industry, COUNT(Id) FROM Account GROUP BY Industry LIMIT 5' });
    if (r.success) pass('sf_query_records GROUP BY aggregate query (new capability documented)', `${r.records?.length ?? 0} group(s)`);
    else fail('sf_query_records GROUP BY aggregate query', r.message);
  }

  // ── New: sf_describe_object ──
  console.log('\n═══ NEW: sf_describe_object ═══');
  {
    const r = await describeObject(auth, { objectApiName: 'Account' });
    if (r.success && r.fields?.length > 0) pass('sf_describe_object Account (full)', `${r.fields.length} fields, ${r.childRelationships?.length ?? 0} child rels`);
    else fail('sf_describe_object Account (full)', r.message ?? 'no fields returned');
  }
  {
    const r = await describeObject(auth, { objectApiName: 'Account', fieldsOnly: true });
    if (r.success && r.fields?.length > 0 && r.childRelationships === undefined) pass('sf_describe_object Account (fieldsOnly)', `${r.fields.length} fields`);
    else fail('sf_describe_object Account (fieldsOnly)', r.message ?? 'unexpected shape');
  }

  // ── New: sf_get_apex_class (deploy a throwaway class via existing deploy path, then read it back) ──
  console.log('\n═══ NEW: sf_get_apex_class (+ regression on existing deploy path) ═══');
  const className = `MCP_Test_Class_${TS}`;
  {
    const classBody = `public class ${className} { public static String hello() { return 'hi'; } }`;
    try {
      const zip = await buildApexClassZip(className, classBody, '66.0');
      const deployId = await deployZip(auth, zip);
      const deployResult = await pollDeployStatus(auth, deployId, 5 * 60 * 1000);
      if (deployResult.success) pass('deploy throwaway Apex class (existing path, regression check)');
      else fail('deploy throwaway Apex class', deployResult.message ?? JSON.stringify(deployResult));
    } catch (err) { fail('deploy throwaway Apex class', err); }
  }
  {
    const r = await getApexClass(auth, { className });
    if (r.success && r.body?.includes('hello')) pass('sf_get_apex_class reads back deployed source');
    else fail('sf_get_apex_class', r.message ?? 'body did not match');
  }
  {
    const r = await getApexClass(auth, { className: `NoSuchClass_${TS}` });
    if (!r.success && /not found/i.test(r.message)) pass('sf_get_apex_class handles missing class gracefully');
    else fail('sf_get_apex_class missing-class handling', JSON.stringify(r));
  }

  // ── New: sf_get_apex_trigger (deploy a throwaway trigger, then read it back) ──
  console.log('\n═══ NEW: sf_get_apex_trigger ═══');
  const triggerName = `MCP_Test_Trigger_${TS}`;
  {
    const triggerBody = `// mcp regression test trigger`;
    try {
      const zip = await buildApexTriggerZip(triggerName, 'Account', ['before insert'], triggerBody, '66.0');
      const deployId = await deployZip(auth, zip);
      const deployResult = await pollDeployStatus(auth, deployId, 5 * 60 * 1000);
      if (deployResult.success) pass('deploy throwaway Apex trigger (existing path, regression check)');
      else fail('deploy throwaway Apex trigger', deployResult.message ?? JSON.stringify(deployResult));
    } catch (err) { fail('deploy throwaway Apex trigger', err); }
  }
  {
    const r = await getApexTrigger(auth, { triggerName });
    if (r.success && r.objectName === 'Account') pass('sf_get_apex_trigger reads back deployed trigger', `on ${r.objectName}`);
    else fail('sf_get_apex_trigger', r.message ?? JSON.stringify(r));
  }

  // ── New: debug log chain — enable, generate activity, list, fetch body ──
  console.log('\n═══ NEW: sf_enable_debug_logs → sf_get_debug_logs → sf_get_debug_log_body ═══');
  const username = process.env.SF_JWT_USERNAME;
  let enableResult;
  {
    enableResult = await enableDebugLogs(auth, { username, durationMinutes: 15, debugLevel: 'FINEST' });
    if (enableResult.success) pass('sf_enable_debug_logs', `traceFlagId=${enableResult.traceFlagId}`);
    else fail('sf_enable_debug_logs', enableResult.message);
  }
  if (enableResult?.success) {
    try {
      const anonResult = await executeAnonymousApex(auth, `System.debug('MCP regression test log line ${TS}');`);
      if (anonResult.success) pass('generate log activity via execute_anonymous_apex (existing tool, regression check)');
      else fail('generate log activity', anonResult.message);
    } catch (err) { fail('generate log activity', err); }

    await new Promise((res) => setTimeout(res, 5000));

    const logsResult = await getApexLogs(auth, { username, limit: 5 });
    if (logsResult.success) pass('sf_get_debug_logs', `${logsResult.logs?.length ?? 0} log(s) found`);
    else fail('sf_get_debug_logs', logsResult.message);

    if (logsResult.success && logsResult.logs?.length > 0) {
      const logId = logsResult.logs[0].logId;
      const bodyResult = await getApexLogBody(auth, { logId });
      if (bodyResult.success) pass('sf_get_debug_log_body', `${bodyResult.logLength} chars`);
      else fail('sf_get_debug_log_body', bodyResult.message);
    } else {
      console.log('  (skipped sf_get_debug_log_body — no log id available yet, logs can take a few seconds to appear)');
    }
  }

  // ── New: sf_get_field_permissions ──
  console.log('\n═══ NEW: sf_get_field_permissions ═══');
  {
    const r = await getFieldPermissions(auth, { objectName: 'Account', fieldName: 'Name' });
    if (r.success) pass('sf_get_field_permissions Account.Name', `${r.grants?.length ?? 0} grant(s)`);
    else fail('sf_get_field_permissions', r.message);
  }

  console.log(`\n═══ SUMMARY: ${passed} passed, ${failed} failed ═══`);
  if (failures.length > 0) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f.name}: ${f.msg}`);
    process.exitCode = 1;
  }
}

main().catch((err) => { console.error('FATAL:', err); process.exitCode = 1; });
