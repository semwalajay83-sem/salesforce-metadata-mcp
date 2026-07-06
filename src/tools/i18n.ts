import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  TranslateCustomLabelSchema,
  TranslateFieldLabelSchema,
} from "../schemas/index.js";
import {
  getAuth,
  translateCustomLabel,
  translateFieldLabel,
} from "../services/salesforce.js";
import { resultContent } from "./utils.js";

export function registerI18nTools(server: McpServer): void {

  server.registerTool(
    "sf_translate_custom_label",
    {
      title: "Translate Custom Label",
      description: `Adds or updates a translation for a Salesforce Custom Label via the Metadata API (Translations type). Provide the label API name, the target language code (e.g. 'fr' for French, 'de' for German, 'ja' for Japanese), and the translated value. Translation Workbench must be enabled in the org. Existing translations for the same label and language will be overwritten.`,
      inputSchema: TranslateCustomLabelSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      const auth = await getAuth();
      const result = await translateCustomLabel(auth, params);
      return resultContent(result);
    }
  );

  server.registerTool(
    "sf_translate_field_label",
    {
      title: "Translate Field Label",
      description: `Adds or updates a translation for a field label (and optionally help text) on a Salesforce object via the Metadata API (CustomObjectTranslation type). Provide the object API name, field API name, language code (e.g. 'fr', 'de', 'es'), and the translated label. Optionally include translated help text. Translation Workbench must be enabled.`,
      inputSchema: TranslateFieldLabelSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      const auth = await getAuth();
      const result = await translateFieldLabel(auth, params);
      return resultContent(result);
    }
  );
}
