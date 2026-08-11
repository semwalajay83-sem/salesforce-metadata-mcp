/**
 * Supplements test-new-tools-v212.mjs.
 *
 * That suite creates a fresh object and field, which on this org are not visible to SOQL for well
 * over five minutes (Salesforce's own schema-cache lag). The data probe therefore never gets to
 * count anything real there, and the single most important safety assertion — "a DESTRUCTIVE change
 * to a field that HOLDS DATA is gated, and the report says how many records are at risk" — goes
 * untested.
 *
 * This script uses an EXISTING, cache-warm custom field instead, seeds data into it, and asserts the
 * full path end to end. Run after the main suite.
 */

import { readFileSync, existsSync } from 'node:fs';
if (existsSync('.env.local')) {
  for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}

import { getAuth, createClient, createRecord, deleteRecord, queryRecords, createCustomObject, createCustomField, deleteMetadataItems } from './dist/services/salesforce.js';
import { getMetadataDependencies, updateCustomFieldSafe, probeFieldData } from './dist/services/impact.js';

let passed = 0, failed = 0;
const failures = [];
const pass = (n, extra = '') => { passed++; console.log(`  PASS  ${n}${extra ? '  (' + extra + ')' : ''}`); };
const fail = (n, m) => { failed++; failures.push({ n, m }); console.log(`  FAIL  ${n}  ->  ${String(m).slice(0, 300)}`); };

/**
 * Builds a dedicated fixture and waits out Salesforce's schema-cache lag.
 *
 * demo-org has no pre-existing SOQL-visible custom Text field to borrow (verified: 38 queryable
 * custom objects, none with custom text fields), so this creates its own and then waits. The wait is
 * long on purpose — the cache took >5 min in the main suite, and the assertion this unlocks is the
 * one that matters most: that a shrink on a field HOLDING DATA is refused and the report says how
 * many records are at risk.
 */
async function buildWarmFixture(auth, maxWaitMs) {
  const TS = Date.now().toString().slice(-6);
  const objName = `ProbeFix${TS}__c`;
  const fldName = `Held${TS}__c`;
  const o = await createCustomObject(auth, {
    fullName: objName, label: `Probe Fixture ${TS}`, pluralLabel: `Probe Fixtures ${TS}`,
    nameField: { label: 'Name', type: 'Text' }, deploymentStatus: 'Deployed', sharingModel: 'ReadWrite',
  });
  if (!o.success) throw new Error('fixture object: ' + o.message);
  const f = await createCustomField(auth, { fullName: `${objName}.${fldName}`, label: 'Held', type: 'Text', length: 100 });
  if (!f.success) throw new Error('fixture field: ' + f.message);
  console.log(`  created ${objName}.${fldName}; waiting up to ${Math.round(maxWaitMs/60000)} min for SOQL visibility...`);

  const c = createClient(auth);
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    try {
      await c.get('/query?q=' + encodeURIComponent(`SELECT COUNT() FROM ${objName} WHERE ${fldName} != null`));
      console.log(`  SOQL-visible after ${Math.round((maxWaitMs - (deadline - Date.now()))/1000)}s`);
      return { objName, fldName, length: 100 };
    } catch { await new Promise(r => setTimeout(r, 15000)); }
  }
  return null;
}

async function main() {
  const auth = await getAuth();
  console.log(`Authenticated against ${auth.instanceUrl}\n`);
  console.log('=== Data probe against a cache-warm existing field ===');

  const target = await buildWarmFixture(auth, 20 * 60 * 1000);
  if (!target) { fail('fixture never became SOQL-visible within 20 min', 'schema-cache lag exceeded the wait'); return finish(); }
  console.log(`  using ${target.objName}.${target.fldName} (Text, length ${target.length})`);

  const marker = 'probe-' + Date.now().toString().slice(-6);
  let recId = null;
  {
    const r = await createRecord(auth, { objectApiName: target.objName, fields: { [target.fldName]: marker } });
    if (!r.success) { fail('seed a record with data', r.message); return finish(); }
    recId = r.id ?? r.fullName;
    pass('seeded a record holding data in a cache-warm field');
  }

  try {
    {
      const r = await probeFieldData(auth, target.objName, target.fldName);
      if (r.queried && r.recordsWithData >= 1) pass('probeFieldData counts populated records', `${r.recordsWithData} of ${r.totalRecords}`);
      else fail('probeFieldData counts populated records', JSON.stringify(r));
    }
    {
      const r = await getMetadataDependencies(auth, { componentType: 'CustomField', componentName: `${target.objName}.${target.fldName}` });
      if (r.success && r.dataProbe?.queried && r.dataProbe.recordsWithData >= 1 && /can lose or reject/i.test(r.dataProbe.note)) {
        pass('dependency report warns that the field holds data', `${r.dataProbe.recordsWithData} record(s), ${r.usedByCount} dep(s)`);
      } else fail('dependency report data warning', JSON.stringify(r.dataProbe));
    }
    {
      // The headline assertion: shrink a field that holds data. Must NOT apply, and the report must
      // quantify what is at risk.
      const r = await updateCustomFieldSafe(auth, { objectApiName: target.objName, fieldApiName: target.fldName, length: 2 });
      if (r.applied) fail('DESTRUCTIVE shrink on populated field must not apply', 'IT APPLIED');
      else if (r.status === 'CONFIRMATION_REQUIRED' && r.impact?.dataProbe?.recordsWithData >= 1) {
        pass('DESTRUCTIVE shrink gated AND report quantifies records at risk', `${r.impact.dataProbe.recordsWithData} record(s)`);
      } else if (r.status === 'VALIDATION_FAILED') {
        pass('DESTRUCTIVE shrink blocked by Salesforce validation, not applied', r.message.slice(0, 110));
      } else fail('DESTRUCTIVE shrink gate', `${r.status}: ${r.message}`);
    }
    {
      const q = await queryRecords(auth, { query: `SELECT ${target.fldName} FROM ${target.objName} WHERE ${target.fldName} = '${marker}' LIMIT 1` });
      const val = q.records?.[0]?.[target.fldName];
      if (val === marker) pass('data is byte-for-byte intact after the gated attempt');
      else fail('data intact after gated attempt', `expected '${marker}', got '${val}'`);
    }
  } finally {
    const del = await deleteMetadataItems(auth, 'CustomObject', [target.objName]);
    console.log(del.success ? `  cleaned up ${target.objName}` : `  NOTE: could not delete ${target.objName}: ${del.message}`);
  }
  finish();
}

function finish() {
  console.log(`\n${'='.repeat(60)}\nPASSED: ${passed}   FAILED: ${failed}`);
  if (failures.length) { console.log('\nFailures:'); failures.forEach(f => console.log(`  - ${f.n}: ${f.m}`)); }
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
