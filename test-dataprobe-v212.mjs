/**
 * Supplements test-new-tools-v212.mjs by proving the ONE property that suite could not.
 *
 * That suite creates a fresh field, and on demo-org a new field stays invisible to SOQL for far
 * longer than is practical to wait (observed >20 min). Its data probe therefore never counted real
 * data — it only proved the honest-UNKNOWN fallback. What remained unproven is that `probeFieldData`
 * returns an ACCURATE count when it can query, and that the count is what reaches the impact report.
 *
 * This proves it against already-warm data rather than waiting on the cache:
 *   - accuracy is asserted against Account.Name, where the true count is independently known,
 *   - propagation into the report is asserted via getMetadataDependencies on a real custom field.
 *
 * The gate behaviour itself (DESTRUCTIVE withheld, type/rename refused, bystander fields survive) is
 * already covered by test-new-tools-v212.mjs and is not repeated here.
 */

import { readFileSync, existsSync } from 'node:fs';
if (existsSync('.env.local')) {
  for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}

import { getAuth, createClient, queryRecords } from './dist/services/salesforce.js';
import { probeFieldData, getMetadataDependencies } from './dist/services/impact.js';

let passed = 0, failed = 0;
const failures = [];
const pass = (n, extra = '') => { passed++; console.log(`  PASS  ${n}${extra ? '  (' + extra + ')' : ''}`); };
const fail = (n, m) => { failed++; failures.push({ n, m }); console.log(`  FAIL  ${n}  ->  ${String(m).slice(0, 300)}`); };

async function main() {
  const auth = await getAuth();
  const c = createClient(auth);
  console.log(`Authenticated against ${auth.instanceUrl}\n`);

  console.log('=== probeFieldData accuracy against independently-known counts ===');
  {
    // Account.Name is never null, so recordsWithData must equal totalRecords exactly.
    const truth = await c.get('/query?q=' + encodeURIComponent('SELECT COUNT() FROM Account'));
    const total = truth.data.totalSize;
    const r = await probeFieldData(auth, 'Account', 'Name');
    if (!r.queried) fail('probe queried Account.Name', r.note);
    else if (r.totalRecords !== total) fail('probe total matches independent count', `probe ${r.totalRecords} vs truth ${total}`);
    else if (r.recordsWithData !== total) fail('Name is never null so withData must equal total', `${r.recordsWithData} vs ${total}`);
    else pass('probe counts are exact against a known-populated field', `${r.recordsWithData}/${total} on Account.Name`);
  }
  {
    // A field that is null on every record must report 0 — the boundary the gate keys on.
    const truth = await c.get('/query?q=' + encodeURIComponent('SELECT COUNT() FROM Account WHERE Fax != null'));
    const r = await probeFieldData(auth, 'Account', 'Fax');
    if (r.queried && r.recordsWithData === truth.data.totalSize) {
      pass('probe agrees with an independent count on a sparse field', `${r.recordsWithData} record(s) with Fax`);
      if (r.recordsWithData === 0 && /not a concern/i.test(r.note)) pass('empty field yields the "no data-loss concern" note');
      else if (r.recordsWithData > 0 && /can lose or reject/i.test(r.note)) pass('populated field yields the data-loss warning note');
      else fail('note matches the count', r.note);
    } else fail('probe agrees on sparse field', JSON.stringify(r));
  }
  {
    const r = await probeFieldData(auth, 'Account', 'No_Such_Field__c');
    if (!r.queried && /UNKNOWN/i.test(r.note)) pass('unqueryable field reports UNKNOWN, never a reassuring zero');
    else fail('unqueryable field honesty', JSON.stringify(r));
  }

  console.log('\n=== the probe reaches the impact report ===');
  {
    // Find any custom field SOQL can already see, so the report path runs with a real count.
    const objs = await c.get('/tooling/query?q=' + encodeURIComponent(
      "SELECT Id, DeveloperName FROM CustomObject WHERE ManageableState = 'unmanaged' LIMIT 40"));
    let target = null;
    for (const o of objs.data.records ?? []) {
      const objName = o.DeveloperName + '__c';
      const flds = await c.get('/tooling/query?q=' + encodeURIComponent(
        `SELECT DeveloperName FROM CustomField WHERE TableEnumOrId = '${o.Id}' LIMIT 5`));
      for (const f of flds.data.records ?? []) {
        const fldName = f.DeveloperName + '__c';
        try {
          await c.get('/query?q=' + encodeURIComponent(`SELECT COUNT() FROM ${objName} WHERE ${fldName} != null`));
          target = { objName, fldName };
          break;
        } catch { /* not visible to SOQL yet */ }
      }
      if (target) break;
    }
    if (!target) { console.log('  SKIP  no SOQL-visible custom field in this org to run the report path against'); }
    else {
      const r = await getMetadataDependencies(auth, { componentType: 'CustomField', componentName: `${target.objName}.${target.fldName}` });
      if (r.success && r.dataProbe?.queried === true && typeof r.dataProbe.recordsWithData === 'number') {
        pass('impact report carries a real, queried data probe', `${target.objName}.${target.fldName}: ${r.dataProbe.recordsWithData} record(s), ${r.usedByCount} dep(s)`);
      } else fail('impact report carries the probe', JSON.stringify(r.dataProbe));
      if (Array.isArray(r.blindSpots) && r.blindSpots.length >= 4) pass('impact report carries the blind-spot disclosure');
      else fail('blind-spot disclosure present', JSON.stringify(r.blindSpots));
    }
  }

  console.log(`\n${'='.repeat(60)}\nPASSED: ${passed}   FAILED: ${failed}`);
  if (failures.length) { console.log('\nFailures:'); failures.forEach(f => console.log(`  - ${f.n}: ${f.m}`)); }
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
