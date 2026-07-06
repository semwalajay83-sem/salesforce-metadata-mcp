// code-analyzer-suppress(cpd:DetectCopyPasteForTypescript)
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CreateFlexCardSchema, UpdateFlexCardSchema, ActivateFlexCardSchema, GetFlexCardSchema,
  CreateOmniScriptSchema, UpdateOmniScriptSchema, ActivateOmniScriptSchema, GetOmniScriptSchema,
  CreateDataRaptorSchema, GetDataRaptorSchema,
  CreateIntegrationProcedureSchema, UpdateIntegrationProcedureSchema,
  GetIntegrationProcedureSchema, ActivateIntegrationProcedureSchema,
  CreateCalculationMatrixSchema, CreateCalculationProcedureSchema,
  ExportOmniStudioComponentSchema, ImportOmniStudioComponentSchema, CreateDocumentGenerationSchema,
} from "../schemas/index.js";
import {
  getAuth,
  createFlexCard, updateFlexCard, activateFlexCard, getFlexCard,
  createOmniScript, updateOmniScript, activateOmniScript, getOmniScript,
  createDataRaptor, getDataRaptor,
  createIntegrationProcedure, updateIntegrationProcedure, activateIntegrationProcedure, getIntegrationProcedure,
  createCalculationMatrix, createCalculationProcedure,
  exportOmniStudioComponent, importOmniStudioComponent, createDocumentGeneration,
} from "../services/salesforce.js";
import { resultContent } from "./utils.js";

