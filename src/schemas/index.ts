import { z } from "zod";

// ─── Shared sub-schemas ───────────────────────────────────────────────────────

export const PicklistValueSchema = z.object({
  fullName: z.string().min(1).max(255).describe("API name for the picklist value (e.g. 'New')"),
  label: z.string().min(1).max(255).describe("Display label for the value"),
  default: z.boolean().default(false).describe("Whether this is the default value"),
  isActive: z.boolean().optional().describe("Whether the value is active (default true)"),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional().describe("Hex color code, e.g. '#FF0000'"),
  description: z.string().max(1000).optional().describe("Optional description for the value"),
});

export const ValueSetSchema = z.object({
  restricted: z.boolean().default(false).describe("If true, only values in the list are allowed"),
  sorted: z.boolean().default(false).describe("Whether values are auto-sorted alphabetically"),
  values: z.array(PicklistValueSchema).min(1).describe("List of picklist values"),
});

// ─── Create Custom Object ─────────────────────────────────────────────────────

export const CreateCustomObjectSchema = z.object({
  fullName: z
    .string()
    .min(1).max(80)
    .regex(/^[A-Za-z][A-Za-z0-9_]*__c$/, "Must end with __c, e.g. 'Invoice__c'")
    .describe("API name of the custom object, e.g. 'Invoice__c'"),
  label: z.string().min(1).max(255).describe("Singular label shown in the UI, e.g. 'Invoice'"),
  pluralLabel: z.string().min(1).max(255).describe("Plural label, e.g. 'Invoices'"),
  description: z.string().max(1000).optional().describe("Optional description for the object"),
  nameFieldLabel: z
    .string()
    .max(255)
    .default("Name")
    .describe("Label for the standard Name field, e.g. 'Invoice Name'"),
  nameFieldType: z
    .enum(["Text", "AutoNumber"])
    .default("Text")
    .describe("Type of Name field: 'Text' (free-form) or 'AutoNumber' (auto-increment)"),
  autoNumberFormat: z
    .string()
    .optional()
    .describe("Format for AutoNumber name field, e.g. 'INV-{0000}'. Required when nameFieldType is AutoNumber."),
  deploymentStatus: z
    .enum(["Deployed", "InDevelopment"])
    .default("Deployed")
    .describe("Deployment status of the object"),
  sharingModel: z
    .enum(["ReadWrite", "Read", "Private", "ControlledByParent", "FullAccess"])
    .default("ReadWrite")
    .describe("OWD sharing model for the object"),
  enableActivities: z.boolean().default(true).describe("Allow activities (tasks/events) on this object"),
  enableHistory: z.boolean().default(false).describe("Enable field history tracking"),
  enableReports: z.boolean().default(true).describe("Make the object available for reports"),
  enableSearch: z.boolean().default(true).describe("Enable search on this object"),
}).strict();

// ─── Create Custom Field ──────────────────────────────────────────────────────

export const FieldTypeSchema = z.enum([
  "Text",          // Text (single line, up to 255 chars)
  "TextArea",      // Text Area (multi-line, up to 255 chars)
  "LongTextArea",  // Text Area (Long) — up to 131072 chars; requires length 256–131072 and visibleLines
  "Html",          // Text Area (Rich) / Rich Text Area — HTML editor; requires length 256–131072 and visibleLines
  "Number",
  "Currency",
  "Percent",
  "Checkbox",
  "Date",
  "DateTime",
  "Email",
  "Phone",
  "Url",
  "Picklist",
  "MultiselectPicklist",
  "Lookup",
  "MasterDetail",
]);

export const CreateCustomFieldSchema = z
  .object({
    objectName: z
      .string()
      .min(1).max(80)
      .describe("API name of the parent object, e.g. 'Account' or 'Invoice__c'"),
    fieldName: z
      .string()
      .min(1).max(80)
      .regex(/^[A-Za-z][A-Za-z0-9_]*__c$/, "Must end with __c, e.g. 'Status__c'")
      .describe("API name of the field, e.g. 'Status__c'"),
    label: z.string().min(1).max(255).describe("Display label for the field, e.g. 'Status'"),
    type: FieldTypeSchema.describe("Salesforce field type"),
    description: z.string().max(1000).optional().describe("Optional description for the field"),
    required: z.boolean().optional().describe("Whether the field is required on page layouts"),
    unique: z.boolean().optional().describe("Whether values must be unique (Text, Number, Email)"),
    externalId: z.boolean().optional().describe("Whether this field is an external ID"),
    length: z
      .number()
      .int()
      .min(1)
      .max(131072)
      .optional()
      .describe("Max length. Text/TextArea: 1–255 (default 255). LongTextArea/Html (Text Area Long / Rich Text Area): 256–131072 (default 32768)."),
    visibleLines: z
      .number()
      .int()
      .min(2)
      .max(50)
      .optional()
      .describe("Visible lines. Required for LongTextArea and Html (Text Area Long / Rich Text Area) — default 10. Also used for MultiselectPicklist."),
    precision: z
      .number()
      .int()
      .min(1)
      .max(18)
      .optional()
      .describe("Total digits for Number/Currency/Percent (1–18)"),
    scale: z
      .number()
      .int()
      .min(0)
      .max(17)
      .optional()
      .describe("Decimal places for Number/Currency/Percent (0–17)"),
    picklistValues: ValueSetSchema.optional().describe(
      "Picklist configuration. Required for Picklist / MultiselectPicklist types."
    ),
    referenceTo: z
      .string()
      .optional()
      .describe("Target object API name for Lookup/MasterDetail, e.g. 'Account'"),
    relationshipLabel: z
      .string()
      .optional()
      .describe("Label for the relationship on the related object"),
    relationshipName: z
      .string()
      .optional()
      .describe("API name for the relationship (no spaces)"),
    deleteConstraint: z
      .enum(["Cascade", "Restrict", "SetNull"])
      .optional()
      .describe("Delete behaviour for Lookup fields: 'Cascade', 'Restrict', or 'SetNull'"),
    defaultValue: z
      .union([z.boolean(), z.string()])
      .optional()
      .describe("Default value for the field. Use true/false for Checkbox fields."),
  })
  .strict();

// ─── Add Picklist Values ──────────────────────────────────────────────────────

export const AddPicklistValuesSchema = z.object({
  objectFieldFullName: z
    .string()
    .min(1)
    .regex(/^[A-Za-z][A-Za-z0-9_]*\.[A-Za-z][A-Za-z0-9_]*__c$/, "Must be 'ObjectName__c.FieldName__c' or 'StandardObject.FieldName__c'")
    .describe("Full API name of the picklist field, e.g. 'Invoice__c.Status__c'"),
  values: z
    .array(PicklistValueSchema)
    .min(1)
    .describe("New picklist values to add (existing values are preserved)"),
}).strict();

// ─── Create Flow ──────────────────────────────────────────────────────────────

export const FlowVariableSchema = z.object({
  name: z.string().min(1).max(80).describe("Variable API name, e.g. 'myVariable'"),
  dataType: z.enum(["String", "Number", "Boolean", "Date", "DateTime", "SObject"])
    .describe("Data type of the variable"),
  objectType: z.string().optional().describe("Object API name when dataType is SObject, e.g. 'Account'"),
  isInput: z.boolean().default(false).describe("Accept input from outside the flow"),
  isOutput: z.boolean().default(false).describe("Return as output from the flow"),
  isCollection: z.boolean().default(false).describe("Holds a collection of values"),
  defaultStringValue: z.string().optional().describe("Default string value"),
});

export const FlowElementSchema = z.object({
  type: z.enum([
    "Decision",
    "GetRecords",
    "CreateRecords",
    "DeleteRecords",
    "SendEmailAlert",
    "ApexAction",
    "Subflow",
    "Loop",
    "Assignment",
    "Screen",
  ]).describe("Flow element type"),
  name: z.string().min(1).describe("Element API name, e.g. 'Check_Stage'"),
  label: z.string().min(1).describe("Element display label"),
  // Decision — each entry is one named rule; rules are evaluated top-to-bottom
  conditions: z.array(z.object({
    leftValueRef: z.string().describe("Left side reference, e.g. 'myVar' or '$Record.Status__c'"),
    operator: z.string().describe("EqualTo, NotEqualTo, GreaterThan, LessThan, GreaterThanOrEqualTo, LessThanOrEqualTo, IsNull, IsNotNull, StartsWith, Contains, EndsWith"),
    rightValue: z.string().optional().describe("Right side literal value. For IsNull/IsNotNull use 'true' or 'false'."),
    rightValueRef: z.string().optional().describe("Right side flow variable reference"),
    label: z.string().optional().describe("Label for this rule (defaults to rightValue or 'Rule N')"),
    nextElement: z.string().optional().describe("Element to go to when this rule matches (connector for this specific rule)"),
  })).optional().describe("Decision rules — each entry creates one named rule with its own connector. Use nextElement on each rule for multi-branch routing. Add defaultConnector for the no-match path."),
  defaultConnector: z.string().optional().describe("Default connector target when no Decision rule matches"),
  // GetRecords / CreateRecords / DeleteRecords
  objectApiName: z.string().optional().describe("Object API name for record operations"),
  filterField: z.string().optional().describe("Single filter field for GetRecords (use filters array for multiple filters)"),
  filterOperator: z.string().optional().describe("Filter operator for GetRecords. Supported: EqualTo, NotEqualTo, GreaterThan, LessThan, GreaterThanOrEqualTo, LessThanOrEqualTo, IsNull, StartsWith, EndsWith. NOTE: Contains is NOT supported by Salesforce Flow record lookups."),
  filterValue: z.string().optional().describe("Literal filter value string (uses stringValue XML). Use filterValueRef when the value comes from a flow variable."),
  filterValueRef: z.string().optional().describe("Flow variable reference for filter value (uses elementReference XML). Use filterValue for literal strings."),
  filters: z.array(z.object({
    field: z.string().describe("Field API name to filter on"),
    operator: z.string().default("EqualTo").describe("Supported: EqualTo, NotEqualTo, GreaterThan, LessThan, GreaterThanOrEqualTo, LessThanOrEqualTo, IsNull, StartsWith, EndsWith. Contains is NOT supported."),
    value: z.string().optional().describe("Literal string/number/boolean value (uses stringValue XML)"),
    valueRef: z.string().optional().describe("Flow variable reference — generates elementReference XML"),
  })).optional().describe("Multiple filters for GetRecords. Each filter: valueRef uses elementReference XML, value uses stringValue XML. Contains operator is not supported — will be rejected with a helpful error."),
  outputVariable: z.string().optional().describe("Variable to store retrieved record(s)"),
  queriedFields: z.array(z.string()).optional().describe("Fields to return from GetRecords. Id is always included automatically. E.g. ['Name', 'Status__c', 'OwnerId']."),
  sortField: z.string().optional().describe("Field to sort GetRecords results by, e.g. 'CreatedDate' or 'Amount'"),
  sortOrder: z.enum(["Asc", "Desc"]).optional().describe("Sort direction for GetRecords: Asc (oldest/smallest first) or Desc (newest/largest first)"),
  limit: z.number().int().positive().optional().describe("Maximum number of records to retrieve. Use with sortField/sortOrder to get top-N records."),
  getFirstRecordOnly: z.boolean().optional().describe("Store only the first matching record in outputVariable instead of a collection. Useful when you expect exactly one match."),
  // SendEmailAlert
  emailAlertApiName: z.string().optional().describe("API name of email alert to send"),
  // ApexAction
  apexClassName: z.string().optional().describe("Apex class name for ApexAction"),
  apexMethodName: z.string().optional().describe("Apex method name for ApexAction"),
  // Subflow
  subflowApiName: z.string().optional().describe("API name of subflow to call"),
  // Loop
  loopVariable: z.string().optional().describe("Collection variable to iterate over (collection must be declared in the variables array)"),
  loopIterationVariable: z.string().optional().describe("Variable to assign the current loop item to on each iteration (generates assignNextValueToReference). Must be declared in the variables array with the appropriate dataType and objectType. Inside loop body assignments, reference this variable's fields with valueRef e.g. 'currentOpp.Name'."),
  loopNextElement: z.string().optional().describe("Element to execute for each loop iteration (nextValueConnector). nextElement is used for the exit path (noMoreValuesConnector)."),
  // CreateRecords
  inputAssignments: z.array(z.object({
    field: z.string().describe("Field API name to set, e.g. 'Name', 'Status__c'"),
    value: z.string().optional().describe("Literal value to set"),
    valueRef: z.string().optional().describe("Flow variable reference, e.g. 'myVar' or 'currentItem.Name'"),
  })).optional().describe("Field values to set when creating records (CreateRecords). Each entry sets one field."),
  // DeleteRecords
  inputReference: z.string().optional().describe("Variable reference to the record(s) to delete (DeleteRecords). Must be a variable holding an SObject or SObject collection."),
  // Assignment
  assignments: z.array(z.object({
    assignToRef: z.string().describe("Variable to assign to"),
    operator: z.string().default("Assign").describe("Operator: Assign, Add, etc."),
    valueRef: z.string().optional().describe("Reference value"),
    value: z.string().optional().describe("Literal value"),
  })).optional().describe("Assignments for Assignment elements"),
  // Screen
  screenFields: z.array(z.object({
    name: z.string().describe("Field name"),
    fieldType: z.string().describe("InputField, DisplayText, etc."),
    label: z.string().optional().describe("Field label"),
    dataType: z.string().optional().describe("String, Number, Boolean, etc."),
    defaultValueRef: z.string().optional().describe("Default value reference"),
  })).optional().describe("Fields for Screen elements"),
  // Next element connector
  nextElement: z.string().optional().describe("API name of the next element to connect to"),
});

export const CreateFlowSchema = z.object({
  label: z.string().min(1).max(255).describe("Human-readable flow label, e.g. 'New Lead Onboarding'"),
  apiName: z.string().min(1).max(80)
    .regex(/^[A-Za-z][A-Za-z0-9_]*$/, "Must start with a letter, no spaces")
    .describe("API name for the flow, e.g. 'New_Lead_Onboarding'"),
  description: z.string().optional().describe("Description of what this flow does"),
  flowType: z.enum(["AutoLaunchedFlow", "Flow", "RecordTriggeredFlow", "ScheduledFlow"])
    .default("AutoLaunchedFlow")
    .describe("Flow type: 'AutoLaunchedFlow' (required for Agentforce actions — agents can ONLY invoke AutoLaunchedFlow, not Screen flows), 'Flow' (Screen flow for guided UI), 'RecordTriggeredFlow' (fires on record create/update/delete), 'ScheduledFlow' (runs on a schedule)."),
  triggerObject: z.string().optional().describe("Object API name for record-triggered flows, e.g. 'Opportunity'"),
  triggerType: z.enum(["RecordBeforeSave", "RecordAfterSave", "RecordBeforeDelete"])
    .optional()
    .describe("When to trigger: RecordBeforeSave, RecordAfterSave, RecordBeforeDelete"),
  triggerFilterFormula: z.string().optional()
    .describe("Formula to filter which records trigger the flow, e.g. \"ISPICKVAL(StageName,'Closed Won')\""),
  fieldUpdates: z.array(z.object({
    field: z.string().describe("Field API name, e.g. 'CloseDate'"),
    value: z.string().optional().describe("Literal string value to set"),
    formula: z.string().optional().describe("Formula for the value, e.g. 'TODAY()'"),
  })).optional().describe("Simple field updates on the triggering record (for RecordTriggeredFlow)"),
  elements: z.array(FlowElementSchema).optional()
    .describe("Advanced flow elements: Decision, GetRecords, CreateRecords, DeleteRecords, SendEmailAlert, ApexAction, Subflow, Loop, Assignment, Screen, Wait, PlatformEvent"),
  variables: z.array(FlowVariableSchema).optional().describe("Input/output variables"),
  status: z.enum(["Draft", "Active"]).default("Draft").describe("Flow activation status. IMPORTANT: Agentforce agents can ONLY invoke Active flows — Draft flows are invisible to agents and will cause silent failures. Set to 'Active' when creating flows for agent actions."),
  submitForApprovalProcessName: z.string().optional().describe("API name of the Approval Process to automatically submit the record into. Works with any approval process — just pass its API name."),
}).strict();

// ─── Create Approval Process ──────────────────────────────────────────────────

export const ApprovalSubmitterSchema = z.object({
  type: z.string().describe("Submitter type: 'owner', 'creator', 'role', 'group', 'user', 'allInternalUsers'"),
  submitter: z.string().optional().describe("API name or username (required for role/group/user types)"),
});

export const ApprovalStepApproverSchema = z.object({
  type: z.string().describe("Approver type: 'user', 'role', 'queue', 'relatedUserField', 'userHierarchyField', 'adhoc'"),
  name: z.string().optional().describe("API name or username (not needed for adhoc/userHierarchyField)"),
});

export const ApprovalStepSchema = z.object({
  name: z.string().min(1).describe("API name of the step, e.g. 'Manager_Approval'"),
  label: z.string().min(1).describe("Display label, e.g. 'Manager Approval'"),
  approvers: z.array(ApprovalStepApproverSchema).min(1).describe("Assigned approvers for this step"),
  whenMultiple: z.enum(["Unanimous", "FirstResponse"]).default("Unanimous")
    .describe("'Unanimous' = all must approve, 'FirstResponse' = first response wins"),
  allowDelegate: z.boolean().default(true).describe("Allow approvers to delegate"),
  entryFormula: z.string().optional().describe("Formula that must be true for this step to apply"),
  ifCriteriaNotMet: z.enum(["ApproveRecord", "RejectRecord", "GotoNextStep"]).default("GotoNextStep")
    .describe("What to do when entry formula is false"),
  rejectBehavior: z.enum(["RejectRequest", "BackToPrevious"]).optional()
    .describe("On rejection (not for step 1): 'RejectRequest' or 'BackToPrevious'"),
});

export const CreateApprovalProcessSchema = z.object({
  objectName: z.string().min(1).describe("Object API name, e.g. 'Opportunity' or 'Leave_Request__c'"),
  processName: z.string().min(1)
    .regex(/^[A-Za-z][A-Za-z0-9_]*$/, "Must start with a letter, no spaces")
    .describe("API name of the process, e.g. 'Large_Deal_Approval'"),
  label: z.string().min(1).describe("Human-readable label, e.g. 'Large Deal Approval Process'"),
  description: z.string().optional().describe("Description of the approval process"),
  allowedSubmitters: z.array(ApprovalSubmitterSchema).min(1)
    .describe("Who can submit: [{type:'owner'}] or [{type:'role', submitter:'SalesRep'}]"),
  approvalSteps: z.array(ApprovalStepSchema).min(1).describe("Ordered list of approval steps"),
  entryFormula: z.string().optional().describe("Formula records must satisfy to enter this process"),
  entryFilterCriteria: z.array(z.object({
    field: z.string().describe("Field API name, e.g. 'Amount'"),
    operation: z.string().describe("Operation: 'greaterThan', 'equals', 'notEqual', etc."),
    value: z.string().describe("Value to compare against"),
  })).optional().describe("Filter criteria alternative to entryFormula"),
  recordEditability: z.enum(["AdminOnly", "AdminOrCurrentApprover"]).default("AdminOnly")
    .describe("Who can edit locked records during approval"),
  allowRecall: z.boolean().default(true).describe("Allow submitters to recall approval requests"),
  finalApprovalLock: z.boolean().default(false).describe("Lock record after final approval"),
  finalRejectionLock: z.boolean().default(false).describe("Lock record after final rejection"),
  emailTemplate: z.string().optional()
    .describe("Email template for approval notifications, e.g. 'unfiled$public/ApprovalEmail'"),
  active: z.boolean().default(false)
    .describe("Activate immediately (warning: cannot change steps after activation)"),
}).strict();

// ─── Create Validation Rule ───────────────────────────────────────────────────

export const CreateValidationRuleSchema = z.object({
  objectName: z.string().min(1).describe("Object API name, e.g. 'Account', 'Opportunity', 'Invoice__c'"),
  ruleName: z.string().min(1)
    .regex(/^[A-Za-z][A-Za-z0-9_]*$/, "Must start with a letter, no spaces")
    .describe("API name for the rule, e.g. 'Require_Close_Date'"),
  errorConditionFormula: z.string().min(1)
    .describe("Formula returning TRUE when data is INVALID, e.g. \"AND(ISPICKVAL(StageName,'Closed Won'),ISBLANK(CloseDate))\""),
  errorMessage: z.string().min(1).max(255)
    .describe("Error shown to user when validation fails (max 255 chars)"),
  errorDisplayField: z.string().optional()
    .describe("Field API name to display error next to, e.g. 'CloseDate'. Blank = top of page."),
  description: z.string().optional().describe("Description of this validation rule"),
  active: z.boolean().default(true).describe("Whether the rule is active"),
}).strict();

// ─── Create Workflow Field Update ─────────────────────────────────────────────

export const CreateWorkflowFieldUpdateSchema = z.object({
  objectName: z.string().min(1).describe("Object API name, e.g. 'Opportunity'"),
  actionName: z.string().min(1)
    .regex(/^[A-Za-z][A-Za-z0-9_]*$/, "Must start with a letter, no spaces")
    .describe("API name of the action, e.g. 'Set_Stage_Closed_Won'"),
  label: z.string().min(1).describe("Human-readable label"),
  field: z.string().min(1).describe("Field API name to update, e.g. 'StageName'"),
  literalValue: z.string().optional().describe("Literal string/picklist value to set"),
  formula: z.string().optional().describe("Formula for the new value, e.g. 'TODAY()'"),
  nullValue: z.boolean().default(false).describe("Set the field to null/blank"),
  notifyAssignee: z.boolean().default(false).describe("Notify owner/assignee after update"),
}).strict();

// ─── OBJECTS & FIELDS ─────────────────────────────────────────────────────────

export const MetadataFieldSchema = z.object({
  fullName: z.string().min(1).describe("Field API name ending in __c, e.g. 'MyField__c'"),
  label: z.string().min(1).describe("Field label"),
  type: z.enum(["Text", "Number", "Checkbox", "Date", "DateTime", "Email", "Phone", "Url",
    "TextArea", "LongTextArea", "Picklist", "Currency", "Percent"]).describe("Field type"),
  required: z.boolean().optional().describe("Is field required"),
  length: z.number().int().optional().describe("Length for text fields"),
  precision: z.number().int().optional().describe("Total digits for number fields"),
  scale: z.number().int().optional().describe("Decimal places for number fields"),
  defaultValue: z.string().optional().describe("Default value"),
  description: z.string().optional().describe("Field description"),
  picklistValues: z.array(z.string()).optional().describe("Picklist values as string array for Picklist type"),
});

export const CreateCustomMetadataTypeSchema = z.object({
  fullName: z.string().min(1).regex(/^[A-Za-z][A-Za-z0-9_]*__mdt$/, "Must end with __mdt")
    .describe("API name of the Custom Metadata Type, e.g. 'Config__mdt'"),
  label: z.string().min(1).describe("Singular label, e.g. 'Config'"),
  pluralLabel: z.string().min(1).describe("Plural label, e.g. 'Configs'"),
  description: z.string().optional().describe("Description of the type"),
  fields: z.array(MetadataFieldSchema).optional().describe("Custom fields to add to this type"),
}).strict();

export const CreateCustomMetadataRecordSchema = z.object({
  typeName: z.string().min(1).regex(/^[A-Za-z][A-Za-z0-9_]*__mdt$/, "Must end with __mdt")
    .describe("Custom Metadata Type API name, e.g. 'Config__mdt'"),
  recordName: z.string().min(1).describe("Record developer name, e.g. 'Default_Config'"),
  label: z.string().min(1).describe("Record label"),
  values: z.array(z.object({
    field: z.string().describe("Field API name, e.g. 'IsActive__c'"),
    value: z.string().describe("Field value as string"),
  })).describe("Field values for this record"),
}).strict();

