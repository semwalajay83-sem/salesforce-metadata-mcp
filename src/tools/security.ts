import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CreatePermissionSetSchema,
  CreateRoleSchema,
  CreateQueueSchema,
  CreateNamedCredentialSchema,
  CreateRoleHierarchySchema,
  CreateFieldLevelSecuritySchema,
  CreateCustomPermissionSchema,
  CreateMutingPermSetSchema,
  CreatePermSetGroupSchema,
} from "../schemas/index.js";
import {
  getAuth,
  createPermissionSet,
  createRole,
  createQueue,
  createNamedCredential,
  createRoleHierarchy,
  createFieldLevelSecurity,
  createCustomPermission,
  createMutingPermSetSimple,
  createPermSetGroupSimple,
} from "../services/salesforce.js";
import { resultContent } from "./utils.js";

export function registerSecurityTools(server: McpServer): void {

  server.registerTool(
    "sf_create_permission_set",
    {
      title: "Create Permission Set",
      description: `Creates a Permission Set with object permissions, field permissions, Apex class access, and user permissions. Permission Sets extend a user's access without changing their profile. Use when you need to grant specific permissions to a subset of users (e.g., a 'Sales Manager' permission set that allows deleting opportunities).`,
      inputSchema: CreatePermissionSetSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      const auth = await getAuth();
      const result = await createPermissionSet(auth, {
        fullName: params.fullName,
        label: params.label,
        description: params.description,
        objectPermissions: params.objectPermissions,
        fieldPermissions: params.fieldPermissions,
        apexClassAccesses: params.apexClassAccesses,
        userPermissions: params.userPermissions,
        tabSettings: params.tabSettings,
      });
      return resultContent(result);
    }
  );

  server.registerTool(
    "sf_create_role",
    {
      title: "Create Role",
      description: `Creates a Role in the Salesforce role hierarchy. Roles control record visibility through role-based sharing. Users in higher roles can see records owned by users in subordinate roles. Specify a parentRole to place this role in the hierarchy, or omit it for a top-level role.`,
      inputSchema: CreateRoleSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      const auth = await getAuth();
      const result = await createRole(auth, {
        fullName: params.fullName,
        name: params.name,
        description: params.description,
        parentRole: params.parentRole,
        caseAccessLevel: params.caseAccessLevel,
        contactAccessLevel: params.contactAccessLevel,
        opportunityAccessLevel: params.opportunityAccessLevel,
        accountAccessLevel: params.accountAccessLevel,
        mayForecastManagerShare: params.mayForecastManagerShare,
      });
      return resultContent(result);
    }
  );

  server.registerTool(
    "sf_create_queue",
    {
      title: "Create Queue",
      description: `Creates a Queue in Salesforce. Queues are groups of users that can be assigned records (Cases, Leads, etc.). When a record is assigned to a queue, any queue member can work on it. Use for support teams, sales teams, or any scenario where multiple people share a pool of records to process.`,
      inputSchema: CreateQueueSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      const auth = await getAuth();
      const result = await createQueue(auth, {
        fullName: params.fullName,
        name: params.name,
        email: params.email,
        doesSendEmailToMembers: params.doesSendEmailToMembers,
        supportedObjects: params.supportedObjects,
        queueMembers: params.queueMembers,
      });
      return resultContent(result);
    }
  );

  server.registerTool(
    "sf_create_named_credential",
    {
      title: "Create Named Credential",
      description: `Creates a Named Credential for making authenticated callouts to external systems from Apex or Flows. Named Credentials store the endpoint URL and authentication details securely, so developers don't hardcode credentials. Supports NoAuthentication, Basic (username/password), OAuth, and more. Use with sf_create_remote_site_setting to also allow the URL.`,
      inputSchema: CreateNamedCredentialSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      const auth = await getAuth();
      const result = await createNamedCredential(auth, {
        fullName: params.fullName,
        label: params.label,
        endpoint: params.endpoint,
        principalType: params.principalType,
        protocol: params.protocol,
        username: params.username,
        allowFormula: params.allowFormula,
        allowCallout: params.allowCallout,
      });
      return resultContent(result);
    }
  );

  server.registerTool(
    "sf_create_role_hierarchy",
    {
      title: "Create Role Hierarchy (Bulk)",
      description: `Creates multiple Salesforce roles in the role hierarchy in a single call. Roles control record visibility — users in higher roles see records owned by subordinate-role users (depending on OWD settings). Use to set up an entire hierarchy at once.

roles: array of {fullName, name, parentRole?, description?}
  - fullName: role API name (e.g. 'VP_Sales')
  - name: display label
  - parentRole: API name of parent role (omit for top-level)`,
      inputSchema: CreateRoleHierarchySchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      const auth = await getAuth();
      const result = await createRoleHierarchy(auth, params);
      return resultContent(result);
    }
  );

  server.registerTool(
    "sf_create_field_level_security",
    {
      title: "Set Field Level Security",
      description: `Sets field-level security (FLS) for a field across one or more profiles, controlling whether each profile can read and/or edit the field. Use after creating a custom field to make it visible and editable to the right profiles.

objectName: object API name
fieldName: field API name (e.g. 'Revenue__c')
profiles: array of {profileName, readable, editable}`,
      inputSchema: CreateFieldLevelSecuritySchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      const auth = await getAuth();
      const result = await createFieldLevelSecurity(auth, params);
      return resultContent(result);
    }
  );

  server.registerTool(
    "sf_create_custom_permission",
    {
      title: "Create Custom Permission",
      description: `Creates a Custom Permission that can be checked in formulas with $Permission.MyPerm or in Apex with FeatureManagement.checkPermission('MyPerm'). Assign custom permissions to users via Permission Sets. Use for feature flags, conditional UI rendering, or access gates.

fullName: permission API name (e.g. 'Can_Approve_Discounts')
label: display label
description: optional description
requiredPermissions: other custom permissions required before this one can be granted`,
      inputSchema: CreateCustomPermissionSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      const auth = await getAuth();
      const result = await createCustomPermission(auth, params);
      return resultContent(result);
    }
  );

  server.registerTool(
    "sf_create_muting_permission_set",
    {
      title: "Create Muting Permission Set",
      description: `Creates a Muting Permission Set that removes specific permissions from users in a Permission Set Group. Use to create exceptions — e.g., a Permission Set Group grants broad access, and a Muting Permission Set removes a subset of that access for specific users.

fullName: muting permission set API name
label: display label
description: optional description`,
      inputSchema: CreateMutingPermSetSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      const auth = await getAuth();
      const result = await createMutingPermSetSimple(auth, params);
      return resultContent(result);
    }
  );

  server.registerTool(
    "sf_create_permission_set_group",
    {
      title: "Create Permission Set Group",
      description: `Creates a Permission Set Group that aggregates multiple Permission Sets into a single assignable unit. Users assigned the group receive all permissions from all included permission sets. Simplifies administration when users need a combination of permissions.

fullName: Permission Set Group API name
label: display label
permissionSets: array of Permission Set API names to include`,
      inputSchema: CreatePermSetGroupSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      const auth = await getAuth();
      const result = await createPermSetGroupSimple(auth, params);
      return resultContent(result);
    }
  );
}
