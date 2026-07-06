import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CreateCustomObjectSchema,
  CreateCustomFieldSchema,
  AddPicklistValuesSchema,
  CreateFlowSchema,
  CreateApprovalProcessSchema,
  CreateValidationRuleSchema,
  CreateWorkflowFieldUpdateSchema,
  CreateFormulaFieldSchema,
} from "../schemas/index.js";
import {
  getAuth,
  createCustomObject,
  createCustomField,
  addPicklistValues,
  activateFlow,
  buildFlowDeployXml,
  createApprovalProcess,
  createValidationRule,
  createWorkflowFieldUpdate,
  createFormulaField,
  API_VERSION,
} from "../services/salesforce.js";
import {
  buildGenericDeployZip,
  deployZip,
  pollDeployStatus,
} from "../services/deployment.js";
import type {
  CustomObjectMetadata,
  CustomFieldMetadata,
  PicklistValue,
} from "../types.js";
import { resultContent } from "./utils.js";

export function registerMetadataTools(server: McpServer): void {

  server.registerTool(
    "sf_create_custom_object",
    {
      title: "Create Salesforce Custom Object",
      description: `Creates a new Salesforce Custom Object using the Metadata API. The object name must end with '__c'. Use this when a user asks to create a new object, entity, or table in Salesforce.`,
      inputSchema: CreateCustomObjectSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      const auth = await getAuth();
      const meta: CustomObjectMetadata = {
        fullName: params.fullName,
        label: params.label,
        pluralLabel: params.pluralLabel,
        description: params.description,
        deploymentStatus: params.deploymentStatus,
        sharingModel: params.sharingModel,
        enableActivities: params.enableActivities,
        enableHistory: params.enableHistory,
        enableReports: params.enableReports,
        enableSearch: params.enableSearch,
        nameField: {
          label: params.nameFieldLabel,
          type: params.nameFieldType,
          ...(params.nameFieldType === "AutoNumber"
            ? { displayFormat: params.autoNumberFormat ?? "REC-{0000}" }
            : {}),
        },
      };
      const result = await createCustomObject(auth, meta);
      return resultContent(result);
    }
  );

  server.registerTool(
    "sf_create_custom_field",
    {
      title: "Create Salesforce Custom Field",
      description: `Creates a new custom field on an existing Salesforce object. The field API name must end with '__c'. Supports all field types: Text, Number, Picklist, Lookup, etc.`,
      inputSchema: CreateCustomFieldSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      const auth = await getAuth();
      const meta: CustomFieldMetadata = {
        fullName: `${params.objectName}.${params.fieldName}`,
        label: params.label,
        type: params.type,
        description: params.description,
        required: params.required,
        unique: params.unique,
        externalId: params.externalId,
        length: params.length,
        visibleLines: params.visibleLines,
        precision: params.precision,
        scale: params.scale,
        defaultValue: params.defaultValue,
        referenceTo: params.referenceTo,
        relationshipLabel: params.relationshipLabel,
        relationshipName: params.relationshipName,
        deleteConstraint: params.deleteConstraint,
        ...(params.picklistValues
          ? {
              valueSet: {
                restricted: params.picklistValues.restricted,
                valueSetDefinition: {
                  sorted: params.picklistValues.sorted,
                  value: params.picklistValues.values as PicklistValue[],
                },
              },
            }
          : {}),
      };
      const result = await createCustomField(auth, meta);
      return resultContent(result);
    }
  );

  server.registerTool(
    "sf_add_picklist_values",
    {
      title: "Add Picklist Values to Existing Field",
      description: `Adds new picklist values to an existing Picklist or MultiselectPicklist field without removing existing values. Use when a user wants to add new options to a dropdown.`,
      inputSchema: AddPicklistValuesSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      const auth = await getAuth();
      const result = await addPicklistValues(
        auth,
        params.objectFieldFullName,
        params.values as PicklistValue[]
      );
      return resultContent(result);
    }
  );

  server.registerTool(
    "sf_create_flow",
    {
      title: "Create Salesforce Flow",
      description: `Creates or updates a Salesforce Flow via the Metadata API. Supports AutoLaunchedFlow (required for Agentforce actions), Screen Flow, RecordTriggeredFlow, and ScheduledFlow. Supports advanced elements: Decision, GetRecords, CreateRecords, DeleteRecords, SendEmailAlert, ApexAction, Subflow, Loop, Assignment, Screen via the 'elements' array. GetRecords filter operators supported: EqualTo, NotEqualTo, GreaterThan, LessThan, GreaterThanOrEqualTo, LessThanOrEqualTo, IsNull, StartsWith, EndsWith. Contains is NOT supported by Salesforce Flow record lookups and will return an error. IMPORTANT for Agentforce: set flowType to 'AutoLaunchedFlow' and status to 'Active' — Draft flows and Screen flows cannot be invoked by agents.`,
      inputSchema: CreateFlowSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      const auth = await getAuth();
      try {
        const unsupportedFilterOps = ["Contains", "NotContain", "NotContains", "DoesNotContain"];
        for (const el of (params.elements ?? [])) {
          if (el.type === "GetRecords") {
            const allFilters = [...(el.filterField ? [{ operator: el.filterOperator ?? "EqualTo" }] : []), ...(el.filters ?? [])];
            for (const f of allFilters) {
              if (unsupportedFilterOps.includes(f.operator)) {
                return resultContent({ success: false, message: `GetRecords filter operator '${f.operator}' is not supported. Use EqualTo, NotEqualTo, GreaterThan, LessThan, GreaterThanOrEqualTo, LessThanOrEqualTo, IsNull, StartsWith, or EndsWith.` });
              }
            }
            if ((el as any).limit) {
              return resultContent({ success: false, message: `GetRecords 'limit' parameter is not supported in Flow metadata deployment. To limit records, use getFirstRecordOnly:true for a single record, or retrieve a collection and process it with a Loop + counter. Remove the limit parameter and try again.` });
            }
          }
        }
        const flowXml = buildFlowDeployXml({
          label: params.label, apiName: params.apiName, description: params.description,
          flowType: params.flowType, triggerObject: params.triggerObject, triggerType: params.triggerType,
          triggerFilterFormula: params.triggerFilterFormula, fieldUpdates: params.fieldUpdates,
          elements: params.elements, variables: params.variables, status: params.status ?? "Draft",
          submitForApprovalProcessName: params.submitForApprovalProcessName,
        });
        const base64Zip = await buildGenericDeployZip([], API_VERSION, [{ type: "Flow", name: params.apiName, xml: flowXml }]);
        const deployId = await deployZip(auth, base64Zip, { rollbackOnError: true });
        const deployResult = await pollDeployStatus(auth, deployId, 10 * 60 * 1000);
        if (!deployResult.success) return resultContent(deployResult);
        if (params.status === "Active") {
          const actResult = await activateFlow(auth, { flowApiName: params.apiName });
          return resultContent({
            success: actResult.success,
            fullName: params.apiName,
            created: true,
            message: actResult.success ? `Flow '${params.apiName}' deployed and activated.` : `Deployed but activation failed: ${actResult.message}`,
          });
        }
        return resultContent({ success: true, fullName: params.apiName, created: true, message: `Flow '${params.apiName}' deployed as Draft.` });
      } catch (err: unknown) {
        return resultContent({ success: false, message: err instanceof Error ? err.message : String(err) });
      }
    }
  );

  server.registerTool(
    "sf_create_approval_process",
    {
      title: "Create Salesforce Approval Process",
      description: `Creates or updates a Salesforce Approval Process via the Metadata API. Define who can submit, approval steps with approvers, entry criteria, and what happens on approval or rejection.`,
      inputSchema: CreateApprovalProcessSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      const auth = await getAuth();
      const result = await createApprovalProcess(auth, {
        objectName: params.objectName,
        processName: params.processName,
        label: params.label,
        description: params.description,
        allowedSubmitters: params.allowedSubmitters,
        approvalSteps: params.approvalSteps,
        entryFormula: params.entryFormula,
        entryFilterCriteria: params.entryFilterCriteria,
        recordEditability: params.recordEditability,
        allowRecall: params.allowRecall,
        finalApprovalLock: params.finalApprovalLock,
        finalRejectionLock: params.finalRejectionLock,
        emailTemplate: params.emailTemplate,
        active: params.active,
      });
      return resultContent(result);
    }
  );

  server.registerTool(
    "sf_create_validation_rule",
    {
      title: "Create Salesforce Validation Rule",
      description: `Creates or updates a Salesforce Validation Rule on any object via the Metadata API. The errorConditionFormula returns TRUE when data is INVALID. Use for data quality enforcement.`,
      inputSchema: CreateValidationRuleSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      const auth = await getAuth();
      const result = await createValidationRule(auth, {
        objectName: params.objectName,
        ruleName: params.ruleName,
        active: params.active,
        errorConditionFormula: params.errorConditionFormula,
        errorMessage: params.errorMessage,
        errorDisplayField: params.errorDisplayField,
        description: params.description,
      });
      return resultContent(result);
    }
  );

  server.registerTool(
    "sf_create_workflow_field_update",
    {
      title: "Create Salesforce Workflow Field Update Action",
      description: `Creates a Workflow Field Update action that can be referenced by Approval Processes, Workflow Rules, or Flows. Sets a field to a literal value, formula result, or null.`,
      inputSchema: CreateWorkflowFieldUpdateSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      const auth = await getAuth();
      const result = await createWorkflowFieldUpdate(auth, {
        objectName: params.objectName,
        actionName: params.actionName,
        label: params.label,
        field: params.field,
        literalValue: params.literalValue,
        formula: params.formula,
        nullValue: params.nullValue,
        notifyAssignee: params.notifyAssignee,
      });
      return resultContent(result);
    }
  );

  server.registerTool(
    "sf_create_formula_field",
    {
      title: "Create Formula Field",
      description: `Creates a formula field on any Salesforce object. Supports all return types (Text, Number, Currency, Date, DateTime, Checkbox, Percent) and the full Salesforce formula language: IF/AND/OR/NOT, BLANKVALUE, TEXT, VALUE, DATE, DATEVALUE, TODAY, NOW, date functions (MONTH/YEAR/DAY), math (FLOOR/CEILING/MOD), string functions (LEN/LEFT/RIGHT/MID/TRIM/UPPER/LOWER/CONTAINS/BEGINS), record type and picklist functions (ISPICKVAL, ISNULL, ISBLANK), cross-object field references (e.g. Account.Owner.Name), and VLOOKUP. Complex multi-line formulas are fully supported.`,
      inputSchema: CreateFormulaFieldSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      const auth = await getAuth();
      const result = await createFormulaField(auth, params);
      return resultContent(result);
    }
  );
}
