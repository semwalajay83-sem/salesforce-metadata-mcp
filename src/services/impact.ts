/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Metadata impact analysis and safe object/field updates (v2.12.0).
 *
 * This module exists because the previous `updateCustomObject`/`updateCustomField` in salesforce.ts
 * were unsafe in a way that had nothing to do with the caller's intent:
 *
 *   1. They read the component with `readMetadata`, edited the returned XML with regexes, and wrote
 *      it back with `upsertMetadata`. `upsertMetadata` is a *full component replace*, and a
 *      `readMetadata` of a CustomObject contains every field, validation rule, list view and record
 *      type. A one-word label change therefore round-tripped every child component through
 *      Salesforce's serializer and wrote it back — anything rendered imperfectly was silently
 *      damaged or dropped.
 *   2. The regexes could not match self-closing tags (`<description/>`), so they fell through to the
 *      append branch and emitted a *duplicate* element.
 *   3. Replacements were written unprefixed while appends were written `met:`-prefixed, inside a
 *      `met:`-prefixed wrapper.
 *
 * The replacement here:
 *   - reads a FIELD's current state from the **Tooling API as JSON**, no XML parsing at all. An
 *     OBJECT still has to come from `readMetadata` XML, because the Tooling API exposes no
 *     `Metadata` for CustomObject in either the REST retrieve or SOQL (verified live 2026-08-11) —
 *     but that parse strips every child collection first and feeds a whitelist, never a write-back,
 *     so it cannot reproduce the old failure,
 *   - writes through a **scoped `deploy()`** instead of `upsertMetadata`, because deploy *merges*:
 *     child components absent from the payload are left alone rather than replaced. For a field the
 *     payload names exactly one `<fields>` entry; for an object it carries object-level properties
 *     only and structurally cannot contain a field,
 *   - classifies every change into a risk tier and refuses, gates, or applies accordingly,
 *   - and uses the same deploy path for `checkOnly` validation as for the real write, so the thing
 *     that was validated is the thing that gets applied.
 */
import JSZip from "jszip";
import type { SalesforceAuth } from "../types.js";
import { API_VERSION, callMetadataSoap, createClient, sanitizeError, soqlEscape, x } from "./salesforce.js";
import { buildPackageXml, deployZip, pollDeployStatus } from "./deployment.js";

// ─── Blind spots ──────────────────────────────────────────────────────────────

/**
 * What Salesforce's MetadataComponentDependency API cannot see.
 *
 * Returned verbatim on **every** dependency response, including empty ones. An unqualified
 * "0 dependencies found" reads as "safe to change", and for these categories that inference is
 * simply wrong — a tool that stays silent about them is more dangerous than one that says nothing
 * at all, because it manufactures false confidence.
 */
export const DEPENDENCY_BLIND_SPOTS: readonly string[] = [
  "Dynamic SOQL, and field or object names assembled by string concatenation in Apex",
  "References from managed-package code (the API cannot see inside a managed namespace)",
  "Reports, dashboards and list-view filters — coverage is partial and undocumented",
  "Hardcoded references outside the org entirely: integrations, API clients, ETL jobs, middleware",
  "Anything that references the component by label rather than by API name",
];

// ─── Identifier validation ────────────────────────────────────────────────────

const API_NAME_CORE = /^[A-Za-z][A-Za-z0-9_]*$/;
const KNOWN_SUFFIXES = /__(c|mdt|e|b|x|kav|r|Share|History|Feed|Tag)$/i;

/**
 * Guards an object/field API name before it reaches SOQL, XML, a package.xml member, or a URL path.
 * Salesforce API names are a narrow character set, so an allowlist is both correct and the cheapest
 * possible injection defence at these call sites.
 */
export function assertApiName(value: string | undefined, label: string): string {
  const v = String(value ?? "").trim();
  if (!v) throw new Error(`${label} is required.`);
  if (v.length > 80) throw new Error(`${label} is too long (max 80 characters).`);
  if (!API_NAME_CORE.test(v.replace(KNOWN_SUFFIXES, ""))) {
    throw new Error(
      `${label} must be a valid Salesforce API name — letters, digits and underscores, starting with a letter. Got: ${JSON.stringify(v).slice(0, 60)}`
    );
  }
  return v;
}

// ─── Component resolution ─────────────────────────────────────────────────────

export interface ResolvedComponent {
  id: string;
  type: string;
  name: string;
  objectApiName?: string;
  fieldApiName?: string;
}

/** Tooling API `CustomObject.Id` for a custom object, by API name (with or without the `__c`). */
async function resolveCustomObjectId(auth: SalesforceAuth, objectApiName: string): Promise<string | null> {
  const client = createClient(auth);
  const developerName = objectApiName.replace(/__c$/i, "");
  const soql = `SELECT Id FROM CustomObject WHERE DeveloperName = '${soqlEscape(developerName)}'`;
  const resp = await client.get<{ records: Array<{ Id: string }> }>(`/tooling/query?q=${encodeURIComponent(soql)}`);
  return resp.data.records?.[0]?.Id ?? null;
}

