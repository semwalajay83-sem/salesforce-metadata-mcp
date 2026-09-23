import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CreateExperienceSiteSchema, CreateExperiencePageSchema } from "../schemas/index.js";
import { getAuth, createExperienceSite } from "../services/salesforce.js";
import { resultContent } from "./utils.js";

export function registerExperienceTools(server: McpServer): void {

  server.registerTool(
    "sf_create_experience_site",
    {
      title: "Create Experience Cloud Site",
      description: `Creates an Experience Cloud site (formerly Community) using a specified template. Supported templates: CustomerService (B2C self-service), Partner (B2B partner portal), LWR (Lightning Web Runtime — high performance), Aloha (App Launcher), Microsites (standalone pages). The urlPathPrefix appears in the site URL (e.g., 'customers' → org.force.com/customers). Site starts in UnderConstruction status by default.`,
      inputSchema: CreateExperienceSiteSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (params) => {
      const auth = await getAuth();
      const result = await createExperienceSite(auth, {
        siteName: params.siteName,
        label: params.label,
        template: params.template,
        urlPathPrefix: params.urlPathPrefix,
        description: params.description,
        status: params.status,
        guestUserProfile: params.guestUserProfile,
      });
      return resultContent(result);
    }
  );

  server.registerTool(
    "sf_create_experience_page",
    {
      title: "Create Experience Cloud Page",
      description: `Creates a page within an existing Experience Cloud site. Pages can be standard (home, login, profile, object detail, object list) or custom. The page URL path is relative to the site's URL prefix. Use after creating the site to add additional pages for different content sections.`,
      inputSchema: CreateExperiencePageSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (params) => {
      const auth = await getAuth();
      // Experience pages are created via the Sites REST API
      try {
        const { createClient } = await import("../services/salesforce.js");
        const client = createClient(auth);
        const resp = await client.post(`/connect/communities/${params.siteName}/pages`, {
          name: params.pageName,
          label: params.label,
          type: params.type,
          url: params.url ?? `/${params.pageName.toLowerCase().replace(/\s+/g, "-")}`,
        });
        const data = resp.data as { id?: string };
        return resultContent({
          success: true,
          message: `Experience page '${params.label}' created in site '${params.siteName}'.${data?.id ? ` Page ID: ${data.id}` : ""}`,
          fullName: `${params.siteName}/${params.pageName}`,
          created: true
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        // connect/communities/{id}/pages does not exist — measured 404 for GET and POST against a
        // real site id on 2026-09-23. Pages live in the site's ExperienceBundle (Aura) or
        // DigitalExperienceBundle (LWR). Until the tool writes those, say so instead of a bare 404.
        if (/\b404\b|NOT_FOUND/.test(msg)) {
          return resultContent({ success: false, message: `Salesforce has no REST endpoint for creating Experience Cloud pages, so this tool cannot create '${params.pageName}'. Add the page in Experience Builder, or deploy it as part of the site's ExperienceBundle / DigitalExperienceBundle. (Underlying error: ${msg})` });
        }
        return resultContent({ success: false, message: msg });
      }
    }
  );
}