export const CreateCustomLabelSchema = z.object({
  fullName: z.string().min(1).regex(/^[A-Za-z][A-Za-z0-9_]*$/, "No spaces or special chars")
    .describe("API name of the label, e.g. 'Welcome_Message'"),
  value: z.string().min(1).describe("The label text value"),
  language: z.string().default("en_US").describe("Language code, e.g. 'en_US', 'fr', 'de'"),
  categories: z.string().optional().describe("Category for grouping labels"),
  protected: z.boolean().default(false).describe("Protected labels are only accessible by the package that created them"),
  shortDescription: z.string().optional().describe("Short description of the label's purpose"),
}).strict();

export const CreateCustomSettingSchema = z.object({
  fullName: z.string().min(1).regex(/^[A-Za-z][A-Za-z0-9_]*__c$/, "Must end with __c")
    .describe("API name of the custom setting, e.g. 'OrgPreferences__c'"),
  label: z.string().min(1).describe("Label for the custom setting object"),
  settingType: z.enum(["Hierarchy", "List"]).default("Hierarchy")
    .describe("Hierarchy: overridable at org/profile/user level. List: simple key-value list."),
  visibility: z.enum(["Public", "Protected"]).default("Public")
    .describe("Public: accessible to all Apex/VF. Protected: only accessible within the namespace."),
  description: z.string().optional().describe("Description of this custom setting"),
  fields: z.array(MetadataFieldSchema).optional().describe("Custom fields to add to this setting"),
}).strict();

export const CreateGlobalValueSetSchema = z.object({
  fullName: z.string().min(1).regex(/^[A-Za-z][A-Za-z0-9_]*$/)
    .describe("API name of the global value set, e.g. 'Industry_Types'"),
  masterLabel: z.string().min(1).describe("Label for the global value set"),
  description: z.string().optional().describe("Description"),
  sorted: z.boolean().default(false).describe("Auto-sort values alphabetically"),
  values: z.array(PicklistValueSchema).min(1).describe("Picklist values"),
}).strict();

export const CreateRecordTypeSchema = z.object({
  objectName: z.string().min(1).describe("Object API name, e.g. 'Opportunity' or 'Case__c'"),
  fullName: z.string().min(1).regex(/^[A-Za-z][A-Za-z0-9_]*$/).describe("Record type developer name, e.g. 'Enterprise_Deal'"),
  label: z.string().min(1).describe("Record type label"),
  description: z.string().optional().describe("Description"),
  businessProcess: z.string().optional().describe("Business process API name to associate (for Opportunity/Lead/Case/Solution)"),
  isActive: z.boolean().default(true).describe("Whether this record type is active"),
  picklistValues: z.array(z.object({
    picklist: z.string().describe("Picklist field API name, e.g. 'StageName'"),
    values: z.array(z.string()).describe("Allowed values for this record type"),
  })).optional().describe("Restrict picklist values per record type"),
}).strict();

export const CreateBusinessProcessSchema = z.object({
  objectName: z.enum(["Opportunity", "Lead", "Case", "Solution"])
    .describe("Object the business process applies to"),
  processName: z.string().min(1).regex(/^[A-Za-z][A-Za-z0-9_]*$/).describe("Business process developer name"),
  label: z.string().min(1).describe("Display label"),
  description: z.string().optional().describe("Description"),
  isActive: z.boolean().default(true).describe("Whether this process is active"),
  values: z.array(z.string()).min(1).describe("Stage/status values included in this business process"),
}).strict();

export const CreatePageLayoutSchema = z.object({
  objectName: z.string().min(1).describe("Object API name, e.g. 'Account' or 'Case__c'"),
  layoutName: z.string().min(1).describe("Layout developer name, e.g. 'Account_Layout'"),
  label: z.string().min(1).describe("Layout display label"),
  sections: z.array(z.object({
    label: z.string().describe("Section label"),
    style: z.enum(["TwoColumnsTopToBottom", "TwoColumnsLeftToRight", "OneColumn"]).default("TwoColumnsTopToBottom"),
    fields: z.array(z.string()).describe("Field API names in this section"),
  })).optional().describe("Layout sections with fields"),
  relatedLists: z.array(z.string()).optional().describe("Related list API names to include"),
}).strict();

export const CreateSharingRuleSchema = z.object({
  objectName: z.string().min(1).describe("Object API name, e.g. 'Account', 'Opportunity'"),
  ruleName: z.string().min(1).regex(/^[A-Za-z][A-Za-z0-9_]*$/).describe("Sharing rule developer name"),
  label: z.string().min(1).describe("Display label"),
  ruleType: z.enum(["criteria", "ownership"]).default("criteria")
    .describe("criteria: share based on field values. ownership: share based on record owner."),
  accessLevel: z.enum(["Read", "Edit"]).default("Read").describe("Access level granted"),
  sharedTo: z.object({
    type: z.enum(["role", "roleAndSubordinates", "group", "queue", "allInternalUsers", "allCustomerPortalUsers"])
      .describe("Who to share with"),
    name: z.string().optional().describe("Role/group/queue API name"),
  }).describe("Who receives the sharing"),
  criteriaItems: z.array(z.object({
    field: z.string().describe("Field API name, e.g. 'Industry'"),
    operation: z.string().describe("equals, notEqual, greaterThan, etc."),
    value: z.string().describe("Value to compare against"),
  })).optional().describe("For criteria-based rules: conditions that trigger sharing"),
  sharedFrom: z.object({
    type: z.enum(["role", "roleAndSubordinates", "group", "queue", "allInternalUsers"])
      .describe("For ownership rules: whose records to share"),
    name: z.string().optional().describe("Role/group/queue API name"),
  }).optional().describe("For ownership-based rules: whose records are shared"),
}).strict();

export const CreateFieldDependencySchema = z.object({
  objectName: z.string().min(1).describe("Object API name"),
  controllingField: z.string().min(1).describe("Controlling picklist field API name"),
  dependentField: z.string().min(1).describe("Dependent picklist field API name"),
  valueSettings: z.array(z.object({
    controllingFieldValue: z.array(z.string()).describe("Controlling field values that enable this dependent value"),
    valueName: z.string().describe("Dependent field value to conditionally show"),
  })).min(1).describe("Value dependency mappings"),
}).strict();

// ─── AUTOMATION ───────────────────────────────────────────────────────────────

export const CreateEmailAlertSchema = z.object({
  objectName: z.string().min(1).describe("Object API name, e.g. 'Opportunity', 'Case'"),
  alertName: z.string().min(1).regex(/^[A-Za-z][A-Za-z0-9_]*$/).describe("API name of the email alert, e.g. 'Notify_Owner_On_Close'"),
  label: z.string().min(1).describe("Display label"),
  description: z.string().optional().describe("Description"),
  template: z.string().min(1).describe("Email template full name, e.g. 'unfiled$public/MyTemplate' or 'MyFolder/MyTemplate'"),
  senderType: z.enum(["CurrentUser", "OrgWideEmailAddress", "DefaultWorkflowUser"]).default("CurrentUser")
    .describe("Who the email appears to come from"),
  senderAddress: z.string().optional().describe("Org-wide email address (required if senderType is OrgWideEmailAddress)"),
  recipients: z.array(z.object({
    type: z.enum(["owner", "creator", "user", "role", "roleSubordinates", "accountTeam", "salesTeam", "caseTeam", "email"]),
    recipient: z.string().optional().describe("Username, role/group API name, or email address"),
  })).min(1).describe("Who receives the email"),
  protected: z.boolean().default(false).describe("Protected email alert"),
}).strict();

export const CreatePlatformEventSchema = z.object({
  fullName: z.string().min(1).regex(/^[A-Za-z][A-Za-z0-9_]*__e$/, "Must end with __e")
    .describe("Platform event API name, e.g. 'Order_Created__e'"),
  label: z.string().min(1).describe("Singular label"),
  pluralLabel: z.string().min(1).describe("Plural label"),
  description: z.string().optional().describe("Description of the event"),
  publishBehavior: z.enum(["PublishAfterCommit", "PublishImmediately"]).default("PublishAfterCommit")
    .describe("PublishAfterCommit: published when DML transaction commits. PublishImmediately: published regardless of transaction."),
  fields: z.array(MetadataFieldSchema).optional().describe("Custom fields on the platform event"),
}).strict();

export const RuleEntrySchema = z.object({
  entryOrder: z.number().int().min(1).describe("Processing order (1 = first)"),
  assignedTo: z.string().describe("User username, queue API name, or role API name"),
  assignedToType: z.enum(["User", "Queue", "Role"]).default("Queue").describe("Type of assignee"),
  criteriaItems: z.array(z.object({
    field: z.string().describe("Field path, e.g. 'Lead.Status'"),
    operation: z.string().describe("equals, notEqual, contains, etc."),
    value: z.string().describe("Comparison value"),
  })).optional().describe("Criteria that trigger this rule entry"),
  formula: z.string().optional().describe("Formula alternative to criteriaItems"),
  template: z.string().optional().describe("Email template for notifications"),
  booleanFilter: z.string().optional().describe("Boolean filter string, e.g. '1 AND 2'"),
});

export const CreateAssignmentRuleSchema = z.object({
  objectName: z.enum(["Lead", "Case"]).describe("Object to apply assignment rules to"),
  ruleName: z.string().min(1).regex(/^[A-Za-z][A-Za-z0-9_]*$/).describe("Assignment rule developer name"),
  label: z.string().min(1).describe("Display label"),
  active: z.boolean().default(true).describe("Set as the active assignment rule"),
  ruleEntries: z.array(RuleEntrySchema).min(1).describe("Ordered list of assignment rule entries"),
}).strict();

export const EscalationActionSchema = z.object({
  minutesToEscalation: z.number().int().min(0).describe("Minutes until escalation (from case creation or last modification)"),
  assignedTo: z.string().optional().describe("User or queue to assign/escalate to"),
  assignedToType: z.enum(["User", "Queue"]).optional().describe("User or Queue"),
  notifyTo: z.string().optional().describe("Email address to notify on escalation"),
  template: z.string().optional().describe("Notification email template"),
});

export const CreateEscalationRuleSchema = z.object({
  ruleName: z.string().min(1).regex(/^[A-Za-z][A-Za-z0-9_]*$/).describe("Escalation rule developer name"),
  label: z.string().min(1).describe("Display label"),
  active: z.boolean().default(true).describe("Set as the active escalation rule"),
  ruleEntries: z.array(z.object({
    entryOrder: z.number().int().min(1).describe("Processing order"),
    criteriaItems: z.array(z.object({
      field: z.string().describe("Field path, e.g. 'Case.Status'"),
      operation: z.string().describe("equals, notEqual, etc."),
      value: z.string().describe("Comparison value"),
    })).optional().describe("Criteria for this escalation entry"),
    formula: z.string().optional().describe("Formula alternative to criteriaItems"),
    businessHours: z.string().default("Default").describe("Business hours name to use"),
    escalationStartDate: z.enum(["CaseCreation", "CaseLastModifiedByCustomer", "CaseLastModified"]).default("CaseCreation"),
    escalationActions: z.array(EscalationActionSchema).min(1).describe("What to do when escalating"),
  })).min(1).describe("Rule entries"),
}).strict();

export const CreateAutoResponseRuleSchema = z.object({
  objectName: z.enum(["Lead", "Case"]).describe("Object for auto-response rules"),
  ruleName: z.string().min(1).regex(/^[A-Za-z][A-Za-z0-9_]*$/).describe("Auto-response rule developer name"),
  label: z.string().min(1).describe("Display label"),
  active: z.boolean().default(true).describe("Set as the active auto-response rule"),
  ruleEntries: z.array(z.object({
    entryOrder: z.number().int().min(1).describe("Processing order"),
    template: z.string().describe("Email template full name to auto-send"),
    senderName: z.string().optional().describe("Sender display name"),
    senderEmail: z.string().optional().describe("Sender email address"),
    criteriaItems: z.array(z.object({
      field: z.string().describe("Field path"),
      operation: z.string().describe("equals, notEqual, etc."),
      value: z.string().describe("Comparison value"),
    })).optional().describe("Criteria to trigger this response"),
    formula: z.string().optional().describe("Formula alternative to criteriaItems"),
  })).min(1).describe("Rule entries"),
}).strict();

export const MatchingRuleItemSchema = z.object({
  fieldName: z.string().describe("Field API name to match on, e.g. 'Email', 'Phone'"),
  matchingMethod: z.enum(["Exact", "FirstName", "LastName", "Company", "Phone", "Email", "City", "Street", "Zip", "Title"])
    .default("Exact").describe("Matching algorithm to use"),
  blankValueBehavior: z.enum(["MatchBlanks", "NullNotAllowed"]).default("NullNotAllowed")
    .describe("How to handle blank values"),
});

export const CreateMatchingRuleSchema = z.object({
  objectName: z.string().min(1).describe("Object API name, e.g. 'Lead', 'Contact', 'Account'"),
  ruleName: z.string().min(1).regex(/^[A-Za-z][A-Za-z0-9_]*$/).describe("Matching rule developer name"),
  label: z.string().min(1).describe("Display label"),
  description: z.string().optional().describe("Description"),
  matchingRuleItems: z.array(MatchingRuleItemSchema).min(1).describe("Fields and methods used for matching"),
}).strict();

export const CreateDuplicateRuleSchema = z.object({
  objectName: z.string().min(1).describe("Object API name, e.g. 'Lead', 'Contact', 'Account'"),
  ruleName: z.string().min(1).regex(/^[A-Za-z][A-Za-z0-9_]*$/).describe("Duplicate rule developer name"),
  label: z.string().min(1).describe("Display label"),
  description: z.string().optional().describe("Description"),
  isActive: z.boolean().default(true).describe("Whether this rule is active"),
  actionOnInsert: z.enum(["Allow", "Block", "AllowWithAlert"]).default("AllowWithAlert")
    .describe("What to do when a duplicate is found on insert"),
  actionOnUpdate: z.enum(["Allow", "Block", "AllowWithAlert"]).default("Allow")
    .describe("What to do when a duplicate is found on update"),
  alertMessage: z.string().optional().describe("Custom message shown when duplicate is detected"),
  matchingRules: z.array(z.object({
    matchingRule: z.string().describe("Matching rule developer name (must exist first)"),
    matchingRuleItems: z.array(z.object({
      fieldName: z.string().describe("Source field to map"),
      matchingField: z.string().describe("Target matching field"),
    })).optional().describe("Field mappings if needed"),
  })).min(1).describe("Matching rules to use for duplicate detection"),
}).strict();

export const CreateApexEmailServiceSchema = z.object({
  functionName: z.string().min(1).regex(/^[A-Za-z][A-Za-z0-9_]*$/).describe("Email service function name"),
  apexClassName: z.string().min(1).describe("Apex class that implements Messaging.InboundEmailHandler"),
  isActive: z.boolean().default(true).describe("Whether this email service is active"),
  isAuthenticationRequired: z.boolean().default(false).describe("Require sender authentication"),
  isErrorRoutingEnabled: z.boolean().default(false).describe("Route errors to an address"),
  errorRoutingAddress: z.string().optional().describe("Error routing email address"),
  functionInactiveAction: z.enum(["Bounce", "Discard", "Requeue"]).default("Bounce")
    .describe("What to do when function is inactive"),
  functionExceptionAction: z.enum(["Bounce", "Discard", "Requeue"]).default("Bounce")
    .describe("What to do when an exception occurs"),
  overLimitAction: z.enum(["Bounce", "Discard", "Requeue"]).default("Discard")
    .describe("What to do when over API limits"),
  authenticationFailureAction: z.enum(["Bounce", "Discard", "Requeue"]).default("Bounce")
    .describe("What to do on authentication failure"),
  attachmentOption: z.enum(["None", "TextOnly", "BinaryOnly", "All"]).default("All")
    .describe("Which attachment types to process"),
}).strict();

export const CreateScheduledJobSchema = z.object({
  className: z.string().min(1).describe("Apex class that implements Schedulable interface"),
  jobName: z.string().min(1).describe("Name for the scheduled job"),
  cronExpression: z.string().min(1).describe("Cron expression, e.g. '0 0 2 * * ?' for daily at 2 AM"),
}).strict();

// ─── SECURITY & ACCESS ────────────────────────────────────────────────────────

export const CreatePermissionSetSchema = z.object({
  fullName: z.string().min(1).regex(/^[A-Za-z][A-Za-z0-9_]*$/).describe("Permission set API name, e.g. 'Sales_Manager_Perms'"),
  label: z.string().min(1).describe("Display label"),
  description: z.string().optional().describe("Description of this permission set"),
  objectPermissions: z.array(z.object({
    object: z.string().describe("Object API name, e.g. 'Account', 'MyObject__c'"),
    allowCreate: z.boolean().default(false),
    allowRead: z.boolean().default(true),
    allowEdit: z.boolean().default(false),
    allowDelete: z.boolean().default(false),
    viewAllRecords: z.boolean().default(false),
    modifyAllRecords: z.boolean().default(false),
  })).optional().describe("Object-level permissions to grant"),
  fieldPermissions: z.array(z.object({
    field: z.string().describe("Full field name: ObjectName.FieldName__c, e.g. 'Account.Phone'"),
    editable: z.boolean().default(false),
    readable: z.boolean().default(true),
  })).optional().describe("Field-level permissions to grant"),
  apexClassAccesses: z.array(z.object({
    apexClass: z.string().describe("Apex class name"),
    enabled: z.boolean().default(true),
  })).optional().describe("Apex class access permissions"),
  userPermissions: z.array(z.object({
    name: z.string().describe("User permission name, e.g. 'ManageUsers', 'ViewSetup'"),
    enabled: z.boolean().default(true),
  })).optional().describe("User-level permissions"),
  tabSettings: z.array(z.object({
    tab: z.string().describe("Tab API name"),
    visibility: z.enum(["Hidden", "DefaultOff", "DefaultOn"]).default("DefaultOn"),
  })).optional().describe("Tab visibility settings"),
}).strict();

export const CreateRoleSchema = z.object({
  fullName: z.string().min(1).regex(/^[A-Za-z][A-Za-z0-9_]*$/).describe("Role API name, e.g. 'VP_Sales'"),
  name: z.string().min(1).describe("Role display name, e.g. 'VP of Sales'"),
  description: z.string().optional().describe("Description of this role"),
  parentRole: z.string().optional().describe("Parent role API name (omit for top-level role)"),
  caseAccessLevel: z.enum(["None", "Read", "Edit", "ReadWrite"]).default("ReadWrite")
    .describe("Case access level for subordinates"),
  contactAccessLevel: z.enum(["None", "Read", "Edit", "ReadWrite"]).default("ReadWrite")
    .describe("Contact access level for subordinates"),
  opportunityAccessLevel: z.enum(["None", "Read", "Edit", "ReadWrite"]).default("ReadWrite")
    .describe("Opportunity access level for subordinates"),
  accountAccessLevel: z.enum(["None", "Read", "Edit", "ReadWrite"]).default("ReadWrite")
    .describe("Account and contact access level for subordinates"),
  mayForecastManagerShare: z.boolean().default(true).describe("Grant manager forecast sharing"),
}).strict();

export const CreateQueueSchema = z.object({
  fullName: z.string().min(1).regex(/^[A-Za-z][A-Za-z0-9_]*$/).describe("Queue API name, e.g. 'Support_Level_1'"),
  name: z.string().min(1).describe("Queue display name"),
  email: z.string().optional().describe("Queue email address for notifications"),
  doesSendEmailToMembers: z.boolean().default(false).describe("Send email to all queue members when record is added"),
  supportedObjects: z.array(z.string()).min(1).describe("Object API names this queue supports, e.g. ['Case', 'Lead']"),
  queueMembers: z.object({
    users: z.array(z.string()).optional().describe("Usernames of queue members"),
    groups: z.array(z.string()).optional().describe("Public group API names"),
    roles: z.array(z.string()).optional().describe("Role API names"),
  }).optional().describe("Queue members"),
}).strict();

export const CreateNamedCredentialSchema = z.object({
  fullName: z.string().min(1).regex(/^[A-Za-z][A-Za-z0-9_]*$/).describe("Named credential API name, e.g. 'My_External_API'"),
  label: z.string().min(1).describe("Display label"),
  endpoint: z.string().url().describe("Endpoint URL, e.g. 'https://api.example.com'"),
  principalType: z.enum(["NamedUser", "Anonymous", "PerUserPrincipal"]).default("NamedUser")
    .describe("NamedUser: shared credentials. PerUserPrincipal: per-user OAuth. Anonymous: no auth."),
  protocol: z.enum(["NoAuthentication", "Password", "OAuth", "AwsSv4", "Jwt", "JwtExchange"]).default("NoAuthentication")
    .describe("Authentication protocol"),
  username: z.string().optional().describe("Username for Password protocol"),
  password: z.string().optional().describe("Password for Password protocol (encrypted at rest)"),
  allowFormula: z.boolean().default(false).describe("Allow formulas in HTTP body (enables merge fields)"),
  allowCallout: z.boolean().default(true).describe("Allow callouts using this credential"),
}).strict();

// ─── UI & EXPERIENCE ──────────────────────────────────────────────────────────

export const CreateLightningAppSchema = z.object({
  fullName: z.string().min(1).regex(/^[A-Za-z][A-Za-z0-9_]*$/).describe("App API name, e.g. 'Sales_Console'"),
  label: z.string().min(1).describe("App display label"),
  description: z.string().optional().describe("Description"),
  navType: z.enum(["Standard", "Console"]).default("Standard").describe("Standard: tabs. Console: split view."),
  uiType: z.enum(["Lightning"]).default("Lightning").describe("Must be Lightning for modern apps"),
  setupExperience: z.enum(["all", "setup", "classicSetup"]).default("all"),
  isNavAutoTempTabsDisabled: z.boolean().default(false),
  isNavPersonalizationDisabled: z.boolean().default(false),
  navItems: z.array(z.object({
    name: z.string().describe("Navigation item API name, e.g. 'standard-home', 'Account', 'MyApp__c'"),
    type: z.enum(["Standard", "CustomTab", "InAppLearning", "VisualizationPlugin"]).default("Standard"),
    label: z.string().optional().describe("Override label"),
    defaultItem: z.boolean().default(false).describe("Set as default landing page"),
  })).optional().describe("Navigation bar items"),
  utilityItems: z.array(z.object({
    name: z.string().describe("Utility item API name"),
    type: z.enum(["Standard", "CustomTab"]).default("Standard"),
    label: z.string().optional(),
    iconName: z.string().optional().describe("SLDS icon name, e.g. 'call'"),
  })).optional().describe("Utility bar items"),
}).strict();

export const CreateTabSchema = z.object({
  fullName: z.string().min(1).describe("Tab API name, typically same as the object API name, e.g. 'Invoice__c'"),
  label: z.string().optional().describe("Tab label (defaults to object label)"),
  motif: z.string().default("Custom64: Coin").describe("Icon/motif for the tab, e.g. 'Custom64: Coin', 'Custom1: default'"),
  sobjectName: z.string().optional().describe("Object API name if this is a custom object tab"),
  customObject: z.boolean().default(true).describe("Set to true for custom object tabs"),
  url: z.string().optional().describe("URL for web tab type"),
  page: z.string().optional().describe("Visualforce page name for VF tab"),
  description: z.string().optional().describe("Tab description"),
}).strict();

