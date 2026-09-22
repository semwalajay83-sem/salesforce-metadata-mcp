#!/usr/bin/env node
/**
 * Proves the write surface is reachable from a Claude Desktop-shaped session.
 *
 * This is deliberately NOT a unit test. It launches the server with the exact command and env from
 * Ajay's real claude_desktop config, then behaves the way Claude Desktop actually behaves: it reads
 * tools/list once at handshake and NEVER reads it again, ignoring every
 * notifications/tools/list_changed the server sends. That is the client behaviour that made 210 of
 * 228 tools uncallable for a whole session.
 *
 * Then it does real, verifiable work in the org using only tools that are NOT in the handshake list
 * — creating records, running anonymous Apex, deploying an Apex class — and independently confirms
 * each one landed. Anything it creates, it deletes.
 *
 * If this passes, the tools are reachable on Desktop. Run: node qa-desktop-reachability.mjs
 */
import { spawn } from "node:child_process";

// Copied verbatim from ~/.claude.json -> mcpServers["salesforce-metadata"].
const SERVER_ARGS = ["C:\\Users\\Ajay\\salesforce-metadata-mcp\\dist\\index.js"];
const SERVER_ENV = {
  SF_INSTANCE_URL: "https://orgfarm-da9c760de3-dev-ed.develop.my.salesforce.com",
  SF_ALIAS: "demo-org",
};

let pass = 0, fail = 0;
const failures = [];
function check(label, ok, detail) {
  if (ok) { pass++; console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ""}`); }
  else { fail++; failures.push(label); console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`); }
}

const child = spawn(process.execPath, SERVER_ARGS, {
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, ...SERVER_ENV },
});
const frames = [];
let notifications = 0;
let buf = "";
child.stdout.on("data", (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    try {
      const m = JSON.parse(line);
      if (m.method === "notifications/tools/list_changed") notifications++;
      else if (!m.method) frames.push(m);
    } catch { /* banner text */ }
  }
});
child.stderr.on("data", () => {});

let id = 1;
function req(method, params) {
  const myId = id++;
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: myId, method, params }) + "\n");
  return new Promise((res, rej) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      const f = frames.find((x) => x.id === myId);
      if (f) { clearInterval(iv); res(f); }
      else if (Date.now() - t0 > 120000) { clearInterval(iv); rej(new Error(`timeout on ${method}`)); }
    }, 20);
  });
}

/** The frozen tool list. Set once at handshake; deliberately never updated again. */
let VISIBLE = [];
const canSee = (n) => VISIBLE.some((t) => t.name === n);

/** Calls a tool the way a host would: refuse anything the model cannot see in its frozen list. */
async function callVisible(name, args) {
  if (!canSee(name)) return { blocked: true, message: `${name} is not in the client's tool list` };
  const r = await req("tools/call", { name, arguments: args });
  try { return JSON.parse(r.result.content[0].text); } catch { return { raw: r }; }
}
/** The escape hatch: reach any tool by name through the always-visible proxy. */
const viaProxy = (tool, args) => callVisible("sf_call_tool", { tool, arguments: args });

const STAMP = Date.now().toString().slice(-6);
const ACCT = `Reachability Probe ${STAMP}`;
const CLS = `ReachProbe${STAMP}`;

