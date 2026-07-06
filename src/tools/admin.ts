import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CreateUserRoleHierarchySchema, ResetUserPasswordSchema, FreezeUserSchema,
  CreateETMTerritorySchema, AssignTerritoryToUserSchema, CreateForecastHierarchySchema,
  CreateSearchLayoutSchema, AssignLayoutToRecordTypeSchema, CreateCustomWebTabSchema,
} from "../schemas/index.js";
import {
  getAuth, createUserRoleHierarchy, resetUserPassword, freezeUser,
  createETMTerritory, assignTerritoryToUser, createForecastHierarchy,
  createSearchLayout, assignLayoutToRecordType, createCustomWebTab,
} from "../services/salesforce.js";
import { resultContent } from "./utils.js";

export function registerAdminTools(server: McpServer): void {
  server.registerTool("sf_create_user_role_hierarchy", {
    title: "Create User Role Hierarchy",
    description: `Creates a new UserRole in the Salesforce Role Hierarchy. Roles control record visibility — users in higher roles can see records owned by users in lower roles (depending on OWD). Optionally set a parentRoleName to place this role beneath an existing role.

roleName: API name for the role (no spaces, used as DeveloperName)
label: display name shown in Setup
parentRoleName: API name of the parent role (omit for a top-level role)
description: optional description`,
    inputSchema: CreateUserRoleHierarchySchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (params) => {
    const auth = await getAuth();
    const result = await createUserRoleHierarchy(auth, params);
    return resultContent(result);
  });

  server.registerTool("sf_reset_user_password", {
    title: "Reset User Password",
    description: `Resets a Salesforce user's password by username or user ID. Sends a password-reset email to the user's email address. Use when a user is locked out or needs to set a new password.

username or userId: identify the user (at least one required)
sendEmail: set false to reset without sending an email (default: true)`,
    inputSchema: ResetUserPasswordSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async (params) => {
    const auth = await getAuth();
    const result = await resetUserPassword(auth, params);
    return resultContent(result);
  });

  server.registerTool("sf_freeze_user", {
    title: "Freeze or Unfreeze User",
    description: `Freezes or unfreezes a Salesforce user account. A frozen user cannot log in but the license is retained (unlike deactivation). Useful for temporarily blocking access without losing data ownership.

username or userId: identify the user
freeze: true to freeze, false to unfreeze`,
    inputSchema: FreezeUserSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (params) => {
    const auth = await getAuth();
    const result = await freezeUser(auth, params);
    return resultContent(result);
  });

  server.registerTool("sf_create_territory", {
    title: "Create Enterprise Territory Management Territory",
    description: `Creates a Territory in Enterprise Territory Management (ETM). Territories define logical sales regions or account groupings. Requires ETM to be enabled in the org.

territoryName: API name (DeveloperName) of the territory
label: display name
territoryType: DeveloperName of the Territory2Type (e.g. 'Geographic', 'Named_Account')
parentTerritoryName: optional parent territory DeveloperName for hierarchical nesting
description: optional description`,
    inputSchema: CreateETMTerritorySchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (params) => {
    const auth = await getAuth();
    const result = await createETMTerritory(auth, params);
    return resultContent(result);
  });

  server.registerTool("sf_assign_territory_to_user", {
    title: "Assign Territory to User",
    description: `Assigns a user to an Enterprise Territory Management territory via the UserTerritory2Association SObject. Users assigned to a territory get visibility into accounts in that territory.

username or userId: identify the user
territoryName: DeveloperName of the Territory2 to assign
roleInTerritory: optional role — 'Salesperson', 'Manager', or 'BusinessUser'`,
    inputSchema: AssignTerritoryToUserSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async (params) => {
    const auth = await getAuth();
    const result = await assignTerritoryToUser(auth, params);
    return resultContent(result);
  });

  server.registerTool("sf_create_forecast_hierarchy", {
    title: "Create Forecast Hierarchy Configuration",
    description: `Configures a Collaborative Forecasting hierarchy entry by assigning a user as a forecast manager for another user. Forecast managers can view and adjust forecasts for their reports.

managerUsername: username of the forecast manager
reporteeUsername: username of the user being managed
forecastingType: the forecasting type DeveloperName (e.g. 'OpportunityRevenue')`,
    inputSchema: CreateForecastHierarchySchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async (params) => {
    const auth = await getAuth();
    const result = await createForecastHierarchy(auth, params);
    return resultContent(result);
  });

  server.registerTool("sf_create_search_layout", {
    title: "Create Search Layout",
    description: `Creates or updates a SearchLayout for a Salesforce object, defining which fields appear in search results, lookup dialogs, and lookup filter fields. Use to customize what columns users see when they search for records or open a lookup dialog.

objectName: the API name of the object, e.g. 'Account' or 'Invoice__c'
searchResultsAdditionalFields: field API names to show as columns in global search results
lookupDialogsAdditionalFields: field API names to show in lookup dialog results
lookupFilterFields: field API names used as filterable columns in lookups`,
    inputSchema: CreateSearchLayoutSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (params) => {
    const auth = await getAuth();
    const result = await createSearchLayout(auth, params);
    return resultContent(result);
  });

  server.registerTool("sf_assign_layout_to_record_type", {
    title: "Assign Layout to Record Type",
    description: `Assigns an existing page layout to a specific record type on an object by updating the Profile metadata. Controls which page layout users see when viewing records of a given record type.

objectName: the API name of the object
recordTypeName: developer name of the record type
layoutName: full name of the page layout, e.g. 'Account Layout'
profileNames: optional list of profile names to update (defaults to Admin profile)`,
    inputSchema: AssignLayoutToRecordTypeSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (params) => {
    const auth = await getAuth();
    const result = await assignLayoutToRecordType(auth, params);
    return resultContent(result);
  });

  server.registerTool("sf_create_custom_tab", {
    title: "Create Custom Web Tab",
    description: `Creates a Custom Web Tab (URL-based tab) that opens an external URL or web page within the Salesforce UI. Different from sf_create_tab which creates object-based tabs. Use when you need a navigation item that points to an external website, an internal Visualforce page by URL, or a custom web app.

fullName: API name for the tab (no spaces, e.g. 'My_Web_Tab')
label: display label shown in the tab bar
url: the URL the tab points to, e.g. 'https://example.com'
description: optional description
hasSidebar: whether to show the Salesforce sidebar alongside the tab content`,
    inputSchema: CreateCustomWebTabSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (params) => {
    const auth = await getAuth();
    const result = await createCustomWebTab(auth, params);
    return resultContent(result);
  });
}