export const CreateCompactLayoutSchema = z.object({
  objectName: z.string().min(1).describe("Object API name to add the compact layout to"),
  fullName: z.string().min(1).regex(/^[A-Za-z][A-Za-z0-9_]*$/).describe("Compact layout developer name"),
  label: z.string().min(1).describe("Display label"),
  fields: z.array(z.string()).min(1).max(10).describe("Field API names to show (max 10), e.g. ['Name', 'Status__c', 'Amount']"),
  setAsDefault: z.boolean().default(true).describe("Set this compact layout as the default for the object"),
}).strict();

export const CreateListViewSchema = z.object({
  objectName: z.string().min(1).describe("Object API name, e.g. 'Account', 'Lead', 'Opportunity'"),
  fullName: z.string().min(1).regex(/^[A-Za-z][A-Za-z0-9_]*$/).describe("List view developer name"),
  label: z.string().min(1).describe("Display label"),
  columns: z.array(z.string()).optional().describe("Column field API names, e.g. ['Name', 'Account.Name', 'Status__c']"),
  filters: z.array(z.object({
    field: z.string().describe("Field API name"),
    operation: z.enum(["equals", "notEqual", "lessThan", "greaterThan", "lessOrEqual", "greaterOrEqual",
      "contains", "notContain", "startsWith", "includes", "excludes", "within"]).describe("Filter operation"),
    value: z.string().describe("Filter value"),
  })).optional().describe("Filter criteria"),
  booleanFilter: z.string().optional().describe("Boolean filter expression, e.g. '1 AND 2 OR 3'"),
  filterScope: z.enum(["Everything", "Mine", "Team", "Queue", "Delegated", "MyTerritory",
    "SalesTeam", "AssignedToMe"]).default("Everything").describe("Base scope filter"),
  sharedTo: z.object({
    type: z.enum(["AllUsers", "Group", "Role", "RoleAndSubordinates"]).default("AllUsers"),
    name: z.string().optional(),
  }).optional().describe("Who can see this list view"),
}).strict();

export const CreateEmailTemplateSchema = z.object({
  fullName: z.string().min(1).describe("Full name including folder: 'FolderName/TemplateName' or 'unfiled$public/TemplateName'"),
  name: z.string().min(1).describe("Template developer name (no spaces)"),
  label: z.string().min(1).describe("Display label"),
  description: z.string().optional().describe("Description"),
  subject: z.string().min(1).describe("Email subject line (can include merge fields like {!Account.Name})"),
  htmlValue: z.string().optional().describe("HTML body of the email (for html type templates)"),
  body: z.string().min(1).describe("Plain text body of the email"),
  type: z.enum(["text", "html", "custom", "visualforce"]).default("html").describe("Template type"),
  relatedEntityType: z.string().optional().describe("Related object API name, e.g. 'Opportunity', 'Contact'"),
  encoding: z.string().default("UTF-8").describe("Character encoding"),
  available: z.boolean().default(true).describe("Make template available for use"),
  replyTo: z.string().optional().describe("Reply-to email address"),
  senderName: z.string().optional().describe("Sender display name"),
}).strict();

export const CreateStaticResourceSchema = z.object({
  fullName: z.string().min(1).max(80).regex(/^[A-Za-z][A-Za-z0-9_]*$/).describe("Static resource API name, e.g. 'MyLibrary'"),
  contentType: z.string().max(128).default("text/plain").describe("MIME type, e.g. 'application/json', 'text/css', 'application/javascript'"),
  content: z.string().min(1).max(5_000_000).describe("The file content as a string (text, JSON, JS, CSS, etc.)"),
  cacheControl: z.enum(["Public", "Private"]).default("Public").describe("Cache control setting"),
  description: z.string().max(1000).optional().describe("Description of this resource"),
}).strict();

export const CreateCustomNotificationTypeSchema = z.object({
  fullName: z.string().min(1).regex(/^[A-Za-z][A-Za-z0-9_]*$/).describe("Custom notification type API name"),
  customNotifTypeName: z.string().min(1).describe("Display name for the notification type"),
  description: z.string().optional().describe("Description"),
  desktop: z.boolean().default(true).describe("Enable for desktop (web browser)"),
  mobile: z.boolean().default(true).describe("Enable for mobile app"),
}).strict();

// ─── REPORTING ────────────────────────────────────────────────────────────────

export const CreateReportTypeSchema = z.object({
  fullName: z.string().min(1).regex(/^[A-Za-z][A-Za-z0-9_]*$/).describe("Report type developer name"),
  label: z.string().min(1).describe("Display label"),
  description: z.string().optional().describe("Description"),
  baseObject: z.string().min(1).describe("Primary object API name, e.g. 'Account', 'Opportunity'"),
  category: z.enum(["accounts", "opportunities", "forecasts", "cases", "leads", "activities",
    "campaigns", "busop", "other"]).default("other").describe("Report category for organization"),
  deployed: z.boolean().default(true).describe("Deploy this report type immediately"),
  relationships: z.array(z.object({
    joinTable: z.string().describe("Related object API name to join"),
    relationshipType: z.enum(["Inner", "Outer"]).default("Outer")
      .describe("Inner: only records with related. Outer: all primary records"),
    field: z.string().optional().describe("Relationship field API name"),
    label: z.string().optional().describe("Display label for this relationship"),
    columns: z.array(z.string()).optional().describe("Fields from this related object to include"),
  })).optional().describe("Related object joins"),
}).strict();

export const CreateDashboardSchema = z.object({
  fullName: z.string().min(1).describe("Dashboard full name including folder: 'FolderName/DashboardName'"),
  title: z.string().min(1).describe("Dashboard title"),
  description: z.string().optional().describe("Description"),
  runningUser: z.string().optional().describe("Username to run the dashboard as"),
  components: z.array(z.object({
    type: z.enum(["Metric", "Gauge", "Table", "Chart", "Map", "VisualforcePage", "Scontrol"])
      .default("Chart").describe("Component type"),
    reportApiName: z.string().optional().describe("Report API name to power this component"),
    header: z.string().optional().describe("Component header text"),
    footer: z.string().optional().describe("Component footer text"),
    chartType: z.enum(["Bar", "BarGrouped", "BarStacked", "Line", "Pie", "Donut", "Funnel", "Scatter"]).optional()
      .describe("Chart type for Chart components"),
    columnSpan: z.number().int().min(1).max(3).default(1).describe("Column span (1-3)"),
    rowSpan: z.number().int().min(1).max(3).default(1).describe("Row span (1-3)"),
  })).optional().describe("Dashboard components"),
}).strict();

// ─── APEX DEVELOPMENT ────────────────────────────────────────────────────────

export const CreateApexClassSchema = z.object({
  className: z.string().min(1).max(80).regex(/^[A-Za-z][A-Za-z0-9_]*$/).describe("Apex class name, e.g. 'AccountService'"),
  classBody: z.string().min(1).max(1_000_000).describe("Full Apex class source code including the class declaration"),
  apiVersion: z.string().max(10).default("66.0").describe("API version for this class, e.g. '66.0'"),
}).strict();

export const CreateApexTriggerSchema = z.object({
  triggerName: z.string().min(1).max(80).regex(/^[A-Za-z][A-Za-z0-9_]*$/).describe("Trigger name, e.g. 'AccountTrigger'"),
  objectName: z.string().min(1).max(80).describe("Object API name the trigger fires on, e.g. 'Account'"),
  events: z.array(z.enum(["before insert", "before update", "before delete",
    "after insert", "after update", "after delete", "after undelete"]))
    .min(1).describe("Trigger events, e.g. ['before insert', 'before update']"),
  triggerBody: z.string().min(1).max(1_000_000).describe("Full trigger body code (the code between the trigger { })"),
  apiVersion: z.string().max(10).default("66.0").describe("API version for this trigger"),
}).strict();

export const CreateApexTestClassSchema = z.object({
  className: z.string().min(1).max(80).regex(/^[A-Za-z][A-Za-z0-9_]*$/).describe("Test class name, e.g. 'AccountServiceTest'"),
  classBody: z.string().min(1).max(1_000_000).describe("Full test class source code including @isTest annotation and class declaration"),
  apiVersion: z.string().max(10).default("66.0").describe("API version for this test class"),
  runAfterDeploy: z.boolean().default(false).describe("Immediately run the tests after deploying"),
}).strict();

export const RunApexTestsSchema = z.object({
  testClasses: z.array(z.string().max(80)).min(1).describe("List of test class names to run, e.g. ['AccountServiceTest', 'ContactTriggerTest']"),
  waitMinutes: z.number().int().min(1).max(15).default(5).describe("Max minutes to wait for test results"),
}).strict();

export const ExecuteAnonymousApexSchema = z.object({
  apexCode: z.string().min(1).max(1_000_000).describe("Anonymous Apex code to execute, e.g. 'System.debug(Date.today());'"),
}).strict();

// ─── LWC DEVELOPMENT ─────────────────────────────────────────────────────────

export const CreateLwcSchema = z.object({
  componentName: z.string().min(1).max(80).regex(/^[a-z][a-zA-Z0-9]*$/, "Must start lowercase, no underscores or hyphens")
    .describe("LWC component name in camelCase, e.g. 'accountCard', 'opportunityList'"),
  html: z.string().min(1).max(500_000).describe("HTML template content (the content of the .html file, including <template> tags)"),
  javascript: z.string().min(1).max(500_000).describe("JavaScript controller content (the content of the .js file, including import statements and class)"),
  css: z.string().max(200_000).optional().describe("Optional CSS styles content"),
  description: z.string().max(1000).optional().describe("Description of the component"),
  targets: z.array(z.enum([
    "lightning__AppPage",
    "lightning__RecordPage",
    "lightning__HomePage",
    "lightning__FlowScreen",
    "lightning__UtilityBar",
    "lightning__RecordAction",
    "lightningCommunity__Page",
    "lightningCommunity__Default",
  ])).optional().describe("Where this component can be placed in Lightning"),
  isExposed: z.boolean().default(true).describe("Make the component available in Lightning App Builder"),
  apiVersion: z.string().default("66.0").describe("API version for this component"),
}).strict();

export const UpdateLwcSchema = z.object({
  componentName: z.string().min(1).max(80).regex(/^[a-z][a-zA-Z0-9]*$/).describe("Existing LWC component name to update"),
  html: z.string().max(500_000).optional().describe("Updated HTML template (leave undefined to keep existing)"),
  javascript: z.string().max(500_000).optional().describe("Updated JavaScript controller (leave undefined to keep existing)"),
  css: z.string().max(200_000).optional().describe("Updated CSS (leave undefined to keep existing)"),
  apiVersion: z.string().max(10).default("66.0").describe("API version"),
}).strict();

// ─── EXPERIENCE CLOUD ────────────────────────────────────────────────────────

export const CreateExperienceSiteSchema = z.object({
  siteName: z.string().min(1).regex(/^[A-Za-z][A-Za-z0-9_]*$/).describe("Site API name, e.g. 'CustomerPortal'"),
  label: z.string().min(1).describe("Site display label"),
  template: z.enum(["CustomerService", "Partner", "LWR", "Aloha", "Microsites", "VFPage"])
    .default("CustomerService").describe("Experience Cloud template to use"),
  urlPathPrefix: z.string().min(1).describe("URL path prefix, e.g. 'customers' → https://org.force.com/customers"),
  description: z.string().optional().describe("Site description"),
  status: z.enum(["Live", "UnderConstruction", "DownForMaintenance"]).default("UnderConstruction")
    .describe("Initial site status"),
  guestUserProfile: z.string().optional().describe("Guest user profile API name (default: '<SiteName> Profile')"),
}).strict();

export const CreateExperiencePageSchema = z.object({
  siteName: z.string().min(1).describe("Experience site API name"),
  pageName: z.string().min(1).describe("Page developer name"),
  label: z.string().min(1).describe("Page display label"),
  type: z.enum(["standard", "home", "login", "profile", "objectDetail", "objectList", "custom"])
    .default("custom").describe("Page type"),
  url: z.string().optional().describe("Page URL path, e.g. '/my-page'"),
}).strict();

// ─── AGENTFORCE ───────────────────────────────────────────────────────────────

export const CreateAgentSchema = z.object({
  agentName: z.string().min(1).max(40).regex(/^[A-Za-z][A-Za-z0-9]*$/, "Letters and numbers only — Salesforce Bot API names do not allow underscores or spaces").describe("Agent API name — letters and numbers only, NO underscores (Salesforce rejects underscores in Bot developer names). Max 40 chars. e.g. 'SalesAgent', 'SupportBot'. Used in all subsequent calls (sf_create_agent_topic, sf_create_agent_planner)."),
  label: z.string().min(1).max(255).describe("Agent display label shown to users, e.g. 'Sales Assistant'"),
  description: z.string().max(1000).optional().describe("Agent description"),
  type: z.enum(["Default", "EinsteinCopilot"]).default("EinsteinCopilot").describe("Agent type — use EinsteinCopilot for standard Agentforce agents"),
  company: z.string().max(255).optional().describe("Company name for the agent's context"),
  persona: z.string().max(5000).optional().describe("Agent persona/role description, e.g. 'A knowledgeable sales expert who helps close deals'"),
  tone: z.enum(["Formal", "Neutral", "Casual"]).default("Neutral").describe("Communication tone for agent responses"),
  instructions: z.string().max(10000).optional().describe("System-level instructions that guide agent behavior across all topics"),
}).strict();

export const CreateAgentTopicSchema = z.object({
  agentName: z.string().min(1).max(80).describe("Parent agent API name — informational only, NOT written to the topic XML. The actual agent→topic wiring happens in sf_create_agent_planner (required separate step)."),
  topicName: z.string().min(1).max(80).regex(/^[A-Za-z][A-Za-z0-9_]*$/).describe("Topic API name, e.g. 'OrderManagement'. Letters, numbers, underscores. This is the name you must include in topicNames when calling sf_create_agent_planner."),
  label: z.string().min(1).max(255).describe("Topic label"),
  description: z.string().min(1).max(5000).describe("What this topic covers"),
  scope: z.string().min(1).max(5000).describe("Scope of this topic — what kind of requests it handles"),
  instructions: z.union([z.string().max(10000), z.array(z.string().max(2000))]).optional().describe("Step-by-step instructions for handling this topic. Pass as a single string or an array of strings (each becomes a separate instruction entry)."),
  actions: z.array(z.string().max(80)).optional().describe("CRITICAL: Action API names (from sf_create_agent_action) to link to this topic. If you omit this or pass an empty array, the topic is created with NO executable actions — the agent will silently do nothing for this topic. Always include all action API names here."),
}).strict();

export const CreateAgentActionSchema = z.object({
  agentName: z.string().min(1).max(80).describe("Parent agent API name — informational only, NOT written to the action XML."),
  topicName: z.string().min(1).max(80).describe("Parent topic API name — informational only, NOT written to the action XML. You must still pass this action's API name (actionName) in the 'actions' array when calling sf_create_agent_topic."),
  actionName: z.string().min(1).max(80).regex(/^[A-Za-z][A-Za-z0-9_]*$/).describe("Action API name. Letters, numbers, underscores. Remember this name — you must pass it in the 'actions' array when calling sf_create_agent_topic."),
  label: z.string().min(1).max(255).describe("Action label"),
  description: z.string().min(1).max(5000).describe("What this action does — used by the AI to decide when to invoke it"),
  type: z.enum(["Flow", "ApexClass", "PromptTemplate", "DataCategoryGroup", "ExternalService"])
    .describe("Action type: 'Flow' (AutoLaunchedFlow only — must be Active), 'ApexClass' (must have @InvocableMethod), 'PromptTemplate', etc."),
  reference: z.string().min(1).max(255).describe("Exact API name of the resource to invoke. For Flow: the flow API name (e.g. 'Get_Account_Details'). For ApexClass: the class name (e.g. 'AccountHelper'). For PromptTemplate: the template API name. Must already exist in Salesforce."),
  inputs: z.array(z.object({
    name: z.string().max(255).describe("Input parameter name"),
    value: z.string().max(1000).describe("Value or reference, e.g. '{!Agent.Topic.Entities.accountName}'"),
  })).optional().describe("Input parameter mappings"),
}).strict();

export const CreateAgentPlannerSchema = z.object({
  agentName: z.string().min(1).max(80).regex(/^[A-Za-z][A-Za-z0-9]*$/, "Letters and numbers only — must match the Bot API name exactly as used in sf_create_agent").describe("Agent API name — must exactly match the agentName used in sf_create_agent (no underscores)."),
  label: z.string().min(1).max(255).optional().describe("Planner display label (defaults to agentName)"),
  topicNames: z.array(z.string().min(1).max(80)).min(1).describe("COMPLETE list of topic API names to wire to this agent. WARNING: This REPLACES any existing planner — if you add a new topic to an existing agent, include ALL previous topic names plus the new one. Omitting a topic here removes it from the agent."),
}).strict();

// ─── MCP SERVER MANAGEMENT ───────────────────────────────────────────────────

export const CreateMcpServerSchema = z.object({
  serverName: z.string().min(1).max(214).describe("Name for the new MCP server, e.g. 'my-salesforce-server'"),
  outputDirectory: z.string().min(1).max(1024).describe("Absolute path to directory where files will be created, e.g. 'C:/projects/my-server'"),
  description: z.string().max(1000).optional().describe("Server description"),
  salesforceInstanceUrl: z.string().max(255).optional().describe("Salesforce instance URL to pre-configure, e.g. 'https://myorg.salesforce.com'"),
}).strict();

export const CreateMcpToolSchema = z.object({
  projectDirectory: z.string().min(1).max(1024).describe("Absolute path to the MCP server project directory"),
  toolName: z.string().min(1).max(80).describe("Tool API name, e.g. 'get_account_data'"),
  toolDescription: z.string().min(1).max(2000).describe("Detailed description of what the tool does"),
  inputSchema: z.record(z.unknown()).describe("JSON Schema for the tool's input parameters"),
  handlerCode: z.string().min(1).max(100_000).describe("TypeScript handler function body code"),
}).strict();

export const ListMcpToolsSchema = z.object({
  projectDirectory: z.string().min(1).max(1024).describe("Absolute path to the MCP server project directory"),
}).strict();

// ─── EXTERNAL APPS & INTEGRATIONS ────────────────────────────────────────────

export const CreateConnectedAppSchema = z.object({
  fullName: z.string().min(1).regex(/^[A-Za-z][A-Za-z0-9_]*$/).describe("Connected app API name, e.g. 'My_External_App'"),
  label: z.string().min(1).describe("Display label"),
  description: z.string().optional().describe("Description"),
  contactEmail: z.string().email().describe("Contact email for the app"),
  callbackUrls: z.array(z.string()).min(1).describe("OAuth callback URLs, e.g. ['https://myapp.com/oauth/callback']"),
  scopes: z.array(z.enum(["api", "web", "full", "chatter_api", "wave_api", "eclair_api",
    "visualforce", "content", "openid", "profile", "email", "address", "phone",
    "offline_access", "custom_permissions", "pardot_api"]))
    .min(1).describe("OAuth scopes to request"),
  consumerKey: z.string().optional().describe("Custom consumer key (auto-generated if not specified)"),
  startUrl: z.string().optional().describe("Default start URL after OAuth"),
  accessTokenValidity: z.number().int().optional().describe("Access token validity in minutes"),
  refreshTokenValidity: z.number().int().optional().describe("Refresh token validity in minutes"),
}).strict();

export const CreateExternalDataSourceSchema = z.object({
  fullName: z.string().min(1).regex(/^[A-Za-z][A-Za-z0-9_]*$/).describe("External data source API name"),
  label: z.string().min(1).describe("Display label"),
  type: z.enum(["SimpleURL", "OData2", "OData4", "Apex", "Files", "MuleSoft"]).default("SimpleURL")
    .describe("Connection type: SimpleURL for basic, OData2/OData4 for OData, Apex for custom"),
  endpoint: z.string().url().describe("Endpoint URL"),
  principalType: z.enum(["NamedUser", "Anonymous", "PerUserPrincipal"]).default("Anonymous")
    .describe("Authentication principal type"),
  protocol: z.enum(["NoAuthentication", "Password", "OAuth"]).default("NoAuthentication")
    .describe("Authentication protocol"),
  username: z.string().optional().describe("Username for Password protocol"),
  password: z.string().optional().describe("Password for Password protocol"),
  description: z.string().optional().describe("Description"),
}).strict();

export const CreateExternalObjectSchema = z.object({
  fullName: z.string().min(1).regex(/^[A-Za-z][A-Za-z0-9_]*__x$/, "Must end with __x")
    .describe("External object API name, e.g. 'Product__x'"),
  label: z.string().min(1).describe("Singular label"),
  pluralLabel: z.string().min(1).describe("Plural label"),
  externalDataSource: z.string().min(1).describe("External data source API name to link to"),
  externalName: z.string().optional().describe("Name in the external system (table/entity name)"),
  description: z.string().optional().describe("Description"),
  fields: z.array(MetadataFieldSchema).optional().describe("Custom fields to add"),
}).strict();

export const CreateRemoteSiteSettingSchema = z.object({
  fullName: z.string().min(1).regex(/^[A-Za-z][A-Za-z0-9_]*$/).describe("Remote site setting API name"),
  name: z.string().min(1).describe("Display name"),
  url: z.string().url().describe("URL to allow for callouts, e.g. 'https://api.example.com'"),
  description: z.string().optional().describe("Description of why this site is trusted"),
  isActive: z.boolean().default(true).describe("Whether this remote site setting is active"),
  disableProtocolSecurity: z.boolean().default(false).describe("Disable protocol security (not recommended)"),
}).strict();

export const CreateCspSettingSchema = z.object({
  endpointUrl: z.string().url().describe("Trusted URL for CSP, e.g. 'https://cdn.example.com'"),
  cspDirectives: z.array(z.enum(["connect-src", "font-src", "frame-src", "img-src",
    "media-src", "object-src", "script-src", "style-src"])).min(1)
    .describe("CSP directives this URL is trusted for"),
  description: z.string().optional().describe("Description of why this URL is trusted"),
  isActive: z.boolean().default(true).describe("Whether this setting is active"),
}).strict();

// ─── CHANGE SETS & DEPLOYMENT ────────────────────────────────────────────────

export const ComponentRefSchema = z.object({
  type: z.string().describe("Metadata type, e.g. 'CustomObject', 'ApexClass', 'Flow', 'CustomField'"),
  name: z.string().describe("Component API name, e.g. 'Account', 'MyClass', 'My_Flow'"),
});

export const CreateOutboundChangeSetSchema = z.object({
  changeSetName: z.string().min(1).describe("Name for the outbound change set"),
  description: z.string().optional().describe("Description of what this change set contains"),
  components: z.array(ComponentRefSchema).optional().describe("Metadata components to add to the change set"),
}).strict();

export const AddToChangeSetSchema = z.object({
  changeSetName: z.string().min(1).describe("Name of the existing outbound change set"),
  components: z.array(ComponentRefSchema).min(1).describe("Components to add"),
}).strict();

export const InlineComponentSchema = z.object({
  type: z.string().describe("Metadata type, e.g. 'Flow', 'ApexClass', 'CustomObject'"),
  name: z.string().describe("Component API name, e.g. 'My_Flow', 'MyClass'"),
  xml: z.string().describe("Complete XML content for this component (the full metadata file content, not just a fragment)"),
});

