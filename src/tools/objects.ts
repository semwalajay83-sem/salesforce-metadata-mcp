import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CreateCustomMetadataTypeSchema,
  CreateCustomMetadataRecordSchema,
  CreateCustomLabelSchema,
  CreateCustomSettingSchema,
  CreateGlobalValueSetSchema,
  CreateRecordTypeSchema,
  CreateBusinessProcessSchema,
  CreatePageLayoutSchema,
  CreateSharingRuleSchema,
  CreateFieldDependencySchema,
} from "../schemas/index.js";
import {
  getAuth,
  createCustomMetadataType,
  createCustomMetadataRecord,
  createCustomLabel,
  createCustomSetting,
  createGlobalValueSet,
  createRecordType,
  createBusinessProcess,
  createPageLayout,
  createSharingRule,
  createFieldDependency,
} from "../services/salesforce.js";
import type { PicklistValue } from "../types.js";
import { resultContent } from "./utils.js";

export function registerObjectTools(server: McpServer): void {

  server.registerTool(
    "sf_create_custom_metadata_type",
    {
      title: "Create Custom Metadata Type",
      description: `Creates a new Custom Metadata Type (ending in __mdt) with optional custom fields. Custom Metadata Types store configuration data that can be packaged and deployed. Use when a user wants to store configuration in metadata rather than custom objects.`,
      inputSchema: CreateCustomMetadataTypeSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      const auth = await getAuth();
      const result = await createCustomMetadataType(auth, {
        fullName: params.fullName,
        label: params.label,
        pluralLabel: params.pluralLabel,
        description: params.description,
        fields: params.fields,
      });
      return resultContent(result);
    }
  );

  server.registerTool(
    "sf_create_custom_metadata_record",
    {
      title: "Create Custom Metadata Record",
      description: `Creates a record within an existing Custom Metadata Type (__mdt). Custom metadata records store configuration values that can be read in Apex, Flows, and formulas. Provide typeName (e.g., 'Config__mdt'), a record name, and field values.`,
      inputSchema: CreateCustomMetadataRecordSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      const auth = await getAuth();
      const result = await createCustomMetadataRecord(auth, {
        typeName: params.typeName,
        recordName: params.recordName,
        label: params.label,
        values: params.values,
      });
      return resultContent(result);
    }
  );

  server.registerTool(
    "sf_create_custom_label",
    {
      title: "Create or Update Custom Label",
      description: `Creates or updates a Salesforce Custom Label. Custom Labels are text values accessible in Apex, Visualforce, LWC, and Flows, with support for translation. Use for internationalizable text strings, error messages, or UI labels.`,
      inputSchema: CreateCustomLabelSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      const auth = await getAuth();
      const result = await createCustomLabel(auth, {
        fullName: params.fullName,
        value: params.value,
        language: params.language,
        categories: params.categories,
        protected: params.protected,
        shortDescription: params.shortDescription,
      });
      return resultContent(result);
    }
  );

  server.registerTool(
    "sf_create_custom_setting",
    {
      title: "Create Custom Setting",
      description: `Creates a Custom Setting object (ending in __c) with Hierarchy or List type. Custom Settings store data accessible via Apex without SOQL queries. Hierarchy type supports org/profile/user level overrides. Use for feature flags, thresholds, or configurable constants.`,
      inputSchema: CreateCustomSettingSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      const auth = await getAuth();
      const result = await createCustomSetting(auth, {
        fullName: params.fullName,
        label: params.label,
        settingType: params.settingType,
        visibility: params.visibility,
        description: params.description,
        fields: params.fields,
      });
      return resultContent(result);
    }
  );

  server.registerTool(
    "sf_create_global_value_set",
    {
      title: "Create Global Value Set (Shared Picklist)",
      description: `Creates a Global Value Set — a shared picklist definition that can be referenced by multiple Picklist fields across different objects. Any change to the Global Value Set is reflected in all fields that use it. Use when the same set of values (like Status, Priority, Region) should be shared and kept in sync across multiple objects.`,
      inputSchema: CreateGlobalValueSetSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      const auth = await getAuth();
      const result = await createGlobalValueSet(auth, {
        fullName: params.fullName,
        masterLabel: params.masterLabel,
        description: params.description,
        sorted: params.sorted,
        values: params.values as PicklistValue[],
      });
      return resultContent(result);
    }
  );

  server.registerTool(
    "sf_create_record_type",
    {
      title: "Create Record Type",
      description: `Creates a Record Type on a Salesforce object. Record Types allow different page layouts, picklist values, and business processes for different types of records on the same object. For example, create 'Enterprise' and 'SMB' record types on Opportunity with different Stage values.`,
      inputSchema: CreateRecordTypeSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      const auth = await getAuth();
      const result = await createRecordType(auth, {
        objectName: params.objectName,
        fullName: params.fullName,
        label: params.label,
        description: params.description,
        businessProcess: params.businessProcess,
        isActive: params.isActive,
        picklistValues: params.picklistValues,
      });
      return resultContent(result);
    }
  );

  server.registerTool(
    "sf_create_business_process",
    {
      title: "Create Business Process",
      description: `Creates a Business Process for Opportunity (Stage values), Lead (Status values), Case (Status values), or Solution (Status values). Business Processes define which picklist values are available for a given Record Type. Must be created before assigning to a Record Type.`,
      inputSchema: CreateBusinessProcessSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      const auth = await getAuth();
      const result = await createBusinessProcess(auth, {
        objectName: params.objectName,
        processName: params.processName,
        label: params.label,
        description: params.description,
        isActive: params.isActive,
        values: params.values,
      });
      return resultContent(result);
    }
  );

  server.registerTool(
    "sf_create_page_layout",
    {
      title: "Create Page Layout",
      description: `Creates a Page Layout for a Salesforce object. Page Layouts control what fields, related lists, and buttons appear on record detail and edit pages. Layouts are assigned to user profiles and record types. Define sections with fields and the related lists to include.`,
      inputSchema: CreatePageLayoutSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      const auth = await getAuth();
      const result = await createPageLayout(auth, {
        objectName: params.objectName,
        layoutName: params.layoutName,
        label: params.label,
        sections: params.sections,
        relatedLists: params.relatedLists,
      });
      return resultContent(result);
    }
  );

  server.registerTool(
    "sf_create_sharing_rule",
    {
      title: "Create Sharing Rule",
      description: `Creates a Sharing Rule for a Salesforce object. Sharing Rules extend the OWD by automatically sharing records with users who meet criteria (criteria-based) or who own records (ownership-based). Use to give specific roles/groups access to records they wouldn't normally see based on OWD.`,
      inputSchema: CreateSharingRuleSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      const auth = await getAuth();
      const result = await createSharingRule(auth, {
        objectName: params.objectName,
        ruleName: params.ruleName,
        label: params.label,
        ruleType: params.ruleType,
        accessLevel: params.accessLevel,
        sharedTo: params.sharedTo,
        criteriaItems: params.criteriaItems,
        sharedFrom: params.sharedFrom,
      });
      return resultContent(result);
    }
  );

  server.registerTool(
    "sf_create_field_dependency",
    {
      title: "Create Field Dependency (Controlling/Dependent Picklist)",
      description: `Creates a field dependency between a controlling picklist and a dependent picklist on the same object. When a user selects a value in the controlling field, only the relevant dependent field values appear. Example: when Country = 'USA', State shows only US states.`,
      inputSchema: CreateFieldDependencySchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      const auth = await getAuth();
      const result = await createFieldDependency(auth, {
        objectName: params.objectName,
        controllingField: params.controllingField,
        dependentField: params.dependentField,
        valueSettings: params.valueSettings,
      });
      return resultContent(result);
    }
  );
}