export function registerOmniStudioTools(server: McpServer): void {
  // ─── FLEXCARDS ────────────────────────────────────────────────────────────
  server.registerTool("sf_create_flexcard", {
    title: "Create OmniStudio FlexCard",
    description: `Creates an OmniStudio FlexCard (OmniUiCard metadata type). FlexCards display contextual data on Lightning pages and Experience Cloud sites.

A FlexCard defines:
- A data source (SOQL query, DataRaptor, Integration Procedure, Apex, or None)
- Fields to display from the data source
- Actions the user can take (navigate, launch OmniScript, open URL, start Flow)
- States (card variations based on data conditions)

The card is created in inactive state. Use sf_activate_flexcard to activate it after creation.

dataSourceType options:
- SOQL: provide a dataSourceName with a SOQL query string
- DataRaptor: provide the DataRaptor interface name
- IntegrationProcedure: provide the Integration Procedure key (Type_SubType)
- Apex: provide the Apex class name
- None: no data source (static card)`,
    inputSchema: CreateFlexCardSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (params) => {
    const auth = await getAuth();
    const result = await createFlexCard(auth, params);
    return resultContent(result);
  });

  server.registerTool("sf_update_flexcard", {
    title: "Update OmniStudio FlexCard",
    description: `Updates an existing OmniStudio FlexCard (OmniUiCard). Reads the current definition, merges the provided changes, and redeploys.

Provide only the fields you want to change. The card will be deactivated automatically if active — use sf_activate_flexcard to reactivate after the update.

All fields arrays (fields, actions, states) are replaced entirely if provided.`,
    inputSchema: UpdateFlexCardSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (params) => {
    const auth = await getAuth();
    const result = await updateFlexCard(auth, params);
    return resultContent(result);
  });

  server.registerTool("sf_activate_flexcard", {
    title: "Activate OmniStudio FlexCard",
    description: `Activates an OmniStudio FlexCard so it is visible on Lightning pages and Experience Cloud sites.

Reads the existing FlexCard definition and redeploys it with isActive=true. The card must already exist (created with sf_create_flexcard).`,
    inputSchema: ActivateFlexCardSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (params) => {
    const auth = await getAuth();
    const result = await activateFlexCard(auth, params);
    return resultContent(result);
  });

  server.registerTool("sf_get_flexcard", {
    title: "Get OmniStudio FlexCard",
    description: `Retrieves the configuration of an OmniStudio FlexCard including its data source, fields, actions, states, and activation status.`,
    inputSchema: GetFlexCardSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (params) => {
    const auth = await getAuth();
    const result = await getFlexCard(auth, params);
    return resultContent(result);
  });

  // ─── OMNISCRIPTS ──────────────────────────────────────────────────────────
  server.registerTool("sf_create_omniscript", {
    title: "Create OmniStudio OmniScript",
    description: `Creates an OmniStudio OmniScript — a guided interaction flow for collecting data or performing processes.

OmniScripts are identified by Type + SubType + Language (e.g. AccountOpening / Personal / English). The fullName becomes Type_SubType_Language.

The script is created inactive with the specified elements. Complex element configuration (branching logic, custom LWC overrides, remote actions) should be finalized in the OmniScript Designer after creation.

isLwcEnabled: true deploys the script as a Lightning Web Component (recommended for performance).
isOmniScriptEmbeddable: true allows embedding this script inside other OmniScripts.

Use sf_activate_omniscript to activate after creation.`,
    inputSchema: CreateOmniScriptSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (params) => {
    const auth = await getAuth();
    const result = await createOmniScript(auth, params);
    return resultContent(result);
  });

  server.registerTool("sf_update_omniscript", {
    title: "Update OmniStudio OmniScript",
    description: `Updates an existing OmniScript's metadata properties (description, LWC mode, embeddable flag). Identified by Type + SubType + Language.

Note: OmniScript element/step editing is best done in the OmniScript Designer. This tool updates the container metadata only. The script will be deactivated if currently active — reactivate with sf_activate_omniscript.`,
    inputSchema: UpdateOmniScriptSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (params) => {
    const auth = await getAuth();
    const result = await updateOmniScript(auth, params);
    return resultContent(result);
  });

  server.registerTool("sf_activate_omniscript", {
    title: "Activate OmniStudio OmniScript",
    description: `Activates an OmniScript so it can be launched from FlexCards, Experience Cloud, or standalone pages. Identified by Type + SubType + Language.`,
    inputSchema: ActivateOmniScriptSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (params) => {
    const auth = await getAuth();
    const result = await activateOmniScript(auth, params);
    return resultContent(result);
  });

  server.registerTool("sf_get_omniscript", {
    title: "Get OmniStudio OmniScript",
    description: `Retrieves the configuration of an OmniScript including its elements, activation status, and LWC settings. Identified by Type + SubType + Language.`,
    inputSchema: GetOmniScriptSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (params) => {
    const auth = await getAuth();
    const result = await getOmniScript(auth, params);
    return resultContent(result);
  });

  // ─── DATARAPTORS ─────────────────────────────────────────────────────────
  server.registerTool("sf_create_dataraptor", {
    title: "Create OmniStudio DataRaptor",
    description: `Creates a DataRaptor interface for OmniStudio data transformation. DataRaptors handle Extract (read from Salesforce), Transform (convert data formats), and Load (write to Salesforce) operations.

interfaceType:
- Extract: reads data from Salesforce objects using SOQL-like field mappings
- Transform: converts/maps data between formats (JSON path transformations)
- Load: writes data to Salesforce objects

Each field mapping defines:
- sourceField: source JSON path or Salesforce field API name
- targetField: target JSON path or Salesforce field API name
- dataType: data type (Text, Number, Boolean, Date, etc.)
- formula: optional transformation formula

filterCriteria: SOQL WHERE clause for Extract DataRaptors (e.g. "Id = ':AccountId'")`,
    inputSchema: CreateDataRaptorSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (params) => {
    const auth = await getAuth();
    const result = await createDataRaptor(auth, params);
    return resultContent(result);
  });

  server.registerTool("sf_get_dataraptor", {
    title: "Get OmniStudio DataRaptor",
    description: `Retrieves the configuration of a DataRaptor interface including its type, field mappings, and filter criteria.`,
    inputSchema: GetDataRaptorSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (params) => {
    const auth = await getAuth();
    const result = await getDataRaptor(auth, params);
    return resultContent(result);
  });

  // ─── INTEGRATION PROCEDURES ───────────────────────────────────────────────
  server.registerTool("sf_create_integration_procedure", {
    title: "Create OmniStudio Integration Procedure",
    description: `Creates an OmniStudio Integration Procedure — a server-side process that orchestrates data integration without UI. Integration Procedures run in Apex context and can be invoked from OmniScripts, FlexCards, or APIs.

Integration Procedures use the OmniScript metadata type with omniProcessType=IntegrationProcedure. The fullName is ProcedureName_SubType.

Element types:
- DataRaptor: call a DataRaptor for Salesforce CRUD
- HTTPAction: call an external REST/SOAP API
- Response: return data to the caller
- Loop: iterate over a collection
- Conditional: branch based on conditions
- SetValues: set variables
- ExceptionBlock: handle errors
- Matrix: call a Calculation Matrix
- OmniScript: call a nested OmniScript
- Aggregate: combine multiple data sources

Set isActive: true to activate immediately after creation.`,
    inputSchema: CreateIntegrationProcedureSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (params) => {
    const auth = await getAuth();
    const result = await createIntegrationProcedure(auth, params);
    return resultContent(result);
  });

  server.registerTool("sf_update_integration_procedure", {
    title: "Update OmniStudio Integration Procedure",
    description: `Updates an existing Integration Procedure's metadata (description, active status). Identified by procedureName + subType (fullName = procedureName_subType).

For element/step changes, use the OmniStudio Integration Procedure Designer. Set isActive: false to deactivate, then make changes, then sf_activate_integration_procedure.`,
    inputSchema: UpdateIntegrationProcedureSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (params) => {
    const auth = await getAuth();
    const result = await updateIntegrationProcedure(auth, params);
    return resultContent(result);
  });

  server.registerTool("sf_get_integration_procedure", {
    title: "Get OmniStudio Integration Procedure",
    description: `Retrieves the configuration of an Integration Procedure including its elements and activation status. Identified by procedureName + subType.`,
    inputSchema: GetIntegrationProcedureSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (params) => {
    const auth = await getAuth();
    const result = await getIntegrationProcedure(auth, params);
    return resultContent(result);
  });

  server.registerTool("sf_activate_integration_procedure", {
    title: "Activate OmniStudio Integration Procedure",
    description: `Activates an Integration Procedure so it can be invoked from OmniScripts, FlexCards, and APIs. Identified by procedureName + subType.`,
    inputSchema: ActivateIntegrationProcedureSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (params) => {
    const auth = await getAuth();
    const result = await activateIntegrationProcedure(auth, params);
    return resultContent(result);
  });

  // ─── CALCULATION MATRIX & PROCEDURE ──────────────────────────────────────
  server.registerTool("sf_create_calculation_matrix", {
    title: "Create OmniStudio Calculation Matrix",
    description: `Creates a Calculation Matrix for rule-based lookups and calculations. Matrices map input combinations to output values — useful for pricing, eligibility, scoring, and decision tables.

inputVariables: list of input variable names (columns used for lookups)
outputVariables: list of output variable names (columns returned)
rows: array of { inputs: {var: value}, outputs: {var: value} } defining the lookup table

Example: a pricing matrix with inputs [ProductType, Region] and outputs [Price, Discount].`,
    inputSchema: CreateCalculationMatrixSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (params) => {
    const auth = await getAuth();
    const result = await createCalculationMatrix(auth, params);
    return resultContent(result);
  });

  server.registerTool("sf_create_calculation_procedure", {
    title: "Create OmniStudio Calculation Procedure",
    description: `Creates a Calculation Procedure that orchestrates multi-step calculations using Calculation Matrices, formulas, and logic steps.

steps array — each step has:
- name: step identifier
- type: MatrixLookup (call a matrix), Formula (expression), Condition (branch), Assignment (set variable)
- matrixName: required for MatrixLookup steps
- expression: required for Formula/Condition steps
- inputMap: maps procedure variables to step inputs
- outputMap: maps step outputs back to procedure variables

Use Calculation Procedures to build complex pricing engines, eligibility calculators, or multi-factor scoring systems.`,
    inputSchema: CreateCalculationProcedureSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (params) => {
    const auth = await getAuth();
    const result = await createCalculationProcedure(auth, params);
    return resultContent(result);
  });

  server.registerTool("sf_export_omnistudio_component", {
    title: "Export OmniStudio Component",
    description: `Exports an OmniStudio component's metadata as a JSON string for backup, version control, or migration to another org.

componentType: FlexCard, OmniScript, DataRaptor, IntegrationProcedure, CalculationMatrix, or CalculationProcedure
componentName: the API name / fullName of the component to export (for OmniScript, use Type_SubType_Language format)

Returns the component metadata as a JSON-serialized XML string.`,
    inputSchema: ExportOmniStudioComponentSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (params) => {
    const auth = await getAuth();
    const result = await exportOmniStudioComponent(auth, params);
    return resultContent(result);
  });

  server.registerTool("sf_import_omnistudio_component", {
    title: "Import OmniStudio Component",
    description: `Imports an OmniStudio component into the org from previously exported JSON (from sf_export_omnistudio_component). Optionally renames the component on import.

componentType: FlexCard, OmniScript, DataRaptor, IntegrationProcedure, CalculationMatrix, or CalculationProcedure
exportedJson: the JSON string returned by sf_export_omnistudio_component
newComponentName: optional new name/fullName for the imported component (useful when migrating to a different name)`,
    inputSchema: ImportOmniStudioComponentSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (params) => {
    const auth = await getAuth();
    const result = await importOmniStudioComponent(auth, params);
    return resultContent(result);
  });

  server.registerTool("sf_create_document_generation", {
    title: "Create OmniStudio Document Generation Template",
    description: `Creates an OmniStudio Document Generation configuration (OmniDocumentGenerationConfig metadata type) that links a document template to a data source for automated document creation.

templateName: unique API name for the document generation config
label: display label
objectApiName: the Salesforce object this template generates documents for
templateType: Word, PDF, or Excel (default: Word)
dataSourceType: DataRaptor or IntegrationProcedure (default: DataRaptor)
dataSourceName: API name of the DataRaptor or Integration Procedure to use for data
description: optional description`,
    inputSchema: CreateDocumentGenerationSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (params) => {
    const auth = await getAuth();
    const result = await createDocumentGeneration(auth, params);
    return resultContent(result);
  });
}