/**
 * Resolves a metadata component to the Tooling API Id that MetadataComponentDependency keys on.
 *
 * CustomField is the awkward case and the reason this helper exists: its Tooling `TableEnumOrId` is
 * the *object API name* for standard objects but the CustomObject *record Id* for custom ones, so a
 * custom object needs an extra hop before the field can be found at all.
 */
export async function resolveComponentId(
  auth: SalesforceAuth,
  componentType: string,
  componentName: string
): Promise<ResolvedComponent> {
  const client = createClient(auth);
  const type = componentType.trim();

  if (type === "CustomField") {
    const parts = componentName.split(".");
    if (parts.length !== 2) {
      throw new Error(`CustomField name must be 'Object.Field__c' (got '${componentName}').`);
    }
    const objectApiName = assertApiName(parts[0], "Object API name");
    const fieldApiName = assertApiName(parts[1], "Field API name");
    let tableEnumOrId: string = objectApiName;
    if (/__c$/i.test(objectApiName)) {
      const objId = await resolveCustomObjectId(auth, objectApiName);
      if (!objId) throw new Error(`Custom object '${objectApiName}' not found.`);
      tableEnumOrId = objId;
    }
    const developerName = fieldApiName.replace(/__c$/i, "");
    const soql =
      `SELECT Id FROM CustomField WHERE TableEnumOrId = '${soqlEscape(tableEnumOrId)}' ` +
      `AND DeveloperName = '${soqlEscape(developerName)}'`;
    const resp = await client.get<{ records: Array<{ Id: string }> }>(`/tooling/query?q=${encodeURIComponent(soql)}`);
    const id = resp.data.records?.[0]?.Id;
    if (!id) {
      throw new Error(
        `Field '${objectApiName}.${fieldApiName}' not found. Note only custom fields (__c) are visible to the Tooling CustomField object — standard fields cannot be resolved or updated this way.`
      );
    }
    return { id, type, name: `${objectApiName}.${fieldApiName}`, objectApiName, fieldApiName };
  }

  if (type === "CustomObject") {
    const objectApiName = assertApiName(componentName, "Object API name");
    const id = await resolveCustomObjectId(auth, objectApiName);
    if (!id) throw new Error(`Custom object '${objectApiName}' not found.`);
    return { id, type, name: objectApiName, objectApiName };
  }

  // Generic single-name types. Each maps to a Tooling sobject with a different name column.
  const GENERIC: Record<string, { sobject: string; column: string }> = {
    ApexClass: { sobject: "ApexClass", column: "Name" },
    ApexTrigger: { sobject: "ApexTrigger", column: "Name" },
    ApexPage: { sobject: "ApexPage", column: "Name" },
    ApexComponent: { sobject: "ApexComponent", column: "Name" },
    Flow: { sobject: "FlowDefinition", column: "DeveloperName" },
    ValidationRule: { sobject: "ValidationRule", column: "ValidationName" },
    Layout: { sobject: "Layout", column: "Name" },
    PermissionSet: { sobject: "PermissionSet", column: "Name" },
    LightningComponentBundle: { sobject: "LightningComponentBundle", column: "DeveloperName" },
    AuraDefinitionBundle: { sobject: "AuraDefinitionBundle", column: "DeveloperName" },
    StaticResource: { sobject: "StaticResource", column: "Name" },
  };
  const g = GENERIC[type];
  if (!g) {
    throw new Error(
      `Unsupported componentType '${type}'. Supported: ${["CustomField", "CustomObject", ...Object.keys(GENERIC)].join(", ")}. For anything else, pass componentId directly.`
    );
  }
  const name = assertApiName(componentName, `${type} name`);
  const soql = `SELECT Id FROM ${g.sobject} WHERE ${g.column} = '${soqlEscape(name)}'`;
  const resp = await client.get<{ records: Array<{ Id: string }> }>(`/tooling/query?q=${encodeURIComponent(soql)}`);
  const id = resp.data.records?.[0]?.Id;
  if (!id) throw new Error(`${type} '${name}' not found.`);
  return { id, type, name };
}

// ─── Data probe ───────────────────────────────────────────────────────────────

export interface DataProbe {
  queried: boolean;
  totalRecords?: number;
  recordsWithData?: number;
  note: string;
}

/**
 * Answers the question that actually decides whether a field change is safe: does this field hold
 * data today? A brand-new empty field is free to reshape; a populated one is not.
 */
export async function probeFieldData(
  auth: SalesforceAuth,
  objectApiName: string,
  fieldApiName: string
): Promise<DataProbe> {
  const client = createClient(auth);
  try {
    const obj = assertApiName(objectApiName, "Object API name");
    const fld = assertApiName(fieldApiName, "Field API name");
    const totalResp = await client.get<{ totalSize: number }>(
      `/query?q=${encodeURIComponent(`SELECT COUNT() FROM ${obj}`)}`
    );
    const withDataResp = await client.get<{ totalSize: number }>(
      `/query?q=${encodeURIComponent(`SELECT COUNT() FROM ${obj} WHERE ${fld} != null`)}`
    );
    const total = totalResp.data.totalSize ?? 0;
    const withData = withDataResp.data.totalSize ?? 0;
    return {
      queried: true,
      totalRecords: total,
      recordsWithData: withData,
      note:
        withData === 0
          ? "No records currently hold a value in this field — data loss is not a concern for this change."
          : `${withData} of ${total} record(s) hold a value in this field. Any change that shortens, retypes or restricts it can lose or reject that data.`,
    };
  } catch (err) {
    return {
      queried: false,
      note: `Could not count records for this field (${sanitizeError(err instanceof Error ? err.message : String(err))}). Treat the data-loss risk as UNKNOWN, not as zero.`,
    };
  }
}

