import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CreateOutboundChangeSetSchema,
  AddToChangeSetSchema,
  DeployMetadataSchema,
  CheckDeployStatusSchema,
  RetrieveMetadataSchema,
  DeleteMetadataSchema,
} from "../schemas/index.js";
import { getAuth, API_VERSION, deleteMetadataItems } from "../services/salesforce.js";
import {
  buildGenericDeployZip,
  deployZip,
  pollDeployStatus,
  checkDeployStatus,
  retrieveMetadataAndWait,
  extractPackageXmlInner,
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
      description: `Retrieves metadata components from the org and returns their actual file contents. Use this to read existing configuration before making changes, to back up metadata, or to check what is really deployed rather than what you think is deployed. Waits for the async retrieve to finish and unpacks the resulting zip, returning each file's path and source. Large files are truncated. Accepts 'components' (array), or 'metadataType'+'componentName' as a single-item shortcut, or a raw 'packageXml' document — provide exactly one form.`,
      inputSchema: RetrieveMetadataSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      const auth = await getAuth();
      // metadataType/componentName and packageXml were accepted by the schema but silently ignored —
      // found 2026-08-03 while investigating a related report (Finding 2: zero-result retrieves
      // reporting false success). A call using either form always retrieved literally nothing (empty
      // <unpackaged> body) while still reporting a "successful" retrieve of the manifest-only zip —
      // the same misleading-success shape as Finding 2, just via a different, previously-untested path.
      if (params.packageXml) {
        const result = await retrieveMetadataAndWait(auth, [], undefined, { rawUnpackagedXml: extractPackageXmlInner(params.packageXml) });
        return resultContent(result);
      }
      const components = (params.components && params.components.length > 0)
        ? params.components
        : (params.metadataType && params.componentName)
          ? [{ type: params.metadataType, name: params.componentName }]
          : (params.components ?? []);
      const result = await retrieveMetadataAndWait(auth, components);
      return resultContent(result);
    }
  );

  server.registerTool(
    "sf_delete_metadata",
    {
      title: "Delete Metadata",
      description: `Permanently deletes one or more metadata components of a given type via the Metadata API's deleteMetadata call — works for CustomObject, CustomField, Flow, GenAiFunction, GenAiPlugin, GenAiPlannerBundle, Bot, ApexClass, and most other metadata types. There was previously no way to remove anything created by this MCP server (sf_deploy_metadata only supports adding/updating components, not destructiveChanges) — diagnostic or abandoned metadata had nowhere to go. Deletes each fullName independently: check the response's deleted/errors lists rather than assuming all all-or-nothing. Some types have dependency order requirements (e.g. delete a Bot's GenAiFunction/GenAiPlugin/GenAiPlannerBundle before the Bot itself, delete CustomField before its parent CustomObject) — Salesforce will reject a delete that still has dependents, naming them in the error.`,
      inputSchema: DeleteMetadataSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      const auth = await getAuth();
      const result = await deleteMetadataItems(auth, params.metadataType, params.fullNames);
      return resultContent(result);
    }
  );
}
