import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CreateKnowledgeArticleTypeSchema,
  CreateBusinessHoursSchema,
  CreateHolidaySchema,
} from "../schemas/index.js";
import {
  getAuth,
  createKnowledgeArticleType,
  createBusinessHours,
  createHoliday,
} from "../services/salesforce.js";
import { resultContent } from "./utils.js";

export function registerKnowledgeTools(server: McpServer): void {

  server.registerTool(
    "sf_create_knowledge_article_type",
    {
      title: "Create Knowledge Article Type",
      description: `Creates a Knowledge Article Type (a custom object for Salesforce Knowledge) via the Metadata API. The article type name must end in __kav. Optionally define custom fields for the article type such as text or long text area fields. Requires Knowledge to be enabled in the org.`,
      inputSchema: CreateKnowledgeArticleTypeSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      const auth = await getAuth();
      const result = await createKnowledgeArticleType(auth, params);
      return resultContent(result);
    }
  );

  server.registerTool(
    "sf_create_business_hours",
    {
      title: "Create Business Hours",
      description: `Creates Business Hours in Salesforce via the Metadata API. Define working hours for each day of the week, specify the time zone, and mark days as active or inactive. Business Hours are used with Entitlement Processes, Escalation Rules, and Holidays to calculate SLA milestones.`,
      inputSchema: CreateBusinessHoursSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      const auth = await getAuth();
      const result = await createBusinessHours(auth, params);
      return resultContent(result);
    }
  );

  server.registerTool(
    "sf_create_holiday",
    {
      title: "Create Holiday",
      description: `Creates a Holiday record in Salesforce via the Metadata API. Holidays are used with Business Hours to exclude specific days from SLA calculations. Supports both one-time and recurring holidays (e.g. yearly). Optionally associate the holiday with specific Business Hours.`,
      inputSchema: CreateHolidaySchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      const auth = await getAuth();
      const result = await createHoliday(auth, params);
      return resultContent(result);
    }
  );
}
