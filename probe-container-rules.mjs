#!/usr/bin/env node
/**
 * Does upserting one rule into a *Rules container replace the others, or merge with them?
 *
 * AssignmentRules, AutoResponseRules, EscalationRules and SharingRules are all keyed by OBJECT and
 * hold every rule of their kind for it. If upsert replaces the container, each of these tools
 * silently deletes every other rule on that object — the CustomObject/Workflow pattern again. If it
 * merges, they are fine as they are.
 *
 * I assumed replace-semantics for Translations earlier and was wrong (Salesforce merges there), so
 * this measures instead of guessing: write rule A, write rule B, then read the container back and
 * see whether A survived.
 *
 * Run: node probe-container-rules.mjs
 */
import { startServer, SERVER_ENV } from "./qa-lib.mjs";
Object.assign(process.env, SERVER_ENV);

const { getAuth, readMetadataItem } = await import("./dist/services/salesforce.js");
const auth = await getAuth();
const T = Date.now().toString().slice(-6);

const s = startServer({ env: { SF_TOOLSETS: "all" } });
await s.initialize();

const A = `QAAsgA${T}`;
const B = `QAAsgB${T}`;
const mk = (name) => s.call("sf_create_assignment_rule", {
  objectName: "Lead",
  ruleName: name,
  label: name,
  ruleEntries: [{
    entryOrder: 1,
    assignedTo: "semwalajaydevorg@agentforce.com",
    assignedToType: "User",
    criteriaItems: [{ field: "Lead.LeadSource", operation: "equals", value: "Web" }],
  }],
});

const before = await readMetadataItem(auth, "AssignmentRules", "Lead");
const count = (xml) => (String(xml).match(/<assignmentRule>/gi) ?? []).length;
console.log("assignmentRule entries on Lead BEFORE:", count(before.rawXml));

const ra = await mk(A);
console.log(`write A: ${ra.ok ? "ok" : "FAILED — " + String(ra.error).slice(0, 140)}`);
const rb = await mk(B);
console.log(`write B: ${rb.ok ? "ok" : "FAILED — " + String(rb.error).slice(0, 140)}`);

const after = await readMetadataItem(auth, "AssignmentRules", "Lead");
const raw = String(after.rawXml);
console.log("assignmentRule entries on Lead AFTER :", count(raw));
console.log(`A present: ${raw.includes(A)}   B present: ${raw.includes(B)}`);

if (ra.ok && rb.ok) {
  console.log(raw.includes(A)
    ? "\n>>> MERGE semantics: writing B left A alone. These tools are safe as they are."
    : "\n>>> REPLACE semantics: writing B DELETED A. Every *Rules tool needs read-merge-write.");
} else {
  console.log("\n>>> inconclusive — a write failed, so nothing can be said about the semantics.");
}
s.stop();
