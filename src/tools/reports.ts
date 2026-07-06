import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CreateReportSchema, UpdateDashboardSchema, CreateReportFolderSchema, ShareReportFolderSchema } from "../schemas/index.js";
import { getAuth, createReport, updateDashboard, createReportFolder, shareReportFolder } from "../services/salesforce.js";
import { resultContent } from "./utils.js";

export function registerReportTools(server: McpServer): void {
  server.registerTool("sf_create_report", {
    title: "Create Salesforce Report",
    description: `Creates a Salesforce Report using the Report metadata type. Supports Tabular, Summary, Matrix, and Joined formats. Specify the report type (e.g., Accounts, Opportunities), columns to display, and optional filters. Reports are created in the specified folder or your personal folder by default.`,
    inputSchema: CreateReportSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (params) => {
    const auth = await getAuth();
    const result = await createReport(auth, params);
    return resultContent(result);
  });

  server.registerTool("sf_update_dashboard", {
    title: "Update Dashboard",
    description: `Updates an existing Dashboard's title or description by reading the current configuration from the org and applying changes. The dashboard must already exist. For structural changes (adding/removing components), use sf_create_dashboard to create a new version.`,
    inputSchema: UpdateDashboardSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (params) => {
    const auth = await getAuth();
    const result = await updateDashboard(auth, params);
    return resultContent(result);
  });

  server.registerTool("sf_create_report_folder", {
    title: "Create Report or Dashboard Folder",
    description: `Creates a folder for organizing Reports or Dashboards. Folder access types: Hidden (only owner), Shared (explicit sharing), Public (all users). After creating, use sf_share_report_folder to grant access to specific users, roles, or groups.`,
    inputSchema: CreateReportFolderSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (params) => {
    const auth = await getAuth();
    const result = await createReportFolder(auth, params);
    return resultContent(result);
  });

  server.registerTool("sf_share_report_folder", {
    title: "Share Report or Dashboard Folder",
    description: `Shares a Report or Dashboard folder with users, roles, groups, or territories. Sets access levels (View, Edit, Manage) per share recipient. Use after creating a folder to grant team members access.`,
    inputSchema: ShareReportFolderSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (params) => {
    const auth = await getAuth();
    const result = await shareReportFolder(auth, params);
    return resultContent(result);
  });
}
