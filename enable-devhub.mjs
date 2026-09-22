#!/usr/bin/env node
/**
 * Enables Dev Hub on the target org by deploying the DevHubSettings settings component.
 *
 * The member is enableScratchOrgManagementPref, NOT enableDevHub — read the settings back from an
 * org to see the real member names (readMetadata on DevHubSettings/DevHub).
 *
 * Dev Hub is normally a Setup toggle (Setup -> Development -> Dev Hub -> Enable Dev Hub), but it is
 * also exposed as a Settings metadata component, so it can be turned on without the UI. Enabling it
 * is additive and reversible — it creates the ScratchOrgInfo object and lets the org act as a Dev
 * Hub. It does not change anything else in the org.
 *
 * Run: node enable-devhub.mjs [--check]
 */
import { SERVER_ENV } from "./qa-lib.mjs";
Object.assign(process.env, SERVER_ENV);

const checkOnly = process.argv.includes("--check");
const { getAuth } = await import("./dist/services/salesforce.js");
const { buildPackageXml, deployZip, pollDeployStatus } = await import("./dist/services/deployment.js");
const { default: JSZip } = await import("jszip");

const auth = await getAuth();

const settingsXml = `<?xml version="1.0" encoding="UTF-8"?>
<DevHubSettings xmlns="http://soap.sforce.com/2006/04/metadata">
    <enableScratchOrgManagementPref>true</enableScratchOrgManagementPref>
</DevHubSettings>`;

const zip = new JSZip();
zip.file("package.xml", buildPackageXml([{ name: "Settings", members: ["DevHub"] }], "66.0"));
zip.file("settings/DevHub.settings", settingsXml);
const b64 = (await zip.generateAsync({ type: "nodebuffer" })).toString("base64");

console.log(`${checkOnly ? "Validating" : "Deploying"} DevHubSettings...`);
const deployId = await deployZip(auth, b64, { checkOnly, rollbackOnError: true });
const result = await pollDeployStatus(auth, deployId, 5 * 60 * 1000);
console.log(result.success ? "  OK — Dev Hub settings accepted" : `  FAILED — ${result.message}`);
process.exit(result.success ? 0 : 1);