// ─── Dependency query ─────────────────────────────────────────────────────────

export interface DependencyRef {
  name: string;
  type: string;
  id: string;
  namespace?: string | null;
}

interface DependencyRow {
  MetadataComponentId: string;
  MetadataComponentName: string;
  MetadataComponentType: string;
  MetadataComponentNamespace?: string | null;
  RefMetadataComponentId: string;
  RefMetadataComponentName: string;
  RefMetadataComponentType: string;
  RefMetadataComponentNamespace?: string | null;
}

async function queryDependencies(
  auth: SalesforceAuth,
  componentId: string,
  direction: "usedBy" | "uses"
): Promise<DependencyRef[]> {
  const client = createClient(auth);
  const where = direction === "usedBy" ? "RefMetadataComponentId" : "MetadataComponentId";
  const soql =
    `SELECT MetadataComponentId, MetadataComponentName, MetadataComponentType, MetadataComponentNamespace, ` +
    `RefMetadataComponentId, RefMetadataComponentName, RefMetadataComponentType, RefMetadataComponentNamespace ` +
    `FROM MetadataComponentDependency WHERE ${where} = '${soqlEscape(componentId)}' LIMIT 2000`;
  const resp = await client.get<{ records: DependencyRow[] }>(`/tooling/query?q=${encodeURIComponent(soql)}`);
  const rows = resp.data.records ?? [];
  return rows.map(r =>
    direction === "usedBy"
      ? { name: r.MetadataComponentName, type: r.MetadataComponentType, id: r.MetadataComponentId, namespace: r.MetadataComponentNamespace ?? null }
      : { name: r.RefMetadataComponentName, type: r.RefMetadataComponentType, id: r.RefMetadataComponentId, namespace: r.RefMetadataComponentNamespace ?? null }
  );
}

export interface DependencyReport {
  success: boolean;
  message: string;
  component?: { type: string; name: string; id: string };
  usedBy?: DependencyRef[];
  usedByCount?: number;
  usedByByType?: Record<string, number>;
  uses?: DependencyRef[];
  usesCount?: number;
  dataProbe?: DataProbe;
  blindSpots: readonly string[];
}

/**
 * Impact analysis for any metadata component: what references it, what it references, and — for
 * custom fields — whether it currently holds data.
 */
export async function getMetadataDependencies(
  auth: SalesforceAuth,
  params: Record<string, any>
): Promise<DependencyReport> {
  try {
    let component: ResolvedComponent;
    if (params.componentId) {
      const id = String(params.componentId).trim();
      if (!/^[A-Za-z0-9]{15,18}$/.test(id)) throw new Error(`componentId must be a 15- or 18-character Salesforce Id.`);
      component = { id, type: params.componentType ?? "Unknown", name: params.componentName ?? id };
    } else {
      if (!params.componentType || !params.componentName) {
        throw new Error("Provide either componentId, or both componentType and componentName.");
      }
      component = await resolveComponentId(auth, params.componentType, params.componentName);
    }

    const includeUses = params.includeUses === true;
    const usedBy = await queryDependencies(auth, component.id, "usedBy");
    const uses = includeUses ? await queryDependencies(auth, component.id, "uses") : undefined;

    const usedByByType: Record<string, number> = {};
    for (const d of usedBy) usedByByType[d.type] = (usedByByType[d.type] ?? 0) + 1;

    let dataProbe: DataProbe | undefined;
    if (component.type === "CustomField" && component.objectApiName && component.fieldApiName) {
      dataProbe = await probeFieldData(auth, component.objectApiName, component.fieldApiName);
    }

    const summary =
      usedBy.length === 0
        ? `No references to ${component.name} found via MetadataComponentDependency. This is NOT proof it is unused — see blindSpots.`
        : `${usedBy.length} component(s) reference ${component.name}: ${Object.entries(usedByByType).map(([t, n]) => `${n} ${t}`).join(", ")}.`;

    return {
      success: true,
      message: summary,
      component: { type: component.type, name: component.name, id: component.id },
      usedBy,
      usedByCount: usedBy.length,
      usedByByType,
      ...(uses ? { uses, usesCount: uses.length } : {}),
      ...(dataProbe ? { dataProbe } : {}),
      blindSpots: DEPENDENCY_BLIND_SPOTS,
    };
  } catch (err) {
    return {
      success: false,
      message: sanitizeError(err instanceof Error ? err.message : String(err)),
      blindSpots: DEPENDENCY_BLIND_SPOTS,
    };
  }
}

// ─── Metadata JSON → XML ──────────────────────────────────────────────────────

/**
 * Serializes a Tooling API `Metadata` JSON blob back to Metadata API XML.
 *
 * Element order follows what Salesforce itself emits in a retrieved `.object` file: `fullName`
 * first, everything else alphabetical. The Metadata API's schema is sequence-based, so arbitrary
 * key order risks an "unexpected element" rejection; matching Salesforce's own output avoids it.
 * Nulls, empty strings and empty collections are dropped rather than emitted — a null in the
 * Tooling blob means "not set", and emitting `<x/>` for it can reset a real value.
 */