export const DeployMetadataSchema = z.object({
  components: z.array(ComponentRefSchema).default([]).describe("Metadata components to include in the deployment package. These reference components already in the org. Can be empty when using componentsXml to deploy new/updated components with inline XML."),
  componentsXml: z.array(InlineComponentSchema).optional().describe("Optional inline XML components to deploy. Each entry provides the complete XML definition (type, name, xml). The file path is inferred from type/name. When provided alongside components, both are deployed together."),
  checkOnly: z.boolean().default(false).describe("Validate only, do not actually deploy"),
  runTests: z.array(z.string()).optional().describe("Test classes to run during deployment"),
  rollbackOnError: z.boolean().default(true).describe("Roll back all changes if any component fails"),
  waitMinutes: z.number().int().min(1).max(60).default(10).describe("Max minutes to wait for deploy to complete"),
  testLevel: z.enum(["NoTestRun","RunSpecifiedTests","RunLocalTests","RunAllTestsInOrg"]).optional().describe("Test level: NoTestRun, RunSpecifiedTests, RunLocalTests, or RunAllTestsInOrg"),
}).strict();

export const CheckDeployStatusSchema = z.object({
  deployId: z.string().min(1).describe("Deploy async job ID returned from sf_deploy_metadata"),
}).strict();

export const RetrieveMetadataSchema = z.object({
  components: z.array(ComponentRefSchema).optional().describe("Metadata components to retrieve"),
  metadataType: z.string().optional().describe("Single metadata type (alternative to components array)"),
  componentName: z.string().optional().describe("Single component name (used with metadataType)"),
  packageXml: z.string().optional().describe("Raw package.xml content for selective retrieve. If provided, components list is ignored."),
}).strict();

// ─── OBJECTS & FIELDS (v2.2.0) ───────────────────────────────────────────────

export const UpdateCustomObjectSchema = z.object({
  objectApiName: z.string().optional().describe("Custom object API name, e.g. 'MyObject__c'"),
  fullName: z.string().optional().describe("Alias for objectApiName"),
  label: z.string().optional().describe("New singular label"),
  pluralLabel: z.string().optional().describe("New plural label"),
  description: z.string().optional().describe("New description"),
  enableHistory: z.boolean().optional().describe("Enable field history tracking"),
  enableReports: z.boolean().optional().describe("Allow in reports"),
  enableSearch: z.boolean().optional().describe("Allow in search"),
  enableActivities: z.boolean().optional().describe("Enable activities (tasks and events)"),
}).strict();

export const UpdateCustomFieldSchema = z.object({
  objectApiName: z.string().optional().describe("Object API name, e.g. 'Account'"),
  objectName: z.string().optional().describe("Alias for objectApiName"),
  fieldApiName: z.string().optional().describe("Field API name, e.g. 'MyField__c'"),
  fieldName: z.string().optional().describe("Alias for fieldApiName"),
  label: z.string().optional().describe("New field label"),
  description: z.string().optional().describe("New description"),
  helpText: z.string().optional().describe("New inline help text"),
  required: z.boolean().optional().describe("Make field required"),
  unique: z.boolean().optional().describe("Enforce uniqueness"),
  defaultValue: z.string().optional().describe("New default value"),
}).strict();

export const CreateRelationshipFieldSchema = z.object({
  objectApiName: z.string().optional().describe("Object API name to create the field on, e.g. 'Contact'"),
  objectName: z.string().optional().describe("Alias for objectApiName"),
  fieldName: z.string().min(1).max(40).regex(/^[A-Za-z][A-Za-z0-9_]*$/).describe("Field name without __c suffix, e.g. 'Account'"),
  label: z.string().min(1).describe("Field label"),
  relationshipType: z.enum(["Lookup","MasterDetail"]).optional().describe("Lookup: optional reference field. MasterDetail: required parent-child relationship (child deleted with parent)."),
  relationType: z.enum(["Lookup","MasterDetail"]).optional().describe("Alias for relationshipType"),
  relatedObject: z.string().optional().describe("API name of the related (parent) object, e.g. 'Account'"),
  referenceTo: z.string().optional().describe("Alias for relatedObject"),
  relationshipName: z.string().min(1).describe("Relationship API name used in SOQL, e.g. 'Account' (no spaces or double underscores)"),
  onDelete: z.enum(["SetNull","Restrict"]).default("SetNull").describe("Lookup only — what happens to child when parent is deleted: SetNull (clears field) or Restrict (blocks deletion)"),
  required: z.boolean().default(false).describe("Make field required (Lookup only; MasterDetail is always required)"),
  description: z.string().optional().describe("Field description"),
}).strict();

export const CreateFormulaFieldSchema = z.object({
  objectApiName: z.string().min(1).describe("Object API name, e.g. 'Opportunity'"),
  fieldName: z.string().min(1).max(40).regex(/^[A-Za-z][A-Za-z0-9_]*$/).describe("Field name without __c suffix"),
  label: z.string().min(1).describe("Field label"),
  returnType: z.enum(["Text","Number","Currency","Date","DateTime","Checkbox","Percent"]).describe("Formula return type"),
  formula: z.string().min(1).describe("Salesforce formula expression. Supports all Salesforce formula functions: IF, AND, OR, NOT, BLANKVALUE, TEXT, VALUE, DATE, DATEVALUE, TODAY, NOW, MONTH, YEAR, DAY, FLOOR, CEILING, MOD, LEN, LEFT, RIGHT, MID, TRIM, UPPER, LOWER, CONTAINS, BEGINS, ISPICKVAL, ISNULL, ISBLANK, cross-object fields (e.g. Account.Owner.Name), etc."),
  formulaTreatBlanksAs: z.enum(["BlankAsZero", "BlankAsLogicalFalse"]).optional().describe("How to treat blank fields in the formula. Defaults to BlankAsZero for numeric types, BlankAsLogicalFalse for Checkbox."),
  precision: z.number().int().min(1).max(18).optional().describe("Total number of digits for Number/Currency/Percent return types (default 18)"),
  scale: z.number().int().min(0).max(18).optional().describe("Decimal places for Number/Currency/Percent return types"),
  description: z.string().optional().describe("Field description"),
}).strict();

// ─── SECURITY & PERMISSIONS (v2.2.0) ─────────────────────────────────────────

export const AssignPermissionSetSchema = z.object({
  permissionSetName: z.string().min(1).describe("Permission Set API name, e.g. 'Sales_Rep_PS'"),
  username: z.string().optional().describe("Username (email) of the user to assign to. Provide username OR userId."),
  userId: z.string().optional().describe("Salesforce User ID (15 or 18 char). Provide username OR userId."),
}).strict();

export const CreatePermissionSetGroupSchema = z.object({
  groupName: z.string().min(1).max(80).regex(/^[A-Za-z][A-Za-z0-9_]*$/).describe("Permission Set Group API name"),
  label: z.string().min(1).describe("Display label"),
  description: z.string().optional().describe("Description"),
  permissionSets: z.array(z.string().min(1)).min(1).describe("Array of Permission Set API names to include in this group"),
}).strict();

const ObjPermSchema = z.object({
  object: z.string().optional().describe("Object API name, e.g. 'Account'"),
  read: z.boolean().default(false),
  create: z.boolean().default(false),
  edit: z.boolean().default(false),
  delete: z.boolean().default(false),
  viewAll: z.boolean().default(false),
  modifyAll: z.boolean().default(false),
});

const FldPermSchema = z.object({
  field: z.string().min(1).describe("Field in Object.Field format, e.g. 'Account.AnnualRevenue'"),
  readable: z.boolean().default(true),
  editable: z.boolean().default(false),
});

export const UpdatePermissionSetSchema = z.object({
  permissionSetName: z.string().min(1).describe("Existing Permission Set API name to update"),
  objectPermissions: z.array(ObjPermSchema).optional().describe("Object permissions to set. Replaces existing permissions for specified objects."),
  fieldPermissions: z.array(FldPermSchema).optional().describe("Field-level security to set. Replaces existing FLS for specified fields."),
}).strict();

export const CreateMutingPermissionSetSchema = z.object({
  mutingPermSetName: z.string().optional().describe("Muting Permission Set API name"),
  permissionSetName: z.string().optional().describe("Alias for mutingPermSetName"),
  description: z.string().optional().describe("Description"),
  label: z.string().min(1).describe("Display label"),
  permissionSetGroup: z.string().optional().describe("Permission Set Group API name to add this muting perm set to"),
  objectPermissions: z.array(ObjPermSchema).optional().describe("Object permissions to mute (suppress)"),
  fieldPermissions: z.array(FldPermSchema).optional().describe("Field permissions to mute"),
}).strict();

export const SetFieldLevelSecuritySchema = z.object({
  fieldApiName: z.string().optional().describe("Field in Object.Field format, e.g. 'Account.AnnualRevenue'"),
  permissionSetName: z.string().optional().describe("Single permission set name"),
  objectName: z.string().optional().describe("Object API name (informational)"),
  fields: z.array(z.object({
    field: z.string().describe("Field API name"),
    readable: z.boolean().optional(),
    editable: z.boolean().optional(),
  })).optional().describe("Array of field FLS settings"),
  profiles: z.array(z.string()).optional().describe("Profile API names to update FLS for"),
  permissionSets: z.array(z.string()).optional().describe("Permission Set API names to update FLS for"),
  readable: z.boolean().optional().describe("Grant read access to this field"),
  editable: z.boolean().optional().describe("Grant edit access to this field (read is implied if editable)"),
}).strict();

export const SetOrgWideDefaultsSchema = z.object({
  objectApiName: z.string().optional().describe("Object API name, e.g. 'Opportunity__c'. For standard objects like Account, use the object API name."),
  objectName: z.string().optional().describe("Alias for objectApiName"),
  defaultInternal: z.enum(["Private","PublicRead","PublicReadWrite","ControlledByParent"]).optional().describe("Internal org-wide default sharing model"),
  defaultAccess: z.string().optional().describe("Alias for defaultInternal: Private, PublicRead, PublicReadWrite"),
  externalAccess: z.string().optional().describe("External org-wide default sharing"),
  defaultExternal: z.enum(["Private","PublicRead","PublicReadWrite","ControlledByParent"]).optional().describe("External org-wide default (for orgs with external sharing model enabled)"),
}).strict();

export const CreateProfileSchema = z.object({
  profileName: z.string().optional().describe("New profile API name"),
  newProfileName: z.string().optional().describe("Alias for profileName"),
  label: z.string().optional().describe("New profile display label"),
  cloneFrom: z.string().optional().describe("API name of existing profile to clone, e.g. 'Standard User'"),
  sourceProfileName: z.string().optional().describe("Alias for cloneFrom"),
  description: z.string().optional().describe("Profile description"),
}).strict();

const ProfileObjPermSchema = z.object({
  object: z.string().optional().describe("Object API name"),
  allowCreate: z.boolean().default(false),
  allowDelete: z.boolean().default(false),
  allowEdit: z.boolean().default(false),
  allowRead: z.boolean().default(true),
  viewAllRecords: z.boolean().default(false),
  modifyAllRecords: z.boolean().default(false),
});

export const UpdateProfileSchema = z.object({
  profileName: z.string().min(1).describe("Profile API name to update"),
  objectPermissions: z.array(ProfileObjPermSchema).optional().describe("Object permissions to set"),
  fieldPermissions: z.array(FldPermSchema).optional().describe("Field-level security to set"),
  tabVisibilities: z.array(z.object({ tab: z.string(), visibility: z.enum(["DefaultOn","DefaultOff","Hidden"]) })).optional().describe("Tab visibility settings"),
  applicationVisibilities: z.array(z.object({ application: z.string(), visible: z.boolean(), default: z.boolean().default(false) })).optional().describe("App visibility settings"),
}).strict();

// ─── PAGE LAYOUTS & UI (v2.2.0) ──────────────────────────────────────────────

export const UpdatePageLayoutSchema = z.object({
  layoutName: z.string().min(1).describe("Layout full name in 'Object-Layout Name' format, e.g. 'Account-Account Layout'"),
  fieldsToAdd: z.array(z.union([
    z.string().transform((s) => ({ field: s })),
    z.object({ field: z.string(), section: z.string().optional(), column: z.number().int().min(0).max(1).default(0) }),
  ])).optional().describe("Fields to add: field API name strings or {field, section?, column?} objects"),
  fieldsToRemove: z.array(z.string()).optional().describe("Field API names to remove from the layout"),
  relatedListsToAdd: z.array(z.string()).optional().describe("Related list API names to add, e.g. 'Contacts'"),
  relatedListsToRemove: z.array(z.string()).optional().describe("Related list API names to remove"),
  buttonsToAdd: z.array(z.string()).optional().describe("Custom button names to add to the layout"),
  objectName: z.string().optional().describe("Object API name (informational)"),
  sections: z.array(z.any()).optional().describe("Page layout sections"),
}).strict();

export const AssignPageLayoutSchema = z.object({
  objectApiName: z.string().optional().describe("Object API name, e.g. 'Account'"),
  objectName: z.string().optional().describe("Alias for objectApiName"),
  layoutName: z.string().min(1).describe("Layout name (without object prefix), e.g. 'Account Layout'"),
  profileName: z.string().optional().describe("Profile API name to assign the layout to"),
  profiles: z.array(z.string()).optional().describe("Array of profile names (alternative to profileName)"),
  recordTypeName: z.string().optional().describe("Record type developer name (if assigning to a specific record type)"),
}).strict();

const FlexiComponentSchema = z.object({
  componentName: z.string().describe("LWC or Aura component API name, e.g. 'flexipage:recordDetail'"),
  region: z.string().describe("Page region, e.g. 'main', 'sidebar', 'left', 'center', 'right'"),
  order: z.number().int().optional().describe("Component order within region (0-based)"),
  properties: z.record(z.unknown()).optional().describe("Component property values"),
});

export const CreateLightningRecordPageSchema = z.object({
  pageName: z.string().min(1).max(80).regex(/^[A-Za-z][A-Za-z0-9_]*$/).describe("FlexiPage API name"),
  label: z.string().min(1).describe("Page display label"),
  objectApiName: z.string().min(1).describe("Object API name for the record page"),
  template: z.enum(["HeaderAndRightSidebar","HeaderAndThreeRegions","MosaicTemplate","FullWidth","LeftSidebar"]).default("HeaderAndRightSidebar").describe("Page template"),
  components: z.array(FlexiComponentSchema).optional().describe("Components to add to the page"),
}).strict();

export const CreateLightningHomePageSchema = z.object({
  pageName: z.string().min(1).max(80).regex(/^[A-Za-z][A-Za-z0-9_]*$/).describe("FlexiPage API name"),
  label: z.string().min(1).describe("Page display label"),
  template: z.string().default("Home").describe("Page template name"),
  components: z.array(FlexiComponentSchema).optional().describe("Components to add to the page"),
}).strict();

export const UpdateLightningPageSchema = z.object({
  pageApiName: z.string().min(1).describe("FlexiPage API name to update"),
  componentsToAdd: z.array(FlexiComponentSchema).optional().describe("Components to add"),
  componentsToRemove: z.array(z.string()).optional().describe("Component names to remove"),
}).strict();

export const AssignLightningPageSchema = z.object({
  pageApiName: z.string().min(1).describe("FlexiPage API name to assign"),
  assignmentType: z.enum(["org","app","recordType"]).describe("Assignment scope"),
  appName: z.string().optional().describe("Lightning App API name (required for app assignment)"),
  recordTypeName: z.string().optional().describe("Record Type developer name (for recordType assignment)"),
  objectApiName: z.string().optional().describe("Object API name (for record page assignments)"),
}).strict();

export const AssignCompactLayoutSchema = z.object({
  objectApiName: z.string().optional().describe("Object API name, e.g. 'Account'"),
  objectName: z.string().optional().describe("Alias for objectApiName"),
  compactLayoutName: z.string().min(1).describe("Compact layout API name to assign as default"),
  recordTypeName: z.string().optional().describe("Record type developer name (if assigning to a specific record type)"),
}).strict();

// ─── AUTOMATION (v2.2.0) ─────────────────────────────────────────────────────
// ActivateFlowSchema and CreateQuickActionSchema defined in CATEGORY I and CATEGORY B sections below

// ─── APEX & LWC (v2.2.0) ─────────────────────────────────────────────────────

export const UpdateApexClassSchema = z.object({
  className: z.string().min(1).describe("Apex class API name (without .cls extension)"),
  body: z.string().min(1).describe("Full updated Apex class source code"),
  apiVersion: z.string().default("66.0").describe("API version for the class"),
}).strict();

export const GetApexClassSchema = z.object({
  className: z.string().min(1).describe("Apex class name to retrieve"),
}).strict();

export const GetCodeCoverageSchema = z.object({
  className: z.string().optional().describe("Apex class or trigger name to get coverage for. Omit to get all classes."),
}).strict();

// CreateVisualforcePageSchema defined in CATEGORY A section below
// CreateAuraComponentSchema defined in CATEGORY H section below

// ─── REPORTS & DASHBOARDS (v2.2.0) ───────────────────────────────────────────

const ReportFilterSchema = z.object({
  field: z.string().describe("Field API name, e.g. 'ACCOUNT_NAME'"),
  operator: z.enum(["equals","notEqual","lessThan","greaterThan","lessOrEqual","greaterOrEqual","contains","notContain","startsWith","includes","excludes"]).describe("Filter operator"),
  value: z.string().describe("Filter value"),
});

export const CreateReportSchema = z.object({
  reportName: z.string().min(1).max(80).regex(/^[A-Za-z][A-Za-z0-9_]*$/).describe("Report API name"),
  label: z.string().min(1).describe("Report display name"),
  reportType: z.string().min(1).describe("Report type API name, e.g. 'Account', 'Opportunity', 'AccountList'"),
  format: z.enum(["Tabular","Summary","Matrix","Joined"]).default("Tabular").describe("Report format"),
  groupByField: z.string().optional().describe("Field to group by (Summary/Matrix formats)"),
  columns: z.array(z.string()).min(1).describe("Field API names to include as columns, e.g. ['ACCOUNT_NAME', 'ANNUAL_REVENUE']"),
  filters: z.array(ReportFilterSchema).optional().describe("Report filters"),
  description: z.string().optional().describe("Report description"),
  folderName: z.string().optional().describe("Folder API name for the report"),
}).strict();

export const UpdateDashboardSchema = z.object({
  dashboardName: z.string().min(1).describe("Dashboard API name"),
  componentsToAdd: z.array(z.object({
    reportName: z.string().describe("Report API name to add as component"),
    chartType: z.enum(["Donut","Bar","Line","Column","Table","Metric","Gauge","HorizontalBar","Funnel"]).default("Table").describe("Chart type"),
    title: z.string().describe("Component title"),
    row: z.number().int().default(0).describe("Row position (0-based)"),
    column: z.number().int().default(0).describe("Column position (0-based)"),
  })).optional().describe("Dashboard components to add"),
  componentsToRemove: z.array(z.string()).optional().describe("Component titles to remove"),
  label: z.string().optional().describe("New dashboard title/label"),
  runningUser: z.string().optional().describe("Username to run dashboard as"),
}).strict();

export const CreateReportFolderSchema = z.object({
  folderName: z.string().min(1).max(80).regex(/^[A-Za-z][A-Za-z0-9_]*$/).describe("Folder API name"),
  label: z.string().min(1).describe("Folder display name"),
  folderType: z.enum(["Report","Dashboard"]).default("Report").describe("Whether this is a report or dashboard folder"),
  accessType: z.enum(["Hidden","Shared","Public"]).default("Shared").describe("Folder access type"),
}).strict();

export const ShareReportFolderSchema = z.object({
  folderName: z.string().min(1).describe("Folder API name to share"),
  folderType: z.enum(["Report","Dashboard"]).default("Report").describe("Whether this is a report or dashboard folder"),
  accessLevel: z.string().optional().describe("Access level shorthand: View, Edit, Manage"),
  shareWith: z.preprocess(
    (v) => typeof v === 'string' ? [{ type: "Group", name: v, accessLevel: "View" }] : v,
    z.array(z.object({
      type: z.enum(["Role","Group","User","RoleAndSubordinates"]).describe("Sharing target type"),
      name: z.string().describe("API name/username of the role, group, or user"),
      accessLevel: z.enum(["View","Edit","Manage"]).default("View").describe("Access level"),
    })).min(1)
  ).describe("Who to share the folder with"),
}).strict();

// ─── USERS & DATA (v2.2.0) ───────────────────────────────────────────────────

export const CreateUserSchema = z.object({
  firstName: z.string().optional().describe("First name"),
  lastName: z.string().min(1).describe("Last name"),
  email: z.string().email().describe("Email address (also used for notifications)"),
  username: z.string().email().describe("Unique username (must be email format and unique across all Salesforce orgs)"),
  alias: z.string().min(1).max(8).describe("User alias (max 8 chars, shown in list views)"),
  profileName: z.string().min(1).describe("Profile name, e.g. 'Standard User', 'System Administrator'"),
  roleName: z.string().optional().describe("Role name to assign, e.g. 'CEO'"),
  timeZone: z.string().default("America/Los_Angeles").describe("Timezone, e.g. 'America/New_York'"),
  locale: z.string().default("en_US").describe("Locale, e.g. 'en_US'"),
  emailEncoding: z.string().default("UTF-8").describe("Email encoding"),
  languageLocale: z.string().default("en_US").describe("Language and locale, e.g. 'en_US'"),
}).strict();

export const UpdateUserSchema = z.object({
  username: z.string().min(1).describe("Username to identify the user to update"),
  profileName: z.string().optional().describe("New profile name"),
  roleName: z.string().optional().describe("New role name (or empty string to remove role)"),
  isActive: z.boolean().optional().describe("Activate or deactivate the user"),
  additionalFields: z.record(z.unknown()).optional().describe("Additional User SObject fields to update, e.g. {Department: 'Sales', Title: 'Manager'}"),
}).strict();

export const AssignQueueMemberSchema = z.object({
  queueDeveloperName: z.string().min(1).describe("Queue developer name (DeveloperName field on Group), e.g. 'Support_Tier1'"),
  users: z.array(z.string()).optional().describe("Usernames to add to the queue"),
  roles: z.array(z.string()).optional().describe("Role API names to add to the queue (adds all users in the role)"),
}).strict();

export const CreatePublicGroupSchema = z.object({
  groupName: z.string().min(1).max(80).describe("Group developer name (no spaces)"),
  label: z.string().min(1).describe("Group display name"),
  members: z.array(z.object({
    type: z.enum(["User","Role","RoleAndSubordinates","Group"]).describe("Member type"),
    name: z.string().describe("Username, role name, or group developer name"),
  })).optional().describe("Initial group members"),
}).strict();

export const QueryRecordsSchema = z.object({
  query: z.string().min(1).describe("Full SOQL query string, e.g. 'SELECT Id, Name FROM Account WHERE Industry = \\'Technology\\' LIMIT 10'"),
  limit: z.number().int().min(1).max(2000).default(200).describe("Maximum records to return (default 200)"),
}).strict();

export const CreateRecordSchema = z.object({
  objectApiName: z.string().min(1).describe("SObject API name, e.g. 'Account', 'Contact', 'My_Object__c'"),
  fields: z.record(z.unknown()).describe("Key-value pairs of field API names to values, e.g. {Name: 'Acme', Industry: 'Technology'}"),
}).strict();

export const UpdateRecordSchema = z.object({
  objectApiName: z.string().min(1).describe("SObject API name"),
  recordId: z.string().min(15).max(18).describe("Salesforce record ID (15 or 18 chars)"),
  fields: z.record(z.unknown()).describe("Key-value pairs of field API names to update values"),
}).strict();

