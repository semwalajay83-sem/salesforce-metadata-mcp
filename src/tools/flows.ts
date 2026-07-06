import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  ActivateFlowSchema,
  DeactivateFlowSchema,
  ListFlowVersionsSchema,
  CreateFlowFromXmlSchema,
} from "../schemas/index.js";
import {
  getAuth,
  activateFlow,
  deactivateFlow,
  listFlowVersions,
  API_VERSION,
} from "../services/salesforce.js";
import {
  buildGenericDeployZip,
  deployZip,
  pollDeployStatus,
} from "../services/deployment.js";
import { resultContent } from "./utils.js";

export function registerFlowManagementTools(server: McpServer): void {

  server.registerTool(
    "sf_activate_flow",
    {
      title: "Activate Flow Version",
      description: `Activates a specific Flow version (or the latest version) via the Tooling API. Only one version of a flow can be active at a time — activating a new version automatically deactivates the previous active version. Use sf_list_flow_versions to discover available versions before activating.`,
      inputSchema: ActivateFlowSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      const auth = await getAuth();
      const result = await activateFlow(auth, params);
      return resultContent(result);
    }
  );

  server.registerTool(
    "sf_deactivate_flow",
    {
      title: "Deactivate Flow",
      description: `Deactivates the currently active version of a Flow via the Tooling API, setting its status to Draft. This stops the flow from being triggered. Use sf_activate_flow to re-activate a specific version. Note: deactivating a flow does not delete it.`,
      inputSchema: DeactivateFlowSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      const auth = await getAuth();
      const result = await deactivateFlow(auth, params);
      return resultContent(result);
    }
  );

  server.registerTool(
    "sf_list_flow_versions",
    {
      title: "List Flow Versions",
      description: `Lists all versions of a specific Flow, or all Flows in the org, via the Tooling API. Returns version number, status (Active, Draft, Obsolete), description, and creation date for each version. Optionally filter to exclude deactivated (Obsolete) versions. Use flowApiName to filter to a single flow.`,
      inputSchema: ListFlowVersionsSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      const auth = await getAuth();
      const result = await listFlowVersions(auth, params);
      return resultContent(result);
    }
  );

  server.registerTool(
    "sf_create_flow_from_xml",
    {
      title: "Deploy Flow from Raw XML",
      description: `Deploys a Salesforce Flow directly from raw XML using the Metadata API zip deploy. Use this for complex flows that are too advanced for sf_create_flow's parameter-based builder — paste the full Flow XML and it deploys it directly. Optionally activates the flow after deployment. The flowXml must be a complete Flow metadata XML document.`,
      inputSchema: CreateFlowFromXmlSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      const auth = await getAuth();
      try {
        const base64Zip = await buildGenericDeployZip(
          [],
          API_VERSION,
          [{ type: "Flow", name: params.flowApiName, xml: params.flowXml }]
        );
        const deployId = await deployZip(auth, base64Zip, { rollbackOnError: true });
        const deployResult = await pollDeployStatus(auth, deployId, 10 * 60 * 1000);
        if (!deployResult.success) {
          return resultContent(deployResult);
        }
        if (params.activate) {
          const activateResult = await activateFlow(auth, { flowApiName: params.flowApiName });
          return resultContent({
            success: activateResult.success,
            fullName: params.flowApiName,
            created: true,
            message: `${deployResult.message} | Activation: ${activateResult.message}`,
          });
        }
        return resultContent({ ...deployResult, fullName: params.flowApiName, created: true });
      } catch (err: unknown) {
        return resultContent({ success: false, message: err instanceof Error ? err.message : String(err) });
      }
    }
  );
}