export function metadataJsonToXml(value: any, indent: string): string {
  const lines: string[] = [];
  const keys = Object.keys(value).filter(k => {
    const v = value[k];
    if (v === null || v === undefined || v === "") return false;
    if (Array.isArray(v) && v.length === 0) return false;
    if (typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0) return false;
    return true;
  });
  keys.sort((a, b) => (a === "fullName" ? -1 : b === "fullName" ? 1 : a.localeCompare(b)));

  for (const key of keys) {
    const v = value[key];
    const emit = (item: any): void => {
      if (item === null || item === undefined) return;
      if (typeof item === "object" && !Array.isArray(item)) {
        lines.push(`${indent}<${key}>`);
        lines.push(metadataJsonToXml(item, `${indent}    `));
        lines.push(`${indent}</${key}>`);
      } else {
        lines.push(`${indent}<${key}>${x(String(item))}</${key}>`);
      }
    };
    if (Array.isArray(v)) v.forEach(emit);
    else emit(v);
  }
  return lines.filter(l => l.length > 0).join("\n");
}

// ─── Risk classification ──────────────────────────────────────────────────────

export type RiskTier = "SAFE" | "GUARDED" | "DESTRUCTIVE" | "REFUSE";

const TIER_RANK: Record<RiskTier, number> = { SAFE: 0, GUARDED: 1, DESTRUCTIVE: 2, REFUSE: 3 };

export interface ChangeItem {
  property: string;
  from: any;
  to: any;
  tier: RiskTier;
  reason: string;
}

function highestTier(changes: ChangeItem[]): RiskTier {
  return changes.reduce<RiskTier>((acc, c) => (TIER_RANK[c.tier] > TIER_RANK[acc] ? c.tier : acc), "SAFE");
}

const SAFE_FIELD_PROPS = new Set([
  "label", "description", "inlineHelpText", "trackHistory", "trackFeedHistory", "trackTrending",
  "visibleLines", "displayLocationInDecimal", "escapeMarkup",
]);

/** Picklist values from a Tooling `valueSet` blob, as plain API-name strings. */
function picklistValuesOf(metadata: any): string[] {
  const values = metadata?.valueSet?.valueSetDefinition?.value;
  if (!Array.isArray(values)) return [];
  return values.map((v: any) => String(v?.fullName ?? "")).filter(Boolean);
}

/**
 * Diffs requested changes against current field metadata and assigns each one a risk tier.
 *
 * `type` changes and `fullName` renames are REFUSE by deliberate policy, not by limitation:
 * Salesforce's own UI performs both through a multi-step wizard with explicit data-conversion
 * warnings, and a rename breaks every string-literal reference that no dependency API can see.
 * Neither belongs behind a single chat message.
 */