export const BulkImportRecordsSchema = z.object({
  objectApiName: z.string().min(1).describe("SObject API name, e.g. 'Account'"),
  operation: z.enum(["insert","upsert","update","delete"]).describe("Bulk operation type"),
  records: z.array(z.record(z.unknown())).min(1).describe("Array of record objects with field API name to value mappings"),
  externalIdField: z.string().optional().describe("External ID field for upsert operations, e.g. 'External_Id__c'"),
}).strict();

// ─── INTEGRATION (v2.2.0) ─────────────────────────────────────────────────────

export const CreateOutboundMessageSchema = z.object({
  messageName: z.string().min(1).max(80).regex(/^[A-Za-z][A-Za-z0-9_]*$/).describe("Outbound message API name"),
  label: z.string().min(1).describe("Display label"),
  objectName: z.string().min(1).describe("Object API name this message fires from, e.g. 'Account'"),
  endpointUrl: z.string().url().describe("HTTPS endpoint URL to send the SOAP message to"),
  fields: z.array(z.string()).min(1).describe("Field API names to include in the outbound message payload"),
  useCallout: z.boolean().default(false).describe("Whether to use a named credential callout"),
  integrationUser: z.string().optional().describe("Username of the integration user (defaults to current user)"),
  description: z.string().optional().describe("Description"),
}).strict();

// CreateAuthProviderSchema defined in CATEGORY E section below

// ─── DEPLOYMENT (v2.2.0) ──────────────────────────────────────────────────────

export const ValidateDeploymentSchema = z.object({
  components: z.array(ComponentRefSchema).min(1).describe("Metadata components to validate"),
  testLevel: z.enum(["NoTestRun","RunLocalTests","RunAllTestsInOrg"]).default("RunLocalTests").describe("Test level for validation"),
  runTests: z.array(z.string()).optional().describe("Specific test classes to run"),
  waitMinutes: z.number().int().min(1).max(60).default(10).describe("Max minutes to wait for validation result"),
}).strict();

export const ListMetadataSchema = z.object({
  metadataType: z.string().min(1).describe("Metadata type to list, e.g. 'ApexClass', 'Flow', 'CustomObject', 'PermissionSet'"),
}).strict();

// ─── EXPERIENCE CLOUD (v2.2.0) ────────────────────────────────────────────────

export const PublishExperienceSiteSchema = z.object({
  siteName: z.string().min(1).describe("Experience Cloud site API name"),
}).strict();

export const UpdateExperienceSiteSchema = z.object({
  siteName: z.string().min(1).describe("Experience Cloud site API name"),
  status: z.enum(["Active","Inactive","UnderConstruction"]).optional().describe("Site status"),
  description: z.string().optional().describe("Site description"),
  guestUserProfile: z.string().optional().describe("Guest user profile name"),
}).strict();

export const CreateNavigationMenuSchema = z.object({
  menuName: z.string().min(1).max(80).describe("Navigation menu API name"),
  label: z.string().min(1).describe("Menu label"),
  networkName: z.string().optional().describe("Experience site name (informational)"),
  items: z.array(z.any()).optional().describe("Alias for menuItems"),
  menuItems: z.array(z.object({
    label: z.string().describe("Menu item label"),
    type: z.enum(["SalesforceObject","ExternalUrl","NavigationalTopic","Event","MenuLabel","GlobalAction","ContentPage"]).describe("Menu item type"),
    target: z.string().optional().describe("Target: object API name, URL, topic name, or event name"),
    position: z.number().int().optional().describe("Position (1-based)"),
  })).optional().describe("Navigation menu items"),
}).strict();

export const CreateExperienceSiteMemberSchema = z.object({
  siteName: z.string().min(1).describe("Experience Cloud site API name"),
  profiles: z.array(z.string()).min(1).describe("Profile names to add as site members"),
}).strict();

export const SetExperienceSiteBrandingSchema = z.object({
  siteName: z.string().min(1).describe("Experience Cloud site API name"),
  brandingSetName: z.string().min(1).describe("API name for the BrandingSet metadata component"),
  label: z.string().optional().describe("Human-readable label for the branding set"),
  properties: z.array(z.object({
    name: z.string().min(1).describe("Branding token name, e.g. 'brandingDesignTokenPrimaryColor'"),
    value: z.string().min(1).describe("Token value, e.g. '#0070D2'"),
  })).optional().describe("Branding property name/value pairs"),
}).strict();

// ─── OMNISTUDIO (v2.3.0) ──────────────────────────────────────────────────────

const OmniCardFieldSchema = z.object({ fieldName: z.string().min(1), label: z.string().min(1), type: z.string().default("Text") });
const OmniCardActionSchema = z.object({ label: z.string().min(1), type: z.enum(["omniscript","url","flow","navigation"]).default("navigation"), target: z.string().min(1) });
const OmniCardStateConditionSchema = z.object({ field: z.string().min(1), operator: z.string().default("=="), value: z.string() });
const OmniCardStateSchema = z.object({ name: z.string().min(1), conditionType: z.enum(["ALL","ANY","CUSTOM"]).default("ALL"), conditions: z.array(OmniCardStateConditionSchema).optional() });

export const CreateFlexCardSchema = z.object({
  cardName: z.string().min(1).max(80).describe("API name of the FlexCard (OmniUiCard)"),
  label: z.string().min(1).max(255).describe("Human-readable label"),
  objectApiName: z.string().optional().describe("Primary SObject, e.g. 'Account'"),
  dataSourceType: z.enum(["SOQL","DataRaptor","Integration Procedure","Apex","None"]).default("SOQL"),
  dataSourceName: z.string().optional().describe("SOQL query, DataRaptor name, or Integration Procedure name"),
  fields: z.array(OmniCardFieldSchema).optional().describe("Fields to display on the card"),
  actions: z.array(OmniCardActionSchema).optional().describe("Card actions"),
  states: z.array(OmniCardStateSchema).optional().describe("Conditional states"),
  description: z.string().optional(),
}).strict();

export const UpdateFlexCardSchema = z.object({
  cardName: z.string().min(1).max(80).describe("API name of the FlexCard to update"),
  label: z.string().optional(),
  dataSourceType: z.enum(["SOQL","DataRaptor","Integration Procedure","Apex","None"]).optional(),
  dataSourceName: z.string().optional(),
  fields: z.array(OmniCardFieldSchema).optional(),
  actions: z.array(OmniCardActionSchema).optional(),
  states: z.array(OmniCardStateSchema).optional(),
  description: z.string().optional(),
}).strict();

export const ActivateFlexCardSchema = z.object({
  cardName: z.string().min(1).max(80).describe("API name of the FlexCard to activate"),
}).strict();

export const GetFlexCardSchema = z.object({
  cardName: z.string().min(1).max(80).describe("API name of the FlexCard to retrieve"),
}).strict();

const OmniElementSchema = z.object({
  name: z.string().min(1),
  type: z.enum(["Text","Input","Select","Radio","Checkbox","Step","Group","TypeAhead","Formula","RemoteAction","DataRaptor","IntegrationProcedure","Disclosure","Navigation","Block"]),
  label: z.string().min(1),
  properties: z.record(z.unknown()).optional().describe("Element-specific configuration properties"),
});

export const CreateOmniScriptSchema = z.object({
  scriptName: z.string().min(1).max(80).optional().describe("Ignored — fullName is derived from type_subType_language"),
  label: z.string().min(1).max(255),
  type: z.string().min(1).describe("OmniScript type, e.g. 'Account', 'Claims'"),
  subType: z.string().min(1).describe("OmniScript sub-type, e.g. 'Create', 'Edit'"),
  language: z.string().default("English").describe("Language label, default English"),
  isLwcEnabled: z.boolean().default(true).describe("Use LWC runtime (recommended for new scripts)"),
  isOmniScriptEmbeddable: z.boolean().default(false).describe("Allow embedding in OmniStudio cards"),
  elements: z.array(OmniElementSchema).optional().describe("Script elements; complex structures are set via the OmniScript designer"),
  description: z.string().optional(),
}).strict();

export const UpdateOmniScriptSchema = z.object({
  type: z.string().min(1).describe("OmniScript type"),
  subType: z.string().min(1).describe("OmniScript sub-type"),
  language: z.string().default("English"),
  description: z.string().optional(),
  isLwcEnabled: z.boolean().optional(),
  isOmniScriptEmbeddable: z.boolean().optional(),
}).strict();

export const ActivateOmniScriptSchema = z.object({
  type: z.string().min(1).describe("OmniScript type"),
  subType: z.string().min(1).describe("OmniScript sub-type"),
  language: z.string().default("English"),
}).strict();

export const GetOmniScriptSchema = z.object({
  type: z.string().min(1).describe("OmniScript type"),
  subType: z.string().min(1).describe("OmniScript sub-type"),
  language: z.string().default("English"),
}).strict();

const DataRaptorFieldMappingSchema = z.object({
  sourceField: z.string().min(1).describe("Source field path, e.g. 'Account.Name' or JSONPath '$.Name'"),
  targetField: z.string().min(1).describe("Target field or JSON key"),
  dataType: z.enum(["String","Number","Boolean","Date","Object","Array"]).default("String"),
  formula: z.string().optional().describe("Optional formula or transformation expression"),
});

export const CreateDataRaptorSchema = z.object({
  dataRaptorName: z.string().min(1).max(80).describe("API name of the DataRaptor"),
  label: z.string().min(1).max(255),
  interfaceType: z.enum(["Extract","Transform","Load"]).describe("DataRaptor type: Extract reads from SF, Transform maps data, Load writes to SF"),
  objectApiName: z.string().optional().describe("Primary SObject for Extract or Load (e.g. 'Account')"),
  fields: z.array(DataRaptorFieldMappingSchema).optional().describe("Field mappings"),
  filterCriteria: z.string().optional().describe("SOQL WHERE clause for Extract, e.g. 'Id = :recordId'"),
  description: z.string().optional(),
}).strict();

export const GetDataRaptorSchema = z.object({
  dataRaptorName: z.string().min(1).max(80).describe("API name of the DataRaptor to retrieve"),
}).strict();

const IPElementSchema = z.object({
  name: z.string().min(1),
  type: z.enum(["DataRaptor","HTTPAction","Response","Loop","Conditional","SetValues","ExceptionBlock","Matrix","OmniScript","Aggregate"]),
  properties: z.record(z.unknown()).optional().describe("Element configuration (DataRaptor name, HTTP method/endpoint, etc.)"),
  inputMap: z.record(z.string()).optional().describe("Input parameter mappings {targetKey: 'sourceExpression'}"),
  outputMap: z.record(z.string()).optional().describe("Output parameter mappings {sourceKey: 'targetPath'}"),
});

export const CreateIntegrationProcedureSchema = z.object({
  procedureName: z.string().min(1).max(80).describe("Type portion of procedure key, e.g. 'Account'"),
  subType: z.string().min(1).describe("Sub-type portion, e.g. 'GetDetails' — fullName = type_subType"),
  label: z.string().min(1).max(255),
  elements: z.array(IPElementSchema).optional().describe("Procedure elements (DataRaptor, HTTP calls, conditionals)"),
  isActive: z.boolean().default(false).describe("Activate immediately after creation"),
  description: z.string().optional(),
}).strict();

export const UpdateIntegrationProcedureSchema = z.object({
  procedureName: z.string().min(1).max(80).describe("Type portion of procedure key"),
  subType: z.string().min(1),
  description: z.string().optional(),
  isActive: z.boolean().optional(),
}).strict();

export const GetIntegrationProcedureSchema = z.object({
  procedureName: z.string().min(1).max(80),
  subType: z.string().min(1),
}).strict();

export const ActivateIntegrationProcedureSchema = z.object({
  procedureName: z.string().min(1).max(80),
  subType: z.string().min(1),
}).strict();

const CalcVariableSchema = z.object({ name: z.string().min(1), dataType: z.enum(["String","Number","Boolean","Date"]).default("String") });

export const CreateCalculationMatrixSchema = z.object({
  matrixName: z.string().min(1).max(80).describe("API name of the Calculation Matrix"),
  label: z.string().min(1).max(255),
  inputVariables: z.array(CalcVariableSchema).min(1).describe("Input column definitions"),
  outputVariables: z.array(CalcVariableSchema).min(1).describe("Output column definitions"),
  rows: z.array(z.record(z.string())).optional().describe("Matrix rows: array of {inputVarName: value, ..., outputVarName: value}"),
  description: z.string().optional(),
}).strict();

const CalcStepSchema = z.object({
  name: z.string().min(1),
  type: z.enum(["Matrix","Expression","Loop","Condition"]).default("Expression"),
  matrixName: z.string().optional().describe("For Matrix steps: CalculationMatrix API name"),
  expression: z.string().optional().describe("For Expression steps: formula string"),
  inputMap: z.record(z.string()).optional(),
  outputMap: z.record(z.string()).optional(),
});

export const CreateCalculationProcedureSchema = z.object({
  procedureName: z.string().min(1).max(80).describe("API name of the Calculation Procedure"),
  label: z.string().min(1).max(255),
  steps: z.array(CalcStepSchema).optional().describe("Procedure steps"),
  description: z.string().optional(),
}).strict();

// ─── OMNICHANNEL (v2.3.0) ────────────────────────────────────────────────────

export const CreateServiceChannelSchema = z.object({
  channelName: z.string().min(1).max(80).describe("API name / DeveloperName of the Service Channel"),
  label: z.string().min(1).max(255),
  channelType: z.enum(["Case","Chat","Messaging","Voice","Email","SocialPost","Custom","Standard"]).default("Case"),
  relatedObjectApiName: z.string().optional().describe("SObject routed via this channel, default 'Case'"),
  capacity: z.number().int().min(1).max(100).default(1).describe("Capacity weight for this channel"),
  relatedObject: z.string().optional().describe("Alias for relatedObjectApiName"),
}).strict();

export const CreateRoutingConfigurationSchema = z.object({
  configName: z.string().optional().describe("API name of the RoutingConfiguration"),
  routingConfigName: z.string().optional().describe("Alias for configName"),
  routingPriority: z.number().int().optional().describe("Alias for priority"),
  label: z.string().min(1).max(255),
  routingModel: z.enum(["LeastActive","MostAvailable","ExternalRouting"]).default("LeastActive"),
  capacity: z.number().min(0).max(100).default(100).describe("Capacity percentage or item count"),
  priority: z.number().int().min(1).default(1).describe("Routing priority (lower number = higher priority)"),
  unitType: z.enum(["Percentage","Items"]).default("Percentage"),
  pushTimeout: z.number().int().min(0).optional().describe("Seconds before push routing times out (0 = no timeout)"),
  description: z.string().optional(),
}).strict();

export const CreateQueueRoutingConfigSchema = z.object({
  queueDeveloperName: z.string().min(1).max(80).describe("DeveloperName of the existing queue"),
  routingConfigName: z.string().min(1).max(80).describe("API name of the RoutingConfiguration to link"),
}).strict();

export const CreatePresenceConfigurationSchema = z.object({
  configName: z.string().min(1).max(80).describe("API name of the PresenceUserConfig"),
  label: z.string().min(1).max(255),
  capacity: z.number().int().min(1).max(100).default(10).describe("Maximum concurrent work items per agent"),
  serviceChannels: z.array(z.union([
    z.string().transform((s) => ({ channelName: s })),
    z.object({ channelName: z.string().min(1), capacity: z.number().int().min(1).optional() }),
  ])).optional(),
  allowAgentsToChangeStatus: z.boolean().default(true),
  description: z.string().optional(),
}).strict();

export const CreatePresenceStatusSchema = z.object({
  statusName: z.string().min(1).max(80).describe("API name / DeveloperName of the Presence Status"),
  label: z.string().min(1).max(255),
  statusType: z.enum(["Online","Busy","Offline"]).default("Online"),
  serviceChannels: z.array(z.string()).optional().describe("ServiceChannel API names to associate"),
}).strict();

export const AssignPresenceStatusSchema = z.object({
  statusName: z.string().min(1).max(80).describe("API name of the ServicePresenceStatus"),
  profiles: z.array(z.string()).optional().describe("Profile API names to grant access"),
  permissionSets: z.array(z.string()).optional().describe("Permission Set API names to grant access"),
}).strict();

export const CreateSkillSchema = z.object({
  skillName: z.string().min(1).max(80).describe("DeveloperName / API name of the skill"),
  label: z.string().min(1).max(255),
  description: z.string().optional(),
}).strict();

export const AssignSkillToAgentSchema = z.object({
  skillName: z.string().min(1).max(80).describe("Skill DeveloperName"),
  username: z.string().min(1).describe("Salesforce username of the service agent"),
  skillLevel: z.number().min(0).max(10).default(5).describe("Proficiency level 0 (novice) to 10 (expert)"),
}).strict();

export const CreateServiceTerritorySchema = z.object({
  territoryName: z.string().min(1).max(80).describe("Name of the Service Territory"),
  label: z.string().min(1).max(255),
  isActive: z.boolean().default(true),
  operatingHoursName: z.string().optional().describe("Name of the OperatingHours record to link"),
  street: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  country: z.string().optional(),
  postalCode: z.string().optional(),
}).strict();

export const CreateWorkTypeSchema = z.object({
  workTypeName: z.string().min(1).max(80).describe("Name of the Work Type"),
  label: z.string().min(1).max(255).describe("Display label (used as Name field)"),
  estimatedDuration: z.number().min(1).describe("Estimated work duration value"),
  durationType: z.enum(["Minutes","Hours"]).default("Minutes"),
  blockTimeBeforeWork: z.number().min(0).default(0).describe("Buffer time before work in minutes"),
  blockTimeAfterWork: z.number().min(0).default(0).describe("Buffer time after work in minutes"),
  skillRequirements: z.array(z.string()).optional().describe("Required Skill DeveloperNames"),
  description: z.string().optional(),
}).strict();

export const CreateMessagingChannelSchema = z.object({
  channelName: z.string().min(1).max(80).describe("API name / MasterLabel for the Messaging Channel"),
  label: z.string().min(1).max(255),
  channelType: z.enum(["SMS","WhatsApp","Facebook","AppleMessages","GoogleBusinessMessages","LINE","Voice","EmbeddedMessaging"]),
  phoneNumber: z.string().optional().describe("Phone number for SMS/WhatsApp channels"),
  pageId: z.string().optional().describe("Facebook Page ID for Facebook Messenger"),
  routingType: z.enum(["Queue","Bot","None"]).default("Queue"),
  queueName: z.string().optional().describe("Queue DeveloperName to route work items to"),
  botName: z.string().optional().describe("Bot API name for bot-first routing"),
  description: z.string().optional(),
}).strict();

export const CreateChatButtonSchema = z.object({
  buttonName: z.string().min(1).max(80).describe("API name / DeveloperName of the chat button"),
  label: z.string().min(1).max(255),
  routingType: z.enum(["Queue","Bot"]).default("Queue"),
  queueName: z.string().optional().describe("Queue DeveloperName for queue-based routing"),
  botName: z.string().optional().describe("Bot name for bot-first routing"),
  windowLanguage: z.string().default("en").describe("Chat window language code, e.g. 'en', 'fr', 'de'"),
  inviteRenderer: z.string().optional().describe("Custom invite Visualforce page/LWC component name"),
  customAgentName: z.string().optional().describe("Agent display name shown in chat window"),
  optionsHasTimeoutAlert: z.boolean().default(false),
  description: z.string().optional(),
}).strict();

export const CreateEmbeddedServiceSchema = z.object({
  deploymentName: z.string().optional().describe("API name of the Embedded Service deployment"),
  serviceName: z.string().optional().describe("Alias for deploymentName"),
  label: z.string().min(1).max(255),
  site: z.string().min(1).describe("Experience Cloud site name or 'none' for non-community deployment"),
  channelType: z.enum(["LiveAgent","MessagingChannel","EmbeddedMessaging"]).default("LiveAgent"),
  chatButtonName: z.string().optional().describe("LiveChatButton API name (for LiveAgent)"),
  messagingChannelName: z.string().optional().describe("MessagingChannel API name (for MessagingChannel)"),
  primaryColor: z.string().optional().describe("Primary brand color hex, e.g. '#0070D2'"),
  secondaryColor: z.string().optional().describe("Secondary color hex"),
  fontName: z.string().optional().describe("Font family name, e.g. 'Salesforce Sans'"),
  description: z.string().optional(),
}).strict();

export const CreateBotRoutingSchema = z.object({
  botName: z.string().min(1).max(80).describe("Einstein Bot API name (DeveloperName of the BotVersion parent)"),
  transferToQueueName: z.string().min(1).describe("Queue DeveloperName to transfer conversation to"),
  transferMessage: z.string().optional().describe("Message shown to customer when transferring to agent"),
  escalationConditions: z.array(z.object({
    trigger: z.enum(["agentRequested","unrecognized","maxErrorCount","custom"]).describe("Trigger condition for escalation"),
    action: z.enum(["TransferToQueue","EndChat","SetVariable"]).default("TransferToQueue"),
  })).optional().describe("Conditions that trigger transfer to human agent"),
}).strict();

// ─── v2.4.0 — NEW TOOLS ──────────────────────────────────────────────────────

export const CreateLightningAppPageSchema = z.object({
  pageName: z.string().min(1).max(80).regex(/^[A-Za-z][A-Za-z0-9_]*$/).describe("FlexiPage API name"),
  label: z.string().min(1).describe("Page display label"),
  template: z.string().default("AppDefaultTemplate").describe("Page template, e.g. AppDefaultTemplate, OneRegion, TwoColumn_LeftSidebar"),
  components: z.array(FlexiComponentSchema).optional().describe("Components to add to the page"),
  description: z.string().optional().describe("Page description"),
}).strict();

export const DeleteRecordSchema = z.object({
  objectApiName: z.string().min(1).describe("SObject API name, e.g. 'Account'"),
  recordId: z.string().min(15).max(18).describe("15 or 18 character Salesforce record ID"),
}).strict();

export const GetSetupAuditTrailSchema = z.object({
  startDate: z.string().optional().describe("Start date in ISO format, e.g. '2025-01-01'"),
  endDate: z.string().optional().describe("End date in ISO format, e.g. '2025-12-31'"),
  createdByUsername: z.string().optional().describe("Filter by the username who made the change"),
  section: z.string().optional().describe("Filter by section, e.g. 'Custom Fields', 'Profiles', 'Flows', 'Apex Classes'"),
  limit: z.number().int().min(1).max(2000).default(100).describe("Maximum records to return"),
}).strict();

export const GetLoginHistorySchema = z.object({
  startDate: z.string().optional().describe("Start date in ISO format, e.g. '2025-01-01'"),
  endDate: z.string().optional().describe("End date in ISO format, e.g. '2025-12-31'"),
  username: z.string().optional().describe("Filter by Salesforce username"),
  status: z.string().optional().describe("Filter by login status, e.g. 'Success', 'Failed'"),
  limit: z.number().int().min(1).max(2000).default(100).describe("Maximum records to return"),
}).strict();

export const GetEventLogsSchema = z.object({
  eventType: z.string().describe("Event type, e.g. 'Login', 'API', 'Report', 'Flow', 'ApexExecution', 'LightningPageView', 'RestApi'"),
  startDate: z.string().optional().describe("Start date in ISO format, e.g. '2025-01-01'"),
  endDate: z.string().optional().describe("End date in ISO format, e.g. '2025-12-31'"),
  limit: z.number().int().min(1).max(50).default(10).describe("Maximum log files to fetch"),
}).strict();

export const GetFieldHistorySchema = z.object({
  objectApiName: z.string().min(1).describe("Object API name, e.g. 'Account', 'Case', 'Opportunity'"),
  recordId: z.string().min(15).describe("Record ID to fetch history for (15 or 18 characters)"),
  fields: z.array(z.string()).optional().describe("Optional field names to filter — returns all tracked fields if omitted"),
  limit: z.number().int().min(1).max(500).default(100).describe("Maximum history records to return"),
}).strict();

