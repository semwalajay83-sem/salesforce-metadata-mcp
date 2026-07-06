import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  GetSetupAuditTrailSchema, GetLoginHistorySchema, GetEventLogsSchema, GetFieldHistorySchema,
} from "../schemas/index.js";
import { getAuth, getSetupAuditTrail, getLoginHistory, getEventLogs, getFieldHistory } from "../services/salesforce.js";
import { resultContent } from "./utils.js";

export function registerAuditTools(server: McpServer): void {
  server.registerTool("sf_get_setup_audit_trail", {
    title: "Get Setup Audit Trail",
    description: `Queries the SetupAuditTrail object to see who made what configuration changes to the org, and when. Covers the last 6 months of setup activity.

Returns records with: date, username, section, action, display (human-readable description)

section filter examples: 'Custom Fields', 'Profiles', 'Flows', 'Apex Classes', 'Permission Sets', 'Connected Apps', 'Users'

Useful for:
- Security audits (who changed profiles or permissions)
- Debugging unexpected configuration changes
- Compliance reporting on org configuration changes`,
    inputSchema: GetSetupAuditTrailSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (params) => {
    const auth = await getAuth();
    const result = await getSetupAuditTrail(auth, params);
    return resultContent(result);
  });

  server.registerTool("sf_get_login_history", {
    title: "Get Login History",
    description: `Queries LoginHistory to see user login activity — who logged in, from where, and whether they succeeded.

Returns records with: loginTime, username, sourceIp, browser, platform, status, loginType

status values: 'Success', 'Failed', 'No Password', 'Blocked', 'No Cookie'
loginType values: 'Application', 'API', 'SAML', 'OAuth', 'LightningLogin', 'Chatter'

Useful for:
- Security monitoring (failed logins, unusual IP addresses)
- Compliance auditing (who accessed the org and when)
- Investigating suspicious account activity

Note: LoginHistory covers the past 6 months.`,
    inputSchema: GetLoginHistorySchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (params) => {
    const auth = await getAuth();
    const result = await getLoginHistory(auth, params);
    return resultContent(result);
  });

  server.registerTool("sf_get_event_logs", {
    title: "Get Event Log Files",
    description: `Queries EventLogFile for detailed activity logs. Event logs capture granular org activity for security monitoring and performance analysis.

Common eventType values:
- Login — login attempts and results
- API — SOAP/REST API calls
- Report — report executions
- Flow — Flow runs and executions
- ApexExecution — Apex code executions
- LightningPageView — Lightning page views
- RestApi — REST API requests
- VisualforceRequest — Visualforce page requests
- URI — general HTTP requests
- LightningError — Lightning component errors

Returns parsed CSV log entries (up to 20 rows per log file, up to 3 files per call).

Requires Event Monitoring add-on OR Agentforce debug logs to be enabled.`,
    inputSchema: GetEventLogsSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (params) => {
    const auth = await getAuth();
    const result = await getEventLogs(auth, params);
    return resultContent(result);
  });

  server.registerTool("sf_get_field_history", {
    title: "Get Field History for a Record",
    description: `Queries the {Object}History object to retrieve a field-level change history for a specific record. Shows what changed, when, the old and new values, and who made the change.

Returns records with: date, field, oldValue, newValue, changedBy

objectApiName: the SObject with history tracking enabled, e.g. 'Account', 'Opportunity', 'Case'
recordId: the specific record to retrieve history for

Note: Field history tracking must be enabled for the object and for each field you want to track (Setup → Object Manager → {Object} → Fields & Relationships → Field History Tracking). History is retained for up to 18 months.`,
    inputSchema: GetFieldHistorySchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (params) => {
    const auth = await getAuth();
    const result = await getFieldHistory(auth, params);
    return resultContent(result);
  });
}
