import JSZip from "jszip";
import type { SalesforceAuth, ToolResult } from "../types.js";
import { API_VERSION, x, sanitizeError, callMetadataSoap } from "./salesforce.js";

// ─── Shared XML helpers ───────────────────────────────────────────────────────

const SF_METADATA_NS = "http://soap.sforce.com/2006/04/metadata";
const XML_DECL = `<?xml version="1.0" encoding="UTF-8"?>`;

function buildMetaNsElement(elementName: string, innerXml: string): string {
  return `${XML_DECL}\n<${elementName} xmlns="${SF_METADATA_NS}">\n${innerXml}\n</${elementName}>`;
}

function buildSimpleMetaXml(elementName: string, apiVersion: string): string {
  return buildMetaNsElement(elementName, `  <apiVersion>${apiVersion}</apiVersion>\n  <status>Active</status>`);
}

// ─── Zip-based deploy helpers ─────────────────────────────────────────────────

export function buildPackageXml(types: Array<{ name: string; members: string[] }>, apiVersion: string): string {
  const typesXml = types.map(t => `
    <types>
      ${t.members.map(m => `<members>${m}</members>`).join("\n      ")}
      <name>${t.name}</name>
    </types>`).join("\n");
  return buildMetaNsElement("Package", `  ${typesXml}\n  <version>${apiVersion}</version>`);
}

export async function buildApexClassZip(className: string, classBody: string, apiVersion: string): Promise<string> {
  const zip = new JSZip();
  const packageXml = buildPackageXml([{ name: "ApexClass", members: [className] }], apiVersion);
  zip.file("package.xml", packageXml);
  zip.file(`classes/${className}.cls`, classBody);
  zip.file(`classes/${className}.cls-meta.xml`, buildSimpleMetaXml("ApexClass", apiVersion));
  const buffer = await zip.generateAsync({ type: "nodebuffer" });
  return buffer.toString("base64");
}

export async function buildApexTriggerZip(triggerName: string, objectName: string, events: string[], triggerBody: string, apiVersion: string): Promise<string> {
  const zip = new JSZip();
  const packageXml = buildPackageXml([{ name: "ApexTrigger", members: [triggerName] }], apiVersion);
  const eventsStr = events.join(", ");
  const fullTrigger = `trigger ${triggerName} on ${objectName} (${eventsStr}) {\n${triggerBody}\n}`;
  zip.file("package.xml", packageXml);
  zip.file(`triggers/${triggerName}.trigger`, fullTrigger);
  zip.file(`triggers/${triggerName}.trigger-meta.xml`, buildSimpleMetaXml("ApexTrigger", apiVersion));
  const buffer = await zip.generateAsync({ type: "nodebuffer" });
  return buffer.toString("base64");
}

export async function buildLwcZip(params: {
  componentName: string; html: string; javascript: string;
  css?: string; description?: string; apiVersion: string;
  targets?: string[]; isExposed: boolean;
}): Promise<string> {
  const zip = new JSZip();
  const packageXml = buildPackageXml([{ name: "LightningComponentBundle", members: [params.componentName] }], params.apiVersion);
  zip.file("package.xml", packageXml);

  const targetsXml = (params.targets ?? []).map(t => `        <target>${t}</target>`).join("\n");
  const metaXml = buildMetaNsElement("LightningComponentBundle", [
    `  <apiVersion>${params.apiVersion}</apiVersion>`,
    `  <isExposed>${params.isExposed}</isExposed>`,
    params.description ? `  <description>${x(params.description)}</description>` : "",
    params.targets && params.targets.length > 0 ? `  <targets>\n${targetsXml}\n  </targets>` : "",
  ].filter(Boolean).join("\n"));

  const dir = `lwc/${params.componentName}`;
  zip.file(`${dir}/${params.componentName}.html`, params.html);
  zip.file(`${dir}/${params.componentName}.js`, params.javascript);
  zip.file(`${dir}/${params.componentName}.js-meta.xml`, metaXml);
  if (params.css) {
    zip.file(`${dir}/${params.componentName}.css`, params.css);
  }
  const buffer = await zip.generateAsync({ type: "nodebuffer" });
  return buffer.toString("base64");
}

export async function buildStaticResourceZip(resourceName: string, content: string, contentType: string, apiVersion: string): Promise<string> {
  const zip = new JSZip();
  const packageXml = buildPackageXml([{ name: "StaticResource", members: [resourceName] }], apiVersion);
  zip.file("package.xml", packageXml);
  zip.file(`staticresources/${resourceName}`, content);
  zip.file(`staticresources/${resourceName}.resource-meta.xml`,
    buildMetaNsElement("StaticResource", `  <cacheControl>Public</cacheControl>\n  <contentType>${contentType}</contentType>`));
  const buffer = await zip.generateAsync({ type: "nodebuffer" });
  return buffer.toString("base64");
}

