import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CreateQuickActionSchema,
  CreateGlobalActionSchema,
  CreateCustomButtonSchema,
  CreateFieldSetSchema,
} from "../schemas/index.js";
import {
  getAuth,
  createQuickAction,
  createGlobalAction,
  createCustomButton,
  createFieldSet,
} from "../services/salesforce.js";
import { resultContent } from "./utils.js";

export function registerActionTools(server: McpServer): void {

  server.registerTool(
    "sf_create_quick_action",
    {
      title: "Create Quick Action",
      description: `Creates an object-specific quick action on a Salesforce object via the Metadata API. Supports Create, Update, LogACall, and SendEmail action types. Optionally specify a target object (for Create type) and the fields to include in the action layout.`,
      inputSchema: CreateQuickActionSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      const auth = await getAuth();
      const result = await createQuickAction(auth, params);
      return resultContent(result);
    }
  );

  server.registerTool(
    "sf_create_global_action",
    {
      title: "Create Global Quick Action",
      description: `Creates a global quick action accessible from the global navigation bar in Salesforce. Supports Create, LogACall, SendEmail, and Canvas action types. Global actions are not tied to a specific object and appear in the global quick actions menu.`,
      inputSchema: CreateGlobalActionSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      const auth = await getAuth();
      const result = await createGlobalAction(auth, params);
      return resultContent(result);
    }
  );

  server.registerTool(
    "sf_create_custom_button",
    {
      title: "Create Custom Button or Link",
      description: `Creates a custom button or link on a Salesforce object via the Metadata API (WebLink). Supports list buttons, detail page buttons, and mass action buttons. Content can be a URL, JavaScript, or a Visualforce page reference. Specify how the target opens (sidebar, new window, replace current page, etc.).`,
      inputSchema: CreateCustomButtonSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      const auth = await getAuth();
      const result = await createCustomButton(auth, params);
      return resultContent(result);
    }
  );

  server.registerTool(
    "sf_create_field_set",
    {
      title: "Create Field Set",
      description: `Creates a field set on a Salesforce object via the Metadata API. Field sets are named groupings of fields used in dynamic forms, Apex code, and LWC. Specify the displayed fields (in the field set) and optionally additional available fields that users can add.`,
      inputSchema: CreateFieldSetSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      const auth = await getAuth();
      const result = await createFieldSet(auth, params);
      return resultContent(result);
    }
  );
}