export function classifyFieldChanges(current: any, requested: Record<string, any>): ChangeItem[] {
  const changes: ChangeItem[] = [];
  const add = (property: string, from: any, to: any, tier: RiskTier, reason: string): void => {
    changes.push({ property, from: from ?? null, to, tier, reason });
  };

  if (requested.type !== undefined && String(requested.type) !== String(current.type)) {
    add("type", current.type, requested.type, "REFUSE",
      "Changing a field's data type can silently drop or mangle every stored value, and the conversion rules differ per type pair. Do this in Setup, where Salesforce shows the per-type data-loss warnings.");
  }
  if (requested.fullName !== undefined && String(requested.fullName) !== String(current.fullName)) {
    add("fullName", current.fullName, requested.fullName, "REFUSE",
      "Renaming a field's API name breaks every reference held as a string — dynamic SOQL, Apex string literals, integrations, external clients — none of which any dependency API can see. Do this in Setup.");
  }

  for (const prop of SAFE_FIELD_PROPS) {
    if (requested[prop] !== undefined && String(requested[prop]) !== String(current[prop] ?? "")) {
      add(prop, current[prop], requested[prop], "SAFE", "Presentation/metadata only — no effect on stored data or references.");
    }
  }

  for (const prop of ["length", "precision", "scale"] as const) {
    if (requested[prop] === undefined) continue;
    const from = Number(current[prop] ?? 0);
    const to = Number(requested[prop]);
    if (from === to) continue;
    if (to < from) {
      add(prop, from, to, "DESTRUCTIVE",
        `Reducing ${prop} from ${from} to ${to} truncates or rejects existing values that no longer fit.`);
    } else {
      add(prop, from, to, "GUARDED", `Increasing ${prop} is generally safe but re-shapes the field's storage.`);
    }
  }

  if (requested.required !== undefined && Boolean(requested.required) !== Boolean(current.required)) {
    add("required", Boolean(current.required), Boolean(requested.required),
      requested.required ? "GUARDED" : "SAFE",
      requested.required
        ? "Making a field required blocks saving any existing record that leaves it blank, including via integrations and Flows."
        : "Relaxing a required field imposes no constraint on existing data.");
  }
  if (requested.unique !== undefined && Boolean(requested.unique) !== Boolean(current.unique)) {
    add("unique", Boolean(current.unique), Boolean(requested.unique),
      requested.unique ? "GUARDED" : "SAFE",
      requested.unique
        ? "Enforcing uniqueness fails outright if any duplicate value already exists in the column."
        : "Removing a uniqueness constraint cannot invalidate existing data.");
  }
  if (requested.externalId !== undefined && Boolean(requested.externalId) !== Boolean(current.externalId)) {
    add("externalId", Boolean(current.externalId), Boolean(requested.externalId), "GUARDED",
      "External-ID status changes how upserts match records — integrations may begin matching (or stop matching) differently.");
  }
  if (requested.defaultValue !== undefined && String(requested.defaultValue) !== String(current.defaultValue ?? "")) {
    add("defaultValue", current.defaultValue, requested.defaultValue, "GUARDED",
      "Affects new records only; existing values are untouched.");
  }
  if (requested.referenceTo !== undefined && String(requested.referenceTo) !== String(current.referenceTo ?? "")) {
    add("referenceTo", current.referenceTo, requested.referenceTo, "DESTRUCTIVE",
      "Repointing a lookup at a different object invalidates every stored reference on existing records.");
  }

  if (Array.isArray(requested.picklistValues)) {
    const from = picklistValuesOf(current);
    const to = requested.picklistValues.map((v: any) => String(v));
    const removed = from.filter(v => !to.includes(v));
    const added = to.filter((v: string) => !from.includes(v));
    if (removed.length > 0) {
      add("picklistValues", from, to, "DESTRUCTIVE",
        `Removes ${removed.length} existing value(s): ${removed.join(", ")}. Records already holding a removed value keep it as an orphaned entry that reports and filters no longer match cleanly.`);
    } else if (added.length > 0) {
      add("picklistValues", from, to, "SAFE", `Adds ${added.length} value(s): ${added.join(", ")}. No existing value is removed.`);
    }
  }
  if (requested.restricted !== undefined) {
    const currentRestricted = Boolean(current?.valueSet?.restricted);
    if (Boolean(requested.restricted) !== currentRestricted && requested.restricted) {
      add("restricted", currentRestricted, true, "DESTRUCTIVE",
        "Restricting a picklist rejects any existing value not in the defined set, breaking saves on records that hold one.");
    }
  }

  return changes;
}

const SAFE_OBJECT_PROPS = new Set([
  "label", "pluralLabel", "description", "enableHistory", "enableReports", "enableSearch",
  "enableActivities", "enableFeeds", "enableBulkApi", "enableStreamingApi",
]);

export function classifyObjectChanges(current: any, requested: Record<string, any>): ChangeItem[] {
  const changes: ChangeItem[] = [];
  for (const prop of SAFE_OBJECT_PROPS) {
    if (requested[prop] !== undefined && String(requested[prop]) !== String(current[prop] ?? "")) {
      changes.push({ property: prop, from: current[prop] ?? null, to: requested[prop], tier: "SAFE", reason: "Presentation or feature toggle — no effect on stored data." });
    }
  }
  if (requested.sharingModel !== undefined && String(requested.sharingModel) !== String(current.sharingModel ?? "")) {
    changes.push({
      property: "sharingModel", from: current.sharingModel ?? null, to: requested.sharingModel, tier: "GUARDED",
      reason: "Changing the org-wide default triggers a full sharing recalculation and can change who can see every record of this object. On a large object this runs for a long time and is visible to users immediately.",
    });
  }
  if (requested.deploymentStatus !== undefined && String(requested.deploymentStatus) !== String(current.deploymentStatus ?? "")) {
    changes.push({
      property: "deploymentStatus", from: current.deploymentStatus ?? null, to: requested.deploymentStatus, tier: "GUARDED",
      reason: "Moving to InDevelopment hides the object from all users except those with 'Customize Application'.",
    });
  }
  return changes;
}

// ─── Scoped deploy builders ───────────────────────────────────────────────────

const OBJECT_LEVEL_KEYS = [
  "label", "pluralLabel", "description", "nameField", "deploymentStatus", "sharingModel",
  "enableActivities", "enableBulkApi", "enableFeeds", "enableHistory", "enableReports",
  "enableSearch", "enableSharing", "enableStreamingApi", "visibility", "startsWith", "gender",
  "customHelp", "customHelpPage", "household", "allowInChatterGroups", "compactLayoutAssignment",
  "externalSharingModel", "recordTypeTrackFeedHistory", "recordTypeTrackHistory",
];

/**
 * Builds a deploy zip touching exactly one custom field.
 *
 * The package.xml names a single `CustomField` member, and the `.object` file carries exactly one
 * `<fields>` entry. A Metadata API deploy merges child components — anything absent from the payload
 * is left untouched — so no other field on the object can be affected by this write. That property
 * is the entire reason this path replaced `upsertMetadata`.
 */
async function buildFieldDeployZip(objectApiName: string, fieldApiName: string, fieldMetadata: any): Promise<string> {
  const zip = new JSZip();
  const member = `${objectApiName}.${fieldApiName}`;
  zip.file("package.xml", buildPackageXml([{ name: "CustomField", members: [member] }], API_VERSION));
  const inner = metadataJsonToXml({ ...fieldMetadata, fullName: fieldApiName }, "        ");
  const objectXml =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata">\n` +
    `    <fields>\n${inner}\n    </fields>\n` +
    `</CustomObject>`;
  zip.file(`objects/${objectApiName}.object`, objectXml);
  const buffer = await zip.generateAsync({ type: "nodebuffer" });
  return buffer.toString("base64");
}