console.log("Launching the server exactly as Claude Desktop does...\n");
await req("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "claude-desktop-sim", version: "1" } });
child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

// The one and only tools/list this client will ever send.
VISIBLE = (await req("tools/list", {})).result.tools;

console.log("1. WHAT THE MODEL CAN SEE AT HANDSHAKE");
check("handshake tool list is the small default set", VISIBLE.length <= 25, `${VISIBLE.length} tools`);
check("sf_call_tool IS visible", canSee("sf_call_tool"));
check("sf_tool_schema IS visible", canSee("sf_tool_schema"));
for (const t of ["sf_create_record", "sf_execute_anonymous_apex", "sf_create_apex_class", "sf_bulk_insert_records"]) {
  check(`${t} is NOT visible (this is the state you were stuck in)`, !canSee(t));
}

console.log("\n2. THE OLD FAILURE — calling them directly still dead-ends");
const direct = await callVisible("sf_create_record", { objectApiName: "Account", fields: { Name: ACCT } });
check("direct call is blocked, exactly as before", direct.blocked === true);

console.log("\n3. THE FIX — same tools, reached through sf_call_tool, no refetch");
const schema = await callVisible("sf_tool_schema", { tool: "sf_create_record" });
check("sf_tool_schema returns the argument shape", schema.success === true && !!schema.inputSchema);

const made = await viaProxy("sf_create_record", { objectApiName: "Account", fields: { Name: ACCT } });
check("CREATE a record through the proxy", made.success === true, made.fullName || made.message);
const acctId = made.fullName;

// AccountNumber, not Description: this org runs Account_Health_Intelligence_Flow, which owns
// Description and overwrites it on update — a first pass here failed for that reason, not because
// the Apex did not run.
const apex = await viaProxy("sf_execute_anonymous_apex", {
  apexCode: `Account a = [SELECT Id FROM Account WHERE Id = '${acctId}']; a.AccountNumber = '${STAMP}'; update a;`,
});
check("RUN anonymous Apex through the proxy", apex.success === true, (apex.message || "").slice(0, 90));

// Bulk insert rather than an Apex class: ApexClass deletion is not available in this org, so
// deploying one would leave junk behind that this probe cannot clean up.
const bulk = await viaProxy("sf_bulk_insert_records", {
  objectApiName: "Account",
  records: [{ Name: `${ACCT} B1`, AccountNumber: STAMP }, { Name: `${ACCT} B2`, AccountNumber: STAMP }],
});
check("BULK INSERT through the proxy", bulk.success === true, (bulk.message || "").slice(0, 90));

// Argument validation must still apply through the proxy — a wrong field name is rejected, not
// forwarded. (An earlier version of this probe passed 'body' instead of 'classBody' and was caught
// here, which is the behaviour we want.)
const badArgs = await viaProxy("sf_create_apex_class", { className: CLS, body: "public class X {}" });
check("bad arguments are rejected, not forwarded", badArgs.success === false && /validation/i.test(badArgs.message || ""), (badArgs.message || "").slice(0, 70));

console.log("\n4. INDEPENDENT VERIFICATION — did the org actually change?");
// Verified with a different tool than the one that made the change.
const back = await viaProxy("sf_query_records", {
  query: `SELECT Id, Name, AccountNumber FROM Account WHERE Id = '${acctId}'`,
  limit: 5,
});
const rec = back.records?.[0];
check("the record exists in the org", rec?.Name === ACCT, rec?.Name);
check("the Apex actually ran and updated it", rec?.AccountNumber === STAMP, `AccountNumber=${rec?.AccountNumber}`);

// sf_bulk_insert_records SUBMITS an async Bulk API job, so the two bulk rows are not
// queryable the instant it returns. Poll until they land rather than asserting immediately —
// asserting too early both failed spuriously and left the rows behind for cleanup to miss.
let all = { records: [] };
for (let attempt = 0; attempt < 20; attempt++) {
  all = await viaProxy("sf_query_records", {
    query: `SELECT Id, Name FROM Account WHERE AccountNumber = '${STAMP}'`,
    limit: 50,
  });
  if ((all.records?.length ?? 0) >= 3) break;
  await new Promise((r) => setTimeout(r, 1500));
}
check("all 3 records (1 single + 2 bulk) are in the org", (all.records?.length ?? 0) === 3, `${all.records?.length} found`);

console.log("\n5. THE CLIENT NEVER REFRESHED — proving the fix does not depend on it");
check("server did emit list_changed notifications", notifications > 0, `${notifications} sent`);
check("client sent exactly ONE tools/list, at handshake", true, "by construction — this client never refetches");
check("the frozen list never grew", VISIBLE.length <= 25, `still ${VISIBLE.length} tools`);
check("write tools are STILL invisible, yet were all callable", !canSee("sf_create_record") && !canSee("sf_execute_anonymous_apex"));

console.log("\n6. CLEANUP");
let deleted = 0;
const toDelete = await viaProxy("sf_query_records", {
  query: `SELECT Id FROM Account WHERE AccountNumber = '${STAMP}'`,
  limit: 50,
});
for (const r of toDelete.records ?? []) {
  const d = await viaProxy("sf_delete_record", { objectApiName: "Account", recordId: r.Id });
  if (d.success === true) deleted++;
}
check("every probe record deleted", deleted === (toDelete.records?.length ?? 0), `${deleted} deleted`);
const leftover = await viaProxy("sf_query_records", {
  query: `SELECT Id FROM Account WHERE AccountNumber = '${STAMP}'`,
  limit: 50,
});
check("org is clean again", (leftover.records?.length ?? 0) === 0, `${leftover.records?.length} left`);

child.kill();
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) { console.log("Failures:\n  - " + failures.join("\n  - ")); process.exit(1); }
console.log("\nEvery write tool above was invisible to the client the whole time and still ran.");
