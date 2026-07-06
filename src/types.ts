// ─── Salesforce Auth ────────────────────────────────────────────────────────

export interface SalesforceAuth {
  instanceUrl: string;
  accessToken: string;
}

// ─── Metadata API Response ───────────────────────────────────────────────────

export interface MetadataUpsertResult {
  created: boolean;
  fullName: string;
  success: boolean;
  errors?: MetadataError[];
}

export interface MetadataError {
  fields?: string[];
  message: string;
  statusCode: string;
}

export interface MetadataReadResult<T> {
  result: T | T[];
}

// ─── Custom Object ───────────────────────────────────────────────────────────

export interface CustomObjectMetadata {
  fullName: string;
  label: string;
  pluralLabel: string;
  nameField: NameField;
  deploymentStatus: "Deployed" | "InDevelopment";
  sharingModel: "ReadWrite" | "Read" | "Private" | "ControlledByParent" | "FullAccess" | "ControlledByCampaign";
  description?: string;
  enableActivities?: boolean;
  enableHistory?: boolean;
  enableReports?: boolean;
  enableSearch?: boolean;
  enableFeeds?: boolean;
}

export interface NameField {
  label: string;
  type: "Text" | "AutoNumber";
  displayFormat?: string; // for AutoNumber, e.g. "OBJ-{0000}"
}

// ─── Custom Field ────────────────────────────────────────────────────────────

export type FieldType =
  | "Text"
  | "TextArea"
  | "LongTextArea"
  | "Html"
  | "Number"
  | "Currency"
  | "Percent"
  | "Checkbox"
  | "Date"
  | "DateTime"
  | "Email"
  | "Phone"
  | "Url"
  | "Picklist"
  | "MultiselectPicklist"
  | "Lookup"
  | "MasterDetail";

export interface CustomFieldMetadata {
  fullName: string; // format: ObjectName__c.FieldName__c
  label: string;
  type: FieldType;
  description?: string;
  required?: boolean;
  unique?: boolean;
  externalId?: boolean;
  // Text fields
  length?: number;
  // LongTextArea / Html
  visibleLines?: number;
  // Number / Currency / Percent
  precision?: number;
  scale?: number;
  // Picklist
  valueSet?: ValueSet;
  // Checkbox default value
  defaultValue?: boolean | string;
  // Lookup / MasterDetail
  referenceTo?: string;
  relationshipLabel?: string;
  relationshipName?: string;
  deleteConstraint?: "Cascade" | "Restrict" | "SetNull";
}

// ─── Picklist ────────────────────────────────────────────────────────────────

export interface ValueSet {
  restricted?: boolean;
  valueSetDefinition: ValueSetDefinition;
}

export interface ValueSetDefinition {
  sorted: boolean;
  value: PicklistValue[];
}

export interface PicklistValue {
  fullName: string;
  label: string;
  default: boolean;
  isActive?: boolean;
  color?: string;
  description?: string;
}

// ─── Tool Response ───────────────────────────────────────────────────────────

export interface ToolSuccessResult {
  success: true;
  fullName: string;
  created: boolean;
  message: string;
}

export interface ToolErrorResult {
  success: false;
  message: string;
  details?: string;
}

export type ToolResult = ToolSuccessResult | ToolErrorResult;
