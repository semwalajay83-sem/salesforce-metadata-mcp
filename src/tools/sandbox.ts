import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CreateSandboxSchema,
  RefreshSandboxSchema,
  ListSandboxesSchema,
} from "../schemas/index.js";
import {
  getAuth,
  createSandbox,
  refreshSandbox,
  listSandboxes,
} from "../services/salesforce.js";
import { resultContent } from "./utils.js";

export function registerSandboxTools(server: McpServer): void {

  server.registerTool(
    "sf_create_sandbox",
    {
      title: "Create Sandbox",
      description: `Creates a new sandbox org via the Tooling API (SandboxInfo object). Supports Developer, Developer Pro, Partial Copy, and Full sandbox types. Optionally specify an Apex class to run after the sandbox copy completes. The sandbox creation is asynchronous — use sf_list_sandboxes to monitor the status.`,
      inputSchema: CreateSandboxSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (params) => {
      const auth = await getAuth();
      const result = await createSandbox(auth, params);
      return resultContent(result);
    }
  );

  server.registerTool(
    "sf_refresh_sandbox",
    {
      title: "Refresh Sandbox",
      description: `Refreshes an existing sandbox org by re-copying it from production via the Tooling API. The sandbox must already exist (use sf_create_sandbox for new sandboxes). Refreshing resets the sandbox to the current state of the production org. The refresh is asynchronous — use sf_list_sandboxes to monitor status.`,
      inputSchema: RefreshSandboxSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (params) => {
      const auth = await getAuth();
      const result = await refreshSandbox(auth, params);
      return resultContent(result);
    }
  );

  server.registerTool(
    "sf_list_sandboxes",
    {
      title: "List Sandboxes",
      description: `Lists all sandbox orgs associated with the production org, including their status, license type, and dates. Returns data from the SandboxInfo Tooling API object. Use this to monitor sandbox creation and refresh status. Must be called from the production org.`,
      inputSchema: ListSandboxesSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      void params;
      const auth = await getAuth();
      const result = await listSandboxes(auth);
      return resultContent(result);
    }
  );
}
