import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CreateOutboundChangeSetSchema,
  AddToChangeSetSchema,
  DeployMetadataSchema,
  CheckDeployStatusSchema,
  RetrieveMetadataSchema,
} from "../schemas/index.js";
import { getAuth, API_VERSION } from "../services/salesforce.js";
import {
  buildGenericDeployZip,
  deployZip,
  pollDeployStatus,
  checkDeployStatus,
  retrieveMetadata,
} from "../services/deployment.js";
import {
  createOutboundChangeSet,
  addComponentsToChangeSet,
} from "../services/tooling.js";
import { resultContent } from "./utils.js";

export function registerDeploymentTools(server: McpServer): void {

  server.registerTool(
    "sf_create_outbound_change_set",
    {
      title: "Create Outbound Change Set",
      description: `Creates an Outbound Change Set in the org — a container for metadata components that can be deployed to connected orgs (sandbox → production). Optionally adds specified components immediately. Returns the change set ID and a link to view it in Setup. Use this before deploying to production when using the change set deployment model.`,
      inputSchema: CreateOutboundChangeSetSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (params) => {
      const auth = await getAuth();
      const csResult = await createOutboundChangeSet(auth, params.changeSetName, params.description);
      if (!csResult.success || !params.components?.length) return resultContent(csResult);
      const addResult = await addComponentsToChangeSet(auth, params.changeSetName, params.components);
      return resultContent({
        success: addResult.success,
        message: `${csResult.message}\n${addResult.message}`,
        ...(addResult.success ? { fullName: params.changeSetName, created: true } : {})
      });
    }
  );

  server.registerTool(
    "sf_add_to_change_set",
    {
      title: "Add Components to Change Set",
      description: `Adds one or more metadata components to an existing Outbound Change Set by change set name. Supports all metadata types: CustomObject, CustomField, ApexClass, ApexTrigger, Flow, ValidationRule, PermissionSet, etc. Use after creating a change set to add the metadata you want to deploy.`,
      inputSchema: AddToChangeSetSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      const auth = await getAuth();
      const result = await addComponentsToChangeSet(auth, params.changeSetName, params.components);
      return resultContent(result);
    }
  );

  server.registerTool(
    "sf_deploy_metadata",
    {
      title: "Deploy Metadata",
      description: `Deploys a set of metadata components directly to the org using the Metadata API SOAP deploy operation. Builds a package.xml and deployment zip in memory. Supports validate-only (checkOnly:true) for pre-deployment validation without making changes. Specify runTests to execute test classes during deployment (required for production). Polls until complete or timeout.`,
      inputSchema: DeployMetadataSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      const auth = await getAuth();
      try {
        const base64Zip = await buildGenericDeployZip(params.components, API_VERSION, params.componentsXml);
        const deployId = await deployZip(auth, base64Zip, {
          checkOnly: params.checkOnly,
          runTests: params.runTests,
          rollbackOnError: params.rollbackOnError,
          testLevel: params.testLevel,
        });
        const result = await pollDeployStatus(auth, deployId, params.waitMinutes * 60 * 1000);
        return resultContent({
          success: result.success,
          message: `${params.checkOnly ? "[VALIDATE ONLY] " : ""}${result.message}`,
          ...(result.success ? { fullName: deployId, created: true } : {})
        });
      } catch (err: unknown) {
        return resultContent({ success: false, message: err instanceof Error ? err.message : String(err) });
      }
    }
  );

  server.registerTool(
    "sf_check_deploy_status",
    {
      title: "Check Deployment Status",
      description: `Checks the status of an in-progress or recently completed metadata deployment by async job ID. Returns the status (Pending, InProgress, Succeeded, Failed, Canceled), component successes, failures, and test results. Use with the deploy ID returned from sf_deploy_metadata.`,
      inputSchema: CheckDeployStatusSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      const auth = await getAuth();
      try {
        const status = await checkDeployStatus(auth, params.deployId);
        return resultContent({
          success: status.done ? status.success : true,
          message: status.message,
          ...(status.done && status.success ? { fullName: params.deployId, created: false } : {})
        });
      } catch (err: unknown) {
        return resultContent({ success: false, message: err instanceof Error ? err.message : String(err) });
      }
    }
  );

  server.registerTool(
    "sf_retrieve_metadata",
    {
      title: "Retrieve Metadata",
      description: `Retrieves metadata components from the org by initiating a SOAP retrieve operation. Returns an async job ID. The org will package the requested components — use this to read existing configuration before making changes, back up metadata, or understand the current state of a setup item. Returns the retrieve request ID; the actual zip is available via Metadata API checkRetrieveStatus.`,
      inputSchema: RetrieveMetadataSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      const auth = await getAuth();
      const result = await retrieveMetadata(auth, params.components ?? []);
      return resultContent(result);
    }
  );
}
