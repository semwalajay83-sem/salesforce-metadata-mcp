import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CreateFlexipageSchema,
  CreatePathAssistantSchema,
  CreateCustomApplicationSchema,
} from "../schemas/index.js";
import {
  getAuth,
  createFlexipage,
  createPathAssistant,
  createCustomApplication,
} from "../services/salesforce.js";
import { resultContent } from "./utils.js";

export function registerPageTools(server: McpServer): void {

  server.registerTool(
    "sf_create_flexipage",
    {
      title: "Create Lightning App Builder Page (FlexiPage)",
      description: `Creates a Lightning App Builder page (FlexiPage) in the Salesforce org via the Metadata API. Supports AppPage, RecordPage, and HomePage types. Specify the page template (e.g. header_and_right_rail, header_and_three_regions) and for RecordPage provide the object API name. The page can then be activated and assigned via Setup > Lightning App Builder.`,
      inputSchema: CreateFlexipageSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      const auth = await getAuth();
      const result = await createFlexipage(auth, params);
      return resultContent(result);
    }
  );

  server.registerTool(
    "sf_create_path_assistant",
    {
      title: "Create Path Assistant (Sales Path)",
      description: `Creates a Path Assistant (Sales Path or Kanban path) for a Salesforce object picklist field via the Metadata API. Define path items for each picklist value with optional guidance text, info titles, and key fields to highlight at each stage. Activate the path to make it visible to users.`,
      inputSchema: CreatePathAssistantSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      const auth = await getAuth();
      const result = await createPathAssistant(auth, params);
      return resultContent(result);
    }
  );

  server.registerTool(
    "sf_create_custom_application",
    {
      title: "Create Lightning Application",
      description: `Creates a Lightning Application (App) in the Salesforce org via the Metadata API. Supports Standard and Console navigation types. Specify tabs to include, form factor (desktop or mobile), and optional utility bar components. The app appears in the App Launcher after creation.`,
      inputSchema: CreateCustomApplicationSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      const auth = await getAuth();
      const result = await createCustomApplication(auth, params);
      return resultContent(result);
    }
  );
}
