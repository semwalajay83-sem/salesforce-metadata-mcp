#!/usr/bin/env node
/**
 * Regression check for the 2026-10-01 report: sf_create_agent always produced a customer-facing
 * Agentforce Service Agent (Bot agentType hard-coded to EinsteinServiceAgent), even for an internal
 * agent, and Salesforce refuses to change the type afterwards ("AgentType can't be updated").
 *
 * Asserts, over real MCP tools/call traffic, with verification through the sf CLI (never the server
 * under test):
 *   1. a new agent with no agentType is an Employee agent (AgentforceEmployeeAgent)
 *   2. asking for a different type on an existing agent is refused with an explanation, not an
 *      opaque deploy error
 *   3. a re-run without agentType (the step-5 plannerName call shape) keeps the existing type
 *
 * Leaves one QA Bot behind if Salesforce refuses the delete (Bot deletion via the Metadata API has
 * been a hard wall in some orgs). The fixed name keeps re-runs from piling up more.
 *
 * Needs a live org. Run: node qa-agent-type.mjs
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { startServer, SERVER_ENV } from "./qa-lib.mjs";

const AGENT = "QaAgentTypeEmployee";
let failures = 0;
const check = (label, cond, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${cond ? "" : `  -> ${detail}`}`);
  if (!cond) failures++;
};

function agentTypeInOrg() {
  const r = spawnSync(
    `sf data query --target-org ${SERVER_ENV.SF_ALIAS} --json -q "SELECT AgentType FROM BotDefinition WHERE DeveloperName = '${AGENT}'"`,
    { encoding: "utf8", shell: true, timeout: 120000 },
  );
  try { return JSON.parse(r.stdout).result.records[0]?.AgentType ?? null; } catch { return null; }
}

const server = startServer({ env: { SF_TOOLSETS: "all" } });
try {
  await server.initialize();
  const base = { agentName: AGENT, label: "QA Agent Type Employee", skipActionCapabilityCheck: true };

  const created = await server.call("sf_create_agent", base, 600000);
  check("create with no agentType succeeds", created.ok, created.error);
  check("new agent is an Employee agent", agentTypeInOrg() === "AgentforceEmployeeAgent", `org says ${agentTypeInOrg()}`);

  const conflict = await server.call("sf_create_agent", { ...base, agentType: "Service" }, 600000);
  check("type change is refused", !conflict.ok, "tool reported success");
  check("refusal explains the type is immutable", /cannot change an agent's type/.test(conflict.error ?? ""), conflict.error);

  const rerun = await server.call("sf_create_agent", base, 600000);
  check("re-run without agentType succeeds", rerun.ok, rerun.error);
  check("re-run keeps the type", agentTypeInOrg() === "AgentforceEmployeeAgent", `org says ${agentTypeInOrg()}`);
} finally {
  server.stop();
}

// destructiveChanges deploy: works without an SFDX project, unlike `sf project delete source`.
const dir = mkdtempSync(path.join(tmpdir(), "qa-agent-type-"));
const pkg = (types) => `<?xml version="1.0" encoding="UTF-8"?><Package xmlns="http://soap.sforce.com/2006/04/metadata">${types}<version>66.0</version></Package>`;
writeFileSync(path.join(dir, "package.xml"), pkg(""));
writeFileSync(path.join(dir, "destructiveChanges.xml"), pkg(`<types><members>${AGENT}</members><name>Bot</name></types>`));
const del = spawnSync(
  `sf project deploy start --target-org ${SERVER_ENV.SF_ALIAS} --metadata-dir "${dir}" --json`,
  { encoding: "utf8", shell: true, timeout: 300000 },
);
console.log(/"status":\s*0/.test(del.stdout) ? `cleanup: deleted ${AGENT}` : `cleanup: could not delete ${AGENT} (left in org; Salesforce often refuses Bot deletes via the Metadata API — use Setup)`);

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
