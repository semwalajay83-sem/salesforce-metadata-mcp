#!/usr/bin/env node
/**
 * Throwaway probe: find which enum values Salesforce actually accepts for a field, by deploying
 * candidates and reading the rejections. CLAUDE.md records this is how the External Client App
 * scope enum was pinned down, because Salesforce's own docs did not list it.
 *
 * "is not a valid value for the enum" means the candidate is wrong. ANY other error means the value
 * was accepted and we failed later on something else — which is the signal we are looking for.
 *
 * Usage: node probe-enum.mjs
 */
import { startServer, SERVER_ENV } from "./qa-lib.mjs";
Object.assign(process.env, SERVER_ENV);

const { getAuth, upsertMetadata } = await import("./dist/services/salesforce.js");
const auth = await getAuth();
const T = Date.now().toString().slice(-6);

const candidates = ["Text", "SMS", "Sms", "WhatsApp", "Facebook", "Apple", "AppleBusinessChat",
                    "Line", "LINE", "Voice", "EmbeddedMessaging", "GoogleRcs", "Custom", "Web"];

console.log("probing MessagingChannelType...\n");
const accepted = [], rejected = [];
for (const v of candidates) {
  const xml = `<met:metadata xsi:type="met:MessagingChannel" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <met:messagingChannelType>${v}</met:messagingChannelType>
    <met:fullName>QAProbe${T}${v.replace(/[^A-Za-z0-9]/g, "")}</met:fullName>
    <met:masterLabel>QA Probe ${v}</met:masterLabel>
</met:metadata>`;
  let msg = "";
  try {
    const r = await upsertMetadata(auth, xml);
    msg = r.success ? "(accepted and deployed)" : String(r.message ?? "");
  } catch (e) {
    msg = e instanceof Error ? e.message : String(e);
  }
  const isEnumError = /is not a valid value for the enum/i.test(msg);
  (isEnumError ? rejected : accepted).push(v);
  console.log(`  ${isEnumError ? "INVALID" : "valid  "}  ${v.padEnd(20)} ${msg.slice(0, 95)}`);
}

console.log(`\nvalid enum values : ${accepted.join(", ") || "(none)"}`);
console.log(`rejected outright : ${rejected.join(", ") || "(none)"}`);
