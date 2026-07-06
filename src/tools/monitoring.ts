import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  GetOrgLimitsSchema, GetFlowErrorsSchema, GetApexTestResultsSchema, GetDeploymentHistorySchema,
} from "../schemas/index.js";
import {
  getAuth, getOrgLimits, getFlowErrors, getApexTestResults, getDeploymentHistory,
} from "../services/salesforce.js";
import { resultContent } from "./utils.js";

export function registerMonitoringTools(server: McpServer): void {
  server.registerTool("sf_get_org_limits", {
    title: "Get Org Limits and Usage",
    description: `Retrieves current API and governor limit usage for the org via the Salesforce Limits REST API. Returns all limits with their current usage and maximum allowed values.

Useful for:
- Checking API call usage before running bulk operations
- Monitoring storage (data/file) usage
- Checking concurrent Apex job limits
- Reviewing email delivery limits
- Auditing active sessions

Returns an array of { name, remaining, max, percentUsed } sorted by percent used (most consumed first).`,
    inputSchema: GetOrgLimitsSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async () => {
    const auth = await getAuth();
    const result = await getOrgLimits(auth, {});
    return resultContent(result);
  });

  server.registerTool("sf_get_flow_errors", {
    title: "Get Flow Errors and Fault Logs",
    description: `Retrieves Flow interview fault records from the FlowRecordRelation and FlowInterview objects. Shows flows that have errored in runtime with their fault message and the record that triggered the error.

flowApiName: filter to a specific flow API name (optional — returns errors for all flows if omitted)
lookbackHours: how many hours back to search (default: 24, max: 168)
limit: maximum records to return (default: 50)

Returns: flow name, start time, error message, and related record ID for each fault.`,
    inputSchema: GetFlowErrorsSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (params) => {
    const auth = await getAuth();
    const result = await getFlowErrors(auth, params);
    return resultContent(result);
  });

  server.registerTool("sf_get_apex_test_results", {
    title: "Get Apex Test Results",
    description: `Retrieves Apex test results from the most recent test runs via the Tooling API. Returns pass/fail status, error messages, stack traces, and code coverage for each test method.

className: filter to a specific test class name (optional)
outcome: filter by outcome — 'Pass', 'Fail', 'Skip', or omit for all
limit: maximum results to return (default: 100)

Returns: class name, method name, outcome, run time (ms), error message, and stack trace for failures.`,
    inputSchema: GetApexTestResultsSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (params) => {
    const auth = await getAuth();
    const result = await getApexTestResults(auth, params);
    return resultContent(result);
  });

  server.registerTool("sf_get_deployment_history", {
    title: "Get Deployment History",
    description: `Retrieves the history of recent metadata deployments using the Tooling API DeployRequest object. Shows deployment status, component counts, test results, and error messages.

limit: number of recent deployments to return (default: 20, max: 200)
status: filter by status — 'Succeeded', 'Failed', 'Canceled', 'InProgress', 'Pending', or omit for all

Returns: deploy ID, status, start time, end time, component totals, test totals, and any errors.`,
    inputSchema: GetDeploymentHistorySchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (params) => {
    const auth = await getAuth();
    const result = await getDeploymentHistory(auth, params);
    return resultContent(result);
  });
}