/**
 * Builds a deploy zip carrying object-level properties only.
 *
 * The payload structurally cannot contain a `<fields>`, `<validationRules>` or `<recordTypes>`
 * element, so — unlike the `readMetadata` → `upsertMetadata` round-trip this replaced — there is no
 * mechanism by which an object-level edit can damage a child component.
 */
async function buildObjectDeployZip(objectApiName: string, objectMetadata: any): Promise<string> {
  const zip = new JSZip();
  zip.file("package.xml", buildPackageXml([{ name: "CustomObject", members: [objectApiName] }], API_VERSION));
  const scoped: Record<string, any> = {};
  for (const k of OBJECT_LEVEL_KEYS) if (objectMetadata[k] !== undefined && objectMetadata[k] !== null) scoped[k] = objectMetadata[k];
  const inner = metadataJsonToXml(scoped, "    ");
  const objectXml =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata">\n${inner}\n</CustomObject>`;
  zip.file(`objects/${objectApiName}.object`, objectXml);
  const buffer = await zip.generateAsync({ type: "nodebuffer" });
  return buffer.toString("base64");
}

// ─── Tooling reads ────────────────────────────────────────────────────────────

async function readToolingMetadata(auth: SalesforceAuth, sobject: string, id: string): Promise<any> {
  const client = createClient(auth);
  const resp = await client.get<{ FullName?: string; Metadata: any }>(`/tooling/sobjects/${sobject}/${id}`);
  const md = resp.data?.Metadata;
  if (!md) throw new Error(`Tooling API returned no Metadata for ${sobject} ${id}.`);
  return { ...md, fullName: resp.data.FullName ?? md.fullName };
}

/**
 * Child elements of a CustomObject that are COLLECTIONS, not object-level properties.
 *
 * These are stripped before any scalar parsing so that, for example, a `<label>` belonging to a
 * field or a record type can never be mistaken for the object's own label. They are also the exact
 * set that must never reach a write payload.
 */
const OBJECT_CHILD_COLLECTIONS = [
  "fields", "validationRules", "listViews", "recordTypes", "webLinks", "compactLayouts",
  "searchLayouts", "actionOverrides", "businessProcesses", "fieldSets", "sharingReasons",
  "indexes", "namedFilters", "historyRetentionPolicy", "profileSearchLayouts", "sharingRecalculations",
];

/** Matches an element by local name, tolerating any namespace prefix (`met:label`, `label`, ...). */
function tagRe(tag: string, flags: string): RegExp {
  return new RegExp(`<(?:\\w+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:\\w+:)?${tag}>`, flags);
}

function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&#39;/g, "'").replace(/&amp;/g, "&");
}

/**
 * Reads a CustomObject's OBJECT-LEVEL properties via the Metadata API.
 *
 * The Tooling API cannot serve this: `CustomObject` exposes no `Metadata` field on the REST retrieve
 * and no `Metadata` column in SOQL (verified live 2026-08-11 — the retrieve returns only
 * DeveloperName/Description/SharingModel and a SOQL `SELECT Metadata` errors with "No such column").
 * So `readMetadata` is the only source, and this parses it defensively:
 *
 *   1. every child COLLECTION is deleted from the XML first, so no nested `<label>` from a field or
 *      record type can be scraped as if it were the object's own,
 *   2. only then are top-level scalars read,
 *   3. `nameField` is parsed explicitly because it is a required nested element on write.
 *
 * The result feeds a whitelist-built payload, never a write-back of the parsed blob — which is the
 * distinction that made the previous implementation dangerous.
 */
async function readObjectMetadataViaSoap(auth: SalesforceAuth, objectApiName: string): Promise<any> {
  const xml = await callMetadataSoap(
    auth,
    "readMetadata",
    `<met:readMetadata><met:type>CustomObject</met:type><met:fullNames>${x(objectApiName)}</met:fullNames></met:readMetadata>`
  );
  const record = tagRe("records", "i").exec(xml);
  if (!record) throw new Error(`Object '${objectApiName}' not found, or readMetadata returned no record for it.`);

  let inner = record[1];
  for (const child of OBJECT_CHILD_COLLECTIONS) inner = inner.replace(tagRe(child, "gi"), "");

  const result: Record<string, any> = { fullName: objectApiName };

  const nameFieldMatch = tagRe("nameField", "i").exec(inner);
  if (nameFieldMatch) {
    const nf: Record<string, any> = {};
    for (const key of ["type", "label", "displayFormat", "trackHistory", "trackFeedHistory", "startingNumber"]) {
      const m = tagRe(key, "i").exec(nameFieldMatch[1]);
      if (m) nf[key] = unescapeXml(m[1].trim());
    }
    if (Object.keys(nf).length > 0) result.nameField = nf;
    inner = inner.replace(tagRe("nameField", "gi"), "");
  }

  for (const key of OBJECT_LEVEL_KEYS) {
    if (key === "nameField") continue;
    const m = tagRe(key, "i").exec(inner);
    if (!m) continue;
    const raw = unescapeXml(m[1].trim());
    result[key] = raw === "true" ? true : raw === "false" ? false : raw;
  }
  return result;
}

