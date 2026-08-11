/**
 * Live test for the 5 tools added 2026-08-11 (v2.12.0) and the two service functions rewritten
 * underneath them:
 *   sf_list_objects, sf_get_metadata_dependencies, sf_update_custom_object,
 *   sf_update_custom_field, sf_disable_debug_logs
 * plus wildcard modes on sf_get_apex_class / sf_get_apex_trigger.
 *
 * The centrepiece is the SAFETY section. The whole point of the rewrite is that a change which
 * could lose data must not land on the first call, and that editing one field must not disturb any
 * other field on the object — the exact failure mode of the deleted regex/upsertMetadata versions.
 * Those two properties are asserted against a live org, not reasoned about.
 *
 * Run: SF_ALIAS=demo-org SF_INSTANCE_URL=<url> node test-new-tools-v212.mjs
 */

import { readFileSync, existsSync } from 'node:fs';
if (existsSync('.env.local')) {
  for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}

import {
  getAuth, listObjects, getApexClass, getApexTrigger, enableDebugLogs, disableDebugLogs,
  describeObject, createCustomObject, createCustomField, createRecord, queryRecords,
  deleteMetadataItems, API_VERSION,
} from './dist/services/salesforce.js';
import {
  getMetadataDependencies, updateCustomFieldSafe, updateCustomObjectSafe,
  metadataJsonToXml, classifyFieldChanges, DEPENDENCY_BLIND_SPOTS,
} from './dist/services/impact.js';
import { createClient } from './dist/services/salesforce.js';

/**
 * Lists a custom object's fields via the TOOLING API rather than REST describe.
 *
 * This matters: Salesforce's REST describe/SOQL schema cache lags the Metadata API by minutes on
 * this org (already documented in describeObject's own comments). Asserting "the bystander field
 * survived" against describe therefore measures Salesforce's cache, not our merge semantics, and
 * yields a false failure. Tooling CustomField is authoritative and immediate.
 */
async function toolingFieldNames(auth, objectApiName) {
  const c = createClient(auth);
  const dev = objectApiName.replace(/__c$/, '');
  const oid = await c.get('/tooling/query?q=' + encodeURIComponent("SELECT Id FROM CustomObject WHERE DeveloperName = '" + dev + "'"));
  const id = oid.data.records && oid.data.records[0] && oid.data.records[0].Id;
  if (!id) return [];
  const r = await c.get('/tooling/query?q=' + encodeURIComponent("SELECT DeveloperName FROM CustomField WHERE TableEnumOrId = '" + id + "'"));
  return (r.data.records || []).map(f => f.DeveloperName + '__c');
}

/** Polls until a field is visible to SOQL, which is exactly what the data probe needs. */
async function waitForSoqlVisibility(auth, obj, fld, maxMs = 300000) {
  const c = createClient(auth);
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    try {
      await c.get('/query?q=' + encodeURIComponent('SELECT COUNT() FROM ' + obj + ' WHERE ' + fld + ' != null'));
      return true;
    } catch { await new Promise(r => setTimeout(r, 10000)); }
  }
  return false;
}

const TS = Date.now().toString().slice(-6);
const OBJ = `ImpactTest${TS}__c`;
const FLD = `Payload${TS}__c`;
const FLD2 = `Bystander${TS}__c`;

let passed = 0, failed = 0;
const failures = [];
const pass = (n, extra = '') => { passed++; console.log(`  PASS  ${n}${extra ? '  (' + extra + ')' : ''}`); };
const fail = (n, err) => { failed++; const m = typeof err === 'string' ? err : (err?.message ?? JSON.stringify(err)); failures.push({ n, m }); console.log(`  FAIL  ${n}  ->  ${String(m).slice(0, 400)}`); };

