import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CreateUserSchema, UpdateUserSchema, AssignQueueMemberSchema, CreatePublicGroupSchema,
  QueryRecordsSchema, CreateRecordSchema, UpdateRecordSchema, BulkImportRecordsSchema,
  DeleteRecordSchema, SendEmailSchema, ExportRecordsSchema, UpsertRecordSchema,
  GetRecordSchema, SearchRecordsSchema,
  CreateDataCategorySchema, BulkInsertRecordsSchema, BulkUpdateRecordsSchema,
  BulkDeleteRecordsSchema, CreateExtIdFieldSchema,
} from "../schemas/index.js";
import {
  getAuth, createUser, updateUser, assignQueueMember, createPublicGroup,
  queryRecords, createRecord, updateRecord, bulkImportRecords, deleteRecord,
  sendEmail, exportRecords, upsertRecord, getRecord, searchRecords,
  createDataCategory, bulkInsertRecords, bulkUpdateRecords, bulkDeleteRecords,
  createExtIdField,
} from "../services/salesforce.js";
import { resultContent } from "./utils.js";

export function registerDataTools(server: McpServer): void {
  server.registerTool("sf_create_user", {
    title: "Create Salesforce User",
    description: `Creates a new Salesforce user via the REST API. Requires username (must be unique and email-like), lastName, email, and profileName. The profile must already exist. Optionally assign a role by roleApiName (DeveloperName of the UserRole). The user will receive a welcome email unless email confirmations are suppressed in org settings.`,
    inputSchema: CreateUserSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async (params) => {
    const auth = await getAuth();
    const result = await createUser(auth, params);
    return resultContent(result);
  });

  server.registerTool("sf_update_user", {
    title: "Update Salesforce User",
    description: `Updates an existing Salesforce user's properties via the REST API. Look up the user by username and update fields like firstName, lastName, email, title, department, phone, or isActive (to deactivate/reactivate). Only fields you provide are updated.`,
    inputSchema: UpdateUserSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (params) => {
    const auth = await getAuth();
    const result = await updateUser(auth, params);
    return resultContent(result);
  });

  server.registerTool("sf_assign_queue_member", {
    title: "Add User to Queue",
    description: `Adds a user to an existing Queue (GroupMember SObject) by username and queue DeveloperName. The queue must already exist (create via sf_create_queue). Users in queues can be assigned records and receive queue notification emails.`,
    inputSchema: AssignQueueMemberSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async (params) => {
    const auth = await getAuth();
    const result = await assignQueueMember(auth, params);
    return resultContent(result);
  });

  server.registerTool("sf_create_public_group", {
    title: "Create Public Group",
    description: `Creates a Public Group (Group SObject with Type=Regular) for sharing rules, email distribution, or queue membership. Public groups can include users, roles, and other groups. Use as a sharing target in sf_create_sharing_rule.`,
    inputSchema: CreatePublicGroupSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async (params) => {
    const auth = await getAuth();
    const result = await createPublicGroup(auth, params);
    return resultContent(result);
  });

  server.registerTool("sf_query_records", {
    title: "Query Records (SOQL)",
    description: `Executes a SOQL query against the org and returns matching records. Provide either a full SOQL string (soql param) or individual parameters (objectApiName, fields, whereClause, orderBy, limit). Use for reading data, checking existing records before creating, or verifying changes.`,
    inputSchema: QueryRecordsSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (params) => {
    const auth = await getAuth();
    const result = await queryRecords(auth, params);
    return resultContent(result);
  });

  server.registerTool("sf_create_record", {
    title: "Create SObject Record",
    description: `Creates a single SObject record via the Salesforce REST API. Provide the object API name and a fields object with field API names and values. For bulk creation (100+ records), use sf_bulk_import_records instead.`,
    inputSchema: CreateRecordSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async (params) => {
    const auth = await getAuth();
    const result = await createRecord(auth, params);
    return resultContent(result);
  });

  server.registerTool("sf_update_record", {
    title: "Update SObject Record",
    description: `Updates an existing SObject record by record ID via the Salesforce REST API. Provide the object API name, the 15 or 18 character record ID, and the fields to update. Only provided fields are changed — omitted fields retain their current values.`,
    inputSchema: UpdateRecordSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (params) => {
    const auth = await getAuth();
    const result = await updateRecord(auth, params);
    return resultContent(result);
  });

  server.registerTool("sf_bulk_import_records", {
    title: "Bulk Import Records (Bulk API 2.0)",
    description: `Bulk imports records using the Salesforce Bulk API 2.0. Supports insert, upsert, update, and delete operations on large datasets (thousands to millions of records). Provide CSV data with a header row. For upsert, set externalIdField to the field used for matching. Polls until the job completes and returns success/failure counts.`,
    inputSchema: BulkImportRecordsSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async (params) => {
    const auth = await getAuth();
    const result = await bulkImportRecords(auth, params);
    return resultContent(result);
  });

  server.registerTool("sf_delete_record", {
    title: "Delete SObject Record",
    description: `Deletes a single SObject record by record ID via the Salesforce REST API. The deletion is permanent and cannot be undone (the record goes to the Recycle Bin for objects that support it, from where it can be undeleted within 15 days).

Provide the object API name and the 15 or 18 character record ID. For bulk deletions (100+ records), use sf_bulk_import_records with operation='delete'.`,
    inputSchema: DeleteRecordSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  }, async (params) => {
    const auth = await getAuth();
    const result = await deleteRecord(auth, params);
    return resultContent(result);
  });

  server.registerTool("sf_send_email", {
    title: "Send Email via Salesforce",
    description: `Sends an email from Salesforce using the emailSimple invocable action. The email is sent from the running user's email address through Salesforce's email infrastructure (respects org email deliverability settings).

toAddresses: one or more recipient email addresses
body / htmlBody: email body content (htmlBody takes precedence)
templateName: use an existing email template instead of providing body text
whatId: related record ID (e.g. Opportunity, Case) — links the email as an activity
whoId: Contact or Lead ID — links the email to the person record
saveAsActivity: saves the email as an EmailMessage activity (default: true)

Note: Salesforce email limits apply (daily email limits based on org edition). Mass emails should use list email features instead.`,
    inputSchema: SendEmailSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async (params) => {
    const auth = await getAuth();
    const result = await sendEmail(auth, params);
    return resultContent(result);
  });

  server.registerTool("sf_export_records", {
    title: "Export Records to CSV",
    description: `Exports Salesforce records as CSV data using a SOQL query. Useful for data extraction, backup, or analysis.

soql: the SOQL query to run (SELECT fields FROM Object WHERE ...)
includeHeader: include column headers in the CSV output (default: true)
maxRecords: maximum records to export (default: 50000 — use Bulk API for larger datasets)

Returns the CSV content as a string. For very large exports (>50k records), use sf_bulk_import_records with operation='query' instead.`,
    inputSchema: ExportRecordsSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (params) => {
    const auth = await getAuth();
    const result = await exportRecords(auth, params);
    return resultContent(result);
  });

  server.registerTool("sf_upsert_record", {
    title: "Upsert SObject Record",
    description: `Creates or updates a Salesforce record using an External ID field for matching. If a record with the given external ID value exists, it is updated; otherwise a new record is created.

objectApiName: the SObject API name (e.g. 'Account', 'Contact')
externalIdField: the External ID field API name used for matching (e.g. 'Legacy_Id__c')
externalIdValue: the value to match on
fields: the field values to set on the record`,
    inputSchema: UpsertRecordSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (params) => {
    const auth = await getAuth();
    const result = await upsertRecord(auth, params);
    return resultContent(result);
  });

  server.registerTool("sf_get_record", {
    title: "Get SObject Record by ID",
    description: `Retrieves a single Salesforce record by its 15 or 18 character record ID. Returns all or specified fields.

objectApiName: the SObject API name (e.g. 'Account', 'Opportunity')
recordId: the 15 or 18 character Salesforce record ID
fields: optional list of field API names to return (omit for all fields)`,
    inputSchema: GetRecordSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (params) => {
    const auth = await getAuth();
    const result = await getRecord(auth, params);
    return resultContent(result);
  });

  server.registerTool("sf_search_records", {
    title: "Search Records (SOSL)",
    description: `Searches across multiple Salesforce objects using SOSL (Salesforce Object Search Language). SOSL uses the search index and is faster than SOQL for cross-object text searches.

searchTerm: the text to search for
objects: array of objects to search with optional fields list, e.g. [{ objectName: 'Account', fields: ['Id', 'Name'] }, { objectName: 'Contact', fields: ['Id', 'Name', 'Email'] }]
searchGroup: where to search — ALL FIELDS (default), NAME FIELDS, EMAIL FIELDS, or PHONE FIELDS
limit: max records per object (default: 20, max: 200)`,
    inputSchema: SearchRecordsSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (params) => {
    const auth = await getAuth();
    const result = await searchRecords(auth, params);
    return resultContent(result);
  });

  server.registerTool("sf_create_data_category", {
    title: "Create Data Category Group",
    description: `Creates a Data Category Group with categories for classifying Salesforce Knowledge articles, solutions, or cases. Data categories enable hierarchical content classification and visibility controls.

fullName: data category group API name
label: display label
objectUsage: object type to categorize (e.g. 'KnowledgeArticle')
categories: top-level categories with optional sub-categories`,
    inputSchema: CreateDataCategorySchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (params) => {
    const auth = await getAuth();
    const result = await createDataCategory(auth, params);
    return resultContent(result);
  });

  server.registerTool("sf_bulk_insert_records", {
    title: "Bulk Insert Records (Bulk API 2.0)",
    description: `Inserts multiple records of the same object type asynchronously using Salesforce Bulk API 2.0. More efficient than individual REST calls for large volumes. Returns a job ID to track status.

objectApiName: Salesforce object API name
records: array of record objects with field:value pairs
externalIdField: if provided, performs an upsert on this external ID field instead of insert`,
    inputSchema: BulkInsertRecordsSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async (params) => {
    const auth = await getAuth();
    const result = await bulkInsertRecords(auth, params);
    return resultContent(result);
  });

  server.registerTool("sf_bulk_update_records", {
    title: "Bulk Update Records (Bulk API 2.0)",
    description: `Updates multiple records of the same object type asynchronously using Salesforce Bulk API 2.0. Each record must include its Salesforce Id field. Returns a job ID to track status.

objectApiName: Salesforce object API name
records: array of records — each must include 'Id' plus fields to update`,
    inputSchema: BulkUpdateRecordsSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async (params) => {
    const auth = await getAuth();
    const result = await bulkUpdateRecords(auth, params);
    return resultContent(result);
  });

  server.registerTool("sf_bulk_delete_records", {
    title: "Bulk Delete Records (Bulk API 2.0)",
    description: `Deletes multiple records by ID asynchronously using Salesforce Bulk API 2.0. Returns a job ID to track status. Use with caution — deleted records go to the Recycle Bin.

objectApiName: Salesforce object API name
ids: array of Salesforce record IDs to delete`,
    inputSchema: BulkDeleteRecordsSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  }, async (params) => {
    const auth = await getAuth();
    const result = await bulkDeleteRecords(auth, params);
    return resultContent(result);
  });

  server.registerTool("sf_create_external_id_field", {
    title: "Create External ID Field",
    description: `Creates a custom field with externalId=true on a Salesforce object. External ID fields can be used for upsert operations and integration matching. The field is also automatically marked as unique.

objectName: object API name
fullName: field API name ending in __c
label: display label
type: field type (Text, Number, Email, or AutoNumber)
length: max length for Text fields`,
    inputSchema: CreateExtIdFieldSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (params) => {
    const auth = await getAuth();
    const result = await createExtIdField(auth, params);
    return resultContent(result);
  });
}