// ─── Safe update: custom field ────────────────────────────────────────────────

export interface UpdateResult {
  success: boolean;
  message: string;
  applied: boolean;
  status: "APPLIED" | "NO_CHANGES" | "CONFIRMATION_REQUIRED" | "REFUSED" | "VALIDATION_FAILED" | "ERROR";
  riskTier?: RiskTier;
  changes?: ChangeItem[];
  impact?: {
    dependencies: DependencyRef[];
    dependencyCount: number;
    dataProbe?: DataProbe;
    validation?: { passed: boolean; message: string };
    blindSpots: readonly string[];
  };
  nextStep?: string;
}

/**
 * Applies field changes through: Tooling read → merge → classify → (gate) → checkOnly → deploy.
 *
 * The gate is deliberately a hard stop rather than a warning attached to a completed write. A
 * warning that arrives alongside "done" is not a safety control.
 */
export async function updateCustomFieldSafe(auth: SalesforceAuth, params: Record<string, any>): Promise<UpdateResult> {
  try {
    const objectApiName = assertApiName(params.objectApiName ?? params.objectName, "objectApiName");
    const fieldApiName = assertApiName(params.fieldApiName ?? params.fieldName, "fieldApiName");
    const resolved = await resolveComponentId(auth, "CustomField", `${objectApiName}.${fieldApiName}`);
    const current = await readToolingMetadata(auth, "CustomField", resolved.id);

    const requested: Record<string, any> = {};
    for (const k of [
      "label", "description", "inlineHelpText", "required", "unique", "externalId", "defaultValue",
      "length", "precision", "scale", "type", "fullName", "referenceTo", "trackHistory",
      "trackFeedHistory", "trackTrending", "visibleLines", "picklistValues", "restricted",
    ]) {
      if (params[k] !== undefined) requested[k] = params[k];
    }
    if (params.helpText !== undefined) requested.inlineHelpText = params.helpText;

    const changes = classifyFieldChanges(current, requested);
    if (changes.length === 0) {
      return { success: true, applied: false, status: "NO_CHANGES", message: `No changes needed — ${objectApiName}.${fieldApiName} already matches the requested values.` };
    }

    const refused = changes.filter(c => c.tier === "REFUSE");
    if (refused.length > 0) {
      return {
        success: false, applied: false, status: "REFUSED", riskTier: "REFUSE", changes,
        message: `Refused: ${refused.map(c => c.property).join(", ")} cannot be changed through this tool. ${refused.map(c => c.reason).join(" ")}`,
        nextStep: `Make this change in Salesforce Setup → Object Manager → ${objectApiName} → Fields & Relationships → ${fieldApiName}, where Salesforce shows the data-conversion consequences before committing.`,
      };
    }

    // Merge onto the full current definition so the deploy carries a complete field, not a fragment.
    const merged: Record<string, any> = { ...current };
    for (const [k, v] of Object.entries(requested)) {
      if (k === "picklistValues") {
        merged.valueSet = {
          ...(current.valueSet ?? {}),
          valueSetDefinition: {
            ...(current.valueSet?.valueSetDefinition ?? {}),
            sorted: current.valueSet?.valueSetDefinition?.sorted ?? false,
            value: (v as any[]).map((pv: any) =>
              typeof pv === "string" ? { fullName: pv, label: pv, default: false } : pv
            ),
          },
        };
      } else if (k === "restricted") {
        merged.valueSet = { ...(current.valueSet ?? {}), restricted: Boolean(v) };
      } else if (k !== "type" && k !== "fullName") {
        merged[k] = v;
      }
    }
    delete merged.fullName;

    const tier = highestTier(changes);
    const zip = await buildFieldDeployZip(objectApiName, fieldApiName, merged);

    if (tier === "SAFE") {
      const deployId = await deployZip(auth, zip, { rollbackOnError: true });
      const result = await pollDeployStatus(auth, deployId, 5 * 60 * 1000);
      return {
        success: result.success, applied: result.success,
        status: result.success ? "APPLIED" : "VALIDATION_FAILED", riskTier: tier, changes,
        message: result.success ? `Applied ${changes.length} safe change(s) to ${objectApiName}.${fieldApiName}.` : result.message,
      };
    }

    // GUARDED / DESTRUCTIVE — gather evidence before anything is written.
    const dependencies = await queryDependencies(auth, resolved.id, "usedBy");
    const dataProbe = await probeFieldData(auth, objectApiName, fieldApiName);
    const checkId = await deployZip(auth, zip, { checkOnly: true, rollbackOnError: true });
    const checkResult = await pollDeployStatus(auth, checkId, 5 * 60 * 1000);
    const impact = {
      dependencies, dependencyCount: dependencies.length, dataProbe,
      validation: { passed: checkResult.success, message: checkResult.message },
      blindSpots: DEPENDENCY_BLIND_SPOTS,
    };

    if (!checkResult.success) {
      return {
        success: false, applied: false, status: "VALIDATION_FAILED", riskTier: tier, changes, impact,
        message: `Salesforce rejected this change during validation, so it was not applied: ${checkResult.message}`,
      };
    }

    if (params.confirmImpact !== true) {
      return {
        success: false, applied: false, status: "CONFIRMATION_REQUIRED", riskTier: tier, changes, impact,
        message:
          `NOT APPLIED — this is a ${tier} change to ${objectApiName}.${fieldApiName} and needs confirmation. ` +
          `${changes.length} change(s); ${dependencies.length} component(s) reference this field; ${dataProbe.note} ` +
          `Salesforce's validate-only deploy passed.`,
        nextStep: "Review the impact above with the user, then call this tool again with confirmImpact: true to apply it.",
      };
    }

    const deployId = await deployZip(auth, zip, { rollbackOnError: true });
    const result = await pollDeployStatus(auth, deployId, 5 * 60 * 1000);
    return {
      success: result.success, applied: result.success,
      status: result.success ? "APPLIED" : "VALIDATION_FAILED", riskTier: tier, changes, impact,
      message: result.success
        ? `Applied ${changes.length} confirmed ${tier} change(s) to ${objectApiName}.${fieldApiName}.`
        : result.message,
    };
  } catch (err) {
    return { success: false, applied: false, status: "ERROR", message: sanitizeError(err instanceof Error ? err.message : String(err)) };
  }
}