async function main() {
  const auth = await getAuth();
  console.log(`Authenticated against ${auth.instanceUrl}`);
  console.log(`API_VERSION in use: ${API_VERSION}\n`);

  // ══ 1. sf_list_objects ══
  console.log('=== sf_list_objects (gap #1) ===');
  {
    const r = await listObjects(auth, { searchTerm: 'Account', limit: 10 });
    if (!r.success) fail('list objects searchTerm=Account', r.message);
    else if (r.objects[0]?.name !== 'Account') fail('exact match ranks first', `got '${r.objects[0]?.name}'`);
    else pass('list objects searchTerm=Account, exact match ranks first', `${r.matched} matched of ${r.totalObjectsInOrg}`);
  }
  {
    const r = await listObjects(auth, { objectType: 'custom', limit: 500 });
    const bad = (r.objects ?? []).filter(o => !o.custom);
    if (!r.success) fail('list objects objectType=custom', r.message);
    else if (bad.length) fail('objectType=custom filter', `${bad.length} standard object(s) leaked through`);
    else pass('list objects objectType=custom', `${r.matched} custom object(s)`);
  }
  {
    const r = await listObjects(auth, { searchTerm: 'zzz_no_such_object_zzz' });
    if (r.success && r.matched === 0) pass('list objects no-match returns empty, not error');
    else fail('list objects no-match', r.message);
  }

  // ══ 2. Apex wildcard listing ══
  console.log('\n=== sf_get_apex_class / sf_get_apex_trigger wildcards (gap #3) ===');
  let sampleClass = null;
  {
    const r = await getApexClass(auth, { namePattern: '*', limit: 5 });
    if (!r.success) fail('apex class namePattern=*', r.message);
    else {
      sampleClass = r.classes?.[0]?.name ?? null;
      if (r.classes?.some(c => c.body !== undefined)) fail('pattern mode omits bodies', 'a body was returned');
      else pass('apex class namePattern=* lists without bodies', `${r.matchCount} class(es)`);
    }
  }
  if (sampleClass) {
    const prefix = sampleClass.slice(0, 3);
    const r = await getApexClass(auth, { namePattern: `${prefix}*` });
    if (r.success && r.classes.some(c => c.name === sampleClass)) pass(`apex class namePattern='${prefix}*' finds '${sampleClass}'`, `${r.matchCount} match(es)`);
    else fail(`apex class namePattern='${prefix}*'`, r.message ?? 'expected class missing');

    const exact = await getApexClass(auth, { className: sampleClass });
    if (exact.success && typeof exact.body === 'string' && exact.body.length > 0) pass('apex class exact name still returns full body (regression)', `${exact.body.length} chars`);
    else fail('apex class exact name returns body', exact.message);
  } else {
    console.log('  SKIP  no Apex classes in org to pattern-match against');
  }
  {
    // A literal underscore must not act as a single-char wildcard.
    const r = await getApexClass(auth, { namePattern: 'A_B_C_no_such_class' });
    if (r.success && r.matchCount === 0) pass('literal underscore is escaped, not treated as wildcard');
    else fail('underscore escaping', r.message ?? `unexpectedly matched ${r.matchCount}`);
  }
  {
    const r = await getApexTrigger(auth, { objectName: 'Account' });
    if (r.success) pass('apex trigger objectName=Account', `${r.matchCount} trigger(s)`);
    else fail('apex trigger objectName=Account', r.message);
  }
  {
    const r = await getApexClass(auth, {});
    if (!r.success && /provide either/i.test(r.message)) pass('apex class with no args gives an actionable error');
    else fail('apex class no-args guard', r.message);
  }

  // ══ 3. Debug log disable ══
  console.log('\n=== sf_disable_debug_logs (gap #4) ===');
  {
    // Resolve a real active user IN THIS org rather than trusting an env var — .env.local points at
    // a different org, and enableDebugLogs fails on an unknown username.
    const me = await queryRecords(auth, { query: `SELECT Username FROM User WHERE IsActive = true ORDER BY CreatedDate ASC LIMIT 1` });
    const who = me?.records?.[0]?.Username;
    if (!who) { console.log('  SKIP  no active user found to trace'); }
    else {
    const en = await enableDebugLogs(auth, { username: who, durationMinutes: 5, debugLevel: 'ERROR' });
    if (!en.success) { console.log(`  SKIP  could not enable debug logs for ${who}: ${en.message}`); }
    else {
      const dis = await disableDebugLogs(auth, { username: who });
      if (dis.success && dis.deleted >= 1) pass('disable debug logs removes the trace flag', `${who}, ${dis.deleted} deleted`);
      else fail('disable debug logs', dis.message);
      const again = await disableDebugLogs(auth, { username: who });
      if (again.success && again.deleted === 0) pass('disable debug logs is idempotent (second call is a clean no-op)');
      else fail('disable debug logs idempotency', again.message);
    }
    }
  }

  // ══ 4. Setup for the safety tests ══
  console.log('\n=== Setup: object with a populated field and a bystander field ===');
  {
    const o = await createCustomObject(auth, {
      fullName: OBJ, label: `Impact Test ${TS}`, pluralLabel: `Impact Tests ${TS}`,
      nameField: { label: 'Name', type: 'Text' }, deploymentStatus: 'Deployed', sharingModel: 'ReadWrite',
    });
    if (!o.success) { fail('create test object', o.message); return finish(); }
    pass('created test object', OBJ);
  }
  {
    const f1 = await createCustomField(auth, { fullName: `${OBJ}.${FLD}`, label: 'Payload', type: 'Text', length: 50 });
    const f2 = await createCustomField(auth, { fullName: `${OBJ}.${FLD2}`, label: 'Bystander', type: 'Text', length: 40 });
    if (!f1.success || !f2.success) { fail('create test fields', `${f1.message} | ${f2.message}`); return finish(); }
    pass('created 2 test fields', `${FLD}, ${FLD2}`);
  }
  console.log('  waiting for the Salesforce schema cache to expose the new fields to SOQL...');
  const soqlReady = await waitForSoqlVisibility(auth, OBJ, FLD);
  let dataSeeded = false;
  if (!soqlReady) {
    console.log('  SKIP  field never became SOQL-visible within 5 min (Salesforce schema-cache lag,');
    console.log('        documented in describeObject; not a defect here). Data-probe assertions are');
    console.log('        skipped; every gate assertion below still runs.');
  } else {
    const r = await createRecord(auth, { objectApiName: OBJ, fields: { Name: 'row-1', [FLD]: 'x'.repeat(45), [FLD2]: 'keep me' } });
    if (r.success) { dataSeeded = true; pass('seeded a record holding 45 chars in the field under test'); }
    else fail('seed record', r.message);
  }

  // ══ 5. Dependency analysis ══
  console.log('\n=== sf_get_metadata_dependencies ===');
  {
    const r = await getMetadataDependencies(auth, { componentType: 'CustomField', componentName: `${OBJ}.${FLD}` });
    if (!r.success) fail('dependencies on custom field', r.message);
    else if (!Array.isArray(r.blindSpots) || r.blindSpots.length === 0) fail('blindSpots always present', 'missing');
    else if (!dataSeeded) pass('dependencies returned (data probe skipped: field not SOQL-visible)', `${r.usedByCount} dep(s)`);
    else if (r.dataProbe?.recordsWithData !== 1) fail('data probe counts populated records', `expected 1, got ${r.dataProbe?.recordsWithData}`);
    else pass('dependencies + data probe on a populated field', `${r.usedByCount} dep(s), ${r.dataProbe.recordsWithData} record(s) with data`);
  }
  {
    const r = await getMetadataDependencies(auth, { componentType: 'CustomField', componentName: `${OBJ}.NoSuchField__c` });
    if (!r.success && Array.isArray(r.blindSpots)) pass('dependencies on missing field errors cleanly, still returns blindSpots');
    else fail('dependencies missing-field handling', r.message);
  }

  // ══ 6. THE SAFETY TESTS ══
  console.log('\n=== SAFETY: sf_update_custom_field risk gate ===');
  {
    const r = await updateCustomFieldSafe(auth, { objectApiName: OBJ, fieldApiName: FLD, label: 'Payload Renamed' });
    if (r.applied && r.status === 'APPLIED' && r.riskTier === 'SAFE') pass('SAFE change (label) applies on the first call');
    else fail('SAFE change applies immediately', `${r.status}: ${r.message}`);
  }
  {
    // The regression that motivated the whole rewrite: editing one field must not disturb another.
    const names = await toolingFieldNames(auth, OBJ);
    if (names.includes(FLD) && names.includes(FLD2)) pass('bystander field survived the FIELD update (merge semantics hold)', `${names.length} custom field(s)`);
    else fail('bystander field survived field update', `custom fields now: ${names.join(', ') || '(none)'}`);
  }
  {
    const r = await updateCustomFieldSafe(auth, { objectApiName: OBJ, fieldApiName: FLD, length: 10 });
    if (r.applied) fail('DESTRUCTIVE length reduction must NOT auto-apply', 'it applied');
    else if (r.status === 'CONFIRMATION_REQUIRED' && r.riskTier === 'DESTRUCTIVE') {
      pass('DESTRUCTIVE length reduction gated, not applied', `${r.impact?.dependencyCount} dep(s)`);
      if (!dataSeeded) {
        // Field is not SOQL-visible so the probe cannot count. What matters is that it SAYS so
        // rather than reporting a reassuring zero.
        if (r.impact?.dataProbe?.queried === false && /UNKNOWN/i.test(r.impact.dataProbe.note)) pass('data probe reports UNKNOWN rather than a false zero when it cannot count');
        else fail('data probe honesty when uncountable', JSON.stringify(r.impact?.dataProbe));
      } else if (r.impact?.dataProbe?.recordsWithData === 1) pass('gated report includes an accurate data probe');
      else fail('gated report includes the data probe', JSON.stringify(r.impact?.dataProbe));
    }
    else if (r.status === 'VALIDATION_FAILED') pass('DESTRUCTIVE length reduction blocked by Salesforce validation, not applied', r.message.slice(0, 120));
    else fail('DESTRUCTIVE gate', `${r.status}: ${r.message}`);
  }
  {
    if (!dataSeeded) console.log('  SKIP  data-untouched check (no data could be seeded)');
    else {
      const before = await queryRecords(auth, { query: `SELECT ${FLD} FROM ${OBJ} LIMIT 1` });
      const stillLong = (before.records?.[0]?.[FLD] ?? '').length === 45;
      if (stillLong) pass('the gated change really did not touch the data (still 45 chars)');
      else fail('data untouched after gated change', `length is now ${(before.records?.[0]?.[FLD] ?? '').length}`);
    }
  }
  {
    const r = await updateCustomFieldSafe(auth, { objectApiName: OBJ, fieldApiName: FLD, type: 'Number' });
    if (r.status === 'REFUSED' && !r.applied) pass('type change is REFUSED outright');
    else fail('type change refused', `${r.status}: ${r.message}`);
  }
  {
    const r = await updateCustomFieldSafe(auth, { objectApiName: OBJ, fieldApiName: FLD, fullName: `Renamed${TS}__c` });
    if (r.status === 'REFUSED' && !r.applied) pass('API-name rename is REFUSED outright');
    else fail('rename refused', `${r.status}: ${r.message}`);
  }
  {
    const r = await updateCustomFieldSafe(auth, { objectApiName: OBJ, fieldApiName: FLD, length: 120, confirmImpact: true });
    if (r.applied && r.riskTier === 'GUARDED') pass('GUARDED length increase applies with confirmImpact:true');
    else fail('GUARDED applies on confirm', `${r.status}: ${r.message}`);
  }
  {
    const r = await updateCustomFieldSafe(auth, { objectApiName: OBJ, fieldApiName: FLD, label: 'Payload Renamed' });
    if (r.status === 'NO_CHANGES' && !r.applied) pass('no-op update is detected and skipped');
    else fail('no-op detection', `${r.status}: ${r.message}`);
  }

  console.log('\n=== SAFETY: sf_update_custom_object risk gate ===');
  {
    const r = await updateCustomObjectSafe(auth, { objectApiName: OBJ, description: 'Updated by v2.12 test' });
    if (r.applied && r.riskTier === 'SAFE') pass('SAFE object change (description) applies immediately');
    else fail('SAFE object change', `${r.status}: ${r.message}`);
  }
  {
    const names = await toolingFieldNames(auth, OBJ);
    if (names.includes(FLD) && names.includes(FLD2)) pass('object-level update left BOTH custom fields intact', `${names.length} custom field(s)`);
    else fail('object update preserved fields', `custom fields now: ${names.join(', ') || '(none)'}`);
  }
  {
    const r = await updateCustomObjectSafe(auth, { objectApiName: OBJ, sharingModel: 'Private' });
    if (!r.applied && r.status === 'CONFIRMATION_REQUIRED' && r.riskTier === 'GUARDED') pass('GUARDED sharingModel change is gated, not applied');
    else if (r.status === 'VALIDATION_FAILED') pass('GUARDED sharingModel rejected by Salesforce validation, not applied', r.message.slice(0, 100));
    else fail('object GUARDED gate', `${r.status}: ${r.message}`);
  }
  {
    const r = await updateCustomObjectSafe(auth, { objectApiName: 'Account', label: 'Nope' });
    if (r.status === 'REFUSED') pass('standard object is refused');
    else fail('standard object refused', `${r.status}: ${r.message}`);
  }

  // ══ 7. Pure-unit checks ══
  console.log('\n=== Unit: serializer and classifier ===');
  {
    const xml = metadataJsonToXml({ label: 'B', fullName: 'A__c', nothing: null, empty: '', nested: { k: 'v' } }, '');
    const order = xml.indexOf('<fullName>') < xml.indexOf('<label>');
    if (order && !xml.includes('nothing') && !xml.includes('<empty>') && xml.includes('<nested>')) pass('serializer: fullName first, nulls/empties dropped, nesting kept');
    else fail('serializer', xml);
  }
  {
    const xml = metadataJsonToXml({ label: 'Tom & "Jerry" <b>' }, '');
    if (xml.includes('&amp;') && xml.includes('&quot;') && xml.includes('&lt;b&gt;')) pass('serializer escapes XML metacharacters');
    else fail('serializer escaping', xml);
  }
  {
    const c = classifyFieldChanges({ type: 'Text', length: 50, required: false }, { length: 10 });
    const d = classifyFieldChanges({ type: 'Text', length: 50 }, { length: 90 });
    if (c[0]?.tier === 'DESTRUCTIVE' && d[0]?.tier === 'GUARDED') pass('classifier: length decrease DESTRUCTIVE, increase GUARDED');
    else fail('classifier length tiers', JSON.stringify([c[0], d[0]]));
  }
  {
    const c = classifyFieldChanges({ valueSet: { valueSetDefinition: { value: [{ fullName: 'A' }, { fullName: 'B' }] } } }, { picklistValues: ['A'] });
    if (c[0]?.tier === 'DESTRUCTIVE' && /removes 1/i.test(c[0].reason)) pass('classifier: removing a picklist value is DESTRUCTIVE');
    else fail('classifier picklist removal', JSON.stringify(c));
  }
  {
    if (DEPENDENCY_BLIND_SPOTS.length >= 4) pass('blind-spot list is populated', `${DEPENDENCY_BLIND_SPOTS.length} entries`);
    else fail('blind-spot list', 'too short');
  }

  // ══ Cleanup ══
  console.log('\n=== Cleanup ===');
  const del = await deleteMetadataItems(auth, 'CustomObject', [OBJ]);
  console.log(del.success ? `  cleaned up ${OBJ}` : `  NOTE: could not delete ${OBJ}: ${del.message}`);

  finish();
}

function finish() {
  console.log(`\n${'='.repeat(60)}\nPASSED: ${passed}   FAILED: ${failed}`);
  if (failures.length) { console.log('\nFailures:'); failures.forEach(f => console.log(`  - ${f.n}: ${f.m}`)); }
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
