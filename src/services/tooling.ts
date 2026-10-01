import type { SalesforceAuth, ToolResult } from "../types.js";
import { createClient, fetchWithTimeout, x, API_VERSION } from "./salesforce.js";

// ─── Execute Anonymous Apex ───────────────────────────────────────────────────

export type AnonymousDebugLog = "userDebug" | "full" | "none";

/** Debug logs can be megabytes; past this the head and tail are kept and the cut is stated. */
const MAX_DEBUG_LOG_CHARS = 50_000;

function unescapeXml(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function soapField(xml: string, tag: string): string | null {
  const m = xml.match(new RegExp(`<(?:\\w+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:\\w+:)?${tag}>`));
  return m ? unescapeXml(m[1]) : null;
}

/**
 * The System.debug() lines from a raw Apex debug log. A log entry starts with a timestamp line
 * ("HH:MM:SS.n (nanos)|EVENT|..."); a multi-line debug message continues on lines without one.
 */
export function extractUserDebug(log: string): string[] {
  const out: string[] = [];
  let current: string | null = null;
  for (const line of log.split(/\r?\n/)) {
    if (/^\d{2}:\d{2}:\d{2}\.\d+ \(\d+\)\|/.test(line)) {
      if (current !== null) out.push(current);
      // ...|USER_DEBUG|[lineNo]|LEVEL|message
      const m = line.match(/\|USER_DEBUG\|\[(\d+)\]\|\w+\|([\s\S]*)$/);
      current = m ? `[line ${m[1]}] ${m[2]}` : null;
    } else if (current !== null) {
      current += `\n${line}`;
    }
  }
  if (current !== null) out.push(current);
  return out;
}

function clipLog(log: string): string {
  if (log.length <= MAX_DEBUG_LOG_CHARS) return log;
  const half = MAX_DEBUG_LOG_CHARS / 2;
  return `${log.slice(0, half)}\n\n... [${log.length - MAX_DEBUG_LOG_CHARS} chars of the debug log omitted] ...\n\n${log.slice(-half)}`;
}

/**
 * Runs anonymous Apex through the SOAP Apex API rather than the REST Tooling endpoint.
 *
 * Reported 2026-10-01: System.debug output never came back. The REST
 * /tooling/executeAnonymous endpoint returns no log at all — the old `result.logs` branch could
 * never fire, while the tool description promised debug output. The SOAP call returns the log in
 * the DebuggingInfo response header when a DebuggingHeader asks for one (what `sf apex run` does).
 */
export async function executeAnonymousApex(auth: SalesforceAuth, apexCode: string, debugLog: AnonymousDebugLog = "userDebug"): Promise<ToolResult & { debugOutput?: string[]; debugLog?: string }> {
  try {
    // Apex_code at DEBUG is what carries USER_DEBUG; the rest stay quiet unless the full log is asked for.
    const categories = debugLog === "full"
      ? [["Apex_code", "FINEST"], ["Apex_profiling", "INFO"], ["Callout", "INFO"], ["Db", "INFO"], ["System", "DEBUG"], ["Validation", "INFO"], ["Workflow", "INFO"]]
      : [["Apex_code", "DEBUG"], ["Db", "NONE"], ["System", "NONE"], ["Workflow", "NONE"], ["Validation", "NONE"], ["Callout", "NONE"], ["Apex_profiling", "NONE"]];
    const header = debugLog === "none" ? "" : `<apex:DebuggingHeader>${categories
      .map(([c, l]) => `<apex:categories><apex:category>${c}</apex:category><apex:level>${l}</apex:level></apex:categories>`)
      .join("")}<apex:debugLevel>DETAIL</apex:debugLevel></apex:DebuggingHeader>`;
    const envelope = `<?xml version="1.0" encoding="utf-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:apex="http://soap.sforce.com/2006/08/apex">
  <soapenv:Header><apex:SessionHeader><apex:sessionId>${auth.accessToken}</apex:sessionId></apex:SessionHeader>${header}</soapenv:Header>
  <soapenv:Body><apex:executeAnonymous><apex:String>${x(apexCode)}</apex:String></apex:executeAnonymous></soapenv:Body>
</soapenv:Envelope>`;
    const response = await fetchWithTimeout(`${auth.instanceUrl}/services/Soap/s/${API_VERSION}`, {
      method: "POST",
      headers: { "Content-Type": "text/xml; charset=utf-8", SOAPAction: '""' },
      body: envelope,
    }, 120_000);
    const xml = await response.text();
    const fault = soapField(xml, "faultstring");
    if (!response.ok || fault) {
      return { success: false, message: `Anonymous Apex request failed (HTTP ${response.status}): ${fault ?? xml.slice(0, 500)}` };
    }

    const log = soapField(xml, "debugLog") ?? "";
    const debugOutput = debugLog === "none" ? undefined : extractUserDebug(log);
    const logFields = debugLog === "none" ? {} : {
      debugOutput,
      ...(debugLog === "full" ? { debugLog: clipLog(log) } : {}),
    };
    const debugText = debugOutput?.length ? `\n\nSystem.debug output (${debugOutput.length} line(s)):\n${debugOutput.join("\n")}` : "";

    if (soapField(xml, "compiled") !== "true") {
      return {
        success: false,
        message: `Apex compile error at line ${soapField(xml, "line")}, column ${soapField(xml, "column")}: ${soapField(xml, "compileProblem") || "Unknown compile error"}`,
      };
    }
    if (soapField(xml, "success") !== "true") {
      // Debug lines written before the exception are often the most useful clue, so they are kept.
      return {
        success: false,
        message: `Apex runtime exception: ${soapField(xml, "exceptionMessage") || "Unknown error"}\n${soapField(xml, "exceptionStackTrace") ?? ""}${debugText}`,
        ...logFields,
      };
    }
    return {
      success: true,
      fullName: "executeAnonymous",
      created: false,
      message: `Anonymous Apex executed successfully.${debugLog === "none" ? "" : debugText || " No System.debug output."}`,
      ...logFields,
    };
  } catch (err: unknown) {
    return { success: false, message: err instanceof Error ? err.message : String(err) };
  }
}

// ─── Run Apex Tests ───────────────────────────────────────────────────────────

interface TestRunRequest {
  tests: Array<{ className: string }>;
}

interface TestRunResult {
  Id?: string;
  id?: string;
}

interface ApexTestQueueItem {
  Status: string;
}

interface ApexTestResult {
  ApexClass?: { Name: string };
  MethodName?: string;
  Outcome?: string;
  Message?: string;
  StackTrace?: string;
}

interface TestQueueQuery {
  records: ApexTestQueueItem[];
}

interface TestResultQuery {
  records: ApexTestResult[];
}

export async function runApexTests(
  auth: SalesforceAuth,
  testClasses: string[],
  waitMinutes: number
): Promise<ToolResult> {
  try {
    const client = createClient(auth);
    const reqBody: TestRunRequest = { tests: testClasses.map(c => ({ className: c })) };
    const runResp = await client.post<TestRunResult>(
      "/tooling/runTestsAsynchronous",
      JSON.stringify(reqBody),
      { headers: { "Content-Type": "application/json" } }
    );
    const testRunId = runResp.data?.Id ?? runResp.data?.id ?? (runResp.data as unknown as string);
    if (!testRunId) {
      return { success: false, message: "No test run ID returned from Salesforce." };
    }

    const maxMs = waitMinutes * 60 * 1000;
    const start = Date.now();
    let done = false;

    while (!done && Date.now() - start < maxMs) {
      await new Promise(r => setTimeout(r, 3_000));
      const queueResp = await client.get<TestQueueQuery>(
        `/tooling/query?q=${encodeURIComponent(`SELECT Status FROM ApexTestQueueItem WHERE ParentJobId='${testRunId}'`)}`
      );
      const records = queueResp.data.records;
      const pending = records.filter(r => !["Completed", "Failed", "Aborted"].includes(r.Status ?? ""));
      done = pending.length === 0;
    }

    const resultResp = await client.get<TestResultQuery>(
      `/tooling/query?q=${encodeURIComponent(
        `SELECT ApexClass.Name, MethodName, Outcome, Message, StackTrace FROM ApexTestResult WHERE AsyncApexJobId='${testRunId}'`
      )}`
    );
    const results = resultResp.data.records;
    const passed = results.filter(r => r.Outcome === "Pass").length;
    const failed = results.filter(r => r.Outcome === "Fail").length;
    const errors = results
      .filter(r => r.Outcome === "Fail")
      .map(r => `${r.ApexClass?.Name ?? ""}.${r.MethodName ?? ""}: ${r.Message ?? ""}`)
      .join("\n");

    if (failed > 0) {
      return { success: false, message: `${passed} passed, ${failed} failed.\n${errors}` };
    }
    return {
      success: true, fullName: testRunId, created: false,
      message: `All ${passed} test(s) passed.${results.length === 0 ? " (No test results found — tests may still be running)" : ""}`
    };
  } catch (err: unknown) {
    return { success: false, message: err instanceof Error ? err.message : String(err) };
  }
}

// ─── Change Sets (Tooling API) ────────────────────────────────────────────────

interface ChangeSetRecord {
  Id: string;
  Name?: string;
}

interface ChangeSetQuery {
  records: ChangeSetRecord[];
}

/**
 * The OutboundChangeSet Tooling object only exists where change sets are enabled, so these tools
 * answered with a bare "Salesforce API error 404: NOT_FOUND" — indistinguishable from a broken
 * tool. Added 2026-09-22, same treatment as devOpsError and sandboxError.
 */
function changeSetError(msg: string): string {
  if (/NOT_FOUND|INVALID_TYPE|OutboundChangeSet|is not supported/i.test(msg)) {
    return `Change sets are not available in this org — the OutboundChangeSet object is not exposed. Change sets require a production or sandbox org with deployment connections configured; a Developer Edition or scratch org has none. Use sf_deploy_metadata for direct metadata deployment instead. (Underlying error: ${msg})`;
  }
  return msg;
}

export async function createOutboundChangeSet(
  auth: SalesforceAuth,
  changeSetName: string,
  description?: string
): Promise<ToolResult> {
  try {
    const client = createClient(auth);
    const body = { Name: changeSetName, Description: description ?? "" };
    const resp = await client.post<ChangeSetRecord>("/tooling/sobjects/OutboundChangeSet", body);
    const csId = resp.data?.Id ?? (resp.data as unknown as string);
    if (!csId) {
      return { success: false, message: "Change set created but no ID returned." };
    }
    return {
      success: true, fullName: changeSetName, created: true,
      message: `Outbound Change Set '${changeSetName}' created. ID: ${csId}\nView in Setup: ${auth.instanceUrl}/lightning/setup/DeployStatus/home`
    };
  } catch (err: unknown) {
    return { success: false, message: changeSetError(err instanceof Error ? err.message : String(err)) };
  }
}

export async function addComponentsToChangeSet(
  auth: SalesforceAuth,
  changeSetName: string,
  components: Array<{ type: string; name: string }>
): Promise<ToolResult> {
  try {
    const client = createClient(auth);
    const queryResp = await client.get<ChangeSetQuery>(
      `/tooling/query?q=${encodeURIComponent(`SELECT Id FROM OutboundChangeSet WHERE Name='${changeSetName}'`)}`
    );
    if (!queryResp.data.records.length) {
      return { success: false, message: `Change set '${changeSetName}' not found.` };
    }
    const csId = queryResp.data.records[0].Id;

    const failures: string[] = [];
    for (const comp of components) {
      try {
        await client.post("/tooling/sobjects/OutboundChangeSetMember", {
          OutboundChangeSetId: csId,
          Name: comp.name,
          Type: comp.type,
        });
      } catch {
        failures.push(`${comp.type}:${comp.name}`);
      }
    }

    if (failures.length) {
      return {
        success: false,
        message: `Added ${components.length - failures.length}/${components.length} components. Failed: ${failures.join(", ")}`
      };
    }
    return {
      success: true, fullName: changeSetName, created: false,
      message: `Added ${components.length} component(s) to change set '${changeSetName}'.`
    };
  } catch (err: unknown) {
    return { success: false, message: err instanceof Error ? err.message : String(err) };
  }
}

// ─── Scheduled Apex Jobs ──────────────────────────────────────────────────────

interface ScheduledJobRecord {
  Id?: string;
  id?: string;
}

export async function createScheduledJob(
  auth: SalesforceAuth,
  className: string,
  jobName: string,
  cronExpression: string
): Promise<ToolResult> {
  try {
    const apexCode = `System.schedule('${jobName.replace(/'/g, "\\'")}', '${cronExpression.replace(/'/g, "\\'")}', new ${className}());`;
    const client = createClient(auth);
    const resp = await client.get<{
      compiled: boolean; success: boolean; exceptionMessage?: string | null;
      compileProblem?: string | null; line?: number; column?: number;
    }>(
      `/tooling/executeAnonymous?anonymousBody=${encodeURIComponent(apexCode)}`
    );
    // A compile failure reports compileProblem, not exceptionMessage. Only the latter was read, so
    // every compile failure — a misspelled class, a class that is not Schedulable, one that does not
    // exist — collapsed into the useless "Failed to schedule job". Say which it was.
    // Fixed 2026-09-22.
    if (!resp.data.compiled) {
      const where = resp.data.line ? ` (line ${resp.data.line}, column ${resp.data.column ?? 0})` : "";
      return {
        success: false,
        message: `Could not schedule '${jobName}': the Apex did not compile${where} — ${resp.data.compileProblem ?? "no compiler message returned"}. Check that class '${className}' exists and implements Schedulable.`,
      };
    }
    if (!resp.data.success) {
      return {
        success: false,
        message: `Could not schedule '${jobName}': ${resp.data.exceptionMessage ?? "the Apex ran but reported failure with no message"}. Check the cron expression '${cronExpression}' and that '${className}' implements Schedulable.`,
      };
    }
    return {
      success: true, fullName: jobName, created: true,
      message: `Scheduled job '${jobName}' created with class '${className}' on cron '${cronExpression}'.`
    };
  } catch (err: unknown) {
    return { success: false, message: err instanceof Error ? err.message : String(err) };
  }
}

// ─── Apex Email Service ───────────────────────────────────────────────────────

export async function createApexEmailService(
  auth: SalesforceAuth,
  params: {
    functionName: string; apexClassName: string; isActive: boolean;
    isAuthenticationRequired: boolean; isErrorRoutingEnabled: boolean;
    errorRoutingAddress?: string; functionInactiveAction: string;
    functionExceptionAction: string; overLimitAction: string;
    authenticationFailureAction: string; attachmentOption: string;
  }
): Promise<ToolResult> {
  try {
    const client = createClient(auth);
    const body = {
      ApexClassId: null,
      AttachmentOption: params.attachmentOption,
      AuthenticationFailureAction: params.authenticationFailureAction,
      FunctionExceptionAction: params.functionExceptionAction,
      FunctionInactiveAction: params.functionInactiveAction,
      IsActive: params.isActive,
      IsAuthenticationRequired: params.isAuthenticationRequired,
      IsErrorRoutingEnabled: params.isErrorRoutingEnabled,
      OverLimitAction: params.overLimitAction,
      ErrorRoutingAddress: params.errorRoutingAddress ?? null,
      FunctionName: params.functionName,
    };

    // First get the Apex class Id
    const classResp = await client.get<{ records: Array<{ Id: string }> }>(
      `/tooling/query?q=${encodeURIComponent(`SELECT Id FROM ApexClass WHERE Name='${params.apexClassName}'`)}`
    );
    if (classResp.data.records.length) {
      (body as Record<string, unknown>)["ApexClassId"] = classResp.data.records[0].Id;
    }

    const resp = await client.post<ScheduledJobRecord>("/tooling/sobjects/ApexEmailNotification", body);
    const id = resp.data?.Id ?? resp.data?.id;
    return {
      success: true, fullName: params.functionName, created: true,
      message: `Apex Email Service '${params.functionName}' created${id ? ` with ID: ${id}` : ""}.`
    };
  } catch (err: unknown) {
    return { success: false, message: err instanceof Error ? err.message : String(err) };
  }
}