function inferMetadataPath(type: string, name: string): string {
  switch (type) {
    case "ApexClass": return `classes/${name}.cls`;
    case "ApexTrigger": return `triggers/${name}.trigger`;
    case "Flow": return `flows/${name}.flow`;
    case "CustomObject": return `objects/${name}/${name}.object`;
    case "Layout": return `layouts/${name}.layout`;
    case "PermissionSet": return `permissionsets/${name}.permissionset`;
    case "Profile": return `profiles/${name}.profile`;
    case "ApprovalProcess": return `approvalProcesses/${name}.approvalProcess`;
    case "WorkflowAlert":
    case "WorkflowRule":
    case "WorkflowFieldUpdate": {
      const [obj] = name.split(".");
      return `workflows/${obj}.workflow`;
    }
    case "CustomField":
    case "ValidationRule": {
      const [obj, member] = name.split(".");
      const dir = type === "CustomField" ? "fields" : "validationRules";
      const ext = type === "CustomField" ? "field" : "validationRule";
      return `objects/${obj}/${dir}/${member}.${ext}`;
    }
    case "LightningComponentBundle": return `lwc/${name}/${name}.js-meta.xml`;
    case "AuraDefinitionBundle": return `aura/${name}/${name}.cmp-meta.xml`;
    case "Bot": return `bots/${name}.bot`;
    case "GenAiPlugin": return `genAiPlugins/${name}.genAiPlugin`;
    case "GenAiFunction": return `genAiFunctions/${name}.genAiFunction`;
    case "GenAiPlanner": return `genAiPlanners/${name}.genAiPlanner`;
    case "GenAiPlannerBundle": return `genAiPlannerBundles/${name}/${name}.genAiPlannerBundle`;
    case "GlobalValueSet": return `globalValueSets/${name}.globalValueSet`;
    case "CustomMetadata": return `customMetadata/${name}.md`;
    case "AssignmentRules": return `assignmentRules/${name}.assignmentRules`;
    case "AutoResponseRules": return `autoResponseRules/${name}.autoResponseRules`;
    case "EscalationRules": return `escalationRules/${name}.escalationRules`;
    case "MatchingRule": return `matchingRules/${name.split(".")[0]}.matchingRule`;
    case "DuplicateRule": return `duplicateRules/${name}.duplicateRule`;
    case "Network": return `networks/${name}.network`;
    case "CustomNotificationType": return `notificationTypes/${name}.notiftype`;
    case "ConnectedApp": return `connectedApps/${name}.connectedApp`;
    case "ReportType": return `reportTypes/${name}.reportType`;
    case "ApexPage": return `pages/${name}.page-meta.xml`;
    case "ApexComponent": return `components/${name}.component-meta.xml`;
    case "WorkflowRule": return `workflows/${name.split(".")[0]}.workflow`;
    case "WorkflowFieldUpdate": return `workflows/${name.split(".")[0]}.workflow`;
    case "WorkflowOutboundMessage": return `workflows/${name.split(".")[0]}.workflow`;
    case "FlowTest": return `flowtests/${name}.flowtest`;
    default: {
      const lower = type.charAt(0).toLowerCase() + type.slice(1);
      const guessedPath = `${lower}s/${name}`;
      console.error(`[salesforce-metadata-mcp] Unknown metadata type '${type}' — guessing path: ${guessedPath}. Deployment may fail if path is incorrect.`);
      return guessedPath;
    }
  }
}

export async function buildGenericDeployZip(
  components: Array<{ type: string; name: string }>,
  apiVersion: string,
  componentsXml?: Array<{ type: string; name: string; xml: string }>
): Promise<string> {
  const zip = new JSZip();
  const typeMap = new Map<string, string[]>();
  for (const c of components) {
    const existing = typeMap.get(c.type) ?? [];
    existing.push(c.name);
    typeMap.set(c.type, existing);
  }
  if (componentsXml) {
    for (const c of componentsXml) {
      const existing = typeMap.get(c.type) ?? [];
      if (!existing.includes(c.name)) existing.push(c.name);
      typeMap.set(c.type, existing);
    }
  }
  const types = [...typeMap.entries()].map(([name, members]) => ({ name, members }));
  const packageXml = buildPackageXml(types, apiVersion);
  zip.file("package.xml", packageXml);
  if (componentsXml) {
    for (const c of componentsXml) {
      const filePath = inferMetadataPath(c.type, c.name);
      zip.file(filePath, c.xml);
    }
  }
  const buffer = await zip.generateAsync({ type: "nodebuffer" });
  return buffer.toString("base64");
}

// ─── Deploy via SOAP ──────────────────────────────────────────────────────────

