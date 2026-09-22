#!/usr/bin/env node
/**
 * Pins Salesforce's MERGE semantics for translation components.
 *
 * sf_translate_custom_label writes a Translations component containing only the one label it is
 * changing. That is safe ONLY because Salesforce merges customLabels into the existing component
 * for that language instead of replacing it — verified live 2026-09-22: a single-entry upsert took
 * the fr component from 28 entries to 29.
 *
 * That distinction matters. Sibling tools (sf_create_queue_routing_config,
 * sf_create_connected_app_oauth_policy, the CustomObject child-component builders) all target types
 * where upsert genuinely REPLACES the component, and each had to be fixed to carry the existing
 * definition through. Translations is the exception, and nothing else in the suite checks it — so
 * if Salesforce ever switched it to replace semantics, these tools would start quietly destroying a
 * language's translations with nothing to catch it. This test is that check.
 *
 * Run: node qa-translation-merge.mjs
 */
import { startServer, SERVER_ENV } from "./qa-lib.mjs";

// the direct readMetadataItem call below runs in THIS process, so it needs the org env too
Object.assign(process.env, SERVER_ENV);

const T = Date.now().toString().slice(-7);
const A = `QATrA${T}`;
const B = `QATrB${T}`;
let pass = 0, fail = 0;
const check = (label, ok, detail) => {
  if (ok) { pass++; console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ""}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`); }
};

const s = startServer({ env: { SF_TOOLSETS: "all" } });
await s.initialize();

console.log("1. two custom labels to translate");
for (const name of [A, B]) {
  const r = await s.call("sf_create_custom_label", { fullName: name, value: `value for ${name}` });
  check(`created ${name}`, r.ok, r.ok ? "" : r.error);
}

console.log("\n2. translate them one after the other into the same language");
const t1 = await s.call("sf_translate_custom_label", { labelName: A, language: "fr", translatedValue: `FR ${A}` });
check(`translated ${A}`, t1.ok, t1.ok ? "" : t1.error);
const t2 = await s.call("sf_translate_custom_label", { labelName: B, language: "fr", translatedValue: `FR ${B}` });
check(`translated ${B}`, t2.ok, t2.ok ? "" : t2.error);

console.log("\n3. THE INVARIANT: writing B must not replace the language file that holds A");
const { getAuth, readMetadataItem } = await import("./dist/services/salesforce.js");
const auth = await getAuth();
const back = await readMetadataItem(auth, "Translations", "fr");
if (!back.success) {
  check("read the fr Translations component back", false, back.message);
} else {
  const names = [...String(back.rawXml).matchAll(/<customLabels>[\s\S]*?<name>([^<]+)<\/name>[\s\S]*?<\/customLabels>/gi)]
    .map((m) => m[1]);
  check(`the language file still holds many entries (${names.length})`, names.length > 1,
    names.length > 1 ? "" : "only one entry left — Salesforce is no longer merging, and these tools now destroy translations");
  check(`the FIRST label's translation survived the second write`, names.includes(A),
    names.includes(A) ? "" : `${A} is gone after translating ${B}`);
  check(`the second label's translation is present`, names.includes(B),
    names.includes(B) ? "" : `${B} missing`);
}

console.log("\n4. cleanup");
const del = await s.call("sf_delete_metadata", { metadataType: "CustomLabel", fullNames: [A, B] });
check("labels deleted", del.ok, del.ok ? "" : del.error);

console.log(`\n${"=".repeat(60)}\nPASS ${pass}  FAIL ${fail}`);
s.stop();
process.exit(fail ? 1 : 0);
