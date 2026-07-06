import type { SalesforceAuth, ToolResult } from "../types.js";
import { createClient } from "./salesforce.js";

// ─── Execute Anonymous Apex ───────────────────────────────────────────────────

interface ExecuteAnonymousResult {
  compiled: boolean;
  compileProblem: string | null;
  success: boolean;
  line: number;
  column: number;
  exceptionMessage: string | null;
  exceptionStackTrace: string | null;
  logs?: string;
}

export async function executeAnonymousApex(auth: SalesforceAuth, apexCode: string): Promise<ToolResult> {
  try {
    const client = createClient(auth);
    const resp = await client.get<ExecuteAnonymousResult>(
      `/tooling/executeAnonymous?anonymousBody=${encodeURIComponent(apexCode)}`
    );
    const result = resp.data;
    if (!result.compiled) {
      return {
        success: false,
        message: `Apex compile error at line ${result.line}, column ${result.column}: ${result.compileProblem ?? "Unknown compile error"}`
      };
    }
    if (!result.success) {
      return {
        success: false,
        message: `Apex runtime exception: ${result.exceptionMessage ?? "Unknown error"}\n${result.exceptionStackTrace ?? ""}`
      };
    }
    return {
      success: true,
      fullName: "executeAnonymous",
      created: false,
      message: `Anonymous Apex executed successfully.${result.logs ? `\n\nDebug Log:\n${result.logs}` : ""}`
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
    return { success: false, message: err instanceof Error ? err.message : String(err) };
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
    const resp = await client.get<{ compiled: boolean; success: boolean; exceptionMessage?: string | null }>(
      `/tooling/executeAnonymous?anonymousBody=${encodeURIComponent(apexCode)}`
    );
    if (!resp.data.compiled || !resp.data.success) {
      return { success: false, message: resp.data.exceptionMessage ?? "Failed to schedule job" };
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
