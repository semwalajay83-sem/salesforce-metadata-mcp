import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CreateVisualforcePageSchema,
  CreateVisualforceComponentSchema,
  CreateVisualforceEmailTemplateSchema,
} from "../schemas/index.js";
import {
  getAuth,
  createVisualforcePage,
  createVisualforceComponent,
  createVisualforceEmailTemplate,
} from "../services/salesforce.js";
import { resultContent } from "./utils.js";

export function registerVisualforceTools(server: McpServer): void {

  server.registerTool(
    "sf_create_visualforce_page",
    {
      title: "Create Visualforce Page",
      description: `Creates a Visualforce page in the Salesforce org via the Metadata API. Provide the page API name, label, and Visualforce markup content (must include an <apex:page> tag). Optionally specify a standard controller, extensions, and whether to show the header/sidebar. The page is deployed immediately and accessible at /apex/PageName.`,
      inputSchema: CreateVisualforcePageSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      const auth = await getAuth();
      const result = await createVisualforcePage(auth, params);
      return resultContent(result);
    }
  );

  server.registerTool(
    "sf_create_visualforce_component",
    {
      title: "Create Visualforce Component",
      description: `Creates a reusable Visualforce component (ApexComponent) in the Salesforce org via the Metadata API. Provide the component API name, label, and Visualforce markup (must include an <apex:component> tag). Components can be included in Visualforce pages using <c:ComponentName/>.`,
      inputSchema: CreateVisualforceComponentSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      const auth = await getAuth();
      const result = await createVisualforceComponent(auth, params);
      return resultContent(result);
    }
  );

  server.registerTool(
    "sf_create_visualforce_email_template",
    {
      title: "Create Visualforce Email Template",
      description: `Creates a Visualforce email template in the Salesforce org. Provide the template name, subject, recipient type (Contact, Lead, or User), related entity type, and the HTML body with Visualforce markup. A plain-text body is also required for email clients that don't support HTML.`,
      inputSchema: CreateVisualforceEmailTemplateSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      const auth = await getAuth();
      const result = await createVisualforceEmailTemplate(auth, params);
      return resultContent(result);
    }
  );
}