// ─── Safe update: custom object ───────────────────────────────────────────────

export async function updateCustomObjectSafe(auth: SalesforceAuth, params: Record<string, any>): Promise<UpdateResult> {
  try {
    const objectApiName = assertApiName(params.objectApiName ?? params.fullName, "objectApiName");
    if (!/__c$/i.test(objectApiName)) {
      return {
        success: false, applied: false, status: "REFUSED",
        message: `'${objectApiName}' is not a custom object. Standard objects cannot have their object-level definition deployed this way.`,
        nextStep: "Use Setup → Object Manager for standard-object settings.",
      };
    }
    const resolved = await resolveComponentId(auth, "CustomObject", objectApiName);
    const current = await readObjectMetadataViaSoap(auth, objectApiName);

    const requested: Record<string, any> = {};
    for (const k of [
      "label", "pluralLabel", "description", "enableHistory", "enableReports", "enableSearch",
      "enableActivities", "enableFeeds", "enableBulkApi", "enableStreamingApi", "sharingModel",
      "deploymentStatus",
    ]) {
      if (params[k] !== undefined) requested[k] = params[k];
    }

    const changes = classifyObjectChanges(current, requested);
    if (changes.length === 0) {
      return { success: true, applied: false, status: "NO_CHANGES", message: `No changes needed — ${objectApiName} already matches the requested values.` };
    }

    const merged = { ...current, ...requested };
    const tier = highestTier(changes);
    const zip = await buildObjectDeployZip(objectApiName, merged);

    if (tier === "SAFE") {
      const deployId = await deployZip(auth, zip, { rollbackOnError: true });
      const result = await pollDeployStatus(auth, deployId, 5 * 60 * 1000);
      return {
        success: result.success, applied: result.success,
        status: result.success ? "APPLIED" : "VALIDATION_FAILED", riskTier: tier, changes,
        message: result.success ? `Applied ${changes.length} safe change(s) to ${objectApiName}.` : result.message,
      };
    }

    const dependencies = await queryDependencies(auth, resolved.id, "usedBy");
    const checkId = await deployZip(auth, zip, { checkOnly: true, rollbackOnError: true });
    const checkResult = await pollDeployStatus(auth, checkId, 5 * 60 * 1000);
    const impact = {
      dependencies, dependencyCount: dependencies.length,
      validation: { passed: checkResult.success, message: checkResult.message },
      blindSpots: DEPENDENCY_BLIND_SPOTS,
    };

    if (!checkResult.success) {
      return {
        success: false, applied: false, status: "VALIDATION_FAILED", riskTier: tier, changes, impact,
        message: `Salesforce rejected this change during validation, so it was not applied: ${checkResult.message}`,
      };
    }

    if (params.confirmImpact !== true) {
      return {
        success: false, applied: false, status: "CONFIRMATION_REQUIRED", riskTier: tier, changes, impact,
        message:
          `NOT APPLIED — this is a ${tier} change to ${objectApiName} and needs confirmation. ` +
          `${changes.map(c => c.property).join(", ")}; ${dependencies.length} component(s) reference this object. ` +
          `Salesforce's validate-only deploy passed.`,
        nextStep: "Review the impact above with the user, then call this tool again with confirmImpact: true to apply it.",
      };
    }

    const deployId = await deployZip(auth, zip, { rollbackOnError: true });
    const result = await pollDeployStatus(auth, deployId, 5 * 60 * 1000);
    return {
      success: result.success, applied: result.success,
      status: result.success ? "APPLIED" : "VALIDATION_FAILED", riskTier: tier, changes, impact,
      message: result.success ? `Applied ${changes.length} confirmed ${tier} change(s) to ${objectApiName}.` : result.message,
    };
  } catch (err) {
    return { success: false, applied: false, status: "ERROR", message: sanitizeError(err instanceof Error ? err.message : String(err)) };
  }
}
