import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CreateAuraComponentSchema,
  CreateAuraAppSchema,
  CreateAuraEventSchema,
} from "../schemas/index.js";
import {
  getAuth,
  createAuraComponent,
  createAuraApp,
  createAuraEvent,
} from "../services/salesforce.js";
import { resultContent } from "./utils.js";

export function registerAuraTools(server: McpServer): void {

  server.registerTool(
    "sf_create_aura_component",
    {
      title: "Create Aura (Lightning) Component",
      description: `Generates an Aura (Lightning Component Framework) component scaffold. Returns the complete bundle file contents: .cmp markup, JavaScript controller, CSS stylesheet, design resource, and metadata XML. Specify interfaces the component implements (e.g. force:appHostable for App Builder), attributes with types and defaults, and an optional Apex controller. Use sf_create_lwc for new development — Aura is for legacy migration scenarios.`,
      inputSchema: CreateAuraComponentSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      const auth = await getAuth();
      const result = await createAuraComponent(auth, params);
      return resultContent(result);
    }
  );

  server.registerTool(
    "sf_create_aura_app",
    {
      title: "Create Aura Application",
      description: `Generates an Aura Application bundle scaffold. Returns the .app file content with the specified access level, optional parent app extension (e.g. force:slds for SLDS styling), included components, and body content. Aura Apps are standalone Lightning applications accessible via /c/AppName.app URL.`,
      inputSchema: CreateAuraAppSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      const auth = await getAuth();
      const result = await createAuraApp(auth, params);
      return resultContent(result);
    }
  );

  server.registerTool(
    "sf_create_aura_event",
    {
      title: "Create Aura Event",
      description: `Generates an Aura Event scaffold (.evt file content). Supports COMPONENT events (propagate up the component hierarchy) and APPLICATION events (broadcast to all subscribed components). Define event attributes with names and types. Components fire events with component.getEvent() and APPLICATION events with $A.get().`,
      inputSchema: CreateAuraEventSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      const auth = await getAuth();
      const result = await createAuraEvent(auth, params);
      return resultContent(result);
    }
  );
}