export const CompareOrgsSchema = z.object({
  sourceAlias: z.string().optional().describe("SF CLI alias for the source org (run: sf org list to see aliases)"),
  targetAlias: z.string().optional().describe("SF CLI alias for the target org"),
  metadataType: z.string().optional().describe("Single metadata type to compare"),
  limit: z.number().int().optional().describe("Maximum results to return"),
  metadataTypes: z.array(z.string()).default(["ApexClass","Flow","CustomObject","PermissionSet","LightningComponentBundle"]).describe("Metadata types to compare"),
}).strict();

export const CreateCertificateSchema = z.object({
  certName: z.string().min(1).max(80).regex(/^[A-Za-z][A-Za-z0-9_]*$/).describe("Certificate API name"),
  label: z.string().min(1).describe("Certificate display label"),
  keySize: z.preprocess(
    (v) => typeof v === 'number' ? String(v) : v,
    z.enum(["2048","4096"]).default("2048")
  ).describe("Key size in bits: 2048 or 4096 (number or string)"),
  expirationDate: z.string().optional().describe("Expiration date in ISO format, e.g. '2030-01-01'"),
  privateKeyExportable: z.boolean().default(false).describe("Whether the private key can be exported"),
}).strict();

export const CreateEventRelaySchema = z.object({
  relayName: z.string().min(1).max(80).regex(/^[A-Za-z][A-Za-z0-9_]*$/).describe("Event relay API name"),
  label: z.string().optional().describe("Display label"),
  eventChannel: z.string().optional().describe("Platform event or CDC channel API name, e.g. 'My_Event__e' or 'AccountChangeEvent'"),
  platformEventName: z.string().optional().describe("Alias for eventChannel"),
  relayChannel: z.string().optional().describe("Channel name for relay"),
  destinationType: z.enum(["AmazonEventBus","AmazonEventBridge","EventBus"]).optional().describe("Destination type for the relay"),
  destinationResourceName: z.string().optional().describe("ARN or event bus name for the destination"),
  state: z.enum(["RUN","STOP","PAUSE"]).default("RUN").describe("Initial relay state"),
  description: z.string().optional().describe("Relay description"),
}).strict();

export const CreateLetterheadSchema = z.object({
  letterheadName: z.string().min(1).max(80).regex(/^[A-Za-z][A-Za-z0-9_]*$/).describe("Letterhead API name"),
  label: z.string().min(1).describe("Letterhead display name"),
  headerColor: z.string().default("#0070D2").describe("Header background color (hex)"),
  headerFontColor: z.string().default("#FFFFFF").describe("Header text color"),
  bodyColor: z.string().default("#FFFFFF").describe("Body background color"),
  footerColor: z.string().default("#404040").describe("Footer background color"),
  footerFontColor: z.string().default("#FFFFFF").describe("Footer text color"),
  fontName: z.string().default("Arial").describe("Font name, e.g. 'Arial', 'Helvetica', 'Times New Roman'"),
  fontSize: z.number().int().default(12).describe("Font size in points"),
  footerText: z.string().optional().describe("Footer text content"),
  topLineColor: z.string().default("#0070D2").describe("Top separator line color"),
  bottomLineColor: z.string().default("#0070D2").describe("Bottom separator line color"),
  backgroundColor: z.string().optional().describe("Alias for bodyColor"),
}).strict();

export const SendEmailSchema = z.object({
  toAddresses: z.array(z.string()).min(1).describe("Recipient email addresses"),
  subject: z.string().min(1).describe("Email subject line"),
  body: z.string().optional().describe("Plain text email body"),
  htmlBody: z.string().optional().describe("HTML email body (takes precedence over body)"),
  templateName: z.string().optional().describe("Email template API name (uses template instead of body)"),
  whatId: z.string().optional().describe("Related record ID (e.g. Opportunity or Case ID)"),
  whoId: z.string().optional().describe("Contact or Lead ID"),
  saveAsActivity: z.boolean().default(true).describe("Save email as an Activity record"),
  useSignature: z.boolean().default(false).describe("Append running user's email signature"),
  ccAddresses: z.array(z.string()).optional().describe("CC email addresses"),
}).strict();

export const CreateEinsteinPredictionSchema = z.object({
  predictionName: z.string().min(1).max(80).regex(/^[A-Za-z][A-Za-z0-9_]*$/).describe("Prediction API name"),
  label: z.string().min(1).describe("Prediction display label"),
  objectApiName: z.string().optional().describe("Salesforce object to run predictions on, e.g. 'Opportunity'"),
  objectName: z.string().optional().describe("Alias for objectApiName"),
  predictionType: z.preprocess(
    (v) => v === 'Classification' ? 'BinaryClassification' : v,
    z.enum(["BinaryClassification","Regression","Classification"])
  ).describe("BinaryClassification/Classification for yes/no, Regression for numeric"),
  targetField: z.string().min(1).describe("Field API name to predict"),
  positiveLabel: z.string().default("Yes").describe("Label for positive outcome (BinaryClassification only)"),
  negativeLabel: z.string().default("No").describe("Label for negative outcome (BinaryClassification only)"),
  pushbackField: z.string().optional().describe("Field to write the prediction score to, e.g. 'Win_Score__c'"),
  description: z.string().optional().describe("Prediction description"),
}).strict();

export const CreateNextBestActionSchema = z.object({
  strategyName: z.string().min(1).max(80).regex(/^[A-Za-z][A-Za-z0-9_]*$/).describe("Strategy API name"),
  label: z.string().min(1).describe("Strategy display label"),
  contextObjectApiName: z.string().optional().describe("Object that provides context, e.g. 'Account', 'Case'"),
  recommendations: z.array(z.object({
    name: z.string().min(1).describe("Recommendation developer name"),
    label: z.string().min(1).describe("Label shown to users"),
    acceptanceLabel: z.string().default("Accept").describe("Accept button label"),
    rejectionLabel: z.string().default("Decline").describe("Reject button label"),
    actionReference: z.string().optional().describe("Flow API name to execute on acceptance"),
  })).optional().describe("Recommendation definitions"),
  description: z.string().optional().describe("Strategy description"),
}).strict();

export const CreateEinsteinBotSchema = z.object({
  botName: z.string().min(1).max(40).regex(/^[A-Za-z][A-Za-z0-9_]*$/).describe("Bot API name"),
  label: z.string().min(1).describe("Bot display label"),
  defaultLocale: z.string().default("en_US").describe("Default language/locale, e.g. 'en_US', 'fr', 'de'"),
  description: z.string().optional().describe("Bot description"),
  dialogs: z.array(z.object({
    name: z.string().min(1).describe("Dialog developer name"),
    label: z.string().min(1).describe("Dialog display label"),
    type: z.enum(["Main","System","Rule"]).default("Main").describe("Dialog type"),
    isGoalStep: z.boolean().default(false).describe("Whether this dialog represents goal completion"),
    utterances: z.array(z.string()).optional().describe("Training utterances that trigger this dialog"),
    messages: z.array(z.string()).optional().describe("Bot messages to show"),
  })).optional().describe("Bot dialogs"),
}).strict();

// ─── v2.5.0 — NEW TOOLS ──────────────────────────────────────────────────────

export const CreateUserRoleHierarchySchema = z.object({
  roleName: z.string().min(1).max(80).regex(/^[A-Za-z][A-Za-z0-9_]*$/).describe("Role API name"),
  label: z.string().min(1).describe("Role display label"),
  parentRoleName: z.string().optional().describe("Parent role API name (omit for top-level)"),
  caseAccessLevel: z.enum(["None","Read","Edit","ReadWrite"]).default("ReadWrite").describe("Case access for subordinates"),
  contactAccessLevel: z.enum(["None","Read","Edit","ReadWrite"]).default("ReadWrite").describe("Contact access for subordinates"),
  opportunityAccessLevel: z.enum(["None","Read","Edit","ReadWrite"]).default("ReadWrite").describe("Opportunity access for subordinates"),
  accountAccessLevel: z.enum(["None","Read","Edit","ReadWrite"]).default("ReadWrite").describe("Account access for subordinates"),
  mayForecastManagerShare: z.boolean().default(true).describe("Grant manager forecast sharing"),
  description: z.string().optional().describe("Role description"),
}).strict();

export const ResetUserPasswordSchema = z.object({
  username: z.string().min(1).describe("Salesforce username of the user to reset"),
  sendEmail: z.boolean().default(true).describe("Send password reset email to the user"),
}).strict();

export const FreezeUserSchema = z.object({
  username: z.string().min(1).describe("Salesforce username to freeze or unfreeze"),
  freeze: z.boolean().describe("true to freeze, false to unfreeze"),
}).strict();

export const CreateETMTerritorySchema = z.object({
  territoryName: z.string().min(1).max(80).regex(/^[A-Za-z][A-Za-z0-9_]*$/).describe("Territory API name"),
  label: z.string().min(1).describe("Territory display label"),
  territoryType: z.string().optional().describe("Territory2Type API name (must exist in org)"),
  parentTerritoryName: z.union([z.string(), z.null()]).optional().describe("Parent territory name for hierarchy"),
  accountAccessLevel: z.enum(["View","Edit","All","None"]).default("View").describe("Account access for territory members"),
  opportunityAccessLevel: z.enum(["View","Edit","All","None"]).default("View").describe("Opportunity access"),
  caseAccessLevel: z.enum(["View","Edit","All","None"]).default("View").describe("Case access"),
  description: z.string().optional().describe("Territory description"),
}).strict();

export const AssignTerritoryToUserSchema = z.object({
  territoryName: z.string().min(1).describe("Territory API name to assign user to"),
  username: z.string().min(1).describe("Salesforce username to assign"),
  roleInTerritory: z.enum(["Salesperson","AccountManager","Owner"]).default("Salesperson").describe("User role within the territory"),
}).strict();

export const CreateForecastHierarchySchema = z.object({
  forecastingType: z.enum(["OpportunityRevenue","OpportunityQuantity","OverlayRevenue","OverlayQuantity","ProductFamily"]).default("OpportunityRevenue").describe("Forecasting type"),
  roleName: z.string().optional().describe("Role name (informational)"),
  displayCurrency: z.string().default("USD").describe("Currency code for display (e.g. 'USD', 'EUR')"),
  isActive: z.boolean().default(true).describe("Enable this forecasting type"),
}).strict();

export const DeleteCustomObjectSchema = z.object({
  objectApiName: z.string().min(1).describe("Custom object API name to delete (e.g. 'MyObject__c')"),
  confirmDelete: z.boolean().describe("Must be true to confirm deletion — this is permanent and deletes all data"),
}).strict();

export const DeleteCustomFieldSchema = z.object({
  objectApiName: z.string().min(1).describe("Object API name containing the field"),
  fieldApiName: z.string().min(1).describe("Field API name to delete (e.g. 'MyField__c')"),
  confirmDelete: z.boolean().describe("Must be true to confirm deletion — this is permanent"),
}).strict();

export const CreateRollupSummaryFieldSchema = z.object({
  objectApiName: z.string().optional().describe("Master object API name to add the rollup field to"),
  objectName: z.string().optional().describe("Alias for objectApiName"),
  fieldName: z.string().min(1).max(40).regex(/^[A-Za-z][A-Za-z0-9_]*$/).describe("Field API name (without __c)"),
  label: z.string().min(1).describe("Field display label"),
  summaryObject: z.string().min(1).describe("Child (detail) object API name, e.g. 'Opportunity'"),
  summaryType: z.enum(["COUNT","SUM","MIN","MAX"]).optional().describe("Aggregation type"),
  summaryOperation: z.enum(["COUNT","SUM","MIN","MAX"]).optional().describe("Alias for summaryType"),
  relationshipField: z.string().optional().describe("Relationship field on child object"),
  aggregatedField: z.string().optional().describe("Child field to aggregate (required for SUM/MIN/MAX, e.g. 'Amount')"),
  filterCriteria: z.union([
    z.string(),
    z.array(z.object({
      field: z.string().describe("Child field API name"),
      operator: z.enum(["equals","notEqual","lessThan","greaterThan","lessOrEqual","greaterOrEqual","contains","notContain","startsWith"]).describe("Filter operator"),
      value: z.string().describe("Filter value"),
    })),
  ]).optional().describe("Filter criteria: string SOQL-like expression or array of {field,operator,value} objects"),
  description: z.string().optional().describe("Field description"),
}).strict();

export const CreateExternalIdFieldSchema = z.object({
  objectApiName: z.string().min(1).describe("Object API name to add the field to"),
  fieldName: z.string().min(1).max(40).regex(/^[A-Za-z][A-Za-z0-9_]*$/).describe("Field API name (without __c)"),
  label: z.string().min(1).describe("Field display label"),
  fieldType: z.enum(["Text","Number","Email","AutoNumber"]).default("Text").describe("Field data type"),
  isUnique: z.boolean().default(true).describe("Enforce unique values"),
  isCaseSensitive: z.boolean().default(false).describe("Case-sensitive uniqueness enforcement (Text only)"),
  length: z.number().int().default(80).describe("Field length (Text fields only)"),
  description: z.string().optional().describe("Field description"),
}).strict();

export const EnableObjectFeaturesSchema = z.object({
  objectApiName: z.string().min(1).describe("Custom object API name"),
  enableHistory: z.boolean().optional().describe("Enable field history tracking"),
  enableFeeds: z.boolean().optional().describe("Enable Chatter feeds on records"),
  enableSearch: z.boolean().optional().describe("Allow records to appear in search results"),
  enableReports: z.boolean().optional().describe("Allow this object to be used in reports"),
  enableActivities: z.boolean().optional().describe("Enable activities (tasks and events) on records"),
  enableBulkApi: z.boolean().optional().describe("Enable Bulk API access"),
}).strict();

export const UpdateFlowSchema = z.object({
  flowApiName: z.string().min(1).describe("Flow API name to update"),
  newLabel: z.string().optional().describe("New display label for the flow"),
  newDescription: z.string().optional().describe("New description for the flow"),
  variablesToAdd: z.array(z.object({
    name: z.string().min(1).describe("Variable API name"),
    dataType: z.enum(["String","Number","Currency","Boolean","Date","DateTime","SObject","Apex","Multipicklist","Picklist"]).describe("Variable data type"),
    isInput: z.boolean().default(false).describe("Available for input"),
    isOutput: z.boolean().default(false).describe("Available for output"),
    objectType: z.string().optional().describe("SObject API name (for SObject dataType)"),
    defaultValue: z.string().optional().describe("Default value expression"),
  })).optional().describe("Variables to add to the flow"),
  label: z.string().optional().describe("Alias for newLabel"),
  description: z.string().optional().describe("Alias for newDescription"),
}).strict();

export const CloneFlowSchema = z.object({
  sourceFlowApiName: z.string().optional().describe("Source flow API name to clone"),
  sourceFlowName: z.string().optional().describe("Alias for sourceFlowApiName"),
  newFlowApiName: z.string().optional().describe("New flow API name"),
  newFlowName: z.string().optional().describe("Alias for newFlowApiName"),
  newLabel: z.string().optional().describe("New flow display label"),
  activateImmediately: z.boolean().default(false).describe("Activate the cloned flow immediately"),
}).strict();

export const CreateFlowTestSchema = z.object({
  flowApiName: z.string().min(1).describe("Flow API name to test"),
  testName: z.string().min(1).max(80).regex(/^[A-Za-z][A-Za-z0-9_]*$/).describe("Test definition API name"),
  label: z.string().optional().describe("Test display label"),
  description: z.string().optional().describe("Test description"),
  inputs: z.array(z.object({
    name: z.string().describe("Variable name"),
    value: z.string().describe("Input value (as string)"),
  })).optional().describe("Input variable values for the test"),
  expectedOutputs: z.array(z.object({
    name: z.string().describe("Variable name"),
    expectedValue: z.string().describe("Expected output value"),
  })).optional().describe("Expected output assertions"),
}).strict();

export const CreateInvocableActionSchema = z.object({
  actionName: z.string().min(1).max(40).regex(/^[A-Za-z][A-Za-z0-9_]*$/).describe("Apex class name for the action"),
  label: z.string().min(1).describe("Action display label"),
  apexMethodName: z.string().default("execute").describe("Apex method name annotated with @InvocableMethod"),
  description: z.string().optional().describe("Action description"),
  inputs: z.array(z.object({
    name: z.string().min(1).describe("Input variable name"),
    label: z.string().min(1).describe("Input variable label"),
    dataType: z.enum(["String","Integer","Long","Double","Boolean","Date","Datetime","Id","sObject"]).describe("Data type"),
    required: z.boolean().default(false).describe("Is input required"),
    sObjectType: z.string().optional().describe("SObject API name if dataType=sObject"),
  })).default([]).describe("Input parameters"),
  outputs: z.array(z.object({
    name: z.string().min(1).describe("Output variable name"),
    label: z.string().min(1).describe("Output variable label"),
    dataType: z.enum(["String","Integer","Long","Double","Boolean","Date","Datetime","Id","sObject"]).describe("Data type"),
    sObjectType: z.string().optional().describe("SObject API name if dataType=sObject"),
  })).default([]).describe("Output parameters"),
  className: z.string().optional().describe("Apex class name (informational)"),
  method: z.string().optional().describe("Method name (informational)"),
}).strict();

export const SearchApexSchema = z.object({
  searchTerm: z.string().min(1).describe("Text to search for in Apex code"),
  searchIn: z.preprocess(
    (v) => {
      if (typeof v !== 'string') return v;
      const map: Record<string, string> = { classes: 'Classes', triggers: 'Triggers', both: 'Both', body: 'Both', all: 'Both' };
      return map[v.toLowerCase()] ?? v;
    },
    z.enum(["Classes","Triggers","Both"]).default("Both")
  ).describe("Where to search: 'Classes', 'Triggers', or 'Both' (also accepts lowercase)"),
  caseSensitive: z.boolean().default(false).describe("Case-sensitive search"),
  limit: z.number().int().default(50).describe("Maximum number of results"),
  searchType: z.string().optional().describe("Alias for searchIn: class/classes/trigger/triggers/both"),
}).strict();

export const GetApexLogsSchema = z.object({
  username: z.string().optional().describe("Filter logs by Salesforce username"),
  limit: z.number().int().min(1).max(100).default(10).describe("Maximum number of logs to return"),
  operation: z.string().optional().describe("Filter by operation name (e.g. '/apex/mypage', 'execute_anonymous_apex')"),
}).strict();

export const GetApexLogBodySchema = z.object({
  logId: z.string().min(15).max(18).describe("Apex debug log ID (from sf_get_apex_logs)"),
}).strict();

export const CreateApexBatchSchema = z.object({
  className: z.string().min(1).max(40).regex(/^[A-Za-z][A-Za-z0-9_]*$/).describe("Apex batch class name"),
  sObjectType: z.string().optional().describe("SObject type to query and process, e.g. 'Account'"),
  objectApiName: z.string().optional().describe("Alias for sObjectType"),
  queryFields: z.array(z.string()).optional().describe("Fields to include in query"),
  queryFilter: z.string().optional().describe("SOQL WHERE clause for start method, e.g. \"CreatedDate = TODAY\""),
  batchSize: z.number().int().default(200).describe("Batch size (records per execute call, 1-2000)"),
  description: z.string().optional().describe("Class description / what the batch does"),
  implementsStateful: z.boolean().default(false).describe("Implement Database.Stateful to maintain state between batches"),
  additionalCode: z.string().optional().describe("Additional Apex code to include in the execute method body"),
}).strict();

export const CreateApexSchedulerSchema = z.object({
  className: z.string().min(1).max(40).regex(/^[A-Za-z][A-Za-z0-9_]*$/).describe("Apex schedulable class name"),
  jobName: z.string().optional().describe("Default schedule job name"),
  batchClass: z.string().optional().describe("Batch class to schedule (alias for batchClassName)"),
  cronExpression: z.string().default("0 0 2 * * ?").describe("Default cron expression, e.g. '0 0 2 * * ?' (daily at 2am)"),
  batchClassName: z.string().optional().describe("Batch class to execute (if this scheduler runs a batch)"),
  description: z.string().optional().describe("Class description"),
}).strict();

export const RollbackDeploymentSchema = z.object({
  deploymentId: z.string().min(15).describe("Deployment job ID to cancel or roll back"),
}).strict();

export const CreateScratchOrgSchema = z.object({
  orgAlias: z.string().min(1).regex(/^[A-Za-z0-9_-]+$/).describe("Alias for the new scratch org"),
  devHubAlias: z.string().default("DevHub").describe("SF CLI alias for the Dev Hub org"),
  duration: z.number().int().min(1).max(30).default(7).describe("Scratch org lifetime in days (1–30)"),
  features: z.array(z.string()).default([]).describe("Scratch org features, e.g. ['Communities', 'ServiceCloud']"),
  edition: z.enum(["Developer","Enterprise","Group","Professional"]).default("Developer").describe("Scratch org edition"),
  adminEmail: z.string().optional().describe("Admin email for the scratch org"),
  description: z.string().optional().describe("Description for the scratch org"),
}).strict();

// CreateSandboxSchema and RefreshSandboxSchema defined in CATEGORY F section below

export const ExportPackageXmlSchema = z.object({
  metadataTypes: z.preprocess(
    (v) => Array.isArray(v) ? v.map((item: unknown) => typeof item === 'object' && item !== null ? ((item as Record<string, unknown>).type || (item as Record<string, unknown>).name || String(item)) : item) : v,
    z.array(z.string()).default([])
  ).describe("Metadata types to include: strings or {type, name} objects. Empty = all common types."),
  includeManaged: z.boolean().default(false).describe("Include managed package components"),
  apiVersion: z.string().optional().describe("API version for the package.xml (defaults to current API_VERSION)"),
  components: z.any().optional().describe("Alias: array of {type, members} objects"),
}).strict();

export const CreateExperienceContainerSchema = z.object({
  pageName: z.string().min(1).describe("FlexiPage API name to add the container to"),
  containerName: z.string().min(1).describe("Container component name"),
  region: z.string().default("main").describe("Region to place the container in"),
  order: z.number().int().default(0).describe("Order within the region"),
  properties: z.array(z.object({ name: z.string(), value: z.string() })).optional().describe("Container component properties"),
}).strict();

export const SetExperienceSiteLoginSchema = z.object({
  siteName: z.string().min(1).describe("Experience Cloud site URL suffix or API name"),
  selfRegistrationEnabled: z.boolean().default(false).describe("Allow users to self-register"),
  selfRegistrationProfileName: z.string().optional().describe("Default profile for self-registered users"),
  forgotPasswordEnabled: z.boolean().default(true).describe("Show forgot password link"),
  loginPageType: z.enum(["Standard","Custom"]).default("Standard").describe("Standard Salesforce login or custom login page"),
  customLoginUrl: z.string().optional().describe("Custom login page URL (for Custom loginPageType)"),
}).strict();

export const CreateCmsContentSchema = z.object({
  contentName: z.string().min(1).max(255).describe("CMS content name"),
  contentType: z.preprocess(
    (v) => typeof v === 'string' ? v.charAt(0).toUpperCase() + v.slice(1).toLowerCase() : v,
    z.enum(["News","Document","Image","Custom","custom"])
  ).describe("CMS content type: 'News', 'Document', 'Image', or 'custom' (case-insensitive)"),
  language: z.string().default("en_US").describe("Content language locale, e.g. 'en_US'"),
  fields: z.union([
    z.record(z.string()),
    z.array(z.object({ name: z.string(), value: z.string() })).transform(
      (arr) => Object.fromEntries(arr.map((f) => [f.name, f.value]))
    ),
  ]).describe("Content field key-value pairs, e.g. {title: 'My Title', body: 'Content...'}"),
  channelNames: z.array(z.string()).optional().describe("Experience Cloud site names to publish content to"),
  title: z.string().optional().describe("Content title (mapped to fields.title)"),
  body: z.string().optional().describe("Content body (mapped to fields.body)"),
}).strict();

