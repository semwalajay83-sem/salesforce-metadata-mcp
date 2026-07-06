import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CreateLwcSchema, UpdateLwcSchema,
  CreateLwcJestTestSchema, GuideLwcAccessibilitySchema,
  MigrateAuraToLwcSchema, CreateLwcFromRequirementsSchema, ExploreSldsBlueprintsSchema,
} from "../schemas/index.js";
import {
  getAuth,
  createLwcJestTest, guideLwcAccessibility, migrateAuraToLwc,
  createLwcFromRequirements, exploreSldsBlueprints,
} from "../services/salesforce.js";
import { buildLwcZip, deployZip, pollDeployStatus } from "../services/deployment.js";
import { resultContent } from "./utils.js";

export function registerLwcTools(server: McpServer): void {

  server.registerTool(
    "sf_create_lwc",
    {
      title: "Create Lightning Web Component",
      description: `Creates and deploys a new Lightning Web Component (LWC) to the Salesforce org. Provide the HTML template, JavaScript controller, optional CSS, and component metadata. The component is packaged into a deployment zip and deployed via the Metadata API. Specify targets to make the component available in Lightning App Builder (AppPage, RecordPage, HomePage), Flow Screen, Utility Bar, or Experience Cloud. Use isExposed:true to make it drag-and-drop in App Builder.`,
      inputSchema: CreateLwcSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      const auth = await getAuth();
      try {
        const base64Zip = await buildLwcZip({
          componentName: params.componentName,
          html: params.html,
          javascript: params.javascript,
          css: params.css,
          description: params.description,
          apiVersion: params.apiVersion,
          targets: params.targets,
          isExposed: params.isExposed,
        });
        const deployId = await deployZip(auth, base64Zip);
        const result = await pollDeployStatus(auth, deployId, 5 * 60 * 1000);
        if (result.success) {
          return resultContent({
            success: true,
            message: `LWC '${params.componentName}' deployed successfully.`,
            fullName: params.componentName,
            created: true
          });
        }
        return resultContent(result);
      } catch (err: unknown) {
        return resultContent({ success: false, message: err instanceof Error ? err.message : String(err) });
      }
    }
  );

  server.registerTool(
    "sf_update_lwc",
    {
      title: "Update Lightning Web Component",
      description: `Updates an existing Lightning Web Component by redeploying it with updated HTML, JavaScript, or CSS. Provide only the files you want to update — any files omitted will use empty placeholders (so you should provide all files you want to keep). The component is redeployed via the Metadata API.`,
      inputSchema: UpdateLwcSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      const auth = await getAuth();
      try {
        const base64Zip = await buildLwcZip({
          componentName: params.componentName,
          html: params.html ?? `<template>\n  <!-- ${params.componentName} -->\n</template>`,
          javascript: params.javascript ?? `import { LightningElement } from 'lwc';\nexport default class ${params.componentName.charAt(0).toUpperCase() + params.componentName.slice(1)} extends LightningElement {}`,
          css: params.css,
          apiVersion: params.apiVersion,
          isExposed: true,
        });
        const deployId = await deployZip(auth, base64Zip);
        const result = await pollDeployStatus(auth, deployId, 5 * 60 * 1000);
        if (result.success) {
          return resultContent({
            success: true,
            message: `LWC '${params.componentName}' updated successfully.`,
            fullName: params.componentName,
            created: false
          });
        }
        return resultContent(result);
      } catch (err: unknown) {
        return resultContent({ success: false, message: err instanceof Error ? err.message : String(err) });
      }
    }
  );

  server.registerTool("sf_create_lwc_jest_test", {
    title: "Create LWC Jest Test",
    description: `Creates a Jest test file for an existing LWC component using @salesforce/lwc-jest conventions. The test file is placed in the __tests__ subfolder of the component bundle and deployed via the Metadata API.

componentName: LWC component name in camelCase, e.g. 'myButton'
testContent: Jest test file content (JavaScript)
apiVersion: Salesforce API version`,
    inputSchema: CreateLwcJestTestSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (params) => {
    const auth = await getAuth();
    const result = await createLwcJestTest(auth, params);
    return resultContent(result);
  });

  server.registerTool("sf_guide_lwc_accessibility", {
    title: "LWC Accessibility Guidance",
    description: `Returns guidance and a checklist for LWC accessibility best practices covering ARIA attributes, keyboard navigation, focus management, and screen reader support. A read-only advisory tool — does not modify the org.

componentName: optional component name for context
checklistOnly: return only the checklist items without detailed guidance`,
    inputSchema: GuideLwcAccessibilitySchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (params) => {
    const auth = await getAuth();
    const result = await guideLwcAccessibility(auth, params);
    return resultContent(result);
  });

  server.registerTool("sf_migrate_aura_to_lwc", {
    title: "Migrate Aura Component to LWC",
    description: `Analyzes an Aura component and returns a comprehensive migration guide with Aura-to-LWC concept mappings, key differences, and an optional LWC scaffold. A read-only advisory tool — does not modify the org.

auraComponentName: the Aura component name to analyze
includeScaffold: whether to generate equivalent LWC template, JS, CSS, and meta files`,
    inputSchema: MigrateAuraToLwcSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (params) => {
    const auth = await getAuth();
    const result = await migrateAuraToLwc(auth, params);
    return resultContent(result);
  });

  server.registerTool("sf_create_lwc_from_requirements", {
    title: "Generate LWC from Requirements",
    description: `Generates a complete LWC component scaffold (HTML template, JS controller, CSS, and meta XML) from a plain-English requirements description. Returns the generated code for review before deploying with sf_create_lwc.

componentName: LWC component name in camelCase
requirements: plain-English description of what the component should do
includeWireAdapters: include @wire adapter examples for data fetching
targetObject: optional Salesforce object to bind to`,
    inputSchema: CreateLwcFromRequirementsSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (params) => {
    const auth = await getAuth();
    const result = await createLwcFromRequirements(auth, params);
    return resultContent(result);
  });

  server.registerTool("sf_explore_slds_blueprints", {
    title: "Explore SLDS Component Blueprints",
    description: `Returns Salesforce Lightning Design System (SLDS) component examples, best practices, and usage guidance for a given UI pattern. A read-only reference tool — does not modify the org.

componentType: SLDS component type, e.g. 'data-table', 'modal', 'combobox'
includeExampleCode: whether to include example LWC code snippets`,
    inputSchema: ExploreSldsBlueprintsSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (params) => {
    const auth = await getAuth();
    const result = await exploreSldsBlueprints(auth, params);
    return resultContent(result);
  });
}