export async function deployZip(
  auth: SalesforceAuth,
  base64Zip: string,
  options: { checkOnly?: boolean; runTests?: string[]; rollbackOnError?: boolean; testLevel?: string } = {}
): Promise<string> {
  const testsXml = (options.runTests ?? []).map(t => `<met:runTests>${t}</met:runTests>`).join("\n");
  const bodyInner = `
    <met:deploy>
      <met:ZipFile>${base64Zip}</met:ZipFile>
      <met:DeployOptions>
        <met:allowMissingFiles>false</met:allowMissingFiles>
        <met:autoUpdatePackage>false</met:autoUpdatePackage>
        <met:checkOnly>${options.checkOnly === true}</met:checkOnly>
        <met:runAllTests>false</met:runAllTests>
        ${testsXml}
        ${options.testLevel ? `<met:testLevel>${options.testLevel}</met:testLevel>` : ""}
        <met:rollbackOnError>${options.rollbackOnError !== false}</met:rollbackOnError>
        <met:singlePackage>true</met:singlePackage>
      </met:DeployOptions>
    </met:deploy>`;
  const xml = await callMetadataSoap(auth, "deploy", bodyInner);
  const idMatch = xml.match(/<id[^>]*>([A-Za-z0-9]{15,18})<\/id>/);
  if (!idMatch) {
    const fault = xml.match(/<faultstring[^>]*>([\s\S]*?)<\/faultstring>/i);
    throw new Error(fault ? fault[1].trim() : "No deploy ID returned from Salesforce");
  }
  return idMatch[1];
}

// ─── Poll deploy status ───────────────────────────────────────────────────────

export async function pollDeployStatus(
  auth: SalesforceAuth,
  deployId: string,
  maxWaitMs = 10 * 60 * 1000
): Promise<ToolResult> {
  const start = Date.now();
  const pollInterval = 5_000;
  while (Date.now() - start < maxWaitMs) {
    await new Promise(r => setTimeout(r, pollInterval));
    const result = await checkDeployStatus(auth, deployId);
    if (result.done) {
      if (result.success) {
        return { success: true, fullName: deployId, created: true, message: result.message };
      } else {
        return { success: false, message: result.message };
      }
    }
    console.error(`Deploy ${deployId}: ${result.status} (${Math.round((Date.now() - start) / 1000)}s)`);
  }
  return { success: false, message: `Deployment timed out after ${maxWaitMs / 1000}s. Deploy ID: ${deployId}` };
}

export async function checkDeployStatus(
  auth: SalesforceAuth,
  deployId: string
): Promise<{ done: boolean; success: boolean; status: string; message: string; details?: unknown }> {
  const bodyInner = `
    <met:checkDeployStatus>
      <met:asyncProcessId>${deployId}</met:asyncProcessId>
      <met:includeDetails>true</met:includeDetails>
    </met:checkDeployStatus>`;
  const xml = await callMetadataSoap(auth, "checkDeployStatus", bodyInner, 30_000);
  const doneMatch = xml.match(/<done>(true|false)<\/done>/i);
  const successMatch = xml.match(/<success>(true|false)<\/success>/i);
  const statusMatch = xml.match(/<status[^>]*>([^<]+)<\/status>/i);
  const done = doneMatch?.[1] === "true";
  const success = successMatch?.[1] === "true";
  const status = statusMatch?.[1] ?? "Pending";

  let message = `Deploy ${deployId}: ${status}`;
  if (done) {
    if (success) {
      message = `Deployment successful. Deploy ID: ${deployId}`;
    } else {
      const problems = [...xml.matchAll(/<problem[^>]*>([\s\S]*?)<\/problem>/gi)].map(m => m[1].trim());
      const compFails = [...xml.matchAll(/<fileName[^>]*>([\s\S]*?)<\/fileName>[\s\S]*?<problem[^>]*>([\s\S]*?)<\/problem>/gi)]
        .map(m => `${m[1].trim()}: ${m[2].trim()}`);
      const errors = [...problems, ...compFails];
      message = errors.length ? `Deployment failed: ${errors.slice(0, 5).join(" | ")}` : `Deployment failed. Deploy ID: ${deployId}`;
    }
  }

  return { done, success, status, message };
}

// ─── Retrieve metadata ────────────────────────────────────────────────────────

export async function retrieveMetadata(
  auth: SalesforceAuth,
  components: Array<{ type: string; name: string }>
): Promise<ToolResult> {
  const typeMap = new Map<string, string[]>();
  for (const c of components) {
    const existing = typeMap.get(c.type) ?? [];
    existing.push(c.name);
    typeMap.set(c.type, existing);
  }
  const typesXml = [...typeMap.entries()].map(([name, members]) =>
    members.map(m => `<met:types><met:members>${m}</met:members><met:name>${name}</met:name></met:types>`).join("\n")
  ).join("\n");

  const bodyInner = `
    <met:retrieve>
      <met:retrieveRequest>
        <met:apiVersion>${API_VERSION}</met:apiVersion>
        <met:unpackaged>
          ${typesXml}
        </met:unpackaged>
      </met:retrieveRequest>
    </met:retrieve>`;

  try {
    const xml = await callMetadataSoap(auth, "retrieve", bodyInner);
    const idMatch = xml.match(/<id[^>]*>([A-Za-z0-9]{15,18})<\/id>/);
    if (!idMatch) {
      const fault = xml.match(/<faultstring[^>]*>([\s\S]*?)<\/faultstring>/i);
      return { success: false, message: fault ? fault[1].trim() : "Retrieve failed" };
    }
    return {
      success: true, fullName: idMatch[1], created: false,
      message: `Retrieve initiated. Async ID: ${idMatch[1]}. Components: ${components.map(c => `${c.type}:${c.name}`).join(", ")}`
    };
  } catch (err: unknown) {
    return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
  }
}