export const ExportRecordsSchema = z.object({
  query: z.string().min(1).describe("Full SOQL query string"),
  includeHeaders: z.boolean().default(true).describe("Include CSV header row"),
  limit: z.number().int().default(2000).describe("Maximum records to export"),
  format: z.string().optional().describe("Export format: json or csv"),
}).strict();

export const UpsertRecordSchema = z.object({
  objectApiName: z.string().min(1).describe("SObject API name, e.g. 'Account'"),
  externalIdField: z.string().min(1).describe("External ID field API name, e.g. 'My_External_Id__c'"),
  externalIdValue: z.string().min(1).describe("Value of the external ID to match on"),
  fields: z.record(z.unknown()).describe("Field key-value pairs to set/update"),
}).strict();

export const GetRecordSchema = z.object({
  objectApiName: z.string().min(1).describe("SObject API name, e.g. 'Account'"),
  recordId: z.string().min(15).describe("Record ID (15 or 18 characters)"),
  fields: z.array(z.string()).optional().describe("Field API names to retrieve. Empty = all available fields"),
}).strict();

export const SearchRecordsSchema = z.object({
  searchTerm: z.string().min(1).describe("Search term (SOSL FIND clause value, no quotes needed)"),
  objectTypes: z.array(z.string()).optional().describe("Alias for objects: array of object API name strings"),
  objects: z.preprocess(
    (v) => Array.isArray(v) ? v.map((item: unknown) => typeof item === 'string' ? { objectName: item, fields: ["Id","Name"] } : item) : v,
    z.array(z.object({
      objectName: z.string().describe("SObject API name"),
      fields: z.array(z.string()).describe("Fields to return"),
    })).default([{ objectName: "Account", fields: ["Id","Name"] }, { objectName: "Contact", fields: ["Id","Name","Email"] }])
  ).describe("Objects to search across: strings or {objectName, fields} objects"),
  limit: z.number().int().default(20).describe("Maximum results per object"),
}).strict();

export const CreatePlatformEventSubscriptionSchema = z.object({
  eventApiName: z.string().optional().describe("Platform event API name, e.g. 'My_Event__e'"),
  platformEventName: z.string().optional().describe("Alias for eventApiName"),
  subscriptionType: z.enum(["Trigger","Flow"]).default("Flow").describe("Subscribe via Apex trigger or Flow"),
  subscriberName: z.string().optional().describe("API name of the trigger or flow to create/reference"),
  subscriberFlowName: z.string().optional().describe("Alias for subscriberName"),
  description: z.string().optional().describe("Description"),
  apexCode: z.string().optional().describe("Apex trigger body (for Trigger type). Auto-generated if omitted."),
}).strict();

export const CreateChangedDataCaptureSchema = z.object({
  objectApiName: z.string().optional().describe("Object API name to enable CDC for, e.g. 'Account', 'Contact', 'My_Object__c'"),
  objectName: z.string().optional().describe("Alias for objectApiName"),
  enabled: z.boolean().default(true).describe("Enable or disable CDC for this object"),
}).strict();

export const CreateRestResourceSchema = z.object({
  resourceName: z.string().optional().describe("Apex class name for the REST resource"),
  className: z.string().optional().describe("Alias for resourceName"),
  urlMapping: z.string().min(1).describe("URL mapping, e.g. '/myresource/*' or '/accounts/:id'"),
  description: z.string().optional().describe("Resource description"),
  methods: z.array(z.union([
    z.string().transform((s) => ({ httpMethod: s })),
    z.object({
      httpMethod: z.enum(["GET","POST","PUT","DELETE","PATCH"]).describe("HTTP method"),
      description: z.string().optional().describe("Method description"),
      apexCode: z.string().optional().describe("Method body code (returns empty implementation if omitted)"),
    }),
  ])).min(1).describe("HTTP methods to implement (array of method names or {httpMethod, description?, apexCode?} objects)"),
}).strict();

export const GetOrgLimitsSchema = z.object({
  filter: z.string().optional().describe("Optional filter string — return only limits whose name contains this text (e.g. 'Api', 'Storage', 'Scratch')"),
}).strict();

export const GetFlowErrorsSchema = z.object({
  flowApiName: z.string().optional().describe("Filter to a specific flow API name (optional)"),
  hoursBack: z.number().int().default(24).describe("Look back this many hours for errors"),
  limit: z.number().int().default(50).describe("Maximum error records to return"),
}).strict();

export const GetApexTestResultsSchema = z.object({
  testRunId: z.string().optional().describe("Specific test run ID (from sf_run_apex_tests). Omit to get latest run."),
  className: z.string().optional().describe("Filter to a specific Apex test class"),
  outcomeFilter: z.enum(["Pass","Fail","CompileFail","Skip","all"]).default("all").describe("Filter by outcome"),
  limit: z.number().int().min(1).max(2000).default(200).optional().describe("Maximum results to return"),
}).strict();

export const GetDeploymentHistorySchema = z.object({
  limit: z.number().int().default(10).describe("Maximum deployments to return"),
  status: z.enum(["Succeeded","Failed","Pending","InProgress","Canceling","all"]).default("all").describe("Filter by deployment status"),
}).strict();

export const CreateAgentChannelSchema = z.object({
  agentApiName: z.string().optional().describe("Agentforce agent (Bot) API name"),
  agentName: z.string().optional().describe("Alias for agentApiName"),
  channelType: z.enum(["Messaging","Chat","Embedded","Voice","Web"]).describe("Channel type to configure"),
  channelName: z.string().min(1).describe("Existing channel API name (MessagingChannel for Messaging, LiveChatButton for Chat)"),
  routingType: z.enum(["Queue","Agent","Bot"]).default("Bot").describe("Routing type — Bot routes to agent first, then escalates"),
  queueName: z.string().optional().describe("Queue name for escalation (recommended when routingType=Bot)"),
  label: z.string().optional().describe("Channel display label"),
}).strict();

export const CloneAgentSchema = z.object({
  sourceAgentApiName: z.string().optional().describe("Source agent (Bot) API name to clone"),
  sourceAgentName: z.string().optional().describe("Alias for sourceAgentApiName"),
  newAgentApiName: z.string().optional().describe("New agent API name"),
  newAgentName: z.string().optional().describe("Alias for newAgentApiName"),
  newLabel: z.string().optional().describe("New agent display label"),
  includeTopics: z.boolean().default(true).describe("Clone the agent's topics (GenAiPlugins)"),
  includeActions: z.boolean().default(true).describe("Clone the agent's actions (GenAiFunctions) — requires includeTopics=true"),
}).strict();

export const ExportAgentSchema = z.object({
  agentApiName: z.string().optional().describe("Agent (Bot) API name to export"),
  agentName: z.string().optional().describe("Alias for agentApiName"),
}).strict();

export const ExportOmniStudioComponentSchema = z.object({
  componentType: z.enum(["FlexCard","OmniScript","DataRaptor","IntegrationProcedure"]).describe("Component type to export"),
  componentName: z.string().min(1).describe("Component API name"),
  subType: z.string().optional().describe("Sub-type (required for OmniScript and IntegrationProcedure: the subType portion of the fullName)"),
  language: z.string().default("English").describe("Language (for OmniScript, e.g. 'English')"),
}).strict();

export const ImportOmniStudioComponentSchema = z.object({
  componentType: z.enum(["FlexCard","OmniScript","DataRaptor","IntegrationProcedure"]).describe("Component type to import"),
  newName: z.string().min(1).describe("New API name for the imported component (must differ from source)"),
  jsonDefinition: z.string().min(1).describe("JSON string exported by sf_export_omnistudio_component"),
  activate: z.boolean().default(false).describe("Activate the component after import"),
}).strict();

export const CreateDocumentGenerationSchema = z.object({
  templateName: z.string().min(1).max(80).regex(/^[A-Za-z][A-Za-z0-9_]*$/).describe("Template API name"),
  label: z.string().min(1).describe("Template display label"),
  objectApiName: z.string().min(1).describe("Context object API name, e.g. 'Account'"),
  templateType: z.enum(["Word","PDF","Excel"]).default("Word").describe("Output document format"),
  dataSourceType: z.enum(["DataRaptor","IntegrationProcedure"]).default("DataRaptor").describe("Data source type"),
  dataSourceName: z.string().min(1).describe("DataRaptor or Integration Procedure API name to feed data"),
  description: z.string().optional().describe("Template description"),
}).strict();

// ─── CATEGORY 1: Basic Admin Tools ───────────────────────────────────────────

export const CreateSearchLayoutSchema = z.object({
  objectName: z.string().min(1).describe("Object API name, e.g. 'Account' or 'Invoice__c'"),
  searchResultsAdditionalFields: z.array(z.string()).optional().describe("Field API names to show in search results"),
  lookupDialogsAdditionalFields: z.array(z.string()).optional().describe("Field API names to show in lookup dialogs"),
  lookupFilterFields: z.array(z.string()).optional().describe("Field API names used as filter fields in lookup"),
});

export const AssignLayoutToRecordTypeSchema = z.object({
  objectName: z.string().min(1).describe("Object API name, e.g. 'Account' or 'Case'"),
  recordTypeName: z.string().min(1).describe("Developer name of the record type, e.g. 'Enterprise'"),
  layoutName: z.string().min(1).describe("Full name of the page layout, e.g. 'Account Layout'"),
  profileNames: z.array(z.string()).optional().describe("Profile names to assign this layout for (optional)"),
});

export const CreateCustomWebTabSchema = z.object({
  fullName: z.string().min(1).regex(/^[A-Za-z][A-Za-z0-9_]*$/).describe("Tab API name, e.g. 'My_Web_Tab'"),
  label: z.string().min(1).describe("Tab display label"),
  url: z.string().url().describe("URL the tab points to, e.g. 'https://example.com'"),
  description: z.string().optional().describe("Tab description"),
  hasSidebar: z.boolean().default(false).describe("Whether the tab shows the Salesforce sidebar"),
});

// ─── CATEGORY 2: Flows & Automation ──────────────────────────────────────────

export const CreateScheduledFlowSchema = z.object({
  fullName: z.string().min(1).max(80).regex(/^[A-Za-z][A-Za-z0-9_]*$/).describe("Flow API name, e.g. 'Nightly_Account_Update'"),
  label: z.string().min(1).describe("Flow display label"),
  objectApiName: z.string().min(1).describe("Object API name to process records from, e.g. 'Account'"),
  scheduledPaths: z.array(z.object({
    label: z.string().min(1).describe("Path label"),
    offsetNumber: z.number().int().describe("Offset number (positive or negative)"),
    offsetUnit: z.enum(["Hours","Days","Months"]).describe("Unit for the offset"),
    timeSource: z.string().describe("Time source field or 'SystemTime'"),
    connectorTarget: z.string().optional().describe("Name of the first flow element to execute on this path (e.g. an Assignment or Action element name)"),
  })).min(1).describe("Scheduled path definitions"),
  description: z.string().optional().describe("Flow description"),
});

export const CreatePlatformEventTriggerSchema = z.object({
  triggerName: z.string().min(1).max(255).describe("Apex trigger name, e.g. 'HandleMyEvent'"),
  eventApiName: z.string().min(1).describe("Platform event API name, e.g. 'MyEvent__e'"),
  body: z.string().min(1).describe("Apex trigger body code"),
  apiVersion: z.string().default("66.0").describe("API version, e.g. '62.0'"),
});

export const CreateWorkflowRuleSchema = z.object({
  objectName: z.string().min(1).describe("Object API name, e.g. 'Lead'"),
  fullName: z.string().min(1).describe("Workflow rule developer name, e.g. 'Lead_Assign_Rule'"),
  description: z.string().optional().describe("Rule description"),
  triggerType: z.enum(["onCreateOnly","onCreateOrTriggeringUpdate","onAllChanges"]).describe("When the rule evaluates"),
  active: z.boolean().default(true).describe("Whether the rule is active"),
  formula: z.string().optional().describe("Formula criteria, e.g. 'ISPICKVAL(Status, \"New\")'"),
  criteriaItems: z.array(z.object({
    field: z.string().describe("Field API name"),
    operation: z.string().describe("Operator, e.g. 'equals'"),
    value: z.string().describe("Criteria value"),
  })).optional().describe("Filter criteria items (alternative to formula)"),
});

export const CreateFieldUpdateSchema = z.object({
  objectName: z.string().min(1).describe("Object API name, e.g. 'Opportunity'"),
  fullName: z.string().min(1).describe("Field update developer name"),
  name: z.string().min(1).describe("Display name for the field update"),
  field: z.string().min(1).describe("Field API name to update, e.g. 'StageName'"),
  operation: z.enum(["Formula","Literal","LiteralBlank","Null"]).describe("Type of update operation"),
  formula: z.string().optional().describe("Formula expression (when operation=Formula)"),
  literalValue: z.string().optional().describe("Literal value to set (when operation=Literal)"),
  description: z.string().optional().describe("Description"),
});

export const CreateWorkflowOutboundMessageSchema = z.object({
  objectName: z.string().min(1).describe("Object API name, e.g. 'Opportunity'"),
  fullName: z.string().min(1).describe("Outbound message developer name"),
  name: z.string().min(1).describe("Display name"),
  endpointUrl: z.string().url().describe("SOAP endpoint URL"),
  fields: z.array(z.string()).min(1).describe("Field API names to include in the message"),
  integrationUser: z.string().optional().describe("Username of the integration user (optional)"),
  description: z.string().optional().describe("Description"),
});

// ─── CATEGORY 3: Security & Access ───────────────────────────────────────────

export const CreateRoleHierarchySchema = z.object({
  roles: z.array(z.object({
    fullName: z.string().min(1).describe("Role API name, e.g. 'VP_Sales'"),
    name: z.string().min(1).describe("Role display label"),
    parentRole: z.string().optional().describe("Parent role API name (omit for top-level)"),
    description: z.string().optional().describe("Role description"),
  })).min(1).describe("Roles to create in the hierarchy"),
});

export const CreateFieldLevelSecuritySchema = z.object({
  objectName: z.string().min(1).describe("Object API name, e.g. 'Account'"),
  fieldName: z.string().min(1).describe("Field API name, e.g. 'Revenue__c'"),
  profiles: z.array(z.object({
    profileName: z.string().min(1).describe("Profile API name, e.g. 'Standard'"),
    readable: z.boolean().describe("Whether the field is visible"),
    editable: z.boolean().describe("Whether the field is editable"),
  })).min(1).describe("Profile-level field access settings"),
});

export const CreateCustomPermissionSchema = z.object({
  fullName: z.string().min(1).regex(/^[A-Za-z][A-Za-z0-9_]*$/).describe("Custom permission API name, e.g. 'Can_Approve_Discounts'"),
  label: z.string().min(1).describe("Display label"),
  description: z.string().optional().describe("Description"),
  requiredPermissions: z.array(z.string()).optional().describe("Other custom permissions required by this one"),
});

export const CreateMutingPermSetSchema = z.object({
  fullName: z.string().min(1).regex(/^[A-Za-z][A-Za-z0-9_]*$/).describe("Muting permission set API name"),
  label: z.string().min(1).describe("Display label"),
  description: z.string().optional().describe("Description"),
});

export const CreatePermSetGroupSchema = z.object({
  fullName: z.string().min(1).regex(/^[A-Za-z][A-Za-z0-9_]*$/).describe("Permission Set Group API name"),
  label: z.string().min(1).describe("Display label"),
  description: z.string().optional().describe("Description"),
  permissionSets: z.array(z.string()).min(1).describe("API names of permission sets to include"),
});

// ─── CATEGORY 4: Data Management ─────────────────────────────────────────────

export const CreateDataCategorySchema = z.object({
  fullName: z.string().min(1).regex(/^[A-Za-z][A-Za-z0-9_]*$/).describe("Data category group API name"),
  label: z.string().min(1).describe("Group display label"),
  objectUsage: z.string().default("KnowledgeArticle").describe("Object to categorize, e.g. 'KnowledgeArticle'"),
  description: z.string().optional().describe("Group description"),
  categories: z.array(z.object({
    name: z.string().min(1).describe("Category API name"),
    label: z.string().min(1).describe("Category label"),
    subCategories: z.array(z.string()).optional().describe("Sub-category API names"),
  })).optional().describe("Top-level categories"),
});

export const BulkInsertRecordsSchema = z.object({
  objectApiName: z.string().min(1).describe("Object API name, e.g. 'Contact'"),
  records: z.array(z.record(z.unknown())).min(1).describe("Array of records to insert (field:value pairs)"),
  externalIdField: z.string().optional().describe("External ID field for upsert (omit for insert)"),
});

export const BulkUpdateRecordsSchema = z.object({
  objectApiName: z.string().min(1).describe("Object API name, e.g. 'Contact'"),
  records: z.array(z.record(z.unknown())).min(1).describe("Array of records with Id field required"),
});

export const BulkDeleteRecordsSchema = z.object({
  objectApiName: z.string().min(1).describe("Object API name, e.g. 'Lead'"),
  ids: z.array(z.string().min(15)).min(1).describe("Salesforce record IDs to delete"),
});

export const CreateExtIdFieldSchema = z.object({
  objectName: z.string().min(1).describe("Object API name, e.g. 'Account'"),
  fullName: z.string().min(1).regex(/^[A-Za-z][A-Za-z0-9_]*__c$/).describe("Field API name ending in __c"),
  label: z.string().min(1).describe("Field display label"),
  type: z.enum(["Text","Number","Email","AutoNumber"]).describe("Field data type"),
  length: z.number().int().min(1).max(255).optional().describe("Length for Text fields"),
  description: z.string().optional().describe("Field description"),
});

// ─── CATEGORY 5: Email & Communication ───────────────────────────────────────

export const CreateLetterheadSimpleSchema = z.object({
  fullName: z.string().min(1).regex(/^[A-Za-z][A-Za-z0-9_]*$/).describe("Letterhead API name"),
  name: z.string().min(1).describe("Display name"),
  description: z.string().optional().describe("Description"),
  backgroundColor: z.string().default("#FFFFFF").describe("Background color hex, e.g. '#FFFFFF'"),
  bodyColor: z.string().default("#FFFFFF").describe("Body background color hex"),
  headerColor: z.string().default("#004080").describe("Header background color hex"),
});

export const CreateNotificationTypeSchema = z.object({
  fullName: z.string().min(1).regex(/^[A-Za-z][A-Za-z0-9_]*$/).describe("Custom notification type API name"),
  masterLabel: z.string().min(1).describe("Master label"),
  description: z.string().optional().describe("Description"),
  customNotifTypeName: z.string().min(1).describe("Developer name for the notification type"),
});

// ─── CATEGORY 6 & 9: DevOps ───────────────────────────────────────────────────

export const CreateNewScratchOrgSchema = z.object({
  definitionFile: z.string().optional().describe("Path to project-scratch-def.json (optional)"),
  alias: z.string().optional().describe("Alias for the scratch org"),
  duration: z.number().int().min(1).max(30).optional().describe("Scratch org duration in days (1-30)"),
  devHubAlias: z.string().optional().describe("Dev Hub org alias"),
});

export const DeleteScratchOrgSchema = z.object({
  alias: z.string().min(1).describe("Alias of the scratch org to delete"),
  noPrompt: z.boolean().default(true).describe("Skip confirmation prompt"),
});

export const CreatePackageSchema = z.object({
  name: z.string().min(1).describe("Package name"),
  packageType: z.enum(["Managed","Unlocked"]).describe("Package type: Managed or Unlocked"),
  path: z.string().min(1).describe("Path to package source, e.g. 'force-app'"),
  description: z.string().optional().describe("Package description"),
  noNamespace: z.boolean().default(false).describe("Create without a namespace (Unlocked only)"),
});

export const CreatePackageVersionSchema = z.object({
  packageId: z.string().min(1).describe("Package ID (0Ho...) or package alias"),
  installationKey: z.string().optional().describe("Installation key for the package version"),
  codeVersion: z.string().optional().describe("Version number, e.g. '1.0.0.NEXT'"),
  wait: z.number().int().min(1).optional().describe("Minutes to wait for version creation"),
});

export const InstallPackageSchema = z.object({
  packageId: z.string().min(1).describe("Package version ID (04t...) or alias to install"),
  targetOrg: z.string().optional().describe("Target org alias (defaults to SF_ALIAS env var)"),
  installationKey: z.string().optional().describe("Installation key if package is protected"),
  wait: z.number().int().min(1).optional().describe("Minutes to wait for installation"),
});

export const DevOpsCreateWorkItemSchema = z.object({
  name: z.string().min(1).describe("Work item name/title"),
  description: z.string().optional().describe("Work item description"),
  pipelineStageId: z.string().optional().describe("Pipeline stage ID to assign to"),
  assignedToId: z.string().optional().describe("User ID to assign the work item to"),
});

export const DevOpsPromoteWorkItemSchema = z.object({
  workItemId: z.string().min(1).describe("DevOps Center work item ID"),
});

export const CheckCodeCoverageSchema = z.object({
  className: z.string().optional().describe("Filter by Apex class name (partial match)"),
  minCoverage: z.number().int().min(0).max(100).optional().describe("Only show classes below this coverage %"),
});

export const DetectDevOpsMergeConflictSchema = z.object({
  workItemId: z.string().min(1).describe("DevOps Center work item ID"),
});

export const ResolveDevOpsMergeConflictSchema = z.object({
  conflictId: z.string().min(1).describe("Merge conflict record ID"),
  resolution: z.enum(["ours","theirs","manual"]).describe("Resolution strategy"),
});

export const CheckoutDevOpsWorkItemSchema = z.object({
  workItemId: z.string().min(1).describe("DevOps Center work item ID to check out"),
});

export const CommitDevOpsWorkItemSchema = z.object({
  workItemId: z.string().min(1).describe("DevOps Center work item ID"),
  message: z.string().min(1).describe("Commit message"),
});

export const CreateDevOpsPullRequestSchema = z.object({
  workItemId: z.string().min(1).describe("DevOps Center work item ID"),
  title: z.string().min(1).describe("Pull request title"),
  description: z.string().optional().describe("Pull request description"),
});

export const ListDevOpsProjectsSchema = z.object({});

export const ListDevOpsWorkItemsSchema = z.object({
  projectId: z.string().optional().describe("Filter by DevOps Center project ID"),
  stageId: z.string().optional().describe("Filter by pipeline stage ID"),
  limit: z.number().int().min(1).max(200).default(20).describe("Maximum records to return"),
});

export const CheckDevOpsCommitStatusSchema = z.object({
  workItemId: z.string().min(1).describe("DevOps Center work item ID"),
});

export const PromoteDevOpsWorkItemSchema = z.object({
  workItemId: z.string().min(1).describe("DevOps Center work item ID"),
  targetStageId: z.string().min(1).describe("Target pipeline stage ID"),
});

// ─── CATEGORY 7: Advanced LWC ─────────────────────────────────────────────────

export const CreateLwcJestTestSchema = z.object({
  componentName: z.string().min(1).describe("LWC component name (camelCase), e.g. 'myButton'"),
  testContent: z.string().min(1).describe("Jest test file content (JavaScript)"),
  apiVersion: z.string().default("66.0").describe("API version, e.g. '62.0'"),
});

export const GuideLwcAccessibilitySchema = z.object({
  componentName: z.string().optional().describe("LWC component name for context (optional)"),
  checklistOnly: z.boolean().default(false).describe("Return only the checklist without detailed guidance"),
});

export const MigrateAuraToLwcSchema = z.object({
  auraComponentName: z.string().min(1).describe("Aura component name to analyze, e.g. 'MyAuraComponent'"),
  includeScaffold: z.boolean().default(true).describe("Whether to generate equivalent LWC scaffold code"),
});

export const CreateLwcFromRequirementsSchema = z.object({
  componentName: z.string().min(1).regex(/^[a-z][a-zA-Z0-9]*$/).describe("LWC component name in camelCase, e.g. 'accountTile'"),
  requirements: z.string().min(1).describe("Plain-English description of what the component should do"),
  includeWireAdapters: z.boolean().default(false).describe("Include wire adapter examples in the component"),
  targetObject: z.string().optional().describe("Salesforce object to bind to, e.g. 'Account'"),
});

export const ExploreSldsBlueprintsSchema = z.object({
  componentType: z.string().min(1).describe("SLDS component type, e.g. 'data-table', 'modal', 'combobox'"),
  includeExampleCode: z.boolean().default(true).describe("Whether to include example LWC code"),
});

// ─── CATEGORY 8: CPQ & Industries ────────────────────────────────────────────

export const CreateProductSchema = z.object({
  name: z.string().min(1).describe("Product name"),
  productCode: z.string().optional().describe("Product code / SKU"),
  description: z.string().optional().describe("Product description"),
  isActive: z.boolean().default(true).describe("Whether the product is active"),
  family: z.string().optional().describe("Product family, e.g. 'Hardware'"),
  quantityUnitOfMeasure: z.string().optional().describe("Unit of measure, e.g. 'Each'"),
});

export const CreatePriceBookSchema = z.object({
  name: z.string().min(1).describe("Price book name"),
  description: z.string().optional().describe("Description"),
  isActive: z.boolean().default(true).describe("Whether the price book is active"),
  isStandard: z.boolean().default(false).describe("Whether this is the standard price book"),
  currencyIsoCode: z.string().optional().describe("Currency ISO code, e.g. 'USD'"),
  products: z.array(z.object({
    productId: z.string().min(1).describe("Product2 record ID"),
    unitPrice: z.number().min(0).describe("Unit price for this product"),
    useStandardPrice: z.boolean().default(false).describe("Use the standard price book entry as the base"),
  })).optional().describe("Products to add to this price book"),
});

export const CreateEntitlementProcessSchema = z.object({
  fullName: z.string().min(1).regex(/^[A-Za-z][A-Za-z0-9_]*$/).describe("Entitlement process API name"),
  name: z.string().min(1).describe("Display name"),
  description: z.string().optional().describe("Description"),
  businessHoursName: z.string().optional().describe("Business hours name (optional)"),
  entryStartDateField: z.string().optional().describe("Start date field API name"),
  exitCriteriaBooleanFilter: z.string().optional().describe("Boolean filter for exit criteria"),
  milestones: z.array(z.object({
    name: z.string().min(1).describe("Milestone name"),
    minutesCustomClass: z.string().optional().describe("Apex class for custom milestone timing"),
    successActions: z.array(z.string()).optional().describe("Action API names on milestone success"),
  })).optional().describe("Milestones to include in the process"),
});

export const CreateMilestoneSchema = z.object({
  fullName: z.string().min(1).regex(/^[A-Za-z][A-Za-z0-9_]*$/).describe("Milestone type API name"),
  name: z.string().min(1).describe("Display name"),
  description: z.string().optional().describe("Description"),
  recurrenceType: z.enum(["recursIndependently","recursChained","noRecurrence"]).optional().describe("Recurrence behaviour"),
});

// ─── CATEGORY 10: Apex Performance ───────────────────────────────────────────

export const ScanApexAntipatternsSchema = z.object({
  classNames: z.array(z.string()).optional().describe("Apex class names to scan (omit to scan all)"),
  maxClasses: z.number().int().min(1).max(200).default(20).describe("Maximum number of classes to scan"),
});

// ─── CATEGORY A: Visualforce ──────────────────────────────────────────────────

export const CreateVisualforcePageSchema = z.object({
  pageName: z.string().min(1).max(80).regex(/^[A-Za-z][A-Za-z0-9_]*$/).describe("API name for the Visualforce page, e.g. 'MyPage'"),
  label: z.string().min(1).max(255).describe("Display label for the page"),
  description: z.string().max(1000).optional().describe("Description of the page"),
  content: z.string().min(1).describe("Visualforce markup (must include <apex:page> tag)"),
  apiVersion: z.string().default("66.0").describe("API version, e.g. '62.0'"),
  showHeader: z.boolean().default(true).describe("Whether to show the Salesforce header"),
  sidebar: z.boolean().default(true).describe("Whether to show the sidebar"),
  standardController: z.string().optional().describe("Standard controller object API name, e.g. 'Account'"),
  extensions: z.string().optional().describe("Comma-separated Apex class names for controller extensions"),
}).strict();

export const CreateVisualforceComponentSchema = z.object({
  componentName: z.string().min(1).max(80).regex(/^[A-Za-z][A-Za-z0-9_]*$/).describe("API name for the Visualforce component, e.g. 'MyComponent'"),
  label: z.string().min(1).max(255).describe("Display label for the component"),
  description: z.string().max(1000).optional().describe("Description of the component"),
  content: z.string().min(1).describe("Visualforce component markup (must include <apex:component> tag)"),
  apiVersion: z.string().default("66.0").describe("API version, e.g. '62.0'"),
}).strict();

export const CreateVisualforceEmailTemplateSchema = z.object({
  templateName: z.string().min(1).max(80).regex(/^[A-Za-z][A-Za-z0-9_]*$/).describe("API name for the email template"),
  subject: z.string().min(1).max(255).describe("Email subject line"),
  recipientType: z.enum(["Contact", "Lead", "User"]).describe("Type of recipient"),
  relatedEntityType: z.string().min(1).describe("Related object API name, e.g. 'Account'"),
  description: z.string().max(1000).optional().describe("Description of the template"),
  htmlBody: z.string().min(1).describe("HTML body with Visualforce markup"),
  textBody: z.string().min(1).describe("Plain-text version of the email body"),
}).strict();

// ─── CATEGORY B: Quick Actions & Field Sets ───────────────────────────────────

export const CreateQuickActionSchema = z.object({
  objectName: z.string().min(1).describe("Object API name, e.g. 'Account'"),
  actionName: z.string().min(1).max(80).regex(/^[A-Za-z][A-Za-z0-9_]*$/).describe("Quick action API name"),
  label: z.string().min(1).max(255).describe("Display label for the quick action"),
  actionType: z.enum(["Create", "Update", "LogACall", "SendEmail"]).describe("Type of quick action"),
  targetObject: z.string().optional().describe("Target object API name (required for Create type)"),
  description: z.string().max(1000).optional().describe("Description of the quick action"),
  fields: z.array(z.object({
    name: z.string().min(1).describe("Field API name"),
    required: z.boolean().default(false).describe("Whether the field is required"),
  })).optional().describe("Fields to include in the quick action layout"),
}).strict();

export const CreateGlobalActionSchema = z.object({
  actionName: z.string().min(1).max(80).regex(/^[A-Za-z][A-Za-z0-9_]*$/).describe("Global action API name"),
  label: z.string().min(1).max(255).describe("Display label"),
  actionType: z.enum(["Create", "LogACall", "SendEmail", "Canvas"]).describe("Type of global action"),
  targetObject: z.string().optional().describe("Target object API name (for Create type)"),
  description: z.string().max(1000).optional().describe("Description"),
}).strict();

export const CreateCustomButtonSchema = z.object({
  objectName: z.string().min(1).describe("Object API name, e.g. 'Account'"),
  buttonName: z.string().min(1).max(80).regex(/^[A-Za-z][A-Za-z0-9_]*$/).describe("Button API name"),
  label: z.string().min(1).max(255).describe("Display label"),
  buttonType: z.enum(["list", "detail", "massAction"]).describe("Button placement type"),
  contentSource: z.enum(["url", "javascript", "page"]).describe("Content source type"),
  content: z.string().min(1).describe("URL, JavaScript code, or Visualforce page name"),
  openType: z.enum(["sidebar", "newWindow", "replace", "noSidebar", "blank"]).describe("How to open the button target"),
}).strict();

export const CreateFieldSetSchema = z.object({
  objectName: z.string().min(1).describe("Object API name, e.g. 'Account'"),
  fieldSetName: z.string().min(1).max(80).regex(/^[A-Za-z][A-Za-z0-9_]*$/).describe("Field set API name"),
  label: z.string().min(1).max(255).describe("Display label"),
  description: z.string().max(1000).optional().describe("Description"),
  fields: z.array(z.string().min(1)).min(1).describe("Array of field API names to include"),
  availableFields: z.array(z.string().min(1)).optional().describe("Additional available fields not in the field set"),
}).strict();

// ─── CATEGORY C: Lightning Pages & App Builder ────────────────────────────────

export const CreateFlexipageSchema = z.object({
  pageName: z.string().min(1).max(80).regex(/^[A-Za-z][A-Za-z0-9_]*$/).describe("FlexiPage API name"),
  label: z.string().min(1).max(255).describe("Display label"),
  pageType: z.enum(["AppPage", "RecordPage", "HomePage"]).describe("Type of Lightning page"),
  description: z.string().max(1000).optional().describe("Description"),
  masterLabel: z.string().min(1).max(255).describe("Master label for the page"),
  objectApiName: z.string().optional().describe("Object API name (required for RecordPage)"),
  template: z.string().default("header_and_right_rail").describe("Page template name, e.g. 'header_and_right_rail'"),
}).strict();

export const CreatePathAssistantSchema = z.object({
  objectName: z.string().min(1).describe("Object API name, e.g. 'Opportunity'"),
  fieldName: z.string().min(1).describe("Picklist field API name, e.g. 'StageName'"),
  pathName: z.string().min(1).max(80).regex(/^[A-Za-z][A-Za-z0-9_]*$/).describe("Path assistant API name"),
  label: z.string().min(1).max(255).describe("Display label"),
  isActive: z.boolean().default(true).describe("Whether the path is active"),
  pathItems: z.array(z.object({
    picklistValue: z.string().min(1).describe("Picklist value this path item corresponds to"),
    infoTitle: z.string().optional().describe("Guidance title for this stage"),
    infoMessage: z.string().optional().describe("Guidance text for this stage"),
    keyFields: z.array(z.object({ fieldName: z.string().min(1).describe("Key field API name") })).optional().describe("Key fields to highlight"),
  })).min(1).describe("Path items for each picklist value"),
}).strict();

export const CreateCustomApplicationSchema = z.object({
  appName: z.string().min(1).max(80).regex(/^[A-Za-z][A-Za-z0-9_]*$/).describe("Application API name"),
  label: z.string().min(1).max(255).describe("Display label"),
  description: z.string().max(1000).optional().describe("Description"),
  formFactor: z.enum(["Large", "Small"]).default("Large").describe("Form factor: Large (desktop) or Small (mobile)"),
  isNavAutoTempTabsDisabled: z.boolean().default(false).describe("Disable auto-temporary tabs in nav"),
  navType: z.enum(["Standard", "Console"]).default("Standard").describe("Navigation type"),
  tabs: z.array(z.string().min(1)).optional().describe("Tab API names to include"),
  utilityBar: z.array(z.object({
    tabName: z.string().min(1).describe("Utility component name"),
    label: z.string().min(1).describe("Label for the utility item"),
    iconName: z.string().min(1).describe("SLDS icon name, e.g. 'call'"),
  })).optional().describe("Utility bar items"),
}).strict();

// ─── CATEGORY D: Knowledge & Service Management ───────────────────────────────

export const CreateKnowledgeArticleTypeSchema = z.object({
  articleTypeName: z.string().min(1).max(80).regex(/^[A-Za-z][A-Za-z0-9_]*__kav$/).describe("Article type API name (must end in __kav)"),
  label: z.string().min(1).max(255).describe("Singular label"),
  pluralLabel: z.string().min(1).max(255).describe("Plural label"),
  description: z.string().max(1000).optional().describe("Description"),
  fields: z.array(z.object({
    fieldName: z.string().min(1).describe("Field API name (without __c)"),
    label: z.string().min(1).describe("Field label"),
    type: z.string().min(1).describe("Field type, e.g. 'Text', 'LongTextArea'"),
  })).optional().describe("Custom fields for the article type"),
}).strict();

export const CreateBusinessHoursSchema = z.object({
  name: z.string().min(1).max(255).describe("Business hours name"),
  isDefault: z.boolean().default(false).describe("Whether this is the default business hours"),
  isActive: z.boolean().default(true).describe("Whether business hours are active"),
  timeZone: z.string().min(1).describe("Time zone, e.g. 'America/New_York'"),
  days: z.array(z.object({
    day: z.enum(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]).describe("Day of week"),
    isActive: z.boolean().describe("Whether this day is active"),
    startTime: z.string().regex(/^\d{2}:\d{2}$/).describe("Start time in HH:MM format"),
    endTime: z.string().regex(/^\d{2}:\d{2}$/).describe("End time in HH:MM format"),
  })).min(1).describe("Business hours for each day"),
}).strict();

export const CreateHolidaySchema = z.object({
  name: z.string().min(1).max(255).describe("Holiday name"),
  description: z.string().max(1000).optional().describe("Description"),
  isRecurring: z.boolean().default(false).describe("Whether this holiday recurs annually"),
  activityDate: z.string().optional().describe("Date for non-recurring holiday (YYYY-MM-DD)"),
  recurrenceType: z.string().optional().describe("Recurrence type, e.g. 'RecursYearly'"),
  recurrenceStartDate: z.string().optional().describe("Recurrence start date (YYYY-MM-DD)"),
  recurrenceEndDateOnly: z.string().optional().describe("Recurrence end date (YYYY-MM-DD)"),
  businessHoursName: z.string().optional().describe("Associated business hours name"),
}).strict();

// ─── CATEGORY E: Auth & Identity ─────────────────────────────────────────────

export const CreateAuthProviderSchema = z.object({
  providerName: z.string().min(1).max(80).regex(/^[A-Za-z][A-Za-z0-9_]*$/).describe("Auth provider API name"),
  friendlyName: z.string().min(1).max(255).describe("Display name"),
  providerType: z.enum(["OpenIdConnect", "Facebook", "Google", "GitHub", "Salesforce", "Custom"]).describe("Provider type"),
  consumerKey: z.string().min(1).describe("Consumer key / client ID"),
  consumerSecret: z.string().min(1).describe("Consumer secret / client secret"),
  defaultScopes: z.string().optional().describe("Default OAuth scopes"),
  customErrorUrl: z.string().optional().describe("Custom error URL"),
  registrationHandler: z.string().optional().describe("Apex class name for registration handler"),
}).strict();

export const CreateSamlSsoConfigSchema = z.object({
  name: z.string().min(1).max(80).regex(/^[A-Za-z][A-Za-z0-9_]*$/).describe("SSO configuration API name"),
  issuer: z.string().min(1).describe("Identity provider issuer URL"),
  identityProviderCertificate: z.string().min(1).describe("Base64-encoded IdP certificate"),
  samlVersion: z.enum(["SAML2_0"]).default("SAML2_0").describe("SAML version"),
  identityLocation: z.enum(["SubjectNameId", "Attribute"]).default("SubjectNameId").describe("Where user identity is stored"),
  identityType: z.enum(["Username", "FederationId", "UserId"]).default("Username").describe("User identity type"),
  requestSignatureMethod: z.enum(["RSA-SHA256"]).default("RSA-SHA256").describe("Signature method"),
  loginUrl: z.string().min(1).describe("Identity provider login URL"),
  logoutUrl: z.string().optional().describe("Identity provider logout URL"),
  attributeName: z.string().optional().describe("SAML attribute name (for Attribute identity location)"),
}).strict();

export const CreateConnectedAppOAuthPolicySchema = z.object({
  connectedAppName: z.string().min(1).describe("Connected App API name"),
  refreshTokenPolicy: z.enum(["infinite", "specific", "expire_on_password"]).describe("Refresh token policy"),
  singleLogoutUrl: z.string().optional().describe("Single logout URL"),
  sessionTimeout: z.string().optional().describe("Session timeout value"),
  ipRelaxation: z.enum(["ipRelax", "enforceIpRanges", "bypassApprovals"]).optional().describe("IP relaxation policy"),
}).strict();

// ─── CATEGORY F: Sandbox Management ──────────────────────────────────────────

export const CreateSandboxSchema = z.object({
  sandboxName: z.string().min(1).max(10).regex(/^[A-Za-z][A-Za-z0-9]*$/).describe("Sandbox name (max 10 chars, alphanumeric)"),
  licenseType: z.enum(["Developer", "Developer_Pro", "Partial_Copy", "Full"]).describe("Sandbox license type"),
  description: z.string().max(1000).optional().describe("Description"),
  apexClassId: z.string().optional().describe("Apex class ID to run after sandbox copy"),
  autoActivate: z.boolean().default(true).describe("Automatically activate the sandbox after creation"),
}).strict();

export const RefreshSandboxSchema = z.object({
  sandboxName: z.string().min(1).max(10).describe("Sandbox name to refresh"),
  licenseType: z.enum(["Developer", "Developer_Pro", "Partial_Copy", "Full"]).describe("Sandbox license type"),
  autoActivate: z.boolean().default(true).describe("Automatically activate after refresh"),
}).strict();

export const ListSandboxesSchema = z.object({}).strict();

// ─── CATEGORY G: Streaming, CDC & Platform Cache ──────────────────────────────

export const CreatePushTopicSchema = z.object({
  topicName: z.string().min(1).max(25).regex(/^[A-Za-z][A-Za-z0-9_]*$/).describe("PushTopic name (max 25 chars)"),
  query: z.string().min(1).describe("SOQL query for the PushTopic"),
  apiVersion: z.number().min(21).max(62).default(62).describe("API version number (e.g. 62)"),
  notifyForOperationCreate: z.boolean().default(true).describe("Notify on record create"),
  notifyForOperationUpdate: z.boolean().default(true).describe("Notify on record update"),
  notifyForOperationDelete: z.boolean().default(false).describe("Notify on record delete"),
  notifyForOperationUndelete: z.boolean().default(false).describe("Notify on record undelete"),
  notifyForFields: z.enum(["Referenced", "All", "Where", "Select"]).default("Referenced").describe("Which fields trigger notifications"),
}).strict();

export const ConfigureChangeDataCaptureSchema = z.object({
  entities: z.array(z.string().min(1)).min(1).describe("Object API names to enable CDC on, e.g. ['Account', 'Contact']"),
}).strict();

export const CreatePlatformCachePartitionSchema = z.object({
  partitionName: z.string().min(1).max(80).regex(/^[A-Za-z][A-Za-z0-9_]*$/).describe("Cache partition API name"),
  description: z.string().max(1000).optional().describe("Description"),
  isDefaultPartition: z.boolean().default(false).describe("Whether this is the default partition"),
  sessionCacheSize: z.number().int().min(0).max(500).default(0).describe("Session cache size in MB"),
  orgCacheSize: z.number().int().min(0).max(500).default(0).describe("Org cache size in MB"),
}).strict();

// ─── CATEGORY H: Aura Components ─────────────────────────────────────────────

export const CreateAuraComponentSchema = z.object({
  componentName: z.string().min(1).max(80).regex(/^[A-Za-z][A-Za-z0-9]*$/).describe("Aura component name (PascalCase)"),
  description: z.string().max(1000).optional().describe("Description"),
  implements: z.string().optional().describe("Comma-separated interfaces, e.g. 'force:appHostable,flexipage:availableForAllPageTypes'"),
  isExposed: z.boolean().default(true).describe("Whether the component is exposed in App Builder"),
  accessLevel: z.enum(["public", "global"]).default("public").describe("Access level"),
  controller: z.string().optional().describe("Apex controller class name"),
  attributes: z.array(z.object({
    name: z.string().min(1).describe("Attribute name"),
    type: z.string().min(1).describe("Attribute type, e.g. 'String', 'Boolean', 'Object'"),
    default: z.string().optional().describe("Default value"),
    description: z.string().optional().describe("Attribute description"),
  })).optional().describe("Component attributes"),
}).strict();

export const CreateAuraAppSchema = z.object({
  appName: z.string().min(1).max(80).regex(/^[A-Za-z][A-Za-z0-9]*$/).describe("Aura app name (PascalCase)"),
  description: z.string().max(1000).optional().describe("Description"),
  access: z.enum(["public", "global"]).default("public").describe("Access level"),
  extends: z.string().optional().describe("Parent app to extend, e.g. 'force:slds'"),
  includes: z.array(z.string()).optional().describe("Component names to include"),
  bodyContent: z.string().optional().describe("Body markup content"),
}).strict();

export const CreateAuraEventSchema = z.object({
  eventName: z.string().min(1).max(80).regex(/^[A-Za-z][A-Za-z0-9]*$/).describe("Aura event name (PascalCase)"),
  eventType: z.enum(["COMPONENT", "APPLICATION"]).describe("Event type"),
  description: z.string().max(1000).optional().describe("Description"),
  attributes: z.array(z.object({
    name: z.string().min(1).describe("Attribute name"),
    type: z.string().min(1).describe("Attribute type"),
    description: z.string().optional().describe("Attribute description"),
  })).optional().describe("Event attributes"),
}).strict();

// ─── CATEGORY I: Flow Management ─────────────────────────────────────────────

export const ActivateFlowSchema = z.object({
  flowApiName: z.string().min(1).describe("Flow API name"),
  versionNumber: z.number().int().min(1).optional().describe("Version number to activate (defaults to latest)"),
}).strict();

export const DeactivateFlowSchema = z.object({
  flowApiName: z.string().min(1).describe("Flow API name to deactivate"),
}).strict();

export const ListFlowVersionsSchema = z.object({
  flowApiName: z.string().optional().describe("Flow API name (omit to list all flows)"),
  includeDeactivated: z.boolean().default(true).describe("Whether to include deactivated versions"),
}).strict();

// ─── CATEGORY J: Translation & Internationalization ───────────────────────────

export const TranslateCustomLabelSchema = z.object({
  labelName: z.string().min(1).describe("Custom label full name (API name)"),
  language: z.string().min(2).max(10).describe("Language code, e.g. 'fr', 'de', 'es', 'ja'"),
  translatedValue: z.string().min(1).describe("Translated text value"),
}).strict();

export const TranslateFieldLabelSchema = z.object({
  objectName: z.string().min(1).describe("Object API name, e.g. 'Account'"),
  fieldName: z.string().min(1).describe("Field API name, e.g. 'Name' or 'MyField__c'"),
  language: z.string().min(2).max(10).describe("Language code, e.g. 'fr', 'de', 'es', 'ja'"),
  translatedLabel: z.string().min(1).describe("Translated field label"),
  translatedHelpText: z.string().optional().describe("Translated help text (optional)"),
}).strict();

// ─── Flow from XML ────────────────────────────────────────────────────────────

export const CreateFlowFromXmlSchema = z.object({
  flowApiName: z.string().min(1).describe("API name of the flow to deploy, e.g. 'My_Flow'"),
  flowXml: z.string().min(1).describe("Complete Flow XML content (the full metadata file, starting with <?xml version...> or <Flow xmlns...>)"),
  activate: z.boolean().default(true).describe("Activate the flow after deployment (default: true). Set to false to deploy as inactive draft."),
}).strict();
