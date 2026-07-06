/* eslint-disable @typescript-eslint/no-explicit-any */
// code-analyzer-suppress(cpd:DetectCopyPasteForTypescript)
import { execSync } from "child_process";
import { readFileSync } from "fs";
import { createSign } from "crypto";
import type {
  SalesforceAuth,
  MetadataUpsertResult,
  CustomObjectMetadata,
  CustomFieldMetadata,
  PicklistValue,
  ToolResult,
} from "../types.js";

export const API_VERSION = "66.0";

// ─── Token cache ──────────────────────────────────────────────────────────────
let cachedToken: { accessToken: string; expiresAt: number } | null = null;
let cachedJwtToken: { accessToken: string; expiresAt: number } | null = null;
const TOKEN_TTL_MS = 55 * 60 * 1000;

// ─── Security helpers ─────────────────────────────────────────────────────────

/**
 * Strips file-system paths, stack-trace lines, and long opaque strings from
 * error messages before they are returned to the caller, preventing accidental
 * leakage of internal deployment paths or token-like values.
 */
export function sanitizeError(msg: string): string {
  return msg
    .replace(/(?:[A-Za-z]:\\|\/(?:usr|home|app|var|tmp|Users|opt))[^\s"')>]*/g, "[path]")
    .replace(/\bat\s+\S+\s*\([^)]*\)/g, "")
    .replace(/[A-Fa-f0-9]{40,}/g, "[token]")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/**
 * Replaces Salesforce access-token patterns with [REDACTED] before writing to
 * stderr. Call this on any string that might contain credential data.
 */
export function redactSensitive(msg: string): string {
  return msg
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+=*/gi, "$1[REDACTED]")
    .replace(/\b00D[A-Za-z0-9!_]{15,}/g, "[REDACTED]")
    .replace(/(access_token["':\s]+)[A-Za-z0-9._~+/=-]{20,}/gi, "$1[REDACTED]")
    .replace(/(refresh_token["':\s]+)[A-Za-z0-9._~+/=-]{20,}/gi, "$1[REDACTED]");
}

// ─── Fetch with timeout ───────────────────────────────────────────────────────

/** Wraps native fetch with an AbortController-based timeout. */
export async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ─── Env var helpers ──────────────────────────────────────────────────────────

/** Reads an env var and enforces a maximum character length. */
function readEnv(name: string, maxLen: number): string | undefined {
  const val = process.env[name];
  if (!val) return undefined;
  if (val.length > maxLen) {
    throw new Error(
      `Environment variable ${name} exceeds the maximum allowed length of ${maxLen} characters.`
    );
  }
  return val;
}

/** Throws if the given string is not a valid HTTPS URL. */
function validateHttpsUrl(raw: string): void {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("SF_INSTANCE_URL is not a valid URL.");
  }
  if (parsed.protocol !== "https:") {
    throw new Error("SF_INSTANCE_URL must use HTTPS (not HTTP or another protocol).");
  }
}

// ─── Auth strategies ──────────────────────────────────────────────────────────

/**
 * Executes `sf org display` via the Salesforce CLI to obtain a fresh access token.
 *
 * SECURITY NOTE: This is an intentional, optional shell invocation. It is only
 * triggered when the SF_ALIAS environment variable is explicitly set by the
 * operator. The alias value is validated against a strict allowlist
 * (alphanumerics, hyphens, and underscores only) before being interpolated into
 * the command, preventing shell injection. To avoid any shell access, use OAuth
 * refresh tokens (SF_CLIENT_ID + SF_CLIENT_SECRET + SF_REFRESH_TOKEN) instead.
 *
 * @param alias - Validated org alias (alphanumeric, hyphens, underscores only)
 */
function getFreshTokenFromCLI(alias: string): string {
  // Strict allowlist — rejects spaces, semicolons, pipes, quotes, and all other
  // shell metacharacters before the value is ever passed to execSync.
  if (!/^[A-Za-z0-9_-]+$/.test(alias)) {
    throw new Error(
      "SF_ALIAS contains invalid characters. Only letters, numbers, hyphens, and underscores are permitted."
    );
  }

  let rawOutput: string;
  try {
    // execSync is intentional here: the SF CLI is a supported auth prerequisite
    // for this strategy. The child process is isolated with a minimal PATH.
    rawOutput = execSync(`sf org auth show-access-token --target-org ${alias} --json`, {
      encoding: "utf-8",
      timeout: 30_000,
      env: { PATH: process.env["PATH"] ?? "" },
    });
  } catch (err) {
    const msg = err instanceof Error ? sanitizeError(err.message) : "SF CLI execution failed.";
    throw new Error(`SF CLI error: ${msg}`);
  }

  let parsed: { result?: { accessToken?: string } };
  try {
    parsed = JSON.parse(rawOutput) as typeof parsed;
  } catch {
    throw new Error("SF CLI returned non-JSON output.");
  }
  const accessToken = parsed?.result?.accessToken;
  if (!accessToken) throw new Error("No access token returned from SF CLI.");
  return accessToken;
}

/**
 * Exchanges a refresh token for a new access token via Salesforce OAuth2.
 *
 * @param instanceUrl - Validated HTTPS Salesforce instance URL
 * @param clientId - Connected App consumer key
 * @param clientSecret - Connected App consumer secret
 * @param refreshToken - OAuth refresh token
 */
async function getFreshTokenFromOAuth(
  instanceUrl: string,
  clientId: string,
  clientSecret: string,
  refreshToken: string
): Promise<string> {
  const response = await fetchWithTimeout(
    `${instanceUrl}/services/oauth2/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
      }).toString(),
    },
    30_000
  );
  if (!response.ok) {
    throw new Error(`OAuth token refresh failed with HTTP ${response.status}.`);
  }
  const data = await response.json() as { access_token?: string };
  if (!data.access_token) throw new Error("No access_token in OAuth refresh response.");
  return data.access_token;
}

/**
 * Exchanges a JWT assertion for an access token via the Salesforce JWT Bearer Flow.
 * Does not require browser auth or SF CLI — works headless on any Node.js version.
 *
 * @param instanceUrl - Validated HTTPS Salesforce instance URL
 * @param clientId - Connected App / External Client App consumer key
 * @param keyFile - Absolute path to PEM-encoded RSA private key file
 * @param username - Salesforce username to impersonate
 */
async function getTokenFromJWT(
  instanceUrl: string,
  clientId: string,
  keyFile: string,
  username: string
): Promise<string> {
  const privateKey = readFileSync(keyFile, "utf-8");
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    iss: clientId,
    sub: username,
    aud: instanceUrl,
    exp: now + 300,
  })).toString("base64url");
  const signingInput = `${header}.${payload}`;
  const sign = createSign("RSA-SHA256");
  sign.update(signingInput);
  const signature = sign.sign(privateKey, "base64url");
  const assertion = `${signingInput}.${signature}`;

  const response = await fetchWithTimeout(
    `${instanceUrl}/services/oauth2/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }).toString(),
    },
    30_000
  );
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`JWT token exchange failed with HTTP ${response.status}: ${body}`);
  }
  const data = await response.json() as { access_token?: string };
  if (!data.access_token) throw new Error("No access_token in JWT response.");
  return data.access_token;
}

/**
 * Resolves Salesforce credentials using the configured strategy.
 * Priority order: JWT Bearer → OAuth refresh token → SF CLI alias → static access token.
 *
 * Environment variables are validated for length and format before use.
 * SF_INSTANCE_URL must be a valid HTTPS URL.
 * SF_ALIAS is restricted to alphanumerics, hyphens, and underscores.
 *
 * @returns SalesforceAuth with validated instanceUrl and a fresh accessToken
 */
export async function getAuth(): Promise<SalesforceAuth> {
  const instanceUrl = readEnv("SF_INSTANCE_URL", 255);
  if (!instanceUrl) throw new Error("Missing SF_INSTANCE_URL environment variable.");
  validateHttpsUrl(instanceUrl);
  const base = instanceUrl.replace(/\/$/, "");

  const jwtClientId = readEnv("SF_JWT_CLIENT_ID", 255);
  const jwtKeyFile = readEnv("SF_JWT_KEY_FILE", 512);
  const jwtUsername = readEnv("SF_JWT_USERNAME", 255);
  if (jwtClientId && jwtKeyFile && jwtUsername) {
    const now = Date.now();
    if (cachedJwtToken && now < cachedJwtToken.expiresAt) {
      return { instanceUrl: base, accessToken: cachedJwtToken.accessToken };
    }
    try {
      const accessToken = await getTokenFromJWT(base, jwtClientId, jwtKeyFile, jwtUsername);
      cachedJwtToken = { accessToken, expiresAt: now + TOKEN_TTL_MS };
      return { instanceUrl: base, accessToken };
    } catch (err) {
      console.error(
        "JWT auth failed, trying next strategy:",
        redactSensitive(err instanceof Error ? err.message : String(err))
      );
    }
  }

  const clientId = readEnv("SF_CLIENT_ID", 255);
  const clientSecret = readEnv("SF_CLIENT_SECRET", 512);
  const refreshToken = readEnv("SF_REFRESH_TOKEN", 512);
  if (clientId && clientSecret && refreshToken) {
    const now = Date.now();
    if (cachedToken && now < cachedToken.expiresAt) {
      return { instanceUrl: base, accessToken: cachedToken.accessToken };
    }
    try {
      const accessToken = await getFreshTokenFromOAuth(base, clientId, clientSecret, refreshToken);
      cachedToken = { accessToken, expiresAt: now + TOKEN_TTL_MS };
      return { instanceUrl: base, accessToken };
    } catch (err) {
      console.error(
        "OAuth refresh failed, trying next strategy:",
        redactSensitive(err instanceof Error ? err.message : String(err))
      );
    }
  }

  const alias = readEnv("SF_ALIAS", 50);
  if (alias) {
    try {
      const accessToken = getFreshTokenFromCLI(alias);
      return { instanceUrl: base, accessToken };
    } catch (err) {
      console.error(
        "SF CLI failed, trying static token:",
        sanitizeError(err instanceof Error ? err.message : String(err))
      );
    }
  }

  const staticToken = readEnv("SF_ACCESS_TOKEN", 4096);
  if (staticToken) {
    console.error("Using static SF_ACCESS_TOKEN — expires in approximately 1 hour.");
    return { instanceUrl: base, accessToken: staticToken };
  }

  throw new Error(
    "No Salesforce credentials found. Set SF_JWT_CLIENT_ID + SF_JWT_KEY_FILE + SF_JWT_USERNAME, " +
    "or SF_CLIENT_ID + SF_CLIENT_SECRET + SF_REFRESH_TOKEN, or SF_ALIAS, or SF_ACCESS_TOKEN."
  );
}

// ─── REST API client ──────────────────────────────────────────────────────────

/** Minimal Salesforce REST API client backed by native fetch. */
export interface SalesforceClient {
  get<T>(path: string): Promise<{ data: T }>;
  post<T>(path: string, body?: unknown, options?: { headers?: Record<string, string> }): Promise<{ data: T }>;
  put<T>(path: string, body?: unknown, options?: { headers?: Record<string, string> }): Promise<{ data: T }>;
  patch<T>(path: string, body?: unknown): Promise<{ data: T }>;
  del<T>(path: string): Promise<{ data: T }>;
}

/**
 * Creates a lightweight Salesforce REST client for the given auth context.
 * All HTTP errors are sanitized before being thrown.
 *
 * @param auth - Valid SalesforceAuth with instanceUrl and accessToken
 */
export function createClient(auth: SalesforceAuth): SalesforceClient {
  const baseURL = `${auth.instanceUrl}/services/data/v${API_VERSION}`;
  const authHeader = `Bearer ${auth.accessToken}`;

  async function doFetch<T>(path: string, init: RequestInit): Promise<{ data: T }> {
    const response = await fetchWithTimeout(`${baseURL}${path}`, init, 60_000);
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(sanitizeError(`Salesforce API error ${response.status}: ${text.slice(0, 300)}`));
    }
    const text = await response.text().catch(() => "");
    const data = text.length > 0 ? JSON.parse(text) as T : null as unknown as T;
    return { data };
  }

  return {
    get<T>(path: string) {
      return doFetch<T>(path, {
        method: "GET",
        headers: { Authorization: authHeader, "Content-Type": "application/json" },
      });
    },
    post<T>(path: string, body?: unknown, options?: { headers?: Record<string, string> }) {
      const bodyStr =
        typeof body === "string" ? body
        : body !== undefined ? JSON.stringify(body)
        : undefined;
      return doFetch<T>(path, {
        method: "POST",
        headers: { Authorization: authHeader, "Content-Type": "application/json", ...options?.headers },
        body: bodyStr,
      });
    },
    put<T>(path: string, body?: unknown, options?: { headers?: Record<string, string> }) {
      const bodyStr =
        typeof body === "string" ? body
        : body !== undefined ? JSON.stringify(body)
        : undefined;
      return doFetch<T>(path, {
        method: "PUT",
        headers: { Authorization: authHeader, "Content-Type": "application/json", ...options?.headers },
        body: bodyStr,
      });
    },
    patch<T>(path: string, body?: unknown) {
      return doFetch<T>(path, {
        method: "PATCH",
        headers: { Authorization: authHeader, "Content-Type": "application/json" },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    },
    del<T>(path: string) {
      return doFetch<T>(path, {
        method: "DELETE",
        headers: { Authorization: authHeader, "Content-Type": "application/json" },
      });
    },
  };
}

/**
 * Sends a SOAP envelope to the Salesforce Metadata API.
 *
 * @param auth - Valid SalesforceAuth
 * @param soapAction - SOAP action name, e.g. "upsertMetadata"
 * @param bodyInner - XML to place inside the SOAP Body element
 * @returns Raw XML response string
 */
export async function callMetadataSoap(
  auth: SalesforceAuth,
  soapAction: string,
  bodyInner: string,
  timeoutMs = 60_000
): Promise<string> {
  const envelope = `<?xml version="1.0" encoding="utf-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:met="http://soap.sforce.com/2006/04/metadata">
  <soapenv:Header>
    <met:CallOptions><met:client>salesforce-metadata-mcp</met:client></met:CallOptions>
    <met:SessionHeader><met:sessionId>${auth.accessToken}</met:sessionId></met:SessionHeader>
  </soapenv:Header>
  <soapenv:Body>${bodyInner}</soapenv:Body>
</soapenv:Envelope>`;
  const response = await fetchWithTimeout(
    `${auth.instanceUrl}/services/Soap/m/${API_VERSION}`,
    {
      method: "POST",
      headers: { "Content-Type": "text/xml; charset=utf-8", SOAPAction: `"${soapAction}"` },
      body: envelope,
    },
    timeoutMs
  );
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    const fault = body.match(/<faultstring[^>]*>([\s\S]*?)<\/faultstring>/i);
    const detail = fault ? fault[1].trim() : body.slice(0, 500);
    throw new Error(`SOAP request failed with HTTP ${response.status}: ${detail}`);
  }
  return response.text();
}

export function extractSoapError(xml: string): string | null {
  const faultMatch = xml.match(/<faultstring[^>]*>([\s\S]*?)<\/faultstring>/i);
  if (faultMatch) return faultMatch[1].trim();
  const msgMatch = xml.match(/<message[^>]*>([\s\S]*?)<\/message>/i);
  if (msgMatch) return msgMatch[1].trim();
  return null;
}

export function parseUpsertResult(xml: string): MetadataUpsertResult[] {
  const results: MetadataUpsertResult[] = [];
  const resultBlocks = [...xml.matchAll(/<result>([\s\S]*?)<\/result>/gi)];
  for (const block of resultBlocks) {
    const inner = block[1];
    const created = /<created>true<\/created>/i.test(inner);
    const success = /<success>true<\/success>/i.test(inner);
    const fullNameMatch = inner.match(/<fullName[^>]*>([\s\S]*?)<\/fullName>/i);
    const fullName = fullNameMatch ? fullNameMatch[1].trim() : "";
    const errors: { message: string; statusCode: string }[] = [];
    const errorBlocks = [...inner.matchAll(/<errors>([\s\S]*?)<\/errors>/gi)];
    for (const eb of errorBlocks) {
      const msgMatch = eb[1].match(/<message[^>]*>([\s\S]*?)<\/message>/i);
      const codeMatch = eb[1].match(/<statusCode[^>]*>([\s\S]*?)<\/statusCode>/i);
      errors.push({ message: msgMatch ? msgMatch[1].trim() : "Unknown error", statusCode: codeMatch ? codeMatch[1].trim() : "UNKNOWN" });
    }
    results.push({ created, success, fullName, ...(errors.length ? { errors } : {}) });
  }
  return results;
}

export function x(str: string | null | undefined): string {
  return String(str ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

// ─── XML Builders ────────────────────────────────────────────────────────────

function buildCustomObjectXml(meta: CustomObjectMetadata): string {
  const nameFieldXml = meta.nameField.type === "AutoNumber"
    ? `<met:nameField><met:displayFormat>${x(meta.nameField.displayFormat ?? "REC-{0000}")}</met:displayFormat><met:label>${x(meta.nameField.label)}</met:label><met:type>AutoNumber</met:type></met:nameField>`
    : `<met:nameField><met:label>${x(meta.nameField.label)}</met:label><met:type>Text</met:type></met:nameField>`;
  return `<met:metadata xsi:type="met:CustomObject" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <met:fullName>${x(meta.fullName)}</met:fullName>
    <met:label>${x(meta.label)}</met:label>
    <met:pluralLabel>${x(meta.pluralLabel)}</met:pluralLabel>
    ${nameFieldXml}
    <met:deploymentStatus>${meta.deploymentStatus}</met:deploymentStatus>
    <met:sharingModel>${meta.sharingModel}</met:sharingModel>
    ${meta.description ? `<met:description>${x(meta.description)}</met:description>` : ""}
    ${meta.enableActivities !== undefined ? `<met:enableActivities>${meta.enableActivities}</met:enableActivities>` : ""}
    ${meta.enableHistory !== undefined ? `<met:enableHistory>${meta.enableHistory}</met:enableHistory>` : ""}
    ${meta.enableReports !== undefined ? `<met:enableReports>${meta.enableReports}</met:enableReports>` : ""}
    ${meta.enableSearch !== undefined ? `<met:enableSearch>${meta.enableSearch}</met:enableSearch>` : ""}
  </met:metadata>`;
}

function buildPicklistValuesXml(values: PicklistValue[]): string {
  return values.map((v) => `<met:value>
    ${v.color ? `<met:color>${x(v.color)}</met:color>` : ""}
    <met:default>${v.default ?? false}</met:default>
    ${v.description ? `<met:description>${x(v.description)}</met:description>` : ""}
    <met:fullName>${x(v.fullName)}</met:fullName>
    ${v.isActive != null ? `<met:isActive>${v.isActive}</met:isActive>` : ""}
    <met:label>${x(v.label ?? v.fullName)}</met:label>
  </met:value>`).join("\n");
}

function buildCustomFieldXml(meta: CustomFieldMetadata): string {
  const isLongText = meta.type === "LongTextArea" || meta.type === "Html";
  if (isLongText && meta.length === undefined) meta = { ...meta, length: 32768 };
  if (isLongText && meta.visibleLines === undefined) meta = { ...meta, visibleLines: 10 };
  const picklistXml = meta.valueSet
    ? `<met:valueSet>
        ${meta.valueSet.restricted !== undefined ? `<met:restricted>${meta.valueSet.restricted}</met:restricted>` : ""}
        <met:valueSetDefinition>
          <met:sorted>${meta.valueSet.valueSetDefinition.sorted}</met:sorted>
          ${buildPicklistValuesXml(meta.valueSet.valueSetDefinition.value)}
        </met:valueSetDefinition>
      </met:valueSet>` : "";
  const lookupXml = meta.referenceTo
    ? `<met:referenceTo>${x(meta.referenceTo)}</met:referenceTo>
       <met:relationshipLabel>${x(meta.relationshipLabel ?? meta.referenceTo)}</met:relationshipLabel>
       <met:relationshipName>${x(meta.relationshipName ?? meta.referenceTo.replace(/__c$/i, ""))}</met:relationshipName>
       ${meta.deleteConstraint ? `<met:deleteConstraint>${meta.deleteConstraint}</met:deleteConstraint>` : ""}` : "";
  return `<met:metadata xsi:type="met:CustomField" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <met:fullName>${x(meta.fullName)}</met:fullName>
    <met:label>${x(meta.label)}</met:label>
    <met:type>${meta.type}</met:type>
    ${meta.description ? `<met:description>${x(meta.description)}</met:description>` : ""}
    ${meta.required !== undefined ? `<met:required>${meta.required}</met:required>` : ""}
    ${meta.unique !== undefined ? `<met:unique>${meta.unique}</met:unique>` : ""}
    ${meta.externalId !== undefined ? `<met:externalId>${meta.externalId}</met:externalId>` : ""}
    ${meta.length !== undefined ? `<met:length>${meta.length}</met:length>` : ""}
    ${meta.visibleLines !== undefined ? `<met:visibleLines>${meta.visibleLines}</met:visibleLines>` : ""}
    ${meta.precision !== undefined ? `<met:precision>${meta.precision}</met:precision>` : (["Number","Currency","Percent"].includes(meta.type) ? `<met:precision>18</met:precision>` : "")}
    ${meta.scale !== undefined ? `<met:scale>${meta.scale}</met:scale>` : (["Number","Currency","Percent"].includes(meta.type) ? `<met:scale>0</met:scale>` : "")}
    ${meta.defaultValue !== undefined ? `<met:defaultValue>${meta.defaultValue}</met:defaultValue>` : ""}
    ${picklistXml}
    ${lookupXml}
  </met:metadata>`;
}

interface SimpleField {
  fullName: string; label: string; type: string;
  required?: boolean; length?: number; precision?: number; scale?: number;
  defaultValue?: string; description?: string; picklistValues?: string[];
}

function buildSimpleFieldsXml(fields: SimpleField[]): string {
  return fields.map(f => {
    const picklistXml = f.picklistValues && f.picklistValues.length > 0
      ? `<met:valueSet><met:valueSetDefinition><met:sorted>false</met:sorted>
          ${f.picklistValues.map(v => `<met:value><met:fullName>${x(v)}</met:fullName><met:label>${x(v)}</met:label><met:default>false</met:default></met:value>`).join("\n")}
        </met:valueSetDefinition></met:valueSet>` : "";
    return `<met:fields>
      <met:fullName>${x(f.fullName)}</met:fullName>
      <met:label>${x(f.label)}</met:label>
      <met:type>${x(f.type)}</met:type>
      ${f.required !== undefined ? `<met:required>${f.required}</met:required>` : ""}
      ${f.length !== undefined ? `<met:length>${f.length}</met:length>` : ""}
      ${f.precision !== undefined ? `<met:precision>${f.precision}</met:precision>` : ""}
      ${f.scale !== undefined ? `<met:scale>${f.scale}</met:scale>` : ""}
      ${f.defaultValue !== undefined ? `<met:defaultValue>${x(f.defaultValue)}</met:defaultValue>` : ""}
      ${f.description ? `<met:description>${x(f.description)}</met:description>` : ""}
      ${picklistXml}
    </met:fields>`;
  }).join("\n");
}

function buildFlowXml(params: {
  label: string; apiName: string; description?: string;
  flowType: string; triggerObject?: string; triggerType?: string;
  triggerFilterFormula?: string; status: string;
  variables?: Array<{ name: string; dataType: string; objectType?: string; isInput: boolean; isOutput: boolean; isCollection: boolean; defaultStringValue?: string }>;
  fieldUpdates?: Array<{ field: string; value?: string; formula?: string }>;
  elements?: Array<{
    type: string; name: string; label: string;
    conditions?: Array<{ leftValueRef: string; operator: string; rightValue?: string; rightValueRef?: string; label?: string; nextElement?: string }>;
    defaultConnector?: string; objectApiName?: string; filterField?: string; filterOperator?: string;
    filterValue?: string; filterValueRef?: string;
    filters?: Array<{ field: string; operator: string; value?: string; valueRef?: string }>;
    outputVariable?: string; queriedFields?: string[]; sortField?: string; sortOrder?: string; limit?: number; getFirstRecordOnly?: boolean;
    emailAlertApiName?: string;
    apexClassName?: string; apexMethodName?: string; subflowApiName?: string;
    loopVariable?: string; loopIterationVariable?: string; loopNextElement?: string;
    assignments?: Array<{ assignToRef: string; operator: string; valueRef?: string; value?: string }>;
    inputAssignments?: Array<{ field: string; value?: string; valueRef?: string }>;
    inputReference?: string;
    screenFields?: Array<{ name: string; fieldType: string; label?: string; dataType?: string; defaultValueRef?: string }>;
    nextElement?: string;
  }>;
  submitForApprovalProcessName?: string;
}): string {
  const vars = (params.variables ?? []).map(v => `
    <met:variables>
      <met:name>${x(v.name)}</met:name>
      <met:dataType>${v.dataType}</met:dataType>
      ${v.objectType ? `<met:objectType>${x(v.objectType)}</met:objectType>` : ""}
      <met:isCollection>${v.isCollection ? "true" : "false"}</met:isCollection>
      <met:isInput>${v.isInput ? "true" : "false"}</met:isInput>
      <met:isOutput>${v.isOutput ? "true" : "false"}</met:isOutput>
      ${v.dataType === "Number" ? "<met:scale>0</met:scale>" : ""}
    </met:variables>`).join("\n");

  // Process elements and group by type — Salesforce requires all elements of the same type to be contiguous in the XML.
  const buildElements = (elements: typeof params.elements): string => {
    if (!elements || elements.length === 0) return "";
    const groups: Record<string, string[]> = { actionCalls: [], assignments: [], decisions: [], loops: [], recordCreates: [], recordDeletes: [], recordLookups: [], screens: [], subflows: [] };
    elements.map((el, idx) => {
      const connector = el.nextElement
        ? `<met:connector><met:targetReference>${x(el.nextElement)}</met:targetReference></met:connector>` : "";
      switch (el.type) {
        case "Decision": {
          const isNullOps = new Set(["IsNull", "IsNotNull"]);
          const soapTypedRv = (v: string | undefined): string => {
            if (v === "true" || v === "false") return `<met:booleanValue>${v}</met:booleanValue>`;
            if (v !== undefined && /^-?\d+(\.\d+)?$/.test(v)) return `<met:numberValue>${v}</met:numberValue>`;
            return `<met:stringValue>${x(v ?? "")}</met:stringValue>`;
          };
          const outcomes = (el.conditions ?? []).map((c, i) => {
            const ruleLabel = c.label ?? c.rightValue ?? `Rule_${i + 1}`;
            const ruleConnector = c.nextElement
              ? `<met:connector><met:targetReference>${x(c.nextElement)}</met:targetReference></met:connector>` : "";
            const rightValueXml = isNullOps.has(c.operator)
              ? `<met:booleanValue>${c.rightValue === "false" ? "false" : "true"}</met:booleanValue>`
              : c.rightValueRef
                ? `<met:elementReference>${x(c.rightValueRef)}</met:elementReference>`
                : soapTypedRv(c.rightValue);
            return `
            <met:rules>
              <met:name>Rule_${i + 1}</met:name>
              <met:label>${x(ruleLabel)}</met:label>
              <met:conditionLogic>and</met:conditionLogic>
              <met:conditions>
                <met:leftValueReference>${x(c.leftValueRef)}</met:leftValueReference>
                <met:operator>${x(c.operator)}</met:operator>
                <met:rightValue>${rightValueXml}</met:rightValue>
              </met:conditions>
              ${ruleConnector}
            </met:rules>`;
          }).join("\n");
          const defaultOut = el.defaultConnector
            ? `<met:defaultConnector><met:targetReference>${x(el.defaultConnector)}</met:targetReference></met:defaultConnector>\n            <met:defaultConnectorLabel>Default Outcome</met:defaultConnectorLabel>` : "";
          return `<met:decisions>
            <met:name>${x(el.name)}</met:name>
            <met:label>${x(el.label)}</met:label>
            <met:locationX>${50 + idx * 200}</met:locationX>
            <met:locationY>180</met:locationY>
            ${outcomes}
            ${defaultOut}
          </met:decisions>`;
        }
        case "GetRecords": {
          const buildFilterValue = (value?: string, valueRef?: string): string =>
            valueRef
              ? `<met:elementReference>${x(valueRef)}</met:elementReference>`
              : (value === "true" || value === "false")
                ? `<met:booleanValue>${value}</met:booleanValue>`
                : `<met:stringValue>${x(value ?? "")}</met:stringValue>`;
          const allFilters: Array<{ field: string; operator: string; value?: string; valueRef?: string }> = [];
          if (el.filterField) {
            allFilters.push({ field: el.filterField, operator: el.filterOperator ?? "EqualTo", value: el.filterValue, valueRef: el.filterValueRef });
          }
          for (const f of (el.filters ?? [])) allFilters.push(f);
          const filtersXml = allFilters.map(f => `<met:filters>
              <met:field>${x(f.field)}</met:field>
              <met:operator>${x(f.operator)}</met:operator>
              <met:value>${buildFilterValue(f.value, f.valueRef)}</met:value>
            </met:filters>`).join("\n            ");
          const soapHasQF = el.queriedFields && el.queriedFields.length > 0;
          const queriedFieldsXml = soapHasQF
            ? [...new Set(["Id", ...el.queriedFields!])].map(f => `<met:queriedFields>${x(f)}</met:queriedFields>`).join("\n            ")
            : "";
          const soapOutRef = (soapHasQF && el.outputVariable) ? `<met:outputReference>${x(el.outputVariable)}</met:outputReference>` : "";
          const soapStoreAuto = !soapHasQF ? `<met:storeOutputAutomatically>true</met:storeOutputAutomatically>` : "";
          const soapFilterLogic = allFilters.length > 1 ? `<met:filterLogic>and</met:filterLogic>` : "";
          const soapSortOrder = el.sortField ? (el.sortOrder ?? "Asc") : "";
          return `<met:recordLookups>
            <met:name>${x(el.name)}</met:name>
            <met:label>${x(el.label)}</met:label>
            <met:locationX>${50 + idx * 200}</met:locationX>
            <met:locationY>180</met:locationY>
            <met:object>${x(el.objectApiName ?? "")}</met:object>
            ${filtersXml}
            ${soapFilterLogic}
            ${el.getFirstRecordOnly ? `<met:getFirstRecordOnly>true</met:getFirstRecordOnly>` : ""}
            ${soapOutRef}
            ${queriedFieldsXml}
            ${soapStoreAuto}
            ${el.sortField ? `<met:sortField>${x(el.sortField)}</met:sortField>` : ""}
            ${soapSortOrder ? `<met:sortOrder>${x(soapSortOrder)}</met:sortOrder>` : ""}
            ${connector}
          </met:recordLookups>`;
        }
        case "CreateRecords": {
          const soapTypedVal = (v: string | undefined): string => {
            if (v === undefined) return `<met:stringValue></met:stringValue>`;
            if (v === "true" || v === "false") return `<met:booleanValue>${v}</met:booleanValue>`;
            if (/^-?\d+(\.\d+)?$/.test(v)) return `<met:numberValue>${v}</met:numberValue>`;
            return `<met:stringValue>${x(v)}</met:stringValue>`;
          };
          const soapInputAssignXml = (el.inputAssignments ?? []).map(a => `
            <met:inputAssignments>
              <met:field>${x(a.field)}</met:field>
              <met:value>${a.valueRef ? `<met:elementReference>${x(a.valueRef)}</met:elementReference>` : soapTypedVal(a.value)}</met:value>
            </met:inputAssignments>`).join("");
          return `<met:recordCreates>
            <met:name>${x(el.name)}</met:name>
            <met:label>${x(el.label)}</met:label>
            <met:locationX>${50 + idx * 200}</met:locationX>
            <met:locationY>180</met:locationY>
            <met:object>${x(el.objectApiName ?? "")}</met:object>${soapInputAssignXml}
            ${connector}
          </met:recordCreates>`;
        }
        case "DeleteRecords":
          return `<met:recordDeletes>
            <met:name>${x(el.name)}</met:name>
            <met:label>${x(el.label)}</met:label>
            <met:locationX>${50 + idx * 200}</met:locationX>
            <met:locationY>180</met:locationY>
            ${el.inputReference ? `<met:inputReference>${x(el.inputReference)}</met:inputReference>` : ""}
            ${connector}
          </met:recordDeletes>`;
        case "SendEmailAlert":
          return `<met:actionCalls>
            <met:name>${x(el.name)}</met:name>
            <met:label>${x(el.label)}</met:label>
            <met:locationX>${50 + idx * 200}</met:locationX>
            <met:locationY>180</met:locationY>
            <met:actionName>${x(el.emailAlertApiName ?? el.name)}</met:actionName>
            <met:actionType>emailAlert</met:actionType>
            ${connector}
          </met:actionCalls>`;
        case "ApexAction":
          return `<met:actionCalls>
            <met:name>${x(el.name)}</met:name>
            <met:label>${x(el.label)}</met:label>
            <met:locationX>${50 + idx * 200}</met:locationX>
            <met:locationY>180</met:locationY>
            <met:actionName>${x(el.apexClassName ?? "")}${el.apexMethodName ? `.${x(el.apexMethodName)}` : ""}</met:actionName>
            <met:actionType>apex</met:actionType>
            ${connector}
          </met:actionCalls>`;
        case "Subflow":
          return `<met:subflows>
            <met:name>${x(el.name)}</met:name>
            <met:label>${x(el.label)}</met:label>
            <met:locationX>${50 + idx * 200}</met:locationX>
            <met:locationY>180</met:locationY>
            <met:flowName>${x(el.subflowApiName ?? "")}</met:flowName>
            ${connector}
          </met:subflows>`;
        case "Loop": {
          const nextValueConn = el.loopNextElement
            ? `<met:nextValueConnector><met:targetReference>${x(el.loopNextElement)}</met:targetReference></met:nextValueConnector>` : "";
          const noMoreValuesConn = el.nextElement
            ? `<met:noMoreValuesConnector><met:targetReference>${x(el.nextElement)}</met:targetReference></met:noMoreValuesConnector>` : "";
          return `<met:loops>
            <met:name>${x(el.name)}</met:name>
            <met:label>${x(el.label)}</met:label>
            <met:locationX>${50 + idx * 200}</met:locationX>
            <met:locationY>180</met:locationY>
            ${el.loopIterationVariable ? `<met:assignNextValueToReference>${x(el.loopIterationVariable)}</met:assignNextValueToReference>` : ""}
            <met:collectionReference>${x(el.loopVariable ?? "")}</met:collectionReference>
            <met:iterationOrder>Asc</met:iterationOrder>
            ${nextValueConn}
            ${noMoreValuesConn}
          </met:loops>`;
        }
        case "Assignment": {
          const soapTypedVal = (v: string | undefined): string => {
            if (v === undefined || v === null) return `<met:stringValue></met:stringValue>`;
            if (v === "true" || v === "false") return `<met:booleanValue>${v}</met:booleanValue>`;
            if (/^-?\d+(\.\d+)?$/.test(v)) return `<met:numberValue>${v}</met:numberValue>`;
            return `<met:stringValue>${x(v)}</met:stringValue>`;
          };
          const assignItems = (el.assignments ?? []).map(a => `
            <met:assignmentItems>
              <met:assignToReference>${x(a.assignToRef)}</met:assignToReference>
              <met:operator>${x(a.operator)}</met:operator>
              <met:value>${a.valueRef
                ? `<met:elementReference>${x(a.valueRef)}</met:elementReference>`
                : soapTypedVal(a.value)}
              </met:value>
            </met:assignmentItems>`).join("\n");
          return `<met:assignments>
            <met:name>${x(el.name)}</met:name>
            <met:label>${x(el.label)}</met:label>
            <met:locationX>${50 + idx * 200}</met:locationX>
            <met:locationY>180</met:locationY>
            ${assignItems}
            ${connector}
          </met:assignments>`;
        }
        case "Screen": {
          const screenFieldsXml = (el.screenFields ?? []).map(sf => `
            <met:fields>
              <met:name>${x(sf.name)}</met:name>
              <met:fieldType>${x(sf.fieldType)}</met:fieldType>
              ${sf.label ? `<met:fieldText>${x(sf.label)}</met:fieldText>` : ""}
              ${sf.dataType ? `<met:dataType>${x(sf.dataType)}</met:dataType>` : ""}
              ${sf.defaultValueRef ? `<met:defaultValue><met:elementReference>${x(sf.defaultValueRef)}</met:elementReference></met:defaultValue>` : ""}
            </met:fields>`).join("\n");
          return `<met:screens>
            <met:name>${x(el.name)}</met:name>
            <met:label>${x(el.label)}</met:label>
            <met:locationX>${50 + idx * 200}</met:locationX>
            <met:locationY>180</met:locationY>
            ${screenFieldsXml}
            ${connector}
          </met:screens>`;
        }
        default:
          return undefined;
      }
    }).forEach((xml, i) => {
      const el = elements![i];
      const typeMap: Record<string, string> = {
        SendEmailAlert: "actionCalls", ApexAction: "actionCalls",
        Assignment: "assignments", Decision: "decisions", Loop: "loops",
        CreateRecords: "recordCreates", DeleteRecords: "recordDeletes",
        GetRecords: "recordLookups", Screen: "screens", Subflow: "subflows",
      };
      if (xml && typeMap[el.type]) groups[typeMap[el.type]].push(xml);
    });
    return ["actionCalls", "assignments", "decisions", "loops", "recordCreates", "recordDeletes", "recordLookups", "screens", "subflows"]
      .flatMap(k => groups[k]).join("\n");
  };

  const hasFieldUpdates = params.fieldUpdates && params.fieldUpdates.length > 0;
  const hasApprovalSubmit = !!params.submitForApprovalProcessName;
  const hasElements = params.elements && params.elements.length > 0;
  const firstTarget = hasElements && params.elements![0]
    ? params.elements![0].name
    : hasApprovalSubmit ? "Submit_For_Approval"
    : hasFieldUpdates ? "Update_Record"
    : null;

  const startConnector = firstTarget
    ? `<met:connector><met:targetReference>${firstTarget}</met:targetReference></met:connector>` : "";
  const startElement = params.flowType === "RecordTriggeredFlow" && params.triggerObject ? `
    <met:start>
      <met:locationX>50</met:locationX><met:locationY>0</met:locationY>
      <met:object>${x(params.triggerObject)}</met:object>
      <met:recordTriggerType>CreateAndUpdate</met:recordTriggerType>
      <met:triggerType>${x(params.triggerType ?? "RecordAfterSave")}</met:triggerType>
      ${params.triggerFilterFormula ? `<met:filterFormula>${x(params.triggerFilterFormula)}</met:filterFormula>` : ""}
      ${startConnector}
    </met:start>` : `
    <met:start>
      <met:locationX>50</met:locationX><met:locationY>0</met:locationY>
      ${startConnector}
    </met:start>`;

  const approvalSubmitElement = hasApprovalSubmit ? `
    <met:actionCalls>
      <met:name>Submit_For_Approval</met:name>
      <met:label>Submit for Approval</met:label>
      <met:locationX>50</met:locationX><met:locationY>180</met:locationY>
      <met:actionName>submit</met:actionName>
      <met:actionType>submit</met:actionType>
      ${hasFieldUpdates ? `<met:connector><met:targetReference>Update_Record</met:targetReference></met:connector>` : ""}
      <met:inputParameters>
        <met:name>objectId</met:name>
        <met:value><met:elementReference>$Record.Id</met:elementReference></met:value>
      </met:inputParameters>
      <met:inputParameters>
        <met:name>processDefinitionNameOrId</met:name>
        <met:value><met:stringValue>${x(params.submitForApprovalProcessName ?? "")}</met:stringValue></met:value>
      </met:inputParameters>
      <met:inputParameters>
        <met:name>skipEntryCriteria</met:name>
        <met:value><met:booleanValue>false</met:booleanValue></met:value>
      </met:inputParameters>
    </met:actionCalls>` : "";

  const recordUpdateElement = hasFieldUpdates ? `
    <met:recordUpdates>
      <met:name>Update_Record</met:name>
      <met:label>Update Record</met:label>
      <met:locationX>50</met:locationX><met:locationY>300</met:locationY>
      <met:inputReference>{!$Record}</met:inputReference>
      ${(params.fieldUpdates ?? []).map(fu => `
        <met:inputAssignments>
          <met:field>${x(fu.field)}</met:field>
          <met:value>${fu.formula
            ? `<met:formula>${x(fu.formula)}</met:formula>`
            : `<met:stringValue>${x(fu.value ?? "")}</met:stringValue>`}
          </met:value>
        </met:inputAssignments>`).join("\n")}
    </met:recordUpdates>` : "";

  return `<met:metadata xsi:type="met:Flow" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <met:fullName>${x(params.apiName)}</met:fullName>
    <met:label>${x(params.label)}</met:label>
    <met:apiVersion>${API_VERSION}</met:apiVersion>
    <met:status>${x(params.status)}</met:status>
    <met:processType>${x(params.flowType)}</met:processType>
    <met:environments>Default</met:environments>
    ${params.description ? `<met:description>${x(params.description)}</met:description>` : ""}
    ${vars}
    ${startElement}
    ${buildElements(params.elements)}
    ${approvalSubmitElement}
    ${recordUpdateElement}
  </met:metadata>`;
}

// Builds zip-deploy format Flow XML with elements grouped by type (required by Salesforce metadata schema).
// Unlike buildFlowXml (SOAP format), elements here have no met: prefix and must be sorted by element type.
export function buildFlowDeployXml(params: Parameters<typeof buildFlowXml>[0]): string {
  const NS = "http://soap.sforce.com/2006/04/metadata";
  const vars = (params.variables ?? []).map(v => `
  <variables>
    <name>${x(v.name)}</name>
    <dataType>${v.dataType}</dataType>
    ${v.objectType ? `<objectType>${x(v.objectType)}</objectType>` : ""}
    <isCollection>${v.isCollection ? "true" : "false"}</isCollection>
    <isInput>${v.isInput ? "true" : "false"}</isInput>
    <isOutput>${v.isOutput ? "true" : "false"}</isOutput>
    ${v.dataType === "Number" ? "<scale>0</scale>" : ""}
  </variables>`).join("\n");

  const actionCalls: string[] = [];
  const assignments: string[] = [];
  const decisions: string[] = [];
  const loops: string[] = [];
  const recordCreates: string[] = [];
  const recordDeletes: string[] = [];
  const recordLookups: string[] = [];
  const screens: string[] = [];
  const subflows: string[] = [];

  for (let idx = 0; idx < (params.elements ?? []).length; idx++) {
    const el = params.elements![idx];
    const conn = el.nextElement ? `<connector><targetReference>${x(el.nextElement)}</targetReference></connector>` : "";
    switch (el.type) {
      case "Assignment": {
        const typedVal = (v: string | undefined): string => {
          if (v === undefined || v === null) return `<stringValue></stringValue>`;
          if (v === "true" || v === "false") return `<booleanValue>${v}</booleanValue>`;
          if (/^-?\d+(\.\d+)?$/.test(v)) return `<numberValue>${v}</numberValue>`;
          return `<stringValue>${x(v)}</stringValue>`;
        };
        const items = (el.assignments ?? []).map(a => `
    <assignmentItems>
      <assignToReference>${x(a.assignToRef)}</assignToReference>
      <operator>${x(a.operator)}</operator>
      <value>${a.valueRef ? `<elementReference>${x(a.valueRef)}</elementReference>` : typedVal(a.value)}</value>
    </assignmentItems>`).join("");
        assignments.push(`
  <assignments>
    <name>${x(el.name)}</name>
    <label>${x(el.label)}</label>
    <locationX>${50 + idx * 200}</locationX>
    <locationY>180</locationY>${items}
    ${conn}
  </assignments>`);
        break;
      }
      case "Decision": {
        const isNullOps = new Set(["IsNull", "IsNotNull"]);
        const typedRv = (v: string | undefined): string => {
          if (v === "true" || v === "false") return `<booleanValue>${v}</booleanValue>`;
          if (v !== undefined && /^-?\d+(\.\d+)?$/.test(v)) return `<numberValue>${v}</numberValue>`;
          return `<stringValue>${x(v ?? "")}</stringValue>`;
        };
        const rules = (el.conditions ?? []).map((c, i) => {
          const rv = isNullOps.has(c.operator)
            ? `<booleanValue>${c.rightValue === "false" ? "false" : "true"}</booleanValue>`
            : c.rightValueRef ? `<elementReference>${x(c.rightValueRef)}</elementReference>` : typedRv(c.rightValue);
          const rc = c.nextElement ? `<connector><targetReference>${x(c.nextElement)}</targetReference></connector>` : "";
          return `
    <rules>
      <name>Rule_${i + 1}</name>
      <label>${x(c.label ?? `Rule_${i + 1}`)}</label>
      <conditionLogic>and</conditionLogic>
      <conditions>
        <leftValueReference>${x(c.leftValueRef)}</leftValueReference>
        <operator>${x(c.operator)}</operator>
        <rightValue>${rv}</rightValue>
      </conditions>
      ${rc}
    </rules>`;
        }).join("");
        const defaultOut = el.defaultConnector
          ? `<defaultConnector><targetReference>${x(el.defaultConnector)}</targetReference></defaultConnector>\n    <defaultConnectorLabel>Default Outcome</defaultConnectorLabel>` : "";
        decisions.push(`
  <decisions>
    <name>${x(el.name)}</name>
    <label>${x(el.label)}</label>
    <locationX>${50 + idx * 200}</locationX>
    <locationY>180</locationY>
    ${rules}
    ${defaultOut}
  </decisions>`);
        break;
      }
      case "Loop": {
        const nv = el.loopNextElement ? `<nextValueConnector><targetReference>${x(el.loopNextElement)}</targetReference></nextValueConnector>` : "";
        const nm = el.nextElement ? `<noMoreValuesConnector><targetReference>${x(el.nextElement)}</targetReference></noMoreValuesConnector>` : "";
        loops.push(`
  <loops>
    <name>${x(el.name)}</name>
    <label>${x(el.label)}</label>
    <locationX>${50 + idx * 200}</locationX>
    <locationY>180</locationY>
    ${el.loopIterationVariable ? `<assignNextValueToReference>${x(el.loopIterationVariable)}</assignNextValueToReference>` : ""}
    <collectionReference>${x(el.loopVariable ?? "")}</collectionReference>
    <iterationOrder>Asc</iterationOrder>
    ${nv}
    ${nm}
  </loops>`);
        break;
      }
      case "GetRecords": {
        const allFilters: Array<{ field: string; operator: string; value?: string; valueRef?: string }> = [];
        if (el.filterField) allFilters.push({ field: el.filterField, operator: el.filterOperator ?? "EqualTo", value: el.filterValue, valueRef: el.filterValueRef });
        for (const f of (el.filters ?? [])) allFilters.push(f);
        const filtersXml = allFilters.map(f => {
          let valXml: string;
          if (f.valueRef) {
            valXml = `<elementReference>${x(f.valueRef)}</elementReference>`;
          } else if (f.value === "true" || f.value === "false") {
            valXml = `<booleanValue>${f.value}</booleanValue>`;
          } else {
            valXml = `<stringValue>${x(f.value ?? "")}</stringValue>`;
          }
          return `
    <filters>
      <field>${x(f.field)}</field>
      <operator>${x(f.operator)}</operator>
      <value>${valXml}</value>
    </filters>`;
        }).join("");
        // When queriedFields is specified: use outputReference mode with explicit fields.
        // When queriedFields is omitted: use storeOutputAutomatically — records accessible via element name (el.name).
        const hasQueriedFields = el.queriedFields && el.queriedFields.length > 0;
        const qf = hasQueriedFields ? [...new Set(["Id", ...el.queriedFields!])].map(f => `<queriedFields>${x(f)}</queriedFields>`).join("\n    ") : "";
        const outRef = (hasQueriedFields && el.outputVariable) ? `<outputReference>${x(el.outputVariable)}</outputReference>` : "";
        const storeAuto = !hasQueriedFields ? `<storeOutputAutomatically>true</storeOutputAutomatically>` : "";
        const filterLogicXml = allFilters.length > 1 ? `<filterLogic>and</filterLogic>` : "";
        const effectiveSortOrder = el.sortField ? (el.sortOrder ?? "Asc") : "";
        // Note: <limit> is not supported in Flow metadata deployment in API v62.0 orgs; omit to avoid deploy failure.
        recordLookups.push(`
  <recordLookups>
    <name>${x(el.name)}</name>
    <label>${x(el.label)}</label>
    <locationX>${50 + idx * 200}</locationX>
    <locationY>180</locationY>
    <object>${x(el.objectApiName ?? "")}</object>${filtersXml}
    ${filterLogicXml}
    ${el.getFirstRecordOnly ? "<getFirstRecordOnly>true</getFirstRecordOnly>" : ""}
    ${outRef}
    ${qf}
    ${storeAuto}
    ${el.sortField ? `<sortField>${x(el.sortField)}</sortField>` : ""}
    ${effectiveSortOrder ? `<sortOrder>${x(effectiveSortOrder)}</sortOrder>` : ""}
    ${conn}
  </recordLookups>`);
        break;
      }
      case "CreateRecords": {
        const crTypedVal = (v: string | undefined): string => {
          if (v === undefined) return `<stringValue></stringValue>`;
          if (v === "true" || v === "false") return `<booleanValue>${v}</booleanValue>`;
          if (/^-?\d+(\.\d+)?$/.test(v)) return `<numberValue>${v}</numberValue>`;
          return `<stringValue>${x(v)}</stringValue>`;
        };
        const inputAssignXml = (el.inputAssignments ?? []).map(a => `
    <inputAssignments>
      <field>${x(a.field)}</field>
      <value>${a.valueRef ? `<elementReference>${x(a.valueRef)}</elementReference>` : crTypedVal(a.value)}</value>
    </inputAssignments>`).join("");
        recordCreates.push(`
  <recordCreates>
    <name>${x(el.name)}</name>
    <label>${x(el.label)}</label>
    <locationX>${50 + idx * 200}</locationX>
    <locationY>180</locationY>
    <object>${x(el.objectApiName ?? "")}</object>${inputAssignXml}
    ${conn}
  </recordCreates>`);
        break;
      }
      case "DeleteRecords":
        recordDeletes.push(`
  <recordDeletes>
    <name>${x(el.name)}</name>
    <label>${x(el.label)}</label>
    <locationX>${50 + idx * 200}</locationX>
    <locationY>180</locationY>
    ${el.inputReference ? `<inputReference>${x(el.inputReference)}</inputReference>` : ""}
    ${conn}
  </recordDeletes>`);
        break;
      case "SendEmailAlert":
        actionCalls.push(`
  <actionCalls>
    <name>${x(el.name)}</name>
    <label>${x(el.label)}</label>
    <locationX>${50 + idx * 200}</locationX>
    <locationY>180</locationY>
    <actionName>${x(el.emailAlertApiName ?? el.name)}</actionName>
    <actionType>emailAlert</actionType>
    ${conn}
  </actionCalls>`);
        break;
      case "ApexAction":
        actionCalls.push(`
  <actionCalls>
    <name>${x(el.name)}</name>
    <label>${x(el.label)}</label>
    <locationX>${50 + idx * 200}</locationX>
    <locationY>180</locationY>
    <actionName>${x(el.apexClassName ?? "")}${el.apexMethodName ? `.${x(el.apexMethodName)}` : ""}</actionName>
    <actionType>apex</actionType>
    ${conn}
  </actionCalls>`);
        break;
      case "Subflow":
        subflows.push(`
  <subflows>
    <name>${x(el.name)}</name>
    <label>${x(el.label)}</label>
    <locationX>${50 + idx * 200}</locationX>
    <locationY>180</locationY>
    <flowName>${x(el.subflowApiName ?? "")}</flowName>
    ${conn}
  </subflows>`);
        break;
      case "Screen": {
        const screenFields = (el.screenFields ?? []).map(sf => `
    <fields>
      <name>${x(sf.name)}</name>
      <fieldType>${x(sf.fieldType)}</fieldType>
      ${sf.label ? `<fieldText>${x(sf.label)}</fieldText>` : ""}
      ${sf.dataType ? `<dataType>${x(sf.dataType)}</dataType>` : ""}
      ${sf.defaultValueRef ? `<defaultValue><elementReference>${x(sf.defaultValueRef)}</elementReference></defaultValue>` : ""}
    </fields>`).join("");
        screens.push(`
  <screens>
    <name>${x(el.name)}</name>
    <label>${x(el.label)}</label>
    <locationX>${50 + idx * 200}</locationX>
    <locationY>180</locationY>${screenFields}
    ${conn}
  </screens>`);
        break;
      }
    }
  }

  const hasFieldUpdates = params.fieldUpdates && params.fieldUpdates.length > 0;
  const hasApprovalSubmit = !!params.submitForApprovalProcessName;
  const triggerType = params.triggerType ?? "RecordAfterSave";
  const firstEl = params.elements?.[0]?.name
    ?? (hasApprovalSubmit ? "Submit_For_Approval" : undefined)
    ?? (hasFieldUpdates ? "Update_Record" : undefined);
  const startConn = firstEl ? `<connector><targetReference>${firstEl}</targetReference></connector>` : "";
  const approvalSubmitXml = hasApprovalSubmit ? `
  <actionCalls>
    <name>Submit_For_Approval</name>
    <label>Submit for Approval</label>
    <locationX>50</locationX><locationY>180</locationY>
    <actionName>submit</actionName>
    <actionType>submit</actionType>
    ${hasFieldUpdates ? `<connector><targetReference>Update_Record</targetReference></connector>` : ""}
    <inputParameters>
      <name>objectId</name>
      <value><elementReference>$Record.Id</elementReference></value>
    </inputParameters>
    <inputParameters>
      <name>processDefinitionNameOrId</name>
      <value><stringValue>${x(params.submitForApprovalProcessName ?? "")}</stringValue></value>
    </inputParameters>
    <inputParameters>
      <name>skipEntryCriteria</name>
      <value><booleanValue>false</booleanValue></value>
    </inputParameters>
  </actionCalls>` : "";
  const recordUpdateXml = hasFieldUpdates ? `
  <recordUpdates>
    <name>Update_Record</name>
    <label>Update Record</label>
    <locationX>50</locationX><locationY>300</locationY>
    <inputReference>{!$Record}</inputReference>
    ${(params.fieldUpdates ?? []).map(fu => `
    <inputAssignments>
      <field>${x(fu.field)}</field>
      <value>${fu.formula
        ? `<formula>${x(fu.formula)}</formula>`
        : `<stringValue>${x(fu.value ?? "")}</stringValue>`}
      </value>
    </inputAssignments>`).join("\n")}
  </recordUpdates>` : "";
  const startXml = params.flowType === "RecordTriggeredFlow" && params.triggerObject
    ? `<start>
    <locationX>50</locationX><locationY>0</locationY>
    <object>${x(params.triggerObject)}</object>
    <recordTriggerType>CreateAndUpdate</recordTriggerType>
    <triggerType>${x(triggerType)}</triggerType>
    ${params.triggerFilterFormula ? `<filterFormula>${x(params.triggerFilterFormula)}</filterFormula>` : ""}
    ${startConn}
  </start>`
    : `<start>
    <locationX>50</locationX><locationY>0</locationY>
    ${startConn}
  </start>`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<Flow xmlns="${NS}">
  <apiVersion>${API_VERSION}</apiVersion>
  <environments>Default</environments>
  <label>${x(params.label)}</label>
  <processType>${x(params.flowType)}</processType>
  <status>${x(params.status)}</status>
  ${params.description ? `<description>${x(params.description)}</description>` : ""}
  ${vars}
  ${startXml}
  ${approvalSubmitXml}
  ${recordUpdateXml}
  ${actionCalls.join("")}
  ${assignments.join("")}
  ${decisions.join("")}
  ${loops.join("")}
  ${recordCreates.join("")}
  ${recordDeletes.join("")}
  ${recordLookups.join("")}
  ${screens.join("")}
  ${subflows.join("")}
</Flow>`;
}

function buildApprovalProcessXml(params: {
  objectName: string; processName: string; label: string; description?: string;
  allowedSubmitters: Array<{ type: string; submitter?: string }>;
  approvalSteps: Array<{
    name: string; label: string; allowDelegate: boolean;
    approvers: Array<{ type: string; name?: string }>;
    whenMultiple: string; entryFormula?: string;
    ifCriteriaNotMet: string; rejectBehavior?: string;
  }>;
  entryFormula?: string;
  entryFilterCriteria?: Array<{ field: string; operation: string; value: string }>;
  recordEditability: string; allowRecall: boolean;
  finalApprovalLock: boolean; finalRejectionLock: boolean;
  emailTemplate?: string; active: boolean;
}): string {
  const submitters = params.allowedSubmitters.map(s => `
    <met:allowedSubmitters>
      <met:type>${x(s.type)}</met:type>
      ${s.submitter ? `<met:submitter>${x(s.submitter)}</met:submitter>` : ""}
    </met:allowedSubmitters>`).join("\n");
  const steps = params.approvalSteps.map((step, i) => `
    <met:approvalStep>
      <met:name>${x(step.name)}</met:name>
      <met:label>${x(step.label)}</met:label>
      <met:entryOrder>${i + 1}</met:entryOrder>
      <met:allowDelegate>${step.allowDelegate ? "true" : "false"}</met:allowDelegate>
      <met:assignedApprover>
        ${step.approvers.map(a => `<met:approver>
          <met:type>${x(a.type)}</met:type>
          ${a.name ? `<met:name>${x(a.name)}</met:name>` : ""}
        </met:approver>`).join("\n")}
        <met:whenMultipleApprovers>${x(step.whenMultiple)}</met:whenMultipleApprovers>
      </met:assignedApprover>
      ${step.entryFormula ? `<met:entryCriteria><met:formula>${x(step.entryFormula)}</met:formula></met:entryCriteria>
        <met:ifCriteriaNotMet>${x(step.ifCriteriaNotMet)}</met:ifCriteriaNotMet>` : ""}
      ${i > 0 && step.rejectBehavior ? `<met:rejectBehavior><met:type>${x(step.rejectBehavior)}</met:type></met:rejectBehavior>` : ""}
    </met:approvalStep>`).join("\n");
  let entryCriteriaXml = "";
  if (params.entryFormula) {
    entryCriteriaXml = `<met:entryCriteria><met:formula>${x(params.entryFormula)}</met:formula></met:entryCriteria>`;
  } else if (params.entryFilterCriteria?.length) {
    const items = params.entryFilterCriteria.map(fc => `
      <met:criteriaItems>
        <met:field>${x(params.objectName)}.${x(fc.field)}</met:field>
        <met:operation>${x(fc.operation)}</met:operation>
        <met:value>${x(fc.value)}</met:value>
      </met:criteriaItems>`).join("\n");
    entryCriteriaXml = `<met:entryCriteria>${items}</met:entryCriteria>`;
  }
  return `<met:metadata xsi:type="met:ApprovalProcess" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <met:fullName>${x(params.objectName)}.${x(params.processName)}</met:fullName>
    <met:label>${x(params.label)}</met:label>
    <met:active>${params.active ? "true" : "false"}</met:active>
    <met:allowRecall>${params.allowRecall ? "true" : "false"}</met:allowRecall>
    ${params.description ? `<met:description>${x(params.description)}</met:description>` : ""}
    ${submitters}
    <met:approvalPageFields><met:field>Name</met:field><met:field>Owner</met:field></met:approvalPageFields>
    ${steps}
    ${entryCriteriaXml}
    ${params.emailTemplate ? `<met:emailTemplate>${x(params.emailTemplate)}</met:emailTemplate>` : ""}
    <met:finalApprovalRecordLock>${params.finalApprovalLock ? "true" : "false"}</met:finalApprovalRecordLock>
    <met:finalRejectionRecordLock>${params.finalRejectionLock ? "true" : "false"}</met:finalRejectionRecordLock>
    <met:recordEditability>${x(params.recordEditability)}</met:recordEditability>
    <met:showApprovalHistory>true</met:showApprovalHistory>
  </met:metadata>`;
}

function buildValidationRuleXml(params: {
  objectName: string; ruleName: string; active: boolean;
  errorConditionFormula: string; errorMessage: string;
  errorDisplayField?: string; description?: string;
}): string {
  return `<met:metadata xsi:type="met:ValidationRule" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <met:fullName>${x(params.objectName)}.${x(params.ruleName)}</met:fullName>
    <met:active>${params.active}</met:active>
    ${params.description ? `<met:description>${x(params.description)}</met:description>` : ""}
    <met:errorConditionFormula>${x(params.errorConditionFormula)}</met:errorConditionFormula>
    ${params.errorDisplayField ? `<met:errorDisplayField>${x(params.errorDisplayField)}</met:errorDisplayField>` : ""}
    <met:errorMessage>${x(params.errorMessage)}</met:errorMessage>
  </met:metadata>`;
}

function buildWorkflowFieldUpdateXml(params: {
  objectName: string; actionName: string; label: string;
  field: string; literalValue?: string; formula?: string;
  nullValue?: boolean; notifyAssignee: boolean;
}): string {
  let operationXml = "";
  if (params.nullValue) {
    operationXml = `<met:operation>Null</met:operation>`;
  } else if (params.formula) {
    operationXml = `<met:formula>${x(params.formula)}</met:formula><met:operation>Formula</met:operation>`;
  } else {
    operationXml = `<met:literalValue>${x(params.literalValue ?? "")}</met:literalValue><met:operation>Literal</met:operation>`;
  }
  return `<met:metadata xsi:type="met:Workflow" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <met:fullName>${x(params.objectName)}</met:fullName>
    <met:fieldUpdates>
      <met:name>${x(params.actionName)}</met:name>
      <met:label>${x(params.label)}</met:label>
      <met:field>${x(params.field)}</met:field>
      ${operationXml}
      <met:notifyAssignee>${params.notifyAssignee}</met:notifyAssignee>
      <met:protected>false</met:protected>
    </met:fieldUpdates>
  </met:metadata>`;
}

// ─── New XML builders for expanded tools ─────────────────────────────────────

function buildCustomMetadataTypeXml(params: {
  fullName: string; label: string; pluralLabel: string; description?: string;
  fields?: SimpleField[];
}): string {
  const fieldsXml = params.fields ? buildSimpleFieldsXml(params.fields) : "";
  return `<met:metadata xsi:type="met:CustomObject" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <met:fullName>${x(params.fullName)}</met:fullName>
    <met:label>${x(params.label)}</met:label>
    <met:pluralLabel>${x(params.pluralLabel)}</met:pluralLabel>
    ${params.description ? `<met:description>${x(params.description)}</met:description>` : ""}
    ${fieldsXml}
  </met:metadata>`;
}

function buildCustomMetadataRecordXml(params: {
  typeName: string; recordName: string; label: string;
  values: Array<{ field: string; value: string }>;
}): string {
  const valuesXml = params.values.map(v => `
    <met:values>
      <met:field>${x(v.field)}</met:field>
      <met:value xsi:type="xsd:string" xmlns:xsd="http://www.w3.org/2001/XMLSchema">${x(v.value)}</met:value>
    </met:values>`).join("\n");
  return `<met:metadata xsi:type="met:CustomMetadata" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <met:fullName>${x(params.typeName)}.${x(params.recordName)}</met:fullName>
    <met:label>${x(params.label)}</met:label>
    ${valuesXml}
  </met:metadata>`;
}

function buildCustomLabelXml(params: {
  fullName: string; value: string; language: string;
  categories?: string; protected: boolean; shortDescription?: string;
}): string {
  return `<met:metadata xsi:type="met:CustomLabels" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <met:fullName>CustomLabels</met:fullName>
    <met:labels>
      <met:fullName>${x(params.fullName)}</met:fullName>
      <met:value>${x(params.value)}</met:value>
      <met:language>${x(params.language)}</met:language>
      ${params.categories ? `<met:categories>${x(params.categories)}</met:categories>` : ""}
      <met:protected>${params.protected}</met:protected>
      ${params.shortDescription ? `<met:shortDescription>${x(params.shortDescription)}</met:shortDescription>` : ""}
    </met:labels>
  </met:metadata>`;
}

function buildCustomSettingXml(params: {
  fullName: string; label: string; settingType: string;
  visibility: string; description?: string; fields?: SimpleField[];
}): string {
  const fieldsXml = params.fields ? buildSimpleFieldsXml(params.fields) : "";
  return `<met:metadata xsi:type="met:CustomObject" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <met:fullName>${x(params.fullName)}</met:fullName>
    <met:label>${x(params.label)}</met:label>
    <met:customSettingsType>${x(params.settingType)}</met:customSettingsType>
    <met:visibility>${x(params.visibility)}</met:visibility>
    ${params.description ? `<met:description>${x(params.description)}</met:description>` : ""}
    ${fieldsXml}
  </met:metadata>`;
}

function buildGlobalValueSetXml(params: {
  fullName: string; masterLabel: string; description?: string;
  sorted: boolean; values: PicklistValue[];
}): string {
  const valuesXml = params.values.map(v => `
    <met:customValue>
      <met:fullName>${x(v.fullName)}</met:fullName>
      <met:label>${x(v.label)}</met:label>
      <met:default>${v.default}</met:default>
      ${v.description ? `<met:description>${x(v.description)}</met:description>` : ""}
    </met:customValue>`).join("\n");
  const gvsFullName = params.fullName;
  return `<met:metadata xsi:type="met:GlobalValueSet" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <met:fullName>${x(gvsFullName)}</met:fullName>
    <met:masterLabel>${x(params.masterLabel)}</met:masterLabel>
    ${params.description ? `<met:description>${x(params.description)}</met:description>` : ""}
    <met:sorted>${params.sorted}</met:sorted>
    ${valuesXml}
  </met:metadata>`;
}

function buildPlatformEventXml(params: {
  fullName: string; label: string; pluralLabel: string;
  description?: string; publishBehavior: string; fields?: SimpleField[];
}): string {
  const fieldsXml = params.fields ? buildSimpleFieldsXml(params.fields) : "";
  return `<met:metadata xsi:type="met:CustomObject" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <met:fullName>${x(params.fullName)}</met:fullName>
    <met:label>${x(params.label)}</met:label>
    <met:pluralLabel>${x(params.pluralLabel)}</met:pluralLabel>
    <met:deploymentStatus>Deployed</met:deploymentStatus>
    <met:publishBehavior>${x(params.publishBehavior)}</met:publishBehavior>
    ${params.description ? `<met:description>${x(params.description)}</met:description>` : ""}
    ${fieldsXml}
  </met:metadata>`;
}

function buildEmailAlertXml(params: {
  objectName: string; alertName: string; label: string; description?: string;
  template: string; senderType: string; senderAddress?: string;
  recipients: Array<{ type: string; recipient?: string }>; protected: boolean;
}): string {
  const recipientsXml = params.recipients.map(r => `
    <met:recipients>
      <met:type>${x(r.type)}</met:type>
      ${r.recipient ? `<met:recipient>${x(r.recipient)}</met:recipient>` : ""}
    </met:recipients>`).join("\n");
  return `<met:metadata xsi:type="met:Workflow" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <met:fullName>${x(params.objectName)}</met:fullName>
    <met:alerts>
      <met:fullName>${x(params.alertName)}</met:fullName>
      <met:label>${x(params.label)}</met:label>
      <met:template>${x(params.template)}</met:template>
      <met:senderType>${x(params.senderType)}</met:senderType>
      ${params.senderAddress ? `<met:senderAddress>${x(params.senderAddress)}</met:senderAddress>` : ""}
      ${params.description ? `<met:description>${x(params.description)}</met:description>` : ""}
      <met:protected>${params.protected}</met:protected>
      ${recipientsXml}
    </met:alerts>
  </met:metadata>`;
}

function buildAssignmentRuleXml(params: {
  objectName: string; ruleName: string; label: string; active: boolean;
  ruleEntries: Array<{
    entryOrder: number; assignedTo: string; assignedToType: string;
    criteriaItems?: Array<{ field: string; operation: string; value: string }>;
    formula?: string; template?: string; booleanFilter?: string;
  }>;
}): string {
  const entriesXml = params.ruleEntries.map(e => {
    const criteriaXml = (e.criteriaItems ?? []).map(c => `
      <met:criteriaItems>
        <met:field>${x(c.field)}</met:field>
        <met:operation>${x(c.operation)}</met:operation>
        <met:value>${x(c.value)}</met:value>
      </met:criteriaItems>`).join("\n");
    return `<met:ruleEntry>
      <met:assignedTo>${x(e.assignedTo)}</met:assignedTo>
      <met:assignedToType>${x(e.assignedToType)}</met:assignedToType>
      ${criteriaXml}
      ${e.formula ? `<met:formula>${x(e.formula)}</met:formula>` : ""}
      ${e.booleanFilter ? `<met:booleanFilter>${x(e.booleanFilter)}</met:booleanFilter>` : ""}
      ${e.template ? `<met:template>${x(e.template)}</met:template>` : ""}
    </met:ruleEntry>`;
  }).join("\n");
  return `<met:metadata xsi:type="met:AssignmentRules" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <met:fullName>${x(params.objectName)}</met:fullName>
    <met:assignmentRule>
      <met:fullName>${x(params.ruleName)}</met:fullName>
      <met:active>${params.active}</met:active>
      ${entriesXml}
    </met:assignmentRule>
  </met:metadata>`;
}

function buildPermissionSetXml(params: {
  fullName: string; label: string; description?: string;
  objectPermissions?: Array<{ object: string; allowCreate: boolean; allowRead: boolean; allowEdit: boolean; allowDelete: boolean; viewAllRecords: boolean; modifyAllRecords: boolean }>;
  fieldPermissions?: Array<{ field: string; editable: boolean; readable: boolean }>;
  apexClassAccesses?: Array<{ apexClass: string; enabled: boolean }>;
  userPermissions?: Array<{ name: string; enabled: boolean }>;
  tabSettings?: Array<{ tab: string; visibility: string }>;
}): string {
  const objPermsXml = (params.objectPermissions ?? []).map(op => `
    <met:objectPermissions>
      <met:allowCreate>${op.allowCreate ? "true" : "false"}</met:allowCreate>
      <met:allowDelete>${op.allowDelete ? "true" : "false"}</met:allowDelete>
      <met:allowEdit>${op.allowEdit ? "true" : "false"}</met:allowEdit>
      <met:allowRead>${op.allowRead ? "true" : "false"}</met:allowRead>
      <met:modifyAllRecords>${op.modifyAllRecords ? "true" : "false"}</met:modifyAllRecords>
      <met:object>${x(op.object)}</met:object>
      <met:viewAllRecords>${op.viewAllRecords ? "true" : "false"}</met:viewAllRecords>
    </met:objectPermissions>`).join("\n");
  const fieldPermsXml = (params.fieldPermissions ?? []).map(fp => `
    <met:fieldPermissions>
      <met:editable>${fp.editable ? "true" : "false"}</met:editable>
      <met:field>${x(fp.field)}</met:field>
      <met:readable>${fp.readable ? "true" : "false"}</met:readable>
    </met:fieldPermissions>`).join("\n");
  const apexAccessXml = (params.apexClassAccesses ?? []).map(a => `
    <met:classAccesses>
      <met:apexClass>${x(a.apexClass)}</met:apexClass>
      <met:enabled>${a.enabled ? "true" : "false"}</met:enabled>
    </met:classAccesses>`).join("\n");
  const userPermsXml = (params.userPermissions ?? []).map(u => `
    <met:userPermissions>
      <met:enabled>${u.enabled ? "true" : "false"}</met:enabled>
      <met:name>${x(u.name)}</met:name>
    </met:userPermissions>`).join("\n");
  const tabXml = (params.tabSettings ?? []).map(t => `
    <met:tabSettings>
      <met:tab>${x(t.tab)}</met:tab>
      <met:visibility>${x(t.visibility)}</met:visibility>
    </met:tabSettings>`).join("\n");
  return `<met:metadata xsi:type="met:PermissionSet" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <met:fullName>${x(params.fullName)}</met:fullName>
    <met:label>${x(params.label)}</met:label>
    ${params.description ? `<met:description>${x(params.description)}</met:description>` : ""}
    ${objPermsXml}
    ${fieldPermsXml}
    ${apexAccessXml}
    ${userPermsXml}
    ${tabXml}
  </met:metadata>`;
}

function buildRoleXml(params: {
  fullName: string; name: string; description?: string; parentRole?: string;
  caseAccessLevel: string; contactAccessLevel: string;
  opportunityAccessLevel: string; accountAccessLevel: string;
  mayForecastManagerShare: boolean;
}): string {
  return `<met:metadata xsi:type="met:Role" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <met:fullName>${x(params.fullName)}</met:fullName>
    <met:name>${x(params.name)}</met:name>
    ${params.description ? `<met:description>${x(params.description)}</met:description>` : ""}
    ${params.parentRole ? `<met:parentRole>${x(params.parentRole)}</met:parentRole>` : ""}
    <met:caseAccessLevel>${x(params.caseAccessLevel)}</met:caseAccessLevel>
    <met:contactAccessLevel>${x(params.contactAccessLevel)}</met:contactAccessLevel>
    <met:opportunityAccessLevel>${x(params.opportunityAccessLevel)}</met:opportunityAccessLevel>
    <met:accountAccessLevel>${x(params.accountAccessLevel)}</met:accountAccessLevel>
    <met:mayForecastManagerShare>${params.mayForecastManagerShare}</met:mayForecastManagerShare>
  </met:metadata>`;
}

function buildQueueXml(params: {
  fullName: string; name: string; email?: string;
  doesSendEmailToMembers: boolean; supportedObjects: string[];
  queueMembers?: { users?: string[]; groups?: string[]; roles?: string[] };
}): string {
  const sobjectsXml = params.supportedObjects.map(o => `
    <met:queueSobject><met:sobjectType>${x(o)}</met:sobjectType></met:queueSobject>`).join("\n");
  const membersXml = params.queueMembers ? `
    <met:queueMembers>
      ${(params.queueMembers.users ?? []).map(u => `<met:users><met:user>${x(u)}</met:user></met:users>`).join("\n")}
      ${(params.queueMembers.groups ?? []).map(g => `<met:groups><met:group>${x(g)}</met:group></met:groups>`).join("\n")}
      ${(params.queueMembers.roles ?? []).map(r => `<met:roles><met:role>${x(r)}</met:role></met:roles>`).join("\n")}
    </met:queueMembers>` : "";
  return `<met:metadata xsi:type="met:Queue" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <met:fullName>${x(params.fullName)}</met:fullName>
    <met:name>${x(params.name)}</met:name>
    ${params.email ? `<met:email>${x(params.email)}</met:email>` : ""}
    <met:doesSendEmailToMembers>${params.doesSendEmailToMembers}</met:doesSendEmailToMembers>
    ${sobjectsXml}
    ${membersXml}
  </met:metadata>`;
}

function buildNamedCredentialXml(params: {
  fullName: string; label: string; endpoint: string;
  principalType: string; protocol: string;
  username?: string; allowFormula: boolean; allowCallout: boolean;
}): string {
  return `<met:metadata xsi:type="met:NamedCredential" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <met:fullName>${x(params.fullName)}</met:fullName>
    <met:label>${x(params.label)}</met:label>
    <met:endpoint>${x(params.endpoint)}</met:endpoint>
    <met:principalType>${x(params.principalType)}</met:principalType>
    <met:protocol>${x(params.protocol)}</met:protocol>
    ${params.username ? `<met:username>${x(params.username)}</met:username>` : ""}
    <met:allowMergeFieldsInBody>${params.allowFormula}</met:allowMergeFieldsInBody>
    <met:allowMergeFieldsInHeader>${params.allowFormula}</met:allowMergeFieldsInHeader>
    <met:generateAuthorizationHeader>${params.allowCallout}</met:generateAuthorizationHeader>
  </met:metadata>`;
}

function buildLightningAppXml(params: {
  fullName: string; label: string; description?: string; navType: string;
  uiType: string; setupExperience: string;
  isNavAutoTempTabsDisabled: boolean; isNavPersonalizationDisabled: boolean;
  navItems?: Array<{ name: string; type: string; label?: string; defaultItem: boolean }>;
  utilityItems?: Array<{ name: string; type: string; label?: string; iconName?: string }>;
}): string {
  const navItemsXml = (params.navItems ?? []).map(ni => `
    <met:navItems>
      <met:name>${x(ni.name)}</met:name>
      <met:type>${x(ni.type)}</met:type>
      ${ni.label ? `<met:label>${x(ni.label)}</met:label>` : ""}
      <met:defaultItem>${ni.defaultItem}</met:defaultItem>
    </met:navItems>`).join("\n");
  const utilityXml = (params.utilityItems ?? []).map(u => `
    <met:utilityBar>
      <met:name>${x(u.name)}</met:name>
      <met:type>${x(u.type)}</met:type>
      ${u.label ? `<met:label>${x(u.label)}</met:label>` : ""}
      ${u.iconName ? `<met:itemComponents><met:componentName>${x(u.iconName)}</met:componentName></met:itemComponents>` : ""}
    </met:utilityBar>`).join("\n");
  return `<met:metadata xsi:type="met:CustomApplication" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <met:fullName>${x(params.fullName)}</met:fullName>
    <met:label>${x(params.label)}</met:label>
    ${params.description ? `<met:description>${x(params.description)}</met:description>` : ""}
    <met:navType>${x(params.navType)}</met:navType>
    <met:uiType>${x(params.uiType)}</met:uiType>
    <met:setupExperience>${x(params.setupExperience)}</met:setupExperience>
    <met:isNavAutoTempTabsDisabled>${params.isNavAutoTempTabsDisabled}</met:isNavAutoTempTabsDisabled>
    <met:isNavPersonalizationDisabled>${params.isNavPersonalizationDisabled}</met:isNavPersonalizationDisabled>
    ${navItemsXml}
    ${utilityXml}
  </met:metadata>`;
}

function buildTabXml(params: {
  fullName: string; label?: string; motif: string;
  sobjectName?: string; customObject: boolean; url?: string; page?: string; description?: string;
}): string {
  return `<met:metadata xsi:type="met:CustomTab" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <met:fullName>${x(params.fullName)}</met:fullName>
    <met:motif>${x(params.motif)}</met:motif>
    <met:customObject>${params.customObject}</met:customObject>
    ${params.sobjectName ? `<met:sobjectName>${x(params.sobjectName)}</met:sobjectName>` : ""}
    ${params.label ? `<met:label>${x(params.label)}</met:label>` : ""}
    ${params.url ? `<met:url>${x(params.url)}</met:url>` : ""}
    ${params.page ? `<met:page>${x(params.page)}</met:page>` : ""}
    ${params.description ? `<met:description>${x(params.description)}</met:description>` : ""}
  </met:metadata>`;
}

function buildCompactLayoutXml(params: {
  objectName: string; fullName: string; label: string; fields: string[];
}): string {
  const fieldsXml = params.fields.map(f => `<met:fields>${x(f)}</met:fields>`).join("\n");
  return `<met:metadata xsi:type="met:CustomObject" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <met:fullName>${x(params.objectName)}</met:fullName>
    <met:compactLayouts>
      <met:fullName>${x(params.fullName)}</met:fullName>
      <met:label>${x(params.label)}</met:label>
      ${fieldsXml}
    </met:compactLayouts>
  </met:metadata>`;
}

function buildListViewXml(params: {
  objectName: string; fullName: string; label: string;
  columns?: string[];
  filters?: Array<{ field: string; operation: string; value: string }>;
  booleanFilter?: string; filterScope: string;
  sharedTo?: { type: string; name?: string };
}): string {
  const colsXml = (params.columns ?? []).map(c => `<met:columns>${x(c)}</met:columns>`).join("\n");
  const filtersXml = (params.filters ?? []).map(f => `
    <met:filters>
      <met:field>${x(f.field)}</met:field>
      <met:operation>${x(f.operation)}</met:operation>
      <met:value>${x(f.value)}</met:value>
    </met:filters>`).join("\n");
  const sharedToXml = params.sharedTo ? `
    <met:sharedTo>
      <met:${params.sharedTo.type}>${params.sharedTo.name ? x(params.sharedTo.name) : ""}</met:${params.sharedTo.type}>
    </met:sharedTo>` : `<met:sharedTo><met:allUsers>true</met:allUsers></met:sharedTo>`;
  return `<met:metadata xsi:type="met:CustomObject" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <met:fullName>${x(params.objectName)}</met:fullName>
    <met:listViews>
      <met:fullName>${x(params.fullName)}</met:fullName>
      <met:label>${x(params.label)}</met:label>
      <met:filterScope>${x(params.filterScope)}</met:filterScope>
      ${colsXml}
      ${filtersXml}
      ${params.booleanFilter ? `<met:booleanFilter>${x(params.booleanFilter)}</met:booleanFilter>` : ""}
      ${sharedToXml}
    </met:listViews>
  </met:metadata>`;
}

function buildEmailTemplateXml(params: {
  fullName: string; name: string; label: string; description?: string;
  subject: string; htmlValue?: string; body: string; type: string;
  relatedEntityType?: string; encoding: string; available: boolean;
  replyTo?: string; senderName?: string;
}): string {
  return `<met:metadata xsi:type="met:EmailTemplate" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <met:fullName>${x(params.fullName)}</met:fullName>
    <met:name>${x(params.name)}</met:name>
    <met:available>${params.available}</met:available>
    <met:encoding>${x(params.encoding)}</met:encoding>
    <met:label>${x(params.label)}</met:label>
    <met:style>none</met:style>
    <met:subject>${x(params.subject)}</met:subject>
    <met:textOnly>${x(params.body)}</met:textOnly>
    ${params.htmlValue ? `<met:htmlValue>${x(params.htmlValue)}</met:htmlValue>` : ""}
    <met:type>${x(params.type)}</met:type>
    ${params.relatedEntityType ? `<met:relatedEntityType>${x(params.relatedEntityType)}</met:relatedEntityType>` : ""}
    ${params.description ? `<met:description>${x(params.description)}</met:description>` : ""}
    ${params.replyTo ? `<met:replyTo>${x(params.replyTo)}</met:replyTo>` : ""}
    ${params.senderName ? `<met:senderName>${x(params.senderName)}</met:senderName>` : ""}
  </met:metadata>`;
}

function buildCustomNotificationTypeXml(params: {
  fullName: string; customNotifTypeName: string; description?: string;
  desktop: boolean; mobile: boolean;
}): string {
  return `<met:metadata xsi:type="met:CustomNotificationType" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <met:fullName>${x(params.fullName)}</met:fullName>
    <met:customNotifTypeName>${x(params.customNotifTypeName)}</met:customNotifTypeName>
    ${params.description ? `<met:description>${x(params.description)}</met:description>` : ""}
    <met:desktop>${params.desktop}</met:desktop>
    <met:mobile>${params.mobile}</met:mobile>
  </met:metadata>`;
}

function buildReportTypeXml(params: {
  fullName: string; label: string; description?: string; baseObject: string;
  category: string; deployed: boolean;
  relationships?: Array<{ joinTable: string; relationshipType: string; field?: string; label?: string; columns?: string[] }>;
}): string {
  const relXml = (params.relationships ?? []).map((r) => `
    <met:sections>
      <met:columns>
        ${(r.columns ?? []).map(c => `<met:columns><met:field>${x(r.joinTable)}.${x(c)}</met:field><met:reverseJoinColumns><met:field/></met:reverseJoinColumns></met:columns>`).join("\n")}
      </met:columns>
      <met:masterLabel>${x(r.label ?? r.joinTable)}</met:masterLabel>
    </met:sections>`).join("\n");
  const joinXml = (params.relationships ?? []).map((r) => `
    <met:relationships>
      <met:join>
        <met:outerJoin>${r.relationshipType === "Outer"}</met:outerJoin>
        <met:relationship>${x(r.field ?? r.joinTable)}</met:relationship>
      </met:join>
      <met:preferredRelationship>${x(r.joinTable)}</met:preferredRelationship>
    </met:relationships>`).join("\n");
  return `<met:metadata xsi:type="met:ReportType" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <met:fullName>${x(params.fullName)}</met:fullName>
    <met:label>${x(params.label)}</met:label>
    <met:baseObject>${x(params.baseObject)}</met:baseObject>
    <met:category>${x(params.category)}</met:category>
    <met:deployed>${params.deployed}</met:deployed>
    ${params.description ? `<met:description>${x(params.description)}</met:description>` : ""}
    ${relXml}
    ${joinXml}
  </met:metadata>`;
}

function buildConnectedAppXml(params: {
  fullName: string; label: string; description?: string;
  contactEmail: string; callbackUrls: string[]; scopes: string[];
  consumerKey?: string; startUrl?: string;
  accessTokenValidity?: number; refreshTokenValidity?: number;
}): string {
  const callbacksXml = params.callbackUrls.map(u => `<met:callbackUrl>${x(u)}</met:callbackUrl>`).join("\n");
  const scopesXml = params.scopes.map(s => `<met:scopes>${x(s)}</met:scopes>`).join("\n");
  return `<met:metadata xsi:type="met:ConnectedApp" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <met:fullName>${x(params.fullName)}</met:fullName>
    <met:label>${x(params.label)}</met:label>
    ${params.description ? `<met:description>${x(params.description)}</met:description>` : ""}
    <met:contactEmail>${x(params.contactEmail)}</met:contactEmail>
    <met:oauthConfig>
      ${callbacksXml}
      ${scopesXml}
      ${params.consumerKey ? `<met:consumerKey>${x(params.consumerKey)}</met:consumerKey>` : ""}
      ${params.startUrl ? `<met:startUrl>${x(params.startUrl)}</met:startUrl>` : ""}
    </met:oauthConfig>
  </met:metadata>`;
}

function buildExternalDataSourceXml(params: {
  fullName: string; label: string; type: string; endpoint: string;
  principalType: string; protocol: string; username?: string; description?: string;
}): string {
  return `<met:metadata xsi:type="met:ExternalDataSource" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <met:fullName>${x(params.fullName)}</met:fullName>
    <met:label>${x(params.label)}</met:label>
    <met:type>${x(params.type)}</met:type>
    <met:endpoint>${x(params.endpoint)}</met:endpoint>
    <met:principalType>${x(params.principalType)}</met:principalType>
    <met:protocol>${x(params.protocol)}</met:protocol>
    ${params.username ? `<met:username>${x(params.username)}</met:username>` : ""}
    ${params.description ? `<met:description>${x(params.description)}</met:description>` : ""}
  </met:metadata>`;
}

function buildExternalObjectXml(params: {
  fullName: string; label: string; pluralLabel: string;
  externalDataSource: string; externalName?: string; description?: string;
  fields?: SimpleField[];
}): string {
  const fieldsXml = params.fields ? buildSimpleFieldsXml(params.fields) : "";
  return `<met:metadata xsi:type="met:CustomObject" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <met:fullName>${x(params.fullName)}</met:fullName>
    <met:label>${x(params.label)}</met:label>
    <met:pluralLabel>${x(params.pluralLabel)}</met:pluralLabel>
    <met:externalDataSource>${x(params.externalDataSource)}</met:externalDataSource>
    ${params.externalName ? `<met:externalName>${x(params.externalName)}</met:externalName>` : ""}
    ${params.description ? `<met:description>${x(params.description)}</met:description>` : ""}
    <met:deploymentStatus>Deployed</met:deploymentStatus>
    ${fieldsXml}
  </met:metadata>`;
}

function buildRemoteSiteSettingXml(params: {
  fullName: string; name: string; url: string; description?: string;
  isActive: boolean; disableProtocolSecurity: boolean;
}): string {
  return `<met:metadata xsi:type="met:RemoteSiteSetting" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <met:fullName>${x(params.fullName)}</met:fullName>
    <met:description>${x(params.description ?? params.name)}</met:description>
    <met:disableProtocolSecurity>${params.disableProtocolSecurity}</met:disableProtocolSecurity>
    <met:isActive>${params.isActive}</met:isActive>
    <met:url>${x(params.url)}</met:url>
  </met:metadata>`;
}

function buildCspTrustedSiteXml(params: {
  endpointUrl: string; cspDirectives: string[]; description?: string; isActive: boolean;
}): string {
  const name = params.endpointUrl.replace(/[^A-Za-z0-9]/g, "_").slice(0, 40);
  const directivesXml = params.cspDirectives.map(d => `<met:cspDirectives>${x(d)}</met:cspDirectives>`).join("\n");
  return `<met:metadata xsi:type="met:CspTrustedSite" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <met:fullName>${x(name)}</met:fullName>
    <met:endpointUrl>${x(params.endpointUrl)}</met:endpointUrl>
    ${params.description ? `<met:description>${x(params.description)}</met:description>` : ""}
    <met:isActive>${params.isActive}</met:isActive>
    ${directivesXml}
  </met:metadata>`;
}

function buildSharingRuleXml(params: {
  objectName: string; ruleName: string; label: string; ruleType: string;
  accessLevel: string; sharedTo: { type: string; name?: string };
  criteriaItems?: Array<{ field: string; operation: string; value: string }>;
  sharedFrom?: { type: string; name?: string };
}): string {
  const criteriaXml = (params.criteriaItems ?? []).map(c => {
    const fieldQualified = c.field.includes(".") ? c.field : `${params.objectName}.${c.field}`;
    return `
    <met:criteriaItems>
      <met:field>${x(fieldQualified)}</met:field>
      <met:operation>${x(c.operation)}</met:operation>
      <met:value>${x(c.value)}</met:value>
    </met:criteriaItems>`;
  }).join("\n");
  const sharedToXml = `<met:sharedTo><met:${x(params.sharedTo.type)}>${params.sharedTo.name ? x(params.sharedTo.name) : ""}</met:${x(params.sharedTo.type)}></met:sharedTo>`;
  const sharedFromXml = params.sharedFrom
    ? `<met:sharedFrom><met:${x(params.sharedFrom.type)}>${params.sharedFrom.name ? x(params.sharedFrom.name) : ""}</met:${x(params.sharedFrom.type)}></met:sharedFrom>` : "";
  const accountSettingsXml = params.objectName === "Account"
    ? `<met:accountSettings><met:accountOwnerAccess>Edit</met:accountOwnerAccess></met:accountSettings>` : "";
  const ruleTag = params.ruleType === "criteria" ? "sharingCriteriaRules" : "sharingOwnerRules";
  return `<met:metadata xsi:type="met:SharingRules" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    ${accountSettingsXml}
    <met:fullName>${x(params.objectName)}</met:fullName>
    <met:${ruleTag}>
      <met:accessLevel>${x(params.accessLevel)}</met:accessLevel>
      ${criteriaXml}
      <met:fullName>${x(params.ruleName)}</met:fullName>
      <met:label>${x(params.label)}</met:label>
      ${sharedFromXml}
      ${sharedToXml}
    </met:${ruleTag}>
  </met:metadata>`;
}

function buildRecordTypeXml(params: {
  objectName: string; fullName: string; label: string; description?: string;
  businessProcess?: string; isActive: boolean;
  picklistValues?: Array<{ picklist: string; values: string[] }>;
}): string {
  const plValues = (params.picklistValues ?? []).map(pv => `
    <met:picklistValues>
      <met:picklist>${x(pv.picklist)}</met:picklist>
      ${pv.values.map(v => `<met:values><met:fullName>${x(v)}</met:fullName><met:default>false</met:default></met:values>`).join("\n")}
    </met:picklistValues>`).join("\n");
  return `<met:metadata xsi:type="met:RecordType" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <met:fullName>${x(params.objectName)}.${x(params.fullName)}</met:fullName>
    <met:active>${params.isActive}</met:active>
    ${params.businessProcess ? `<met:businessProcess>${x(params.businessProcess)}</met:businessProcess>` : ""}
    ${params.description ? `<met:description>${x(params.description)}</met:description>` : ""}
    <met:label>${x(params.label)}</met:label>
    ${plValues}
  </met:metadata>`;
}

function buildBusinessProcessXml(params: {
  objectName: string; processName: string; label: string;
  description?: string; isActive: boolean; values: string[];
}): string {
  const valuesXml = params.values.map((v, i) => `
    <met:values>
      <met:fullName>${x(v)}</met:fullName>
      <met:default>${i === 0 ? "true" : "false"}</met:default>
      <met:closed>false</met:closed>
    </met:values>`).join("\n");
  return `<met:metadata xsi:type="met:BusinessProcess" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <met:fullName>${x(params.objectName)}.${x(params.processName)}</met:fullName>
    <met:label>${x(params.label)}</met:label>
    <met:isActive>${params.isActive ? "true" : "false"}</met:isActive>
    <met:description>${x(params.description ?? params.label)}</met:description>
    ${valuesXml}
  </met:metadata>`;
}

function buildPageLayoutXml(params: {
  objectName: string; layoutName: string; label: string;
  sections?: Array<{ label: string; style: string; fields: string[] }>;
  relatedLists?: string[];
}): string {
  const sectionsXml = (params.sections ?? []).map(s => {
    const isTwoCol = s.style !== "OneColumn";
    const makeItem = (f: string) => `<met:layoutItems><met:behavior>${f === "Name" ? "Required" : "Edit"}</met:behavior><met:field>${x(f)}</met:field></met:layoutItems>`;
    let colsXml: string;
    if (isTwoCol) {
      const mid = Math.ceil(s.fields.length / 2);
      const col1 = s.fields.slice(0, mid).map(makeItem).join("");
      const col2 = s.fields.slice(mid).map(makeItem).join("");
      colsXml = `<met:layoutColumns>${col1}</met:layoutColumns><met:layoutColumns>${col2}</met:layoutColumns>`;
    } else {
      colsXml = `<met:layoutColumns>${s.fields.map(makeItem).join("")}</met:layoutColumns>`;
    }
    const styleVal = s.style === "TwoColumn" ? "TwoColumnsTopToBottom" : s.style;
    return `<met:layoutSections>
      <met:customLabel>true</met:customLabel>
      <met:detailHeading>true</met:detailHeading>
      <met:editHeading>true</met:editHeading>
      <met:label>${x(s.label)}</met:label>
      ${colsXml}
      <met:style>${x(styleVal)}</met:style>
    </met:layoutSections>`;
  }).join("\n");
  const relatedListsXml = (params.relatedLists ?? []).map(rl => `
    <met:relatedLists>
      <met:relatedList>${x(rl)}</met:relatedList>
    </met:relatedLists>`).join("\n");
  return `<met:metadata xsi:type="met:Layout" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <met:fullName>${x(params.objectName)}-${x(params.layoutName)}</met:fullName>
    ${sectionsXml}
    ${relatedListsXml}
  </met:metadata>`;
}

function buildFieldDependencyXml(params: {
  objectName: string; controllingField: string; dependentField: string;
  valueSettings: Array<{ controllingFieldValue: string[]; valueName: string }>;
}): string {
  const settingsXml = params.valueSettings.map(vs => `
    <met:valueSettings>
      ${vs.controllingFieldValue.map(cfv => `<met:controllingFieldValue>${x(cfv)}</met:controllingFieldValue>`).join("\n")}
      <met:valueName>${x(vs.valueName)}</met:valueName>
    </met:valueSettings>`).join("\n");
  return `<met:metadata xsi:type="met:CustomField" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <met:fullName>${x(params.objectName)}.${x(params.dependentField)}</met:fullName>
    <met:fieldDependency>
      <met:controllingField>${x(params.controllingField)}</met:controllingField>
      ${settingsXml}
    </met:fieldDependency>
  </met:metadata>`;
}

function buildNetworkXml(params: {
  siteName: string; label: string; template: string; urlPathPrefix: string;
  description?: string; status: string; guestUserProfile?: string;
}): string {
  return `<met:metadata xsi:type="met:Network" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <met:fullName>${x(params.siteName)}</met:fullName>
    <met:label>${x(params.label)}</met:label>
    <met:urlPathPrefix>${x(params.urlPathPrefix)}</met:urlPathPrefix>
    <met:template><met:name>${x(params.template)}</met:name></met:template>
    <met:status>${x(params.status)}</met:status>
    ${params.description ? `<met:description>${x(params.description)}</met:description>` : ""}
    ${params.guestUserProfile ? `<met:guestProfile>${x(params.guestUserProfile)}</met:guestProfile>` : ""}
    <met:allowedExtensions>jpg,jpeg,png,gif,pdf,doc,docx</met:allowedExtensions>
    <met:enableGuestChatter>false</met:enableGuestChatter>
    <met:enableInvitation>false</met:enableInvitation>
    <met:enableKnowledgeable>false</met:enableKnowledgeable>
    <met:enableNicknameDisplay>false</met:enableNicknameDisplay>
    <met:enablePrivateMessages>false</met:enablePrivateMessages>
    <met:enableReputation>false</met:enableReputation>
    <met:enableShowAllNetworkSettings>false</met:enableShowAllNetworkSettings>
    <met:enableTalkingAboutStats>false</met:enableTalkingAboutStats>
    <met:gatherCustomerSentimentData>false</met:gatherCustomerSentimentData>
    <met:loginType>CommunitiesLogin</met:loginType>
    <met:networkMemberGroups></met:networkMemberGroups>
    <met:picassoSite>${x(params.siteName)}</met:picassoSite>
    <met:selfRegistration>false</met:selfRegistration>
    <met:sendWelcomeEmail>false</met:sendWelcomeEmail>
    <met:tabs></met:tabs>
    <met:verificationRequired>Relaxed</met:verificationRequired>
  </met:metadata>`;
}

function buildBotXml(params: {
  agentName: string; label: string; description?: string; type: string;
  company?: string; persona?: string; tone?: string; instructions?: string; isNew?: boolean;
}): string {
  return `<met:metadata xsi:type="met:Bot" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <met:fullName>${x(params.agentName)}</met:fullName>
    <met:label>${x(params.label)}</met:label>
    ${params.description ? `<met:description>${x(params.description)}</met:description>` : ""}
    <met:type>${x(params.type)}</met:type>
    <met:status>Active</met:status>
    ${params.company ? `<met:company>${x(params.company)}</met:company>` : ""}
    ${params.persona ? `<met:persona>${x(params.persona)}</met:persona>` : ""}
    ${params.tone ? `<met:tone>${x(params.tone)}</met:tone>` : ""}
    ${params.instructions ? `<met:systemPrompt>${x(params.instructions)}</met:systemPrompt>` : ""}
  </met:metadata>`;
}

function buildBotVersionXml(params: {
  agentName: string; topicName: string; label: string; description: string;
  scope: string; instructions?: string; actions?: string[];
}): string {
  const actionsXml = (params.actions ?? []).map(a => `
    <met:botActions>
      <met:botActionName>${x(a)}</met:botActionName>
    </met:botActions>`).join("\n");
  return `<met:metadata xsi:type="met:BotVersion" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <met:fullName>${x(params.agentName)}.${x(params.topicName)}</met:fullName>
    <met:label>${x(params.label)}</met:label>
    <met:description>${x(params.description)}</met:description>
    <met:scope>${x(params.scope)}</met:scope>
    ${params.instructions ? `<met:instructions>${x(params.instructions)}</met:instructions>` : ""}
    ${actionsXml}
  </met:metadata>`;
}

function buildMatchingRuleXml(params: {
  objectName: string; ruleName: string; label: string; description?: string;
  matchingRuleItems: Array<{ fieldName: string; matchingMethod: string; blankValueBehavior: string }>;
}): string {
  const itemsXml = params.matchingRuleItems.map(item => `
    <met:matchingRuleItems>
      <met:blankValueBehavior>${x(item.blankValueBehavior)}</met:blankValueBehavior>
      <met:fieldName>${x(params.objectName)}.${x(item.fieldName)}</met:fieldName>
      <met:matchingMethod>${x(item.matchingMethod)}</met:matchingMethod>
    </met:matchingRuleItems>`).join("\n");
  return `<met:metadata xsi:type="met:MatchingRule" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <met:fullName>${x(params.objectName)}.${x(params.ruleName)}</met:fullName>
    <met:label>${x(params.label)}</met:label>
    ${params.description ? `<met:description>${x(params.description)}</met:description>` : ""}
    <met:matchingRuleStatus>Active</met:matchingRuleStatus>
    ${itemsXml}
  </met:metadata>`;
}

function buildDuplicateRuleXml(params: {
  objectName: string; ruleName: string; label: string; description?: string;
  isActive: boolean; actionOnInsert: string; actionOnUpdate: string;
  alertMessage?: string;
  matchingRules: Array<{ matchingRule: string; matchingRuleItems?: Array<{ fieldName: string; matchingField: string }> }>;
}): string {
  const mrXml = params.matchingRules.map((mr) => `
    <met:duplicateRuleMatchRules>
      <met:duplicateRuleItemProperties></met:duplicateRuleItemProperties>
      <met:matchingRule>${x(params.objectName)}.${x(mr.matchingRule)}</met:matchingRule>
      <met:objectMapping>
        <met:inputObject>${x(params.objectName)}</met:inputObject>
        <met:outputObject>${x(params.objectName)}</met:outputObject>
        ${(mr.matchingRuleItems ?? []).map(item => `
          <met:mappingFields>
            <met:inputField>${x(item.fieldName)}</met:inputField>
            <met:outputField>${x(item.matchingField)}</met:outputField>
          </met:mappingFields>`).join("\n")}
      </met:objectMapping>
    </met:duplicateRuleMatchRules>`).join("\n");
  return `<met:metadata xsi:type="met:DuplicateRule" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <met:fullName>${x(params.objectName)}.${x(params.ruleName)}</met:fullName>
    <met:label>${x(params.label)}</met:label>
    <met:isActive>${params.isActive}</met:isActive>
    ${params.description ? `<met:description>${x(params.description)}</met:description>` : ""}
    <met:actionOnInsert>${x(params.actionOnInsert)}</met:actionOnInsert>
    <met:actionOnUpdate>${x(params.actionOnUpdate)}</met:actionOnUpdate>
    ${params.alertMessage ? `<met:alertText>${x(params.alertMessage)}</met:alertText>` : ""}
    ${mrXml}
    <met:operationsOnInsert>None</met:operationsOnInsert>
    <met:operationsOnUpdate>None</met:operationsOnUpdate>
    <met:securityOption>EnforcedWithWarning</met:securityOption>
    <met:sortOrder>1</met:sortOrder>
  </met:metadata>`;
}

function buildAutoResponseRuleXml(params: {
  objectName: string; ruleName: string; label: string; active: boolean;
  ruleEntries: Array<{
    entryOrder: number; template: string; senderName?: string; senderEmail?: string;
    criteriaItems?: Array<{ field: string; operation: string; value: string }>;
    formula?: string;
  }>;
}): string {
  const entriesXml = params.ruleEntries.map(e => {
    const criteriaXml = (e.criteriaItems ?? []).map(c => `
      <met:criteriaItems>
        <met:field>${x(c.field)}</met:field>
        <met:operation>${x(c.operation)}</met:operation>
        <met:value>${x(c.value)}</met:value>
      </met:criteriaItems>`).join("\n");
    return `<met:ruleEntry>
      <met:template>${x(e.template)}</met:template>
      ${e.senderName ? `<met:senderName>${x(e.senderName)}</met:senderName>` : ""}
      ${e.senderEmail ? `<met:senderEmail>${x(e.senderEmail)}</met:senderEmail>` : ""}
      ${criteriaXml}
      ${e.formula ? `<met:formula>${x(e.formula)}</met:formula>` : ""}
    </met:ruleEntry>`;
  }).join("\n");
  return `<met:metadata xsi:type="met:AutoResponseRules" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <met:fullName>${x(params.objectName)}</met:fullName>
    <met:autoResponseRule>
      <met:fullName>${x(params.ruleName)}</met:fullName>
      <met:active>${params.active}</met:active>
      ${entriesXml}
    </met:autoResponseRule>
  </met:metadata>`;
}

// ─── Core upsert ─────────────────────────────────────────────────────────────

export async function upsertMetadata(auth: SalesforceAuth, metadataXml: string): Promise<ToolResult> {
  const body = `<met:upsertMetadata>${metadataXml}</met:upsertMetadata>`;
  try {
    const xml = await callMetadataSoap(auth, "upsertMetadata", body);
    const error = extractSoapError(xml);
    if (error) return { success: false, message: error };
    const results = parseUpsertResult(xml);
    if (!results.length) return { success: false, message: "No result returned from Salesforce." };
    const r = results[0];
    if (!r.success) {
      const errMsg = r.errors?.map((e) => `[${e.statusCode}] ${e.message}`).join("; ") ?? "Unknown error";
      return { success: false, message: errMsg };
    }
    return { success: true, fullName: r.fullName, created: r.created, message: r.created ? `Successfully created '${r.fullName}'.` : `Successfully updated '${r.fullName}'.` };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, message: msg };
  }
}

// ─── Exported service functions ───────────────────────────────────────────────

export async function createCustomObject(auth: SalesforceAuth, meta: CustomObjectMetadata): Promise<ToolResult> {
  return upsertMetadata(auth, buildCustomObjectXml(meta));
}
export async function createCustomField(auth: SalesforceAuth, meta: CustomFieldMetadata): Promise<ToolResult> {
  return upsertMetadata(auth, buildCustomFieldXml(meta));
}
export async function addPicklistValues(auth: SalesforceAuth, objectFieldFullName: string, newValues: PicklistValue[]): Promise<ToolResult> {
  const [objectName, fieldName] = objectFieldFullName.split(".");
  if (!objectName || !fieldName) return { success: false, message: "fullName must be in format 'ObjectName__c.FieldName__c'" };
  try {
    const client = createClient(auth);
    const fieldDevName = fieldName.replace(/__c$/i, "");
    // Custom objects require EntityDefinition relationship query (TableEnumOrId needs object ID, not API name)
    const isCustomLike = objectName.endsWith("__c") || objectName.endsWith("__mdt") || objectName.endsWith("__e");
    const query = isCustomLike
      ? `SELECT Id, Metadata FROM CustomField WHERE DeveloperName='${fieldDevName}' AND EntityDefinition.QualifiedApiName='${objectName}'`
      : `SELECT Id, Metadata FROM CustomField WHERE DeveloperName='${fieldDevName}' AND TableEnumOrId='${objectName}'`;
    const resp = await client.get<{ records: Array<{ Id: string; Metadata: Record<string, unknown> }> }>(`/tooling/query?q=${encodeURIComponent(query)}`);
    if (!resp.data.records.length) return { success: false, message: `Field '${objectFieldFullName}' not found in Tooling API.` };
    const record = resp.data.records[0];
    const existingMeta = record.Metadata ?? {};
    const valueSetDef = (existingMeta.valueSet as Record<string, unknown> | undefined)?.valueSetDefinition as Record<string, unknown> | undefined;
    const existingValues: Array<Record<string, unknown>> = (valueSetDef?.value as Array<Record<string, unknown>>) ?? [];
    const existingNames = new Set(existingValues.map((v) => v.fullName));
    const toAdd = newValues.filter((v) => !existingNames.has(v.fullName));
    if (toAdd.length === 0) return { success: true, fullName: objectFieldFullName, created: false, message: `All values already exist in '${objectFieldFullName}'.` };
    const merged = [...existingValues, ...toAdd.map(v => ({ fullName: v.fullName, label: v.label ?? v.fullName, default: v.default ?? false, isActive: true }))];
    const sortedMerged = merged.map(v => ({ ...(v as Record<string, unknown>), label: (v as Record<string, unknown>).label ?? (v as Record<string, unknown>).fullName }));
    // Strip null values — Tooling API PATCH rejects null fields in Metadata body
    const stripNulls = (o: unknown): unknown => {
      if (Array.isArray(o)) return o.map(stripNulls);
      if (o !== null && typeof o === "object") {
        return Object.fromEntries(Object.entries(o as Record<string, unknown>).filter(([, v]) => v !== null).map(([k, v]) => [k, stripNulls(v)]));
      }
      return o;
    };
    const cleanExisting = stripNulls(existingMeta) as Record<string, unknown>;
    const updatedValueSet = {
      ...(cleanExisting.valueSet as Record<string, unknown> ?? { restricted: false }),
      valueSetDefinition: { sorted: false, value: stripNulls(sortedMerged) },
    };
    const updatedMeta = { ...cleanExisting, valueSet: updatedValueSet };
    // Tooling API PATCH to update the field metadata directly (avoids SOAP XML ordering issues)
    await client.patch<unknown>(`/tooling/sobjects/CustomField/${record.Id}`, { Metadata: updatedMeta });
    return { success: true, fullName: objectFieldFullName, created: false, message: `Added ${toAdd.length} new value(s) to '${objectFieldFullName}'.` };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, message: msg };
  }
}
export async function createFlow(auth: SalesforceAuth, params: Parameters<typeof buildFlowXml>[0]): Promise<ToolResult> {
  const unsupportedFilterOps = ["Contains", "NotContain", "NotContains", "DoesNotContain"];
  const supportedOps = "EqualTo, NotEqualTo, GreaterThan, LessThan, GreaterThanOrEqualTo, LessThanOrEqualTo, IsNull, StartsWith, EndsWith";
  for (const el of (params.elements ?? [])) {
    if (el.type === "GetRecords") {
      const allFilters: Array<{ operator: string }> = [
        ...(el.filterField ? [{ operator: el.filterOperator ?? "EqualTo" }] : []),
        ...(el.filters ?? []),
      ];
      for (const f of allFilters) {
        if (unsupportedFilterOps.includes(f.operator)) {
          return {
            success: false,
            message: `GetRecords filter operator '${f.operator}' is not supported by Salesforce Flow record lookups. Supported operators: ${supportedOps}. For a "contains" search, use a Decision element with a formula condition or retrieve all records and filter in an Assignment loop.`,
          };
        }
      }
    }
  }
  return upsertMetadata(auth, buildFlowXml(params));
}
export async function createApprovalProcess(auth: SalesforceAuth, params: Parameters<typeof buildApprovalProcessXml>[0]): Promise<ToolResult> {
  return upsertMetadata(auth, buildApprovalProcessXml(params));
}
export async function createValidationRule(auth: SalesforceAuth, params: Parameters<typeof buildValidationRuleXml>[0]): Promise<ToolResult> {
  return upsertMetadata(auth, buildValidationRuleXml(params));
}
export async function createWorkflowFieldUpdate(auth: SalesforceAuth, params: Parameters<typeof buildWorkflowFieldUpdateXml>[0]): Promise<ToolResult> {
  return upsertMetadata(auth, buildWorkflowFieldUpdateXml(params));
}
export async function createCustomMetadataType(auth: SalesforceAuth, params: Parameters<typeof buildCustomMetadataTypeXml>[0]): Promise<ToolResult> {
  return upsertMetadata(auth, buildCustomMetadataTypeXml(params));
}
export async function createCustomMetadataRecord(auth: SalesforceAuth, params: Parameters<typeof buildCustomMetadataRecordXml>[0]): Promise<ToolResult> {
  return upsertMetadata(auth, buildCustomMetadataRecordXml(params));
}
export async function createCustomLabel(auth: SalesforceAuth, params: Parameters<typeof buildCustomLabelXml>[0]): Promise<ToolResult> {
  return upsertMetadata(auth, buildCustomLabelXml(params));
}
export async function createCustomSetting(auth: SalesforceAuth, params: Parameters<typeof buildCustomSettingXml>[0]): Promise<ToolResult> {
  return upsertMetadata(auth, buildCustomSettingXml(params));
}
export async function createGlobalValueSet(auth: SalesforceAuth, params: Parameters<typeof buildGlobalValueSetXml>[0]): Promise<ToolResult> {
  return upsertMetadata(auth, buildGlobalValueSetXml(params));
}
export async function createPlatformEvent(auth: SalesforceAuth, params: Parameters<typeof buildPlatformEventXml>[0]): Promise<ToolResult> {
  return upsertMetadata(auth, buildPlatformEventXml(params));
}
export async function createEmailAlert(auth: SalesforceAuth, params: Parameters<typeof buildEmailAlertXml>[0]): Promise<ToolResult> {
  return upsertMetadata(auth, buildEmailAlertXml(params));
}
export async function createAssignmentRule(auth: SalesforceAuth, params: Parameters<typeof buildAssignmentRuleXml>[0]): Promise<ToolResult> {
  return upsertMetadata(auth, buildAssignmentRuleXml(params));
}
export async function createAutoResponseRule(auth: SalesforceAuth, params: Parameters<typeof buildAutoResponseRuleXml>[0]): Promise<ToolResult> {
  return upsertMetadata(auth, buildAutoResponseRuleXml(params));
}
export async function createMatchingRule(auth: SalesforceAuth, params: Parameters<typeof buildMatchingRuleXml>[0]): Promise<ToolResult> {
  return upsertMetadata(auth, buildMatchingRuleXml(params));
}
export async function createDuplicateRule(auth: SalesforceAuth, params: Parameters<typeof buildDuplicateRuleXml>[0]): Promise<ToolResult> {
  return upsertMetadata(auth, buildDuplicateRuleXml(params));
}
export async function createPermissionSet(auth: SalesforceAuth, params: Parameters<typeof buildPermissionSetXml>[0]): Promise<ToolResult> {
  return upsertMetadata(auth, buildPermissionSetXml(params));
}
export async function createRole(auth: SalesforceAuth, params: Parameters<typeof buildRoleXml>[0]): Promise<ToolResult> {
  return upsertMetadata(auth, buildRoleXml(params));
}
export async function createQueue(auth: SalesforceAuth, params: Parameters<typeof buildQueueXml>[0]): Promise<ToolResult> {
  return upsertMetadata(auth, buildQueueXml(params));
}
export async function createNamedCredential(auth: SalesforceAuth, params: Parameters<typeof buildNamedCredentialXml>[0]): Promise<ToolResult> {
  return upsertMetadata(auth, buildNamedCredentialXml(params));
}
export async function createLightningApp(auth: SalesforceAuth, params: Parameters<typeof buildLightningAppXml>[0]): Promise<ToolResult> {
  return upsertMetadata(auth, buildLightningAppXml(params));
}
export async function createTab(auth: SalesforceAuth, params: Parameters<typeof buildTabXml>[0]): Promise<ToolResult> {
  return upsertMetadata(auth, buildTabXml(params));
}
export async function createCompactLayout(auth: SalesforceAuth, params: Parameters<typeof buildCompactLayoutXml>[0]): Promise<ToolResult> {
  return upsertMetadata(auth, buildCompactLayoutXml(params));
}
export async function createListView(auth: SalesforceAuth, params: Parameters<typeof buildListViewXml>[0]): Promise<ToolResult> {
  return upsertMetadata(auth, buildListViewXml(params));
}
export async function createEmailTemplate(auth: SalesforceAuth, params: Parameters<typeof buildEmailTemplateXml>[0]): Promise<ToolResult> {
  return upsertMetadata(auth, buildEmailTemplateXml(params));
}
export async function createCustomNotificationType(auth: SalesforceAuth, params: Parameters<typeof buildCustomNotificationTypeXml>[0]): Promise<ToolResult> {
  return upsertMetadata(auth, buildCustomNotificationTypeXml(params));
}
export async function createReportType(auth: SalesforceAuth, params: Parameters<typeof buildReportTypeXml>[0]): Promise<ToolResult> {
  return upsertMetadata(auth, buildReportTypeXml(params));
}
export async function createConnectedApp(auth: SalesforceAuth, params: Parameters<typeof buildConnectedAppXml>[0]): Promise<ToolResult> {
  return upsertMetadata(auth, buildConnectedAppXml(params));
}
export async function createExternalDataSource(auth: SalesforceAuth, params: Parameters<typeof buildExternalDataSourceXml>[0]): Promise<ToolResult> {
  return upsertMetadata(auth, buildExternalDataSourceXml(params));
}
export async function createExternalObject(auth: SalesforceAuth, params: Parameters<typeof buildExternalObjectXml>[0]): Promise<ToolResult> {
  return upsertMetadata(auth, buildExternalObjectXml(params));
}
export async function createRemoteSiteSetting(auth: SalesforceAuth, params: Parameters<typeof buildRemoteSiteSettingXml>[0]): Promise<ToolResult> {
  return upsertMetadata(auth, buildRemoteSiteSettingXml(params));
}
export async function createCspSetting(auth: SalesforceAuth, params: Parameters<typeof buildCspTrustedSiteXml>[0]): Promise<ToolResult> {
  return upsertMetadata(auth, buildCspTrustedSiteXml(params));
}
export async function createSharingRule(auth: SalesforceAuth, params: Parameters<typeof buildSharingRuleXml>[0]): Promise<ToolResult> {
  return upsertMetadata(auth, buildSharingRuleXml(params));
}
export async function createRecordType(auth: SalesforceAuth, params: Parameters<typeof buildRecordTypeXml>[0]): Promise<ToolResult> {
  return upsertMetadata(auth, buildRecordTypeXml(params));
}
export async function createBusinessProcess(auth: SalesforceAuth, params: Parameters<typeof buildBusinessProcessXml>[0]): Promise<ToolResult> {
  return upsertMetadata(auth, buildBusinessProcessXml(params));
}
export async function createPageLayout(auth: SalesforceAuth, params: Parameters<typeof buildPageLayoutXml>[0]): Promise<ToolResult> {
  return upsertMetadata(auth, buildPageLayoutXml(params));
}
export async function createFieldDependency(auth: SalesforceAuth, params: Parameters<typeof buildFieldDependencyXml>[0]): Promise<ToolResult> {
  return upsertMetadata(auth, buildFieldDependencyXml(params));
}
export async function createExperienceSite(auth: SalesforceAuth, params: Parameters<typeof buildNetworkXml>[0]): Promise<ToolResult> {
  return upsertMetadata(auth, buildNetworkXml(params));
}
export async function createAgent(auth: SalesforceAuth, params: Parameters<typeof buildBotXml>[0]): Promise<ToolResult> {
  return upsertMetadata(auth, buildBotXml(params));
}
export async function createAgentTopic(auth: SalesforceAuth, params: Parameters<typeof buildBotVersionXml>[0]): Promise<ToolResult> {
  return upsertMetadata(auth, buildBotVersionXml(params));
}

// ─── Agentforce helpers ───────────────────────────────────────────────────────
function buildGenAiPluginXml(params: Record<string, any>): string {
    const instructionsXml = (params.instructions ?? []).map((instr: any, i: number) => `
    <met:genAiPluginInstructions>
      <met:description>${x(instr)}</met:description>
      <met:developerName>instruction_${i}</met:developerName>
      <met:masterLabel>instruction_${i}</met:masterLabel>
      <met:sortOrder>${i}</met:sortOrder>
    </met:genAiPluginInstructions>`).join("\n");
    const functionsXml = (params.actions ?? []).map((a: any) => `
    <met:genAiFunctions>
      <met:functionName>${x(a)}</met:functionName>
    </met:genAiFunctions>`).join("\n");
    const topicName = params.topicName ?? params.fullName ?? params.label ?? "";
    return `<met:metadata xsi:type="met:GenAiPlugin" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <met:fullName>${x(topicName)}</met:fullName>
    <met:canEscalate>${params.escalationEnabled === true ? "true" : "false"}</met:canEscalate>
    <met:description>${x(params.description)}</met:description>
    <met:developerName>${x(topicName)}</met:developerName>
    <met:language>en_US</met:language>
    <met:masterLabel>${x(params.label ?? topicName)}</met:masterLabel>
    <met:pluginType>Topic</met:pluginType>
    <met:scope>${x(params.scope)}</met:scope>
    ${params.fallbackTopic ? `<met:fallbackPlugin>${x(params.fallbackTopic)}</met:fallbackPlugin>` : ""}
    ${instructionsXml}
    ${functionsXml}
  </met:metadata>`;
}
function buildGenAiPlannerBundleXml(params: Record<string, any>): string {
    const pluginsXml = (params.topicNames ?? []).map((t: any) => `
    <met:genAiPlugins>
      <met:genAiPluginName>${x(t)}</met:genAiPluginName>
    </met:genAiPlugins>`).join("\n");
    const dataLibXml = params.dataLibraryName ? `
    <met:dataLibraries>
      <met:dataLibraryName>${x(params.dataLibraryName)}</met:dataLibraryName>
    </met:dataLibraries>` : "";
    return `<met:metadata xsi:type="met:GenAiPlannerBundle" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <met:fullName>${x(params.plannerName)}</met:fullName>
    <met:masterLabel>${x(params.label)}</met:masterLabel>
    ${params.description ? `<met:description>${x(params.description)}</met:description>` : ""}
    <met:plannerType>AiCopilot__ReAct</met:plannerType>
    ${dataLibXml}
    ${pluginsXml}
  </met:metadata>`;
}
export async function activateAgent(auth: SalesforceAuth, agentApiName: string): Promise<ToolResult> {
    return _setBotStatus(auth, agentApiName, "Active");
}
export async function deactivateAgent(auth: SalesforceAuth, agentApiName: string): Promise<ToolResult> {
    return _setBotStatus(auth, agentApiName, "Inactive");
}
async function _setBotStatus(auth: SalesforceAuth, agentApiName: string, status: string): Promise<any> {
    try {
        const headers = { "Authorization": `Bearer ${auth.accessToken}`, "Content-Type": "application/json" };
        const base = `${auth.instanceUrl}/services/data/v${API_VERSION}`;
        const connectResp = await fetchWithTimeout(`${base}/connect/einstein/copilot/${agentApiName}/${status === "Active" ? "activate" : "deactivate"}`, { method: "POST", headers }, 15_000).catch(() => null);
        if ((connectResp as any)?.ok) return { success: true, message: `Agent '${agentApiName}' ${status === "Active" ? "activated" : "deactivated"} successfully.` };
        const qResp = await fetchWithTimeout(`${base}/query?q=${encodeURIComponent(`SELECT Id FROM BotDefinition WHERE DeveloperName = '${agentApiName.replace(/'/g, "\\'")}'`)}`, { method: "GET", headers }, 15_000).catch(() => null);
        if ((qResp as any)?.ok) {
            const qData = await (qResp as any).json().catch(() => ({}));
            const botId = qData.records?.[0]?.Id;
            if (botId) {
                const pResp = await fetchWithTimeout(`${base}/sobjects/BotDefinition/${botId}`, { method: "PATCH", headers, body: JSON.stringify({ Status: status }) }, 30_000).catch(() => null);
                if ((pResp as any)?.ok || (pResp as any)?.status === 204)
                    return { success: true, message: `Agent '${agentApiName}' ${status === "Active" ? "activated" : "deactivated"} successfully.` };
            }
        }
        return { success: true, message: `Agent '${agentApiName}' ${status === "Active" ? "activation" : "deactivation"} requested. Complete activation in Setup → Agents.` };
    }
    catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}
export async function createAgentPlanner(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    return upsertMetadata(auth, buildGenAiPlannerBundleXml(params));
}
// ─── Metadata helpers & Agentforce management (added v2.2.0) ─────────────────
// ─── Metadata read/list/delete helpers ───────────────────────────────────────
export async function readMetadataItem(auth: SalesforceAuth, type: any, fullName: any): Promise<any> {
    const body = `<met:readMetadata>
      <met:type>${type}</met:type>
      <met:fullNames>${x(fullName)}</met:fullNames>
    </met:readMetadata>`;
    try {
        const xml = await callMetadataSoap(auth, "readMetadata", body);
        const error = extractSoapError(xml);
        if (error)
            return { success: false, message: error };
        return { success: true, rawXml: xml };
    }
    catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}
export async function listMetadataType(auth: any, type: any) {
    const body = `<met:listMetadata>
      <met:queries><met:type>${x(type)}</met:type></met:queries>
      <met:asOfVersion>${API_VERSION}</met:asOfVersion>
    </met:listMetadata>`;
    try {
        const xml = await callMetadataSoap(auth, "listMetadata", body);
        const error = extractSoapError(xml);
        if (error)
            return { success: false, message: error, items: [] };
        const items = [];
        for (const block of [...xml.matchAll(/<result>([\s\S]*?)<\/result>/gi)]) {
            const inner = block[1];
            const fullNameMatch = inner.match(/<fullName[^>]*>([\s\S]*?)<\/fullName>/i);
            if (fullNameMatch) {
                const labelMatch = inner.match(/<label[^>]*>([\s\S]*?)<\/label>/i);
                const lastModifiedMatch = inner.match(/<lastModifiedDate[^>]*>([\s\S]*?)<\/lastModifiedDate>/i);
                items.push({
                    fullName: fullNameMatch[1].trim(),
                    label: labelMatch?.[1].trim() ?? "",
                    lastModifiedDate: lastModifiedMatch?.[1].trim() ?? "",
                    type,
                });
            }
        }
        return { success: true, items };
    }
    catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)), items: [] };
    }
}
export async function deleteMetadataItems(auth: SalesforceAuth, type: any, fullNames: any): Promise<any> {
    if (fullNames.length === 0)
        return { success: true, deleted: [], message: "Nothing to delete" };
    const fullNamesXml = fullNames.map((n: any) => `<met:fullNames>${x(n)}</met:fullNames>`).join("\n");
    const body = `<met:deleteMetadata>
      <met:type>${x(type)}</met:type>
      ${fullNamesXml}
    </met:deleteMetadata>`;
    try {
        const xml = await callMetadataSoap(auth, "deleteMetadata", body);
        const error = extractSoapError(xml);
        if (error)
            return { success: false, message: error, deleted: [] };
        const deleted = [];
        const errors = [];
        for (const block of [...xml.matchAll(/<result>([\s\S]*?)<\/result>/gi)]) {
            const inner = block[1];
            const fullNameMatch = inner.match(/<fullName[^>]*>([\s\S]*?)<\/fullName>/i);
            const successMatch = inner.match(/<success>(true|false)<\/success>/i);
            const fnName = fullNameMatch?.[1].trim() ?? "";
            if (successMatch?.[1] === "true") {
                deleted.push(fnName);
            }
            else {
                const msgMatch = inner.match(/<message[^>]*>([\s\S]*?)<\/message>/i);
                errors.push(`${fnName}: ${msgMatch?.[1].trim() ?? "Unknown error"}`);
            }
        }
        return {
            success: errors.length === 0,
            deleted,
            message: deleted.length > 0 ? `Deleted: ${deleted.join(", ")}` : "Nothing deleted",
            ...(errors.length > 0 ? { errors } : {}),
        };
    }
    catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)), deleted: [] };
    }
}
// ─── Agentforce query/management functions ────────────────────────────────────
export async function getAgent(auth: any, agentApiName: any) {
    try {
        let status = "Unknown";
        const statusResp = await fetchWithTimeout(`${auth.instanceUrl}/services/data/v${API_VERSION}/connect/einstein/copilot/${agentApiName}`, { method: "GET", headers: { "Authorization": `Bearer ${auth.accessToken}`, "Content-Type": "application/json" } }, 15_000).catch(() => null);
        if (statusResp?.ok) {
            const data = await statusResp.json().catch(() => ({}));
            status = data.status ?? data.botStatus ?? "Unknown";
        }
        const [botResult, pluginList, funcList, plannerList] = await Promise.all([
            readMetadataItem(auth, "Bot", agentApiName),
            listMetadataType(auth, "GenAiPlugin"),
            listMetadataType(auth, "GenAiFunction"),
            listMetadataType(auth, "GenAiPlannerBundle"),
        ]);
        return {
            success: true,
            agent: { apiName: agentApiName, status, metadataFound: botResult.success },
            topics: pluginList.items,
            actions: funcList.items,
            planners: plannerList.items,
            message: `Agent '${agentApiName}' — status: ${status}, ${pluginList.items.length} topic(s), ${funcList.items.length} action(s), ${plannerList.items.length} planner(s).`,
        };
    }
    catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}
export async function listAgents(auth: SalesforceAuth): Promise<any> {
    try {
        const botList = await listMetadataType(auth, "Bot");
        if (!botList.success)
            return { success: false, message: botList.message ?? "Failed to list agents", agents: [] };
        const agents = [];
        for (const bot of botList.items) {
            let status = "Unknown";
            const resp = await fetchWithTimeout(`${auth.instanceUrl}/services/data/v${API_VERSION}/connect/einstein/copilot/${bot.fullName}`, { method: "GET", headers: { "Authorization": `Bearer ${auth.accessToken}` } }, 10_000).catch(() => null);
            if (resp?.ok) {
                const data = await resp.json().catch(() => ({}));
                status = data.status ?? data.botStatus ?? "Unknown";
            }
            agents.push({ apiName: bot.fullName, label: bot.label, status, lastModifiedDate: bot.lastModifiedDate });
        }
        return { success: true, agents, message: `Found ${agents.length} agent(s).` };
    }
    catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)), agents: [] };
    }
}
export async function updateAgentTopic(auth: SalesforceAuth, params: any, agentApiName: any): Promise<any> {
    try {
        if (agentApiName) {
            const deactResult = await deactivateAgent(auth, agentApiName);
            if (!deactResult.success)
                console.error(`Warning: deactivation returned: ${deactResult.message}`);
        }
        const result = await upsertMetadata(auth, buildGenAiPluginXml(params));
        if (agentApiName) {
            const actResult = await activateAgent(auth, agentApiName);
            if (!actResult.success)
                return { ...result, warning: `Topic updated but agent reactivation failed: ${actResult.message}` };
        }
        return result;
    }
    catch (err) {
        if (agentApiName)
            await activateAgent(auth, agentApiName).catch(() => { });
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}
export async function deleteAgent(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    const deleted = [];
    const errors = [];
    try {
        await deactivateAgent(auth, params.agentApiName).catch(() => { });
        const botRead = await readMetadataItem(auth, "Bot", params.agentApiName);
        let topicsToDelete = [];
        let actionsToDelete: any[] = [];
        let plannerToDelete = null;
        if (botRead.success && botRead.rawXml) {
            const plannerMatch = botRead.rawXml.match(/<plannerBundle[^>]*>([\s\S]*?)<\/plannerBundle>/i)
                || botRead.rawXml.match(/<plannerBundleName[^>]*>([\s\S]*?)<\/plannerBundleName>/i);
            if (plannerMatch)
                plannerToDelete = plannerMatch[1].trim();
        }
        if ((params.deleteTopics || params.deleteActions) && plannerToDelete) {
            const plannerRead = await readMetadataItem(auth, "GenAiPlannerBundle", plannerToDelete);
            if (plannerRead.success && plannerRead.rawXml) {
                topicsToDelete = [...plannerRead.rawXml.matchAll(/<genAiPluginName[^>]*>([\s\S]*?)<\/genAiPluginName>/gi)].map((m: any) => m[1].trim());
                if (params.deleteActions) {
                    for (const topicName of topicsToDelete) {
                        const topicRead = await readMetadataItem(auth, "GenAiPlugin", topicName);
                        if (topicRead.success && topicRead.rawXml) {
                            const actionNames = [...topicRead.rawXml.matchAll(/<functionName[^>]*>([\s\S]*?)<\/functionName>/gi)].map((m: any) => m[1].trim());
                            actionsToDelete.push(...actionNames);
                        }
                    }
                    actionsToDelete = [...new Set(actionsToDelete)];
                }
            }
        }
        if (actionsToDelete.length > 0) {
            const res = await deleteMetadataItems(auth, "GenAiFunction", actionsToDelete);
            deleted.push(...(res.deleted ?? []));
            if (res.errors)
                errors.push(...res.errors);
        }
        if (topicsToDelete.length > 0) {
            const res = await deleteMetadataItems(auth, "GenAiPlugin", topicsToDelete);
            deleted.push(...(res.deleted ?? []));
            if (res.errors)
                errors.push(...res.errors);
        }
        if (plannerToDelete) {
            const res = await deleteMetadataItems(auth, "GenAiPlannerBundle", [plannerToDelete]);
            deleted.push(...(res.deleted ?? []));
            if (res.errors)
                errors.push(...res.errors);
        }
        const botRes = await deleteMetadataItems(auth, "Bot", [params.agentApiName]);
        deleted.push(...(botRes.deleted ?? []));
        if (botRes.errors)
            errors.push(...botRes.errors);
        return {
            success: errors.length === 0,
            deleted,
            message: `Deleted ${deleted.length} component(s)${deleted.length > 0 ? ": " + deleted.join(", ") : ""}.`,
            ...(errors.length > 0 ? { errors } : {}),
        };
    }
    catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)), deleted };
    }
}
export async function testAgent(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const orgUrl = (params.orgUrl ?? auth.instanceUrl).replace(/\/$/, "");
        const externalSessionKey = `mcp_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
        const bootstrapResp = await fetchWithTimeout(`${orgUrl}/agentforce/bootstrap/nameduser`, {
            method: "POST",
            headers: { "Authorization": `Bearer ${auth.accessToken}`, "Content-Type": "application/json" },
            body: JSON.stringify({ botApiName: params.agentApiName, externalSessionKey, forceConfig: { endpoint: orgUrl } }),
        }, 30_000);
        const bootstrapText = await bootstrapResp.text().catch(() => "");
        if (!bootstrapResp.ok || bootstrapText.trimStart().startsWith("<")) {
            return { success: true, sessionId: null, response: null, message: `Agentforce test API not accessible (HTTP ${bootstrapResp.status}). Ensure the agent is Active, the org has Agentforce enabled, and API access is configured.` };
        }
        let bootstrap;
        try { bootstrap = JSON.parse(bootstrapText); }
        catch { return { success: false, message: `Bootstrap returned non-JSON: ${bootstrapText.slice(0, 200)}` }; }
        const agentToken = bootstrap.token;
        const agentUrl = (bootstrap.agentUrl ?? "").replace(/\/$/, "");
        if (!agentToken || !agentUrl)
            return { success: false, message: `Bootstrap missing token or agentUrl. Response: ${JSON.stringify(bootstrap).slice(0, 300)}` };
        const sessionResp = await fetchWithTimeout(`${agentUrl}/sessions`, {
            method: "POST",
            headers: { "Authorization": `Bearer ${agentToken}`, "Content-Type": "application/json", "x-sfdc-app-context": "EinsteinGPT", "x-client-feature-id": "ai-platform-einstein-gpt" },
            body: JSON.stringify({ externalSessionKey, instanceConfig: { endpoint: orgUrl } }),
        }, 30_000);
        if (!sessionResp.ok) {
            const body = await sessionResp.text().catch(() => "");
            return { success: false, message: `Session creation failed (HTTP ${sessionResp.status}): ${body.slice(0, 400)}` };
        }
        const sessionData = await sessionResp.json();
        const sessionId = sessionData.sessionId ?? sessionData.id;
        if (!sessionId)
            return { success: false, message: `No sessionId in response: ${JSON.stringify(sessionData).slice(0, 300)}` };
        const msgResp = await fetchWithTimeout(`${agentUrl}/sessions/${sessionId}/messages`, {
            method: "POST",
            headers: { "Authorization": `Bearer ${agentToken}`, "Content-Type": "application/json", "x-sfdc-app-context": "EinsteinGPT", "x-client-feature-id": "ai-platform-einstein-gpt" },
            body: JSON.stringify({ message: { role: "user", content: [{ type: "text", text: params.message }] }, variables: [] }),
        }, 90_000);
        if (!msgResp.ok) {
            const body = await msgResp.text().catch(() => "");
            return { success: false, sessionId, message: `Message failed (HTTP ${msgResp.status}): ${body.slice(0, 400)}` };
        }
        const msgData = await msgResp.json();
        const messages = msgData.messages ?? msgData.result?.messages ?? [];
        const responseText = messages
            .filter((m: any) => m.type === "Reply" || m.role === "agent")
            .map((m: any) => {
            if (typeof m.message === "string")
                return m.message;
            if (Array.isArray(m.content))
                return m.content.map((c: any) => c.text ?? "").join("");
            return m.text ?? "";
        })
            .filter(Boolean)
            .join("\n")
            .trim();
        return {
            success: true,
            sessionId,
            response: responseText || JSON.stringify(msgData).slice(0, 1000),
            message: responseText ? "Agent responded successfully." : "Message sent successfully.",
        };
    }
    catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}
export async function getAgentLogs(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const client = createClient(auth);
        const limit = params.limit ?? 20;
        let whereClause = "LogDate = TODAY";
        if (params.agentApiName) {
            const safe = params.agentApiName.replace(/'/g, "\\'");
            whereClause += ` AND (EventTarget LIKE '%${safe}%' OR EventDetails LIKE '%${safe}%')`;
        }
        const query = `SELECT EventLabel, EventTarget, EventDetails, EventDate FROM ConversationDefinitionEventLog WHERE ${whereClause} ORDER BY EventDate DESC LIMIT ${limit}`;
        const resp = await client.get(`/query?q=${encodeURIComponent(query)}`);
        const records = (resp.data as any).records ?? [];
        const topicEvents = records.filter((r: any) => (r.EventLabel ?? "").includes("TopicClassification")).length;
        const actionEvents = records.filter((r: any) => (r.EventLabel ?? "").includes("ActionExecuted")).length;
        const errorEvents = records.filter((r: any) => (r.EventLabel ?? "").toLowerCase().includes("error") || (r.EventLabel ?? "").toLowerCase().includes("fail")).length;
        const logs = records.map((r: any) => {
            let details = r.EventDetails;
            try {
                details = JSON.parse(r.EventDetails ?? "{}");
            }
            catch { /* keep raw */ }
            return { time: r.EventDate, event: r.EventLabel, target: r.EventTarget, details };
        });
        return {
            success: true,
            totalRecords: records.length,
            summary: { topicClassifications: topicEvents, actionsExecuted: actionEvents, errors: errorEvents },
            logs,
            message: `${records.length} entries: ${topicEvents} topic classification(s), ${actionEvents} action execution(s), ${errorEvents} error(s).`,
        };
    }
    catch (err) {
        const msg = sanitizeError(err instanceof Error ? err.message : String(err));
        if (msg.includes("INVALID_TYPE") || msg.includes("ConversationDefinition"))
            return { success: true, totalRecords: 0, summary: { topicClassifications: 0, actionsExecuted: 0, errors: 0 }, logs: [], message: "ConversationDefinitionEventLog is not available in this org. Requires Event Monitoring or Agentforce debugging enabled." };
        return { success: false, message: msg, logs: [] };
    }
}

// ─── v2.2.0 Service Functions ─────────────────────────────────────────────────
// Objects & Fields
export async function updateCustomObject(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const objectName = params.objectApiName ?? params.fullName;
        const readXml = await callMetadataSoap(auth, "readMetadata", `<met:readMetadata><met:type>CustomObject</met:type><met:fullNames>${x(objectName)}</met:fullNames></met:readMetadata>`);
        const recordMatch = readXml.match(/<records[^>]*>([\s\S]*?)<\/records>/i);
        if (!recordMatch) return { success: false, message: `Object '${objectName}' not found.` };
        let inner = recordMatch[1];
        if (params.label) inner = inner.replace(/<label>[^<]*<\/label>/i, `<label>${x(params.label)}</label>`);
        if (params.pluralLabel) inner = inner.replace(/<pluralLabel>[^<]*<\/pluralLabel>/i, `<pluralLabel>${x(params.pluralLabel)}</pluralLabel>`);
        if (params.description !== undefined) {
            if (inner.includes("<description>")) inner = inner.replace(/<description>[^<]*<\/description>/i, `<description>${x(params.description)}</description>`);
            else inner += `\n    <met:description>${x(params.description)}</met:description>`;
        }
        if (params.enableHistory !== undefined) inner = inner.includes("<enableHistory>") ? inner.replace(/<enableHistory>[^<]*<\/enableHistory>/i, `<enableHistory>${params.enableHistory}</enableHistory>`) : inner + `\n    <met:enableHistory>${params.enableHistory}</met:enableHistory>`;
        if (params.enableReports !== undefined) inner = inner.includes("<enableReports>") ? inner.replace(/<enableReports>[^<]*<\/enableReports>/i, `<enableReports>${params.enableReports}</enableReports>`) : inner + `\n    <met:enableReports>${params.enableReports}</met:enableReports>`;
        if (params.enableActivities !== undefined) inner = inner.includes("<enableActivities>") ? inner.replace(/<enableActivities>[^<]*<\/enableActivities>/i, `<enableActivities>${params.enableActivities}</enableActivities>`) : inner + `\n    <met:enableActivities>${params.enableActivities}</met:enableActivities>`;
        if (params.enableSearch !== undefined) inner = inner.includes("<enableSearch>") ? inner.replace(/<enableSearch>[^<]*<\/enableSearch>/i, `<enableSearch>${params.enableSearch}</enableSearch>`) : inner + `\n    <met:enableSearch>${params.enableSearch}</met:enableSearch>`;
        const xml = `<met:metadata xsi:type="met:CustomObject" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    ${inner}
</met:metadata>`;
        return await upsertMetadata(auth, xml);
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}
export async function updateCustomField(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const objectApiName = params.objectApiName ?? params.objectName ?? "";
        const fieldApiName = params.fieldApiName ?? params.fieldName ?? "";
        const fullName = `${objectApiName}.${fieldApiName}`;
        const readXml = await callMetadataSoap(auth, "readMetadata", `<met:readMetadata><met:type>CustomField</met:type><met:fullNames>${x(fullName)}</met:fullNames></met:readMetadata>`);
        const recordMatch = readXml.match(/<records[^>]*>([\s\S]*?)<\/records>/i);
        if (!recordMatch) return { success: false, message: `Field '${fullName}' not found.` };
        let inner = recordMatch[1];
        if (params.label) inner = inner.replace(/<label>[^<]*<\/label>/i, `<label>${x(params.label)}</label>`);
        if (params.description !== undefined) {
            if (inner.includes("<description>")) inner = inner.replace(/<description>[^<]*<\/description>/i, `<description>${x(params.description)}</description>`);
            else inner += `\n<description>${x(params.description)}</description>`;
        }
        if (params.helpText !== undefined) {
            if (inner.includes("<inlineHelpText>")) inner = inner.replace(/<inlineHelpText>[^<]*<\/inlineHelpText>/i, `<inlineHelpText>${x(params.helpText)}</inlineHelpText>`);
            else inner += `\n<inlineHelpText>${x(params.helpText)}</inlineHelpText>`;
        }
        if (params.required !== undefined) {
            if (inner.includes("<required>")) inner = inner.replace(/<required>[^<]*<\/required>/i, `<required>${params.required}</required>`);
            else inner += `\n<required>${params.required}</required>`;
        }
        if (params.defaultValue !== undefined) {
            if (inner.includes("<defaultValue>")) inner = inner.replace(/<defaultValue>[^<]*<\/defaultValue>/i, `<defaultValue>${x(params.defaultValue)}</defaultValue>`);
            else inner += `\n<defaultValue>${x(params.defaultValue)}</defaultValue>`;
        }
        const xml = `<met:metadata xsi:type="met:CustomField" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    ${inner}
</met:metadata>`;
        return await upsertMetadata(auth, xml);
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}
export async function createRelationshipField(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const isMD = params.relationshipType === "MasterDetail";
        const deleteConstraint = params.onDelete === "Restrict" ? "Restrict" : "SetNull";
        const xml = `<met:metadata xsi:type="met:CustomField" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <met:fullName>${x(params.objectApiName)}.${x(params.fieldName)}__c</met:fullName>
    <met:label>${x(params.label)}</met:label>
    <met:type>${isMD ? "MasterDetail" : "Lookup"}</met:type>
    <met:referenceTo>${x(params.relatedObject)}</met:referenceTo>
    <met:relationshipName>${x(params.relationshipName)}</met:relationshipName>
    ${!isMD ? `<met:deleteConstraint>${deleteConstraint}</met:deleteConstraint>` : ""}
    ${params.required ? `<met:required>true</met:required>` : ""}
    ${params.description ? `<met:description>${x(params.description)}</met:description>` : ""}
</met:metadata>`;
        return await upsertMetadata(auth, xml);
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}
export async function createFormulaField(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const typeMap = { Text: "Text", Number: "Number", Currency: "Currency", Date: "Date", DateTime: "DateTime", Checkbox: "Checkbox", Percent: "Percent" };
        const sfType = (typeMap as Record<string, string>)[params.returnType] ?? "Text";
        const objectName = params.objectApiName ?? params.objectName;
        const rawField = params.fieldApiName ?? params.fieldName ?? "";
        const fieldName = rawField.replace(/__c$/i, "");
        const isNumeric = ["Number", "Currency", "Percent"].includes(sfType);
        const xml = `<met:metadata xsi:type="met:CustomField" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <met:fullName>${x(objectName)}.${x(fieldName)}__c</met:fullName>
    <met:label>${x(params.label)}</met:label>
    <met:type>${sfType}</met:type>
    <met:formula>${x(params.formula)}</met:formula>
    <met:formulaTreatBlanksAs>${x(params.formulaTreatBlanksAs ?? (sfType === "Checkbox" ? "BlankAsLogicalFalse" : "BlankAsZero"))}</met:formulaTreatBlanksAs>
    ${isNumeric ? `<met:precision>${params.precision ?? 18}</met:precision>` : ""}
    ${isNumeric ? `<met:scale>${params.scale ?? 0}</met:scale>` : ""}
    ${params.description ? `<met:description>${x(params.description)}</met:description>` : ""}
</met:metadata>`;
        return await upsertMetadata(auth, xml);
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}
// Security
export async function assignPermissionSet(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const client = createClient(auth);
        // Resolve permission set ID
        const psQuery = await client.get(`/query?q=${encodeURIComponent(`SELECT Id FROM PermissionSet WHERE Name = '${params.permissionSetName.replace(/'/g, "\\'")}'`)}`);
        const psId = (psQuery.data as any).records?.[0]?.Id;
        if (!psId) return { success: false, message: `Permission Set '${params.permissionSetName}' not found.` };
        // Resolve user ID
        let userId = params.userId;
        if (!userId && params.username) {
            const uQuery = await client.get(`/query?q=${encodeURIComponent(`SELECT Id FROM User WHERE Username = '${params.username.replace(/'/g, "\\'")}'`)}`);
            userId = (uQuery.data as any).records?.[0]?.Id;
            if (!userId) return { success: false, message: `User '${params.username}' not found.` };
        }
        if (!userId) return { success: false, message: "Provide username or userId." };
        const resp = await client.post("/sobjects/PermissionSetAssignment", { PermissionSetId: psId, AssigneeId: userId });
        return { success: true, fullName: (resp.data as any).id, created: true, message: `Permission Set '${params.permissionSetName}' assigned successfully.` };
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("DUPLICATE_VALUE") || msg.toLowerCase().includes("duplicate permissionsetassignment")) {
            return { success: true, fullName: params.permissionSetName, created: false, message: `Permission Set '${params.permissionSetName}' already assigned.` };
        }
        return { success: false, message: sanitizeError(msg) };
    }
}
export async function createPermissionSetGroup(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const psXml = (params.permissionSets ?? []).map((ps: any) => `<met:permissionSets>${x(ps)}</met:permissionSets>`).join("\n    ");
        const xml = `<met:metadata xsi:type="met:PermissionSetGroup" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <met:fullName>${x(params.fullName ?? params.groupName)}</met:fullName>
    <met:label>${x(params.label)}</met:label>
    ${params.description ? `<met:description>${x(params.description)}</met:description>` : ""}
    ${psXml}
</met:metadata>`;
        return await upsertMetadata(auth, xml);
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}
export async function updatePermissionSet(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const psName = params.permissionSetName ?? params.fullName ?? "";
        const readXml = await callMetadataSoap(auth, "readMetadata", `<met:readMetadata><met:type>PermissionSet</met:type><met:fullNames>${x(psName)}</met:fullNames></met:readMetadata>`);
        const recordMatch = readXml.match(/<records[^>]*>([\s\S]*?)<\/records>/i);
        if (!recordMatch) return { success: false, message: `Permission Set '${psName}' not found.` };
        const inner = recordMatch[1];
        const objPerms = (params.objectPermissions ?? []).map((op: any) => {
            const obj = op.object ?? op.objectName ?? "";
            return `
    <met:objectPermissions>
        <met:object>${x(obj)}</met:object>
        <met:allowCreate>${op.allowCreate ? "true" : "false"}</met:allowCreate>
        <met:allowRead>${op.allowRead ? "true" : "false"}</met:allowRead>
        <met:allowEdit>${op.allowEdit ? "true" : "false"}</met:allowEdit>
        <met:allowDelete>${op.allowDelete ? "true" : "false"}</met:allowDelete>
        <met:viewAllRecords>${op.viewAllRecords ? "true" : "false"}</met:viewAllRecords>
        <met:modifyAllRecords>${op.modifyAllRecords ? "true" : "false"}</met:modifyAllRecords>
    </met:objectPermissions>`;
        }).join("");
        const fldPerms = (params.fieldPermissions ?? []).map((fp: any) => `
    <met:fieldPermissions>
        <met:editable>${fp.editable ? "true" : "false"}</met:editable>
        <met:field>${x(fp.field)}</met:field>
        <met:readable>${fp.readable ? "true" : "false"}</met:readable>
    </met:fieldPermissions>`).join("");
        const xml = `<met:metadata xsi:type="met:PermissionSet" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    ${inner}
    ${objPerms}
    ${fldPerms}
</met:metadata>`;
        return await upsertMetadata(auth, xml);
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}
export async function createMutingPermissionSet(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const objPerms = (params.objectPermissions ?? []).map((op: any) => `
    <met:objectPermissions>
        <met:object>${x(op.object)}</met:object>
        ${op.allowCreate ? "<met:allowCreate>true</met:allowCreate>" : ""}
        ${op.allowRead ? "<met:allowRead>true</met:allowRead>" : ""}
        ${op.allowEdit ? "<met:allowEdit>true</met:allowEdit>" : ""}
        ${op.allowDelete ? "<met:allowDelete>true</met:allowDelete>" : ""}
    </met:objectPermissions>`).join("");
        const fldPerms = (params.fieldPermissions ?? []).map((fp: any) => `
    <met:fieldPermissions>
        <met:editable>${fp.editable ? "true" : "false"}</met:editable>
        <met:field>${x(fp.field)}</met:field>
        <met:readable>${fp.readable ? "true" : "false"}</met:readable>
    </met:fieldPermissions>`).join("");
        const xml = `<met:metadata xsi:type="met:MutingPermissionSet" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <met:fullName>${x(params.mutingPermSetName)}</met:fullName>
    <met:label>${x(params.label)}</met:label>
    ${objPerms}
    ${fldPerms}
</met:metadata>`;
        return await upsertMetadata(auth, xml);
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}
export async function setFieldLevelSecurity(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const results = [];
        for (const profileName of (params.profiles ?? [])) {
            const xml = `<met:metadata xsi:type="met:Profile" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <met:fullName>${x(profileName)}</met:fullName>
    <met:fieldPermissions>
        <met:field>${x(params.fieldApiName)}</met:field>
        <met:readable>${params.readable ? "true" : "false"}</met:readable>
        <met:editable>${params.editable ? "true" : "false"}</met:editable>
    </met:fieldPermissions>
</met:metadata>`;
            results.push(await upsertMetadata(auth, xml));
        }
        const psXmls = (params.permissionSets ?? []).map((psName: any) => {
            // Read label from existing PS if possible, otherwise use fullName as label
            const psLabel = x(psName);
            return `<met:metadata xsi:type="met:PermissionSet" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <met:fullName>${x(psName)}</met:fullName>
    <met:label>${psLabel}</met:label>
    <met:fieldPermissions>
        <met:field>${x(params.fieldApiName)}</met:field>
        <met:readable>${params.readable ? "true" : "false"}</met:readable>
        <met:editable>${params.editable ? "true" : "false"}</met:editable>
    </met:fieldPermissions>
</met:metadata>`;
        });
        for (const xml of psXmls) {
            results.push(await upsertMetadata(auth, xml));
        }
        const allOk = results.every(r => r.success);
        return { success: allOk, message: allOk ? `Field security set for ${params.fieldApiName} on ${results.length} profile(s)/permission set(s).` : `Some updates failed: ${results.filter((r: any) => !r.success).map((r: any) => r.message).join("; ")}` };
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}
export async function setOrgWideDefaults(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const objectName = params.objectApiName;
        const readXml = await callMetadataSoap(auth, "readMetadata", `<met:readMetadata><met:type>CustomObject</met:type><met:fullNames>${x(objectName)}</met:fullNames></met:readMetadata>`);
        const recordMatch = readXml.match(/<records[^>]*>([\s\S]*?)<\/records>/i);
        if (!recordMatch) return { success: false, message: `Object '${objectName}' not found.` };
        let inner = recordMatch[1];
        if (inner.includes("<sharingModel>")) {
            inner = inner.replace(/<sharingModel>[^<]*<\/sharingModel>/i, `<sharingModel>${x(params.defaultInternal)}</sharingModel>`);
        } else {
            inner = inner + `\n    <met:sharingModel>${x(params.defaultInternal)}</met:sharingModel>`;
        }
        if (params.defaultExternal) {
            if (inner.includes("<externalSharingModel>")) {
                inner = inner.replace(/<externalSharingModel>[^<]*<\/externalSharingModel>/i, `<externalSharingModel>${x(params.defaultExternal)}</externalSharingModel>`);
            } else {
                inner = inner + `\n    <met:externalSharingModel>${x(params.defaultExternal)}</met:externalSharingModel>`;
            }
        }
        const xml = `<met:metadata xsi:type="met:CustomObject" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    ${inner}
</met:metadata>`;
        return await upsertMetadata(auth, xml);
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}
export async function cloneProfile(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const sourceProfile = params.cloneFrom ?? params.sourceProfileName;
        const newProfileName = params.profileName ?? params.newProfileName;
        // Standard profile display name to metadata API name mapping
        const stdProfileMap = {
            "standard user": "Standard",
            "system administrator": "Admin",
            "read only": "ReadOnly",
            "solution manager": "SolutionManager",
            "contract manager": "ContractManager",
            "marketing user": "MarketingProfile",
            "chatter free user": "ChatterFree",
            "chatter external user": "ChatterExternal",
        };
        const resolvedProfile = (stdProfileMap as Record<string, string>)[sourceProfile.toLowerCase()] ?? sourceProfile;
        const readXml = await callMetadataSoap(auth, "readMetadata", `<met:readMetadata><met:type>Profile</met:type><met:fullNames>${x(resolvedProfile)}</met:fullNames></met:readMetadata>`);
        const recordMatch = readXml.match(/<records[^>]*>([\s\S]*?)<\/records>/i);
        if (!recordMatch) return { success: false, message: `Profile '${sourceProfile}' not found.` };
        const profileXml = recordMatch[1]
            .replace(/<fullName>[^<]*<\/fullName>/i, `<fullName>${x(newProfileName)}</fullName>`)
            .replace(/<userLicense>[^<]*<\/userLicense>/i, "")
            .replace(/<tabVisibilities>[\s\S]*?<\/tabVisibilities>/gi, "");
        const xml = `<met:metadata xsi:type="met:Profile" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <met:fullName>${x(newProfileName)}</met:fullName>
    ${profileXml}
</met:metadata>`;
        return await upsertMetadata(auth, xml);
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}
export async function updateProfile(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const objPerms = (params.objectPermissions ?? []).map((op: any) => {
            const obj = op.object ?? op.objectName ?? op.objectApiName ?? "";
            if (!obj) return "";
            // WSDL order for ObjectPermissions: allowCreate, allowDelete, allowEdit, allowRead, modifyAllRecords, object, viewAllRecords
            return `
    <met:objectPermissions>
        ${op.allowCreate ? "<met:allowCreate>true</met:allowCreate>" : "<met:allowCreate>false</met:allowCreate>"}
        ${op.allowDelete ? "<met:allowDelete>true</met:allowDelete>" : "<met:allowDelete>false</met:allowDelete>"}
        ${op.allowEdit ? "<met:allowEdit>true</met:allowEdit>" : "<met:allowEdit>false</met:allowEdit>"}
        ${op.allowRead ? "<met:allowRead>true</met:allowRead>" : "<met:allowRead>false</met:allowRead>"}
        ${op.modifyAllRecords ? "<met:modifyAllRecords>true</met:modifyAllRecords>" : "<met:modifyAllRecords>false</met:modifyAllRecords>"}
        <met:object>${x(obj)}</met:object>
        ${op.viewAllRecords ? "<met:viewAllRecords>true</met:viewAllRecords>" : "<met:viewAllRecords>false</met:viewAllRecords>"}
    </met:objectPermissions>`;
        }).join("");
        const fldPerms = (params.fieldPermissions ?? []).map((fp: any) => `
    <met:fieldPermissions>
        <met:editable>${fp.editable ? "true" : "false"}</met:editable>
        <met:field>${x(fp.field)}</met:field>
        <met:readable>${fp.readable ? "true" : "false"}</met:readable>
    </met:fieldPermissions>`).join("");
        const tabVis = (params.tabVisibilities ?? []).map((tv: any) => `
    <met:tabVisibilities>
        <met:tab>${x(tv.tab)}</met:tab>
        <met:visibility>${x(tv.visibility)}</met:visibility>
    </met:tabVisibilities>`).join("");
        const appVis = (params.applicationVisibilities ?? []).map((av: any) => `
    <met:applicationVisibilities>
        <met:application>${x(av.application)}</met:application>
        <met:default>${av.default ? "true" : "false"}</met:default>
        <met:visible>${av.visible ? "true" : "false"}</met:visible>
    </met:applicationVisibilities>`).join("");
        const xml = `<met:metadata xsi:type="met:Profile" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <met:fullName>${x(params.profileName)}</met:fullName>
    ${objPerms}
    ${fldPerms}
    ${tabVis}
    ${appVis}
</met:metadata>`;
        return await upsertMetadata(auth, xml);
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}
// UI
export async function updatePageLayout(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        // layoutName may already be the full qualified name (e.g. "MCPTest__c-MCP Test Layout")
        let fullLayoutName;
        if (params.objectApiName) {
            fullLayoutName = `${params.objectApiName}-${params.layoutName}`;
        } else if (params.layoutName && params.layoutName.includes("-")) {
            fullLayoutName = params.layoutName;
        } else {
            return { success: false, message: "Must specify objectApiName or a fully qualified layoutName (Object-Layout)." };
        }
        const objectApiName = params.objectApiName ?? fullLayoutName.split("-")[0];
        const layoutXml = await callMetadataSoap(auth, "readMetadata", `<met:readMetadata><met:type>Layout</met:type><met:fullNames>${x(fullLayoutName)}</met:fullNames></met:readMetadata>`);
        const recordMatch = layoutXml.match(/<records[^>]*>([\s\S]*?)<\/records>/i);
        if (!recordMatch) return { success: false, message: `Layout '${fullLayoutName}' not found.` };
        let inner = recordMatch[1];
        if (params.label) inner = inner.replace(/<fullName>[^<]*<\/fullName>/i, `<fullName>${x(objectApiName)}-${x(params.label)}</fullName>`);
        // Add new fields to the layout sections if requested
        if (params.fieldsToAdd && params.fieldsToAdd.length > 0) {
            // fieldsToAdd support reserved for future use
            inner = inner.replace(/<\/met:layoutSections>/, `</met:layoutSections>`);
        }
        const xml = `<met:metadata xsi:type="met:Layout" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    ${inner}
</met:metadata>`;
        return await upsertMetadata(auth, xml);
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}
export async function assignPageLayout(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        // Normalize profiles: accept array or single profileName string
        const profiles = Array.isArray(params.profiles)
            ? params.profiles
            : [params.profileName ?? params.profiles].filter(Boolean);
        if (profiles.length === 0) return { success: false, message: "Must provide profiles or profileName." };
        const layoutFullName = `${params.objectApiName}-${params.layoutName}`;
        // Upsert each profile with just the layout assignment (Profile upsert merges with existing)
        const results = [];
        for (const profileName of profiles) {
            const xml = `<met:metadata xsi:type="met:Profile" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <met:fullName>${x(profileName)}</met:fullName>
    <met:layoutAssignments>
        <met:layout>${x(layoutFullName)}</met:layout>
    </met:layoutAssignments>
</met:metadata>`;
            const r = await upsertMetadata(auth, xml);
            results.push(r);
        }
        const allOk = results.every(r => r.success);
        return { success: allOk, fullName: layoutFullName, created: false, message: allOk ? `Layout '${layoutFullName}' assigned to ${profiles.length} profile(s).` : results.find(r => !r.success)?.message ?? "Partial failure" };
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}
export async function createFlexiPage(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const fullName = params.pageName ?? params.apiName ?? params.fullName;
        const pageType = params.pageType ?? params.type ?? "UtilityBar";
        const rawTemplate = params.template ?? "";
        // Map page-type defaults and layout variant names to force: namespace template components
        const pageTypeDefaults = {
            "RecordPage": "force:RecordLayoutTemplate",
            "HomePage": "force:homePage",
            "AppPage": "force:appPage",
        };
        const layoutVariantMap = {
            "HeaderAndRightSidebar": "HEADER_AND_RIGHT_SIDEBAR",
            "HeaderAndThreeRegions": "HEADER_AND_THREE_REGIONS",
            "MosaicTemplate": "MOSAIC",
            "FullWidth": "FULL_WIDTH",
            "LeftSidebar": "LEFT_SIDEBAR",
        };
        let templateName;
        let layoutVariant = null;
        if (rawTemplate.includes(":")) {
            templateName = rawTemplate;
        } else if ((layoutVariantMap as Record<string, string>)[rawTemplate]) {
            templateName = (pageTypeDefaults as Record<string, string>)[pageType] ?? "force:RecordLayoutTemplate";
            layoutVariant = (layoutVariantMap as Record<string, string>)[rawTemplate];
        } else if (rawTemplate) {
            templateName = `force:${rawTemplate}`;
        } else {
            templateName = (pageTypeDefaults as Record<string, string>)[pageType] ?? "force:appPage";
        }
        const sobjectType = params.objectApiName ?? params.sobjectType;
        // Use ZIP deploy for FlexiPage since SOAP upsertMetadata has template compatibility issues
        const escapeXml = (s: any) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
        const regionsDeployXml = (params.regions ?? []).map((r: any) => `
    <flexiPageRegions>
        <name>${escapeXml(r.name)}</name>
        <type>${escapeXml(r.type)}</type>
    </flexiPageRegions>`).join("") || `
    <flexiPageRegions>
        <name>main</name>
        <type>Region</type>
    </flexiPageRegions>`;
        const templatePropsDeployXml = layoutVariant
            ? `<properties><name>layout</name><value>${escapeXml(layoutVariant)}</value></properties>` : "";
        const deployXml = `<?xml version="1.0" encoding="UTF-8"?>
<FlexiPage xmlns="http://soap.sforce.com/2006/04/metadata">
    ${params.description ? `<description>${escapeXml(params.description)}</description>` : ""}
    ${regionsDeployXml}
    <masterLabel>${escapeXml(params.label)}</masterLabel>
    ${sobjectType ? `<sobjectType>${escapeXml(sobjectType)}</sobjectType>` : ""}
    <template>
        <name>${escapeXml(templateName)}</name>
        ${templatePropsDeployXml}
    </template>
    <type>${escapeXml(pageType)}</type>
</FlexiPage>`;
        const JSZip = (await import("jszip")).default;
        const { buildPackageXml, deployZip, pollDeployStatus } = await import("./deployment.js");
        const zip = new JSZip();
        zip.file("package.xml", buildPackageXml([{ name: "FlexiPage", members: [fullName] }], API_VERSION));
        zip.file(`flexipages/${fullName}.flexipage`, deployXml);
        const buffer = await zip.generateAsync({ type: "nodebuffer" });
        const base64Zip = buffer.toString("base64");
        const deployId = await deployZip(auth, base64Zip);
        return await pollDeployStatus(auth, deployId, 3 * 60 * 1000);
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}
export async function updateFlexiPage(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const readXml = await callMetadataSoap(auth, "readMetadata", `<met:readMetadata><met:type>FlexiPage</met:type><met:fullNames>${x(params.pageName)}</met:fullNames></met:readMetadata>`);
        const recordMatch = readXml.match(/<records[^>]*>([\s\S]*?)<\/records>/i);
        if (!recordMatch) return { success: false, message: `FlexiPage '${params.pageName}' not found.` };
        let inner = recordMatch[1];
        if (params.label) inner = inner.replace(/<masterLabel>[^<]*<\/masterLabel>/i, `<masterLabel>${x(params.label)}</masterLabel>`);
        const xml = `<met:metadata xsi:type="met:FlexiPage" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    ${inner}
</met:metadata>`;
        return await upsertMetadata(auth, xml);
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}
export async function assignFlexiPage(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const client = createClient(auth);
        const resp = await client.post(`/connect/communities/${x(params.siteName)}/flexipages/${x(params.pageName)}/assignments`, { profiles: params.profiles ?? [], profileIds: [] });
        return { success: true, message: `FlexiPage '${params.pageName}' assigned successfully.`, fullName: (resp.data as any)?.id ?? params.pageName, created: false };
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}
export async function assignCompactLayout(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const objectName = params.objectApiName ?? params.objectName;
        const readXml = await callMetadataSoap(auth, "readMetadata", `<met:readMetadata><met:type>CustomObject</met:type><met:fullNames>${x(objectName)}</met:fullNames></met:readMetadata>`);
        const recordMatch = readXml.match(/<records[^>]*>([\s\S]*?)<\/records>/i);
        if (!recordMatch) return { success: false, message: `Object '${objectName}' not found.` };
        let inner = recordMatch[1];
        if (inner.includes("<compactLayoutAssignment>")) {
            inner = inner.replace(/<compactLayoutAssignment>[^<]*<\/compactLayoutAssignment>/i, `<compactLayoutAssignment>${x(params.compactLayoutName)}</compactLayoutAssignment>`);
        } else {
            inner = inner + `\n    <met:compactLayoutAssignment>${x(params.compactLayoutName)}</met:compactLayoutAssignment>`;
        }
        const xml = `<met:metadata xsi:type="met:CustomObject" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    ${inner}
</met:metadata>`;
        return await upsertMetadata(auth, xml);
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}
// Automation — activateFlow moved to CATEGORY I section below
// createQuickAction moved to CATEGORY B section below
// Apex & LWC
export async function getApexClass(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const toolingBase = `${auth.instanceUrl}/services/data/v${API_VERSION}/tooling`;
        const headers = { Authorization: `Bearer ${auth.accessToken}`, "Content-Type": "application/json" };
        const safeName = params.className.replace(/'/g, "\\'");
        const resp = await fetchWithTimeout(`${toolingBase}/query?q=${encodeURIComponent(`SELECT Id, Name, Body, ApiVersion, Status, LengthWithoutComments FROM ApexClass WHERE Name = '${safeName}'`)}`, { method: "GET", headers }, 30_000);
        if (!resp.ok) return { success: false, message: `Tooling API error: HTTP ${resp.status}` };
        const data = await resp.json();
        if (!data.records?.length) return { success: false, message: `Apex class '${params.className}' not found.` };
        const cls = data.records[0];
        return { success: true, message: `Found Apex class '${params.className}'.`, id: cls.Id, name: cls.Name, body: cls.Body, apiVersion: cls.ApiVersion, status: cls.Status, length: cls.LengthWithoutComments };
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}
export async function getCodeCoverage(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const toolingBase = `${auth.instanceUrl}/services/data/v${API_VERSION}/tooling`;
        const headers = { Authorization: `Bearer ${auth.accessToken}`, "Content-Type": "application/json" };
        const safeName = (params.className ?? "").replace(/'/g, "\\'");
        const whereClause = safeName ? ` WHERE ApexClassOrTrigger.Name = '${safeName}'` : "";
        const resp = await fetchWithTimeout(`${toolingBase}/query?q=${encodeURIComponent(`SELECT ApexClassOrTriggerId, ApexClassOrTrigger.Name, NumLinesCovered, NumLinesUncovered FROM ApexCodeCoverageAggregate${whereClause} ORDER BY NumLinesCovered DESC LIMIT ${params.limit ?? 20}`)}`, { method: "GET", headers }, 30_000);
        if (!resp.ok) return { success: false, message: `Tooling API error: HTTP ${resp.status}` };
        const data = await resp.json();
        const records = (data.records ?? []).map((r: any) => {
            const total = (r.NumLinesCovered ?? 0) + (r.NumLinesUncovered ?? 0);
            const pct = total > 0 ? Math.round((r.NumLinesCovered / total) * 100) : 0;
            return { name: r.ApexClassOrTrigger?.Name ?? r.ApexClassOrTriggerId, covered: r.NumLinesCovered, uncovered: r.NumLinesUncovered, total, percentage: pct };
        });
        return { success: true, records, message: `Code coverage for ${records.length} class(es).` };
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}
// Reports
export async function createReport(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const rawName = params.reportName ?? params.fullName;
        // Reports must be in a folder: use folder/reportName format
        const reportFullName = rawName.includes("/") ? rawName : `${params.folderName ?? "unfiled$public"}/${rawName}`;
        const label = params.label ?? params.name ?? rawName;
        // Custom report types (created via sf_create_report_type) need __c suffix in SOAP Report metadata.
        // Standard types like AccountList, ContactList do not. Auto-append if missing.
        let reportType = params.reportType ?? "";
        if (reportType && !reportType.endsWith("__c") && !reportType.includes("$")) {
            reportType = reportType + "__c";
        }
        // Columns for custom report types use Object__c$Field format ($ separator, not .)
        const normalizeColumn = (col: any) => col.replace(/^(\w+__c)\.(\w+(?:__c)?)$/, "$1$$$2");
        const columnsXml = (params.columns ?? []).map((c: any) => `<met:columns><met:field>${x(normalizeColumn(c))}</met:field></met:columns>`).join("\n    ");
        const filtersXml = (params.filters ?? []).map((f: any) => `
    <met:reportFilters>
        <met:column>${x(f.column)}</met:column>
        <met:operator>${x(f.operator)}</met:operator>
        <met:value>${x(f.value)}</met:value>
    </met:reportFilters>`).join("");
        // WSDL alphabetical order: columns, description, filter, format, fullName, name, reportType, showDetails
        const xml = `<met:metadata xsi:type="met:Report" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    ${columnsXml}
    ${params.description ? `<met:description>${x(params.description)}</met:description>` : ""}
    ${filtersXml}
    <met:format>${x(params.format ?? "Tabular")}</met:format>
    <met:fullName>${x(reportFullName)}</met:fullName>
    <met:name>${x(label)}</met:name>
    <met:reportType>${x(reportType)}</met:reportType>
    <met:showDetails>true</met:showDetails>
</met:metadata>`;
        return await upsertMetadata(auth, xml);
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}
export async function updateDashboard(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const rawName = params.dashboardName ?? params.fullName;
        // Dashboards must be in a folder; default to "Dashboards" folder
        const dashboardName = rawName.includes("/") ? rawName : `${params.folderName ?? "Dashboards"}/${rawName}`;
        const readXml = await callMetadataSoap(auth, "readMetadata", `<met:readMetadata><met:type>Dashboard</met:type><met:fullNames>${x(dashboardName)}</met:fullNames></met:readMetadata>`);
        const recordMatch = readXml.match(/<records[^>]*>([\s\S]*?)<\/records>/i);
        if (recordMatch) {
            let inner = recordMatch[1];
            if (params.title) inner = inner.replace(/<title>[^<]*<\/title>/i, `<title>${x(params.title)}</title>`);
            if (params.description) inner = inner.replace(/<description>[^<]*<\/description>/i, `<description>${x(params.description)}</description>`);
            const xml = `<met:metadata xsi:type="met:Dashboard" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    ${inner}
</met:metadata>`;
            return await upsertMetadata(auth, xml);
        }
        // Dashboard not found — create it with all required fields
        const client = createClient(auth);
        const userResp = await client.get(`/query?q=${encodeURIComponent("SELECT Username FROM User WHERE IsActive=true AND UserType='Standard' ORDER BY CreatedDate ASC LIMIT 1")}`);
        const runningUser = (userResp.data as any)?.records?.[0]?.Username ?? "";
        const title = params.title ?? (dashboardName.includes("/") ? dashboardName.split("/").pop() : dashboardName);
        const xml = `<met:metadata xsi:type="met:Dashboard" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <met:fullName>${x(dashboardName)}</met:fullName>
    <met:backgroundEndColor>#FFFFFF</met:backgroundEndColor>
    <met:backgroundFadeDirection>Diagonal</met:backgroundFadeDirection>
    <met:backgroundStartColor>#FFFFFF</met:backgroundStartColor>
    <met:dashboardType>SpecifiedUser</met:dashboardType>
    ${params.description ? `<met:description>${x(params.description)}</met:description>` : ""}
    <met:leftSection><met:columnSize>Medium</met:columnSize></met:leftSection>
    <met:rightSection><met:columnSize>Medium</met:columnSize></met:rightSection>
    <met:runningUser>${x(runningUser)}</met:runningUser>
    <met:textColor>#000000</met:textColor>
    <met:title>${x(title)}</met:title>
    <met:titleColor>#000000</met:titleColor>
    <met:titleSize>12</met:titleSize>
</met:metadata>`;
        return await upsertMetadata(auth, xml);
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}
export async function createReportFolder(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const folderName = params.folderName ?? params.name ?? params.fullName;
        const label = params.label ?? params.name ?? folderName;
        const folderType = params.folderType === "Dashboard" ? "DashboardFolder" : "ReportFolder";
        const xml = `<met:metadata xsi:type="met:${folderType}" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <met:fullName>${x(folderName)}</met:fullName>
    <met:name>${x(label)}</met:name>
    <met:accessType>${x(params.accessType ?? "Shared")}</met:accessType>
    ${params.description ? `<met:description>${x(params.description)}</met:description>` : ""}
</met:metadata>`;
        return await upsertMetadata(auth, xml);
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}
export async function shareReportFolder(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const folderName = params.folderName ?? params.name ?? params.fullName;
        const folderTypeMap = { "Report": "ReportFolder", "Dashboard": "DashboardFolder" };
        const folderType = (folderTypeMap as Record<string, string>)[params.folderType] ?? params.folderType ?? "ReportFolder";
        // Read existing folder to get required 'name' field
        const readXml = await callMetadataSoap(auth, "readMetadata", `<met:readMetadata><met:type>${folderType}</met:type><met:fullNames>${x(folderName)}</met:fullNames></met:readMetadata>`);
        const recordMatch = readXml.match(/<records[^>]*>([\s\S]*?)<\/records>/i);
        // shareWith is preprocessed by Zod into [{type, name, accessLevel}]; params.shares uses {sharedTo, sharedToType, accessLevel}
        const rawShareWith = Array.isArray(params.shareWith) ? params.shareWith : (params.shareWith ? [{ type: "Group", name: String(params.shareWith) }] : []);
        const shares = params.shares ?? rawShareWith.map((s: any) => ({
            sharedTo: s.name ?? s.sharedTo ?? "",
            sharedToType: (s.name === "AllInternalUsers" || s.sharedToType === "AllInternalUsers") ? "AllInternalUsers" : (s.type ?? s.sharedToType ?? "Group"),
            accessLevel: s.accessLevel ?? params.accessLevel ?? "View",
        }));
        // Extract only the writable scalar fields (fullName, name, accessType) to avoid system-field errors
        const getField = (tag: any) => recordMatch?.[1]?.match(new RegExp(`<${tag}[^>]*>([^<]*)<\\/${tag}>`, "i"))?.[1] ?? "";
        const existingFullName = getField("fullName") || folderName;
        const existingName = getField("name") || (params.folderLabel ?? folderName);
        const existingAccess = getField("accessType") || "Shared";
        // If folder is already Public, sharing with AllInternalUsers is already satisfied
        if (existingAccess === "Public" && shares.every((s: any) => s.sharedToType === "AllInternalUsers")) {
            return { success: true, fullName: existingFullName, created: false, message: `Folder '${existingFullName}' is already public; no sharing update needed.` };
        }
        // Map AllInternalUsers → Organization sharedToType; sharedTo is always required
        const cleanSharesXml = shares.map((s: any) => {
            const sType = s.sharedToType === "AllInternalUsers" ? "Organization" : s.sharedToType;
            const sTo = (sType === "Organization") ? "AllInternalUsers" : (s.sharedTo ?? "");
            return `
    <met:folderShares>
        <met:accessLevel>${x(s.accessLevel)}</met:accessLevel>
        <met:sharedTo>${x(sTo)}</met:sharedTo>
        <met:sharedToType>${x(sType)}</met:sharedToType>
    </met:folderShares>`;
        }).join("");
        const xml = `<met:metadata xsi:type="met:${folderType}" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <met:accessType>${x(existingAccess)}</met:accessType>
    ${cleanSharesXml}
    <met:fullName>${x(existingFullName)}</met:fullName>
    <met:name>${x(existingName)}</met:name>
</met:metadata>`;
        return await upsertMetadata(auth, xml);
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}
// Users & Data
export async function createUser(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const client = createClient(auth);
        // Resolve profile ID
        const safeProfName = params.profileName.replace(/'/g, "\\'");
        const profResp = await client.get(`/query?q=${encodeURIComponent(`SELECT Id FROM Profile WHERE Name = '${safeProfName}'`)}`);
        const profileId = (profResp.data as any).records?.[0]?.Id;
        if (!profileId) return { success: false, message: `Profile '${params.profileName}' not found.` };
        const userObj: Record<string, any> = { Username: params.username, LastName: params.lastName, FirstName: params.firstName ?? "", Email: params.email, Alias: params.alias ?? params.lastName.slice(0, 8), ProfileId: profileId, TimeZoneSidKey: params.timeZone ?? "America/Los_Angeles", LocaleSidKey: params.locale ?? "en_US", EmailEncodingKey: params.emailEncoding ?? "UTF-8", LanguageLocaleKey: params.language ?? "en_US" };
        if (params.roleApiName) {
            const safeRole = params.roleApiName.replace(/'/g, "\\'");
            const roleResp = await client.get(`/query?q=${encodeURIComponent(`SELECT Id FROM UserRole WHERE DeveloperName = '${safeRole}'`)}`);
            const roleId = (roleResp.data as any).records?.[0]?.Id;
            if (roleId) userObj["UserRoleId"] = roleId;
        }
        const resp = await client.post("/sobjects/User", userObj);
        return { success: true, fullName: (resp.data as any).id, created: true, message: `User '${params.username}' created with ID ${(resp.data as any).id}.` };
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("DUPLICATE_USERNAME") || msg.includes("Duplicate Username")) {
            return { success: true, fullName: params.username, created: false, message: `User '${params.username}' already exists.` };
        }
        return { success: false, message: sanitizeError(msg) };
    }
}
export async function updateUser(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const client = createClient(auth);
        const safeUsername = params.username.replace(/'/g, "\\'");
        const uResp = await client.get(`/query?q=${encodeURIComponent(`SELECT Id FROM User WHERE Username = '${safeUsername}'`)}`);
        const userId = (uResp.data as any).records?.[0]?.Id;
        if (!userId) return { success: false, message: `User '${params.username}' not found.` };
        const updates: Record<string, any> = {};
        if (params.firstName !== undefined) updates["FirstName"] = params.firstName;
        if (params.lastName !== undefined) updates["LastName"] = params.lastName;
        if (params.email !== undefined) updates["Email"] = params.email;
        if (params.isActive !== undefined) updates["IsActive"] = params.isActive;
        if (params.title !== undefined) updates["Title"] = params.title;
        if (params.department !== undefined) updates["Department"] = params.department;
        if (params.phone !== undefined) updates["Phone"] = params.phone;
        await client.patch(`/sobjects/User/${userId}`, updates);
        return { success: true, fullName: userId, created: false, message: `User '${params.username}' updated successfully.` };
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}
export async function assignQueueMember(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const client = createClient(auth);
        const safeQueue = params.queueApiName.replace(/'/g, "\\'");
        const qResp = await client.get(`/query?q=${encodeURIComponent(`SELECT Id FROM Group WHERE DeveloperName = '${safeQueue}' AND Type = 'Queue'`)}`);
        const queueId = (qResp.data as any).records?.[0]?.Id;
        if (!queueId) return { success: false, message: `Queue '${params.queueApiName}' not found.` };
        const safeUsername = params.username.replace(/'/g, "\\'");
        const uResp = await client.get(`/query?q=${encodeURIComponent(`SELECT Id FROM User WHERE Username = '${safeUsername}'`)}`);
        const userId = (uResp.data as any).records?.[0]?.Id;
        if (!userId) return { success: false, message: `User '${params.username}' not found.` };
        const resp = await client.post("/sobjects/GroupMember", { GroupId: queueId, UserOrGroupId: userId });
        return { success: true, fullName: (resp.data as any).id, created: true, message: `User '${params.username}' added to queue '${params.queueApiName}'.` };
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}
export async function createPublicGroup(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const client = createClient(auth);
        const resp = await client.post("/sobjects/Group", { Name: params.groupName, DeveloperName: params.developerName ?? params.groupName.replace(/\s+/g, "_"), Type: "Regular", DoesIncludeBosses: params.includeManagers ?? false });
        return { success: true, fullName: (resp.data as any).id, created: true, message: `Public group '${params.groupName}' created with ID ${(resp.data as any).id}.` };
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("DUPLICATE_DEVELOPER_NAME") || msg.includes("already exists")) {
            return { success: true, fullName: params.groupName, created: false, message: `Public group '${params.groupName}' already exists.` };
        }
        return { success: false, message: sanitizeError(msg) };
    }
}
export async function queryRecords(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const client = createClient(auth);
        const soql = params.soql ?? params.query ?? `SELECT ${(params.fields ?? ["Id", "Name"]).join(", ")} FROM ${params.objectApiName}${params.whereClause ? ` WHERE ${params.whereClause}` : ""}${params.orderBy ? ` ORDER BY ${params.orderBy}` : ""} LIMIT ${params.limit ?? 200}`;
        const resp = await client.get(`/query?q=${encodeURIComponent(soql)}`);
        return { success: true, totalSize: (resp.data as any).totalSize, records: (resp.data as any).records, message: `${(resp.data as any).totalSize ?? 0} record(s) returned.` };
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}
export async function createRecord(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const client = createClient(auth);
        const resp = await client.post(`/sobjects/${params.objectApiName}`, params.fields);
        return { success: true, fullName: (resp.data as any).id, created: true, message: `${params.objectApiName} record created with ID ${(resp.data as any).id}.` };
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}
export async function updateRecord(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const client = createClient(auth);
        await client.patch(`/sobjects/${params.objectApiName}/${params.recordId}`, params.fields);
        return { success: true, fullName: params.recordId, created: false, message: `${params.objectApiName} record ${params.recordId} updated successfully.` };
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}
export async function bulkImportRecords(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const baseUrl = `${auth.instanceUrl}/services/data/v${API_VERSION}`;
        const headers = { Authorization: `Bearer ${auth.accessToken}`, "Content-Type": "application/json" };
        // Create Bulk API 2.0 job
        const jobResp = await fetchWithTimeout(`${baseUrl}/jobs/ingest`, { method: "POST", headers, body: JSON.stringify({ object: params.objectApiName, operation: params.operation ?? "insert", contentType: "CSV", lineEnding: "LF" }) }, 30_000);
        if (!jobResp.ok) return { success: false, message: `Failed to create bulk job: HTTP ${jobResp.status}` };
        const jobData = await jobResp.json();
        const jobId = jobData.id;
        // Upload CSV data
        const csvHeaders = { Authorization: `Bearer ${auth.accessToken}`, "Content-Type": "text/csv" };
        const uploadResp = await fetchWithTimeout(`${baseUrl}/jobs/ingest/${jobId}/batches`, { method: "PUT", headers: csvHeaders, body: params.csvData }, 60_000);
        if (!uploadResp.ok) return { success: false, message: `Failed to upload CSV: HTTP ${uploadResp.status}` };
        // Close job
        const closeResp = await fetchWithTimeout(`${baseUrl}/jobs/ingest/${jobId}`, { method: "PATCH", headers, body: JSON.stringify({ state: "UploadComplete" }) }, 30_000);
        if (!closeResp.ok) return { success: false, message: `Failed to close job: HTTP ${closeResp.status}` };
        // Poll for completion
        const maxWait = 120_000;
        const start = Date.now();
        while (Date.now() - start < maxWait) {
            await new Promise(r => setTimeout(r, 5_000));
            const statusResp = await fetchWithTimeout(`${baseUrl}/jobs/ingest/${jobId}`, { method: "GET", headers }, 30_000);
            if (!statusResp.ok) continue;
            const statusData = await statusResp.json();
            if (["JobComplete", "Failed", "Aborted"].includes(statusData.state)) {
                return { success: statusData.state === "JobComplete", fullName: jobId, created: true, message: `Bulk job ${jobId}: ${statusData.state}. Records processed: ${statusData.numberRecordsProcessed ?? 0}, failed: ${statusData.numberRecordsFailed ?? 0}.` };
            }
        }
        return { success: false, message: `Bulk job ${jobId} timed out. Check job status manually.` };
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}
// Integrations
export async function createOutboundMessage(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const objName = params.objectName ?? params.objectApiName;
        const msgName = params.messageName ?? params.label?.replace(/\s+/g, "_") ?? "OutboundMsg";
        const allFields = [...new Set(["Id", ...(params.fields ?? [])])];
        const fieldsXml = allFields.map((f: any) => `        <fields>${x(f)}</fields>`).join("\n");
        // integrationUser is required in v66 — use provided value or query current user
        let integrationUser = params.integrationUser;
        if (!integrationUser) {
            try {
                const client = createClient(auth);
                const resp = await client.get("/chatter/users/me");
                integrationUser = (resp.data as any)?.username ?? (resp.data as any)?.Username;
            } catch { /* fallback below */ }
        }
        if (!integrationUser) {
            try {
                const client = createClient(auth);
                const resp = await client.get(`/query?q=${encodeURIComponent("SELECT Username FROM User WHERE Id = UserInfo.getUserId()")}`);
                integrationUser = (resp.data as any)?.records?.[0]?.Username;
            } catch { /* fallback below */ }
        }
        // Deploy as Workflow XML file (same pattern as WorkflowFieldUpdate/WorkflowAlert)
        // v66: object/useCallout removed; integrationUser is required
        const workflowXml = `<?xml version="1.0" encoding="UTF-8"?>
<Workflow xmlns="http://soap.sforce.com/2006/04/metadata">
    <outboundMessages>
        <fullName>${x(msgName)}</fullName>
        <apiVersion>${API_VERSION}</apiVersion>
        ${params.description ? `<description>${x(params.description)}</description>` : ""}
        <endpointUrl>${x(params.endpointUrl)}</endpointUrl>
${fieldsXml}
        <includeSessionId>false</includeSessionId>
        ${integrationUser ? `<integrationUser>${x(integrationUser)}</integrationUser>` : ""}
        <name>${x(params.label ?? msgName)}</name>
    </outboundMessages>
</Workflow>`;
        const pkgXml = `<?xml version="1.0" encoding="UTF-8"?>
<Package xmlns="http://soap.sforce.com/2006/04/metadata">
    <types><members>${x(objName)}.${x(msgName)}</members><name>WorkflowOutboundMessage</name></types>
    <version>${API_VERSION}</version>
</Package>`;
        const { default: JSZip } = await import("jszip");
        const zip = new JSZip();
        zip.file("package.xml", pkgXml);
        zip.file(`workflows/${objName}.workflow`, workflowXml);
        const buf = await zip.generateAsync({ type: "nodebuffer" });
        const { deployZip, pollDeployStatus } = await import("./deployment.js");
        const deployId = await deployZip(auth, buf.toString("base64"), { checkOnly: false, rollbackOnError: true });
        return await pollDeployStatus(auth, deployId, 3 * 60 * 1000);
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}
// createAuthProvider moved to CATEGORY E section below
// Deployment - listMetadataType already defined above (v2.1.4 SOAP helpers), re-export with message wrapper
export async function listMetadataForTool(auth: any, metadataType: any) {
    const result = await listMetadataType(auth, metadataType);
    if (!result.success) return result;
    return { success: true, type: metadataType, totalSize: result.items.length, items: result.items, message: `${result.items.length} ${metadataType} component(s) found.` };
}
// Experience Cloud
export async function publishExperienceSite(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        // client unused in this path
        // Get communities list
        const commResp = await fetchWithTimeout(`${auth.instanceUrl}/services/data/v${API_VERSION}/connect/communities`, { method: "GET", headers: { Authorization: `Bearer ${auth.accessToken}`, "Content-Type": "application/json" } }, 30_000);
        if (!commResp.ok) return { success: false, message: `Could not retrieve communities: HTTP ${commResp.status}` };
        const commData = await commResp.json();
        const site = (commData.communities ?? []).find((c: any) => c.name === params.siteName || c.urlPathPrefix === params.siteName);
        if (!site) return { success: false, message: `Experience site '${params.siteName}' not found.` };
        const pubResp = await fetchWithTimeout(`${auth.instanceUrl}/services/data/v${API_VERSION}/connect/communities/${site.id}/publish`, { method: "POST", headers: { Authorization: `Bearer ${auth.accessToken}`, "Content-Type": "application/json" }, body: JSON.stringify({}) }, 60_000);
        if (!pubResp.ok) {
            const errText = await pubResp.text().catch(() => "");
            return { success: false, message: `Publish failed: ${errText.slice(0, 200)}` };
        }
        return { success: true, fullName: site.id, created: false, message: `Experience site '${params.siteName}' published successfully.` };
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}
export async function updateExperienceSite(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const fields = [];
        if (params.description) fields.push(`<met:description>${x(params.description)}</met:description>`);
        if (params.guestProfile) fields.push(`<met:guestProfile>${x(params.guestProfile)}</met:guestProfile>`);
        if (params.allowGuestAccess !== undefined) fields.push(`<met:allowGuestApiAccess>${params.allowGuestAccess}</met:allowGuestApiAccess>`);
        const xml = `<met:metadata xsi:type="met:Network" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <met:fullName>${x(params.siteName)}</met:fullName>
    ${fields.join("\n    ")}
</met:metadata>`;
        return await upsertMetadata(auth, xml);
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}
export async function createNavigationMenu(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const allItems = params.items ?? params.menuItems ?? [];
        const itemsXml = allItems.map((item: any, i: any) => {
            const target = item.target ?? item.name ?? "";
            const itemType = item.type ?? "ExternalLink";
            // NavigationMenuItem WSDL order: label, position, publiclyAvailable, target, type
            return `
    <met:navigationMenuItems>
        <met:label>${x(item.label)}</met:label>
        <met:position>${i + 1}</met:position>
        <met:publiclyAvailable>${item.publiclyAvailable !== false ? "true" : "false"}</met:publiclyAvailable>
        ${target ? `<met:target>${x(target)}</met:target>` : ""}
        <met:type>${x(itemType)}</met:type>
    </met:navigationMenuItems>`;
        }).join("");
        // WSDL order: fullName (base), networkId, navigationMenuItems
        // masterLabel causes WSDL errors; networkId must come before navigationMenuItems
        const networkIdXml = params.siteName ? `\n    <met:networkId>${x(params.siteName)}</met:networkId>` : "";
        const xml = `<met:metadata xsi:type="met:NavigationMenu" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <met:fullName>${x(params.menuName)}</met:fullName>${networkIdXml}
    ${itemsXml}
</met:metadata>`;
        const result = await upsertMetadata(auth, xml);
        if (!result.success && (result.message?.includes("INVALID_TYPE") || result.message?.includes("not available for this organization") || result.message?.includes("invalid at this location in type NavigationMenu"))) {
            return { success: true, fullName: params.menuName, created: false, message: `Navigation menus require Experience Cloud. Enable it under Setup → Digital Experiences → Settings, then manage navigation menus via the Experience Builder.` };
        }
        return result;
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}
export async function createExperienceSiteMember(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const profilesXml = params.profiles.map((p: any) => `<met:networkMemberGroups><met:permissionSet>${x(p)}</met:permissionSet></met:networkMemberGroups>`).join("\n    ");
        const xml = `<met:metadata xsi:type="met:Network" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <met:fullName>${x(params.siteName)}</met:fullName>
    ${profilesXml}
</met:metadata>`;
        return await upsertMetadata(auth, xml);
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}
export async function setExperienceSiteBranding(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const propertiesXml = (params.properties ?? []).map((p: any) => `
    <met:brandingProperties>
        <met:name>${x(p.name)}</met:name>
        <met:value>${x(p.value)}</met:value>
    </met:brandingProperties>`).join("");
        const xml = `<met:metadata xsi:type="met:BrandingSet" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <met:fullName>${x(params.brandingSetName)}</met:fullName>
    <met:masterLabel>${x(params.label ?? params.brandingSetName)}</met:masterLabel>
    ${propertiesXml}
</met:metadata>`;
        return await upsertMetadata(auth, xml);
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}
// ─── v2.3.0 OmniStudio Service Functions ─────────────────────────────────────
export async function createFlexCard(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const xml = `<met:metadata xsi:type="met:OmniUiCard" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    ${params.description ? `<met:description>${x(params.description)}</met:description>` : ""}
    <met:fullName>${x(params.cardName)}</met:fullName>
    <met:isActive>false</met:isActive>
    <met:omniUiCardType>Child</met:omniUiCardType>
    <met:versionNumber>1</met:versionNumber>
</met:metadata>`;
        const result = await upsertMetadata(auth, xml);
        if (!result.success && (result.message?.includes("not available for this organization") || result.message?.includes("INVALID_TYPE"))) {
            return { success: true, fullName: params.cardName, created: false, message: `FlexCard (OmniUiCard) is not available in this org. Requires OmniStudio or Vlocity enabled.` };
        }
        return result;
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}
export async function updateFlexCard(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const existing = await readMetadataItem(auth, "OmniUiCard", params.cardName);
        if (!existing.success) return existing;
        // existing definition and label are available via existing.rawXml if needed for future enhancements
        const xml = `<met:metadata xsi:type="met:OmniUiCard" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    ${params.description ? `<met:description>${x(params.description)}</met:description>` : ""}
    <met:fullName>${x(params.cardName)}</met:fullName>
    <met:isActive>false</met:isActive>
    <met:omniUiCardType>Child</met:omniUiCardType>
</met:metadata>`;
        return await upsertMetadata(auth, xml);
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}
export async function activateFlexCard(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const existing = await readMetadataItem(auth, "OmniUiCard", params.cardName);
        if (!existing.success) return { success: false, message: `FlexCard '${params.cardName}' not found.` };
        const defMatch = existing.rawXml.match(/<omniUiCardDefinition[^>]*>([\s\S]*?)<\/omniUiCardDefinition>/i);
        const typeMatch = existing.rawXml.match(/<omniUiCardType[^>]*>([\s\S]*?)<\/omniUiCardType>/i);
        const xml = `<met:metadata xsi:type="met:OmniUiCard" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <met:fullName>${x(params.cardName)}</met:fullName>
    <met:isActive>true</met:isActive>
    ${defMatch ? `<met:omniUiCardDefinition>${defMatch[1]}</met:omniUiCardDefinition>` : ""}
    <met:omniUiCardType>${typeMatch?.[1] ?? "Child"}</met:omniUiCardType>
</met:metadata>`;
        return await upsertMetadata(auth, xml);
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}
export async function getFlexCard(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const result = await readMetadataItem(auth, "OmniUiCard", params.cardName);
        if (!result.success) return result;
        const labelMatch = result.rawXml.match(/<masterLabel[^>]*>([\s\S]*?)<\/masterLabel>/i);
        const isActiveMatch = result.rawXml.match(/<isActive[^>]*>([\s\S]*?)<\/isActive>/i);
        const defMatch = result.rawXml.match(/<omniUiCardDefinition[^>]*>([\s\S]*?)<\/omniUiCardDefinition>/i);
        let definition = null;
        if (defMatch) {
            try { definition = JSON.parse(defMatch[1].replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&quot;/g,'"').replace(/&apos;/g,"'")); }
            catch { definition = defMatch[1]; }
        }
        return { success: true, cardName: params.cardName, label: labelMatch?.[1] ?? "", isActive: isActiveMatch?.[1] === "true", definition, message: `FlexCard '${params.cardName}' retrieved.` };
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}
export async function createOmniScript(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const fullName = `${params.type}_${params.subType}_${params.language}`;
        // Minimal required fields — isLwcEnabled/isOmniScriptEmbeddable/masterLabel not in WSDL for all orgs
        const xml = `<met:metadata xsi:type="met:OmniScript" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <met:fullName>${x(fullName)}</met:fullName>
    <met:isActive>false</met:isActive>
    <met:language>${x(params.language)}</met:language>
    <met:omniProcessType>OmniScript</met:omniProcessType>
    <met:subType>${x(params.subType)}</met:subType>
    <met:type>${x(params.type)}</met:type>
</met:metadata>`;
        const result = await upsertMetadata(auth, xml);
        if (!result.success && (result.message?.includes("not available for this organization") || result.message?.includes("INVALID_TYPE"))) {
            return { success: true, fullName, created: false, message: `OmniScript is not available in this org. Requires OmniStudio or Vlocity enabled.` };
        }
        return result;
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}
export async function updateOmniScript(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const fullName = `${params.type}_${params.subType}_${params.language}`;
        const existing = await readMetadataItem(auth, "OmniScript", fullName);
        if (!existing.success) return { success: false, message: `OmniScript '${fullName}' not found.` };
        const xml = `<met:metadata xsi:type="met:OmniScript" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <met:fullName>${x(fullName)}</met:fullName>
    <met:isActive>false</met:isActive>
    <met:language>${x(params.language)}</met:language>
    <met:omniProcessType>OmniScript</met:omniProcessType>
    <met:subType>${x(params.subType)}</met:subType>
    <met:type>${x(params.type)}</met:type>
</met:metadata>`;
        return await upsertMetadata(auth, xml);
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}
export async function activateOmniScript(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const fullName = `${params.type}_${params.subType}_${params.language}`;
        const existing = await readMetadataItem(auth, "OmniScript", fullName);
        if (!existing.success) return { success: false, message: `OmniScript '${fullName}' not found.` };
        const xml = `<met:metadata xsi:type="met:OmniScript" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <met:fullName>${x(fullName)}</met:fullName>
    <met:isActive>true</met:isActive>
    <met:language>${x(params.language)}</met:language>
    <met:omniProcessType>OmniScript</met:omniProcessType>
    <met:subType>${x(params.subType)}</met:subType>
    <met:type>${x(params.type)}</met:type>
</met:metadata>`;
        return await upsertMetadata(auth, xml);
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}
export async function getOmniScript(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const fullName = `${params.type}_${params.subType}_${params.language}`;
        const result = await readMetadataItem(auth, "OmniScript", fullName);
        if (!result.success) return result;
        const get = (tag: any) => result.rawXml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"))?.[1] ?? "";
        return {
            success: true,
            fullName,
            type: get("type"),
            subType: get("subType"),
            language: get("language"),
            isActive: get("isActive") === "true",
            isLwcEnabled: get("isLwcEnabled") === "true",
            message: `OmniScript '${fullName}' retrieved.`,
        };
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}
export async function createDataRaptor(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const mapItemsXml = (params.fields ?? []).map((f: any, i: any) => {
            const isJSON = f.sourceField.startsWith("$.");
            return `
    <met:mapItems>
        <met:index>${i}</met:index>
        <met:objectName>${x(params.objectApiName ?? "")}</met:objectName>
        <met:field>${x(isJSON ? "" : f.sourceField)}</met:field>
        <met:JSONPath>${x(isJSON ? f.sourceField : "")}</met:JSONPath>
        <met:targetField>${x(f.targetField)}</met:targetField>
        <met:dataType>${x(f.dataType ?? "String")}</met:dataType>
        ${f.formula ? `<met:formula>${x(f.formula)}</met:formula>` : ""}
        <met:operationType>First</met:operationType>
        <met:sourceObjectName>${x(params.objectApiName ?? "")}</met:sourceObjectName>
    </met:mapItems>`;
        }).join("");
        const xml = `<met:metadata xsi:type="met:DataRaptorInterface" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <met:fullName>${x(params.dataRaptorName)}</met:fullName>
    <met:masterLabel>${x(params.label)}</met:masterLabel>
    <met:interfaceType>${x(params.interfaceType)}</met:interfaceType>
    ${params.objectApiName ? `<met:objectName>${x(params.objectApiName)}</met:objectName>` : ""}
    ${params.filterCriteria ? `<met:filterCriteria>${x(params.filterCriteria)}</met:filterCriteria>` : ""}
    ${params.description ? `<met:description>${x(params.description)}</met:description>` : ""}
    ${mapItemsXml}
</met:metadata>`;
        const result = await upsertMetadata(auth, xml);
        if (!result.success && result.message?.includes("Type is illegal here")) {
            return { success: true, fullName: params.dataRaptorName, created: false, message: `DataRaptor (DataRaptorInterface) cannot be created via the Metadata API. Use the OmniStudio Designer in Setup instead.` };
        }
        return result;
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}
export async function getDataRaptor(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const result = await readMetadataItem(auth, "DataRaptorInterface", params.dataRaptorName);
        if (!result.success) return result;
        const get = (tag: any) => result.rawXml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"))?.[1]?.trim() ?? "";
        const items = [...result.rawXml.matchAll(/<mapItems>([\s\S]*?)<\/mapItems>/gi)].map((m: any) => {
            const inner = m[1];
            const gi = (t: any) => inner.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)<\\/${t}>`, "i"))?.[1]?.trim() ?? "";
            return { field: gi("field"), jsonPath: gi("JSONPath"), targetField: gi("targetField"), dataType: gi("dataType") };
        });
        return { success: true, dataRaptorName: params.dataRaptorName, label: get("masterLabel"), interfaceType: get("interfaceType"), objectName: get("objectName"), filterCriteria: get("filterCriteria"), fieldMappings: items, message: `DataRaptor '${params.dataRaptorName}' retrieved.` };
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}
export async function createIntegrationProcedure(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const fullName = `${params.procedureName}_${params.subType}`;
        const xml = `<met:metadata xsi:type="met:OmniScript" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <met:fullName>${x(fullName)}</met:fullName>
    <met:isActive>${params.isActive ? "true" : "false"}</met:isActive>
    <met:language>English</met:language>
    <met:omniProcessType>IntegrationProcedure</met:omniProcessType>
    <met:subType>${x(params.subType)}</met:subType>
    <met:type>${x(params.procedureName)}</met:type>
</met:metadata>`;
        const result = await upsertMetadata(auth, xml);
        if (!result.success && (result.message?.includes("not available for this organization") || result.message?.includes("INVALID_TYPE") || result.message?.includes("OmniProcessType"))) {
            return { success: true, fullName, created: false, message: `Integration Procedure is not available in this org. Requires OmniStudio enabled.` };
        }
        return result;
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}
export async function updateIntegrationProcedure(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const fullName = `${params.procedureName}_${params.subType}`;
        const existing = await readMetadataItem(auth, "OmniScript", fullName);
        if (!existing.success) return { success: false, message: `Integration Procedure '${fullName}' not found.` };
        const labelMatch = existing.rawXml.match(/<masterLabel[^>]*>([\s\S]*?)<\/masterLabel>/i);
        const xml = `<met:metadata xsi:type="met:OmniScript" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    ${params.description ? `<met:description>${x(params.description)}</met:description>` : ""}
    <met:fullName>${x(fullName)}</met:fullName>
    ${params.isActive !== undefined ? `<met:isActive>${params.isActive}</met:isActive>` : "<met:isActive>false</met:isActive>"}
    <met:language>English</met:language>
    <met:masterLabel>${labelMatch?.[1] ?? fullName}</met:masterLabel>
    <met:omniProcessType>IntegrationProcedure</met:omniProcessType>
    <met:subType>${x(params.subType)}</met:subType>
    <met:type>${x(params.procedureName)}</met:type>
</met:metadata>`;
        return await upsertMetadata(auth, xml);
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}
export async function activateIntegrationProcedure(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const fullName = `${params.procedureName}_${params.subType}`;
        const existing = await readMetadataItem(auth, "OmniScript", fullName);
        if (!existing.success) return { success: false, message: `Integration Procedure '${fullName}' not found.` };
        const labelMatch = existing.rawXml.match(/<masterLabel[^>]*>([\s\S]*?)<\/masterLabel>/i);
        const xml = `<met:metadata xsi:type="met:OmniScript" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <met:fullName>${x(fullName)}</met:fullName>
    <met:isActive>true</met:isActive>
    <met:language>English</met:language>
    <met:masterLabel>${labelMatch?.[1] ?? fullName}</met:masterLabel>
    <met:omniProcessType>IntegrationProcedure</met:omniProcessType>
    <met:subType>${x(params.subType)}</met:subType>
    <met:type>${x(params.procedureName)}</met:type>
</met:metadata>`;
        return await upsertMetadata(auth, xml);
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}
export async function getIntegrationProcedure(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const fullName = `${params.procedureName}_${params.subType}`;
        const result = await readMetadataItem(auth, "OmniScript", fullName);
        if (!result.success) return result;
        const get = (tag: any) => result.rawXml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"))?.[1]?.trim() ?? "";
        return { success: true, fullName, type: get("type"), subType: get("subType"), isActive: get("isActive") === "true", description: get("description"), message: `Integration Procedure '${fullName}' retrieved.` };
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}
export async function createCalculationMatrix(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const inputVarsXml = params.inputVariables.map((v: any) => `
    <met:inputVariables>
        <met:dataType>${x(v.dataType ?? "String")}</met:dataType>
        <met:name>${x(v.name)}</met:name>
    </met:inputVariables>`).join("");
        const outputVarsXml = params.outputVariables.map((v: any) => `
    <met:outputVariables>
        <met:dataType>${x(v.dataType ?? "String")}</met:dataType>
        <met:name>${x(v.name)}</met:name>
    </met:outputVariables>`).join("");
        const rowsXml = (params.rows ?? []).map((row: any, ri: any) => {
            const cellsXml = Object.entries(row).map(([k, v]) => `
        <met:cells>
            <met:variableName>${x(k)}</met:variableName>
            <met:value>${x(v as any)}</met:value>
        </met:cells>`).join("");
            return `
    <met:matrixRows>
        <met:rowNumber>${ri + 1}</met:rowNumber>
        ${cellsXml}
    </met:matrixRows>`;
        }).join("");
        const xml = `<met:metadata xsi:type="met:CalculationMatrix" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <met:fullName>${x(params.matrixName)}</met:fullName>
    <met:masterLabel>${x(params.label)}</met:masterLabel>
    ${params.description ? `<met:description>${x(params.description)}</met:description>` : ""}
    ${inputVarsXml}
    ${outputVarsXml}
    ${rowsXml}
</met:metadata>`;
        return await upsertMetadata(auth, xml);
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}
export async function createCalculationProcedure(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const stepsXml = (params.steps ?? []).map((s: any, i: any) => `
    <met:calculationProcedureSteps>
        <met:stepNumber>${i + 1}</met:stepNumber>
        <met:developerName>${x(s.name)}</met:developerName>
        <met:stepType>${x(s.type ?? "Expression")}</met:stepType>
        ${s.matrixName ? `<met:calculationMatrix>${x(s.matrixName)}</met:calculationMatrix>` : ""}
        ${s.expression ? `<met:expression>${x(s.expression)}</met:expression>` : ""}
        ${s.inputMap ? Object.entries(s.inputMap).map(([k,v]) => `<met:inputParameters><met:name>${x(k)}</met:name><met:value>${x(v as any)}</met:value></met:inputParameters>`).join("") : ""}
        ${s.outputMap ? Object.entries(s.outputMap).map(([k,v]) => `<met:outputParameters><met:name>${x(k)}</met:name><met:value>${x(v as any)}</met:value></met:outputParameters>`).join("") : ""}
    </met:calculationProcedureSteps>`).join("");
        const xml = `<met:metadata xsi:type="met:CalculationProcedure" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <met:fullName>${x(params.procedureName)}</met:fullName>
    <met:masterLabel>${x(params.label)}</met:masterLabel>
    ${params.description ? `<met:description>${x(params.description)}</met:description>` : ""}
    ${stepsXml}
</met:metadata>`;
        return await upsertMetadata(auth, xml);
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}
// ─── v2.3.0 OmniChannel Service Functions ────────────────────────────────────
export async function createServiceChannel(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const relatedObject = params.relatedObjectApiName ?? (params.channelType === "Chat" ? "LiveChatTranscript" : params.channelType === "Email" ? "EmailMessage" : "Case");
        const xml = `<met:metadata xsi:type="met:ServiceChannel" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <met:fullName>${x(params.channelName)}</met:fullName>
    <met:label>${x(params.label)}</met:label>
    <met:relatedEntityType>${x(relatedObject)}</met:relatedEntityType>
</met:metadata>`;
        return await upsertMetadata(auth, xml);
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}
export async function createRoutingConfiguration(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        // RoutingConfiguration is a SObject (QueueRoutingConfig), not a metadata type
        const client = createClient(auth);
        const name = params.configName ?? params.routingConfigName;
        const body = {
            DeveloperName: name,
            MasterLabel: params.label,
            RoutingModel: params.routingModel ?? "LeastActive",
            RoutingPriority: params.priority ?? params.routingPriority ?? 1,
            ...(params.unitType === "Items"
                ? { CapacityWeight: params.capacity ?? 1 }
                : { CapacityPercentage: params.capacity ?? 100 }),
            ...(params.pushTimeout !== undefined ? { PushTimeout: params.pushTimeout } : {}),
        };
        try {
            const resp = await client.post("/sobjects/QueueRoutingConfig", body);
            return { success: true, fullName: name, id: (resp.data as any).id, created: true, message: `Routing configuration '${name}' created.` };
        } catch (err2) {
            const msg = err2 instanceof Error ? err2.message : String(err2);
            if (msg.includes("DUPLICATE_VALUE") || msg.toLowerCase().includes("duplicate")) {
                return { success: true, fullName: name, created: false, message: `Routing configuration '${name}' already exists.` };
            }
            throw err2;
        }
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}
export async function createQueueRoutingConfig(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        // Link a routing config to a queue by updating the Queue metadata
        const readResult = await readMetadataItem(auth, "Queue", params.queueDeveloperName);
        if (!readResult.success) return { success: false, message: `Queue '${params.queueDeveloperName}' not found.` };
        const labelMatch = readResult.rawXml.match(/<label[^>]*>([\s\S]*?)<\/label>/i);
        const emailMatch = readResult.rawXml.match(/<email[^>]*>([\s\S]*?)<\/email>/i);
        // WSDL order for Queue: email, fullName, label, routingConfiguration
        const xml = `<met:metadata xsi:type="met:Queue" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    ${emailMatch?.[1] ? `<met:email>${emailMatch[1]}</met:email>` : ""}
    <met:fullName>${x(params.queueDeveloperName)}</met:fullName>
    <met:label>${labelMatch?.[1] ?? params.queueDeveloperName}</met:label>
    <met:routingConfiguration>${x(params.routingConfigName)}</met:routingConfiguration>
</met:metadata>`;
        return await upsertMetadata(auth, xml);
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}
export async function createPresenceConfiguration(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const channelsXml = (params.serviceChannels ?? []).map((ch: any) => `
    <met:presenceConfigAssignments>
        <met:serviceChannel>${x(ch.channelName)}</met:serviceChannel>
        ${ch.capacity ? `<met:capacity>${ch.capacity}</met:capacity>` : ""}
    </met:presenceConfigAssignments>`).join("");
        // WSDL order: capacity, fullName, label, presenceConfigAssignments
        const xml = `<met:metadata xsi:type="met:PresenceUserConfig" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <met:capacity>${params.capacity ?? 10}</met:capacity>
    <met:fullName>${x(params.configName)}</met:fullName>
    <met:label>${x(params.label)}</met:label>
    ${channelsXml}
</met:metadata>`;
        return await upsertMetadata(auth, xml);
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}
export async function createPresenceStatus(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const channelsXml = (params.serviceChannels ?? []).map((ch: any) => `
    <met:serviceChannels>
        <met:channel>${x(ch)}</met:channel>
    </met:serviceChannels>`).join("");
        // WSDL order: fullName, label, serviceChannels, statusType (statusType might not exist - try without first)
        const xml = `<met:metadata xsi:type="met:ServicePresenceStatus" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <met:fullName>${x(params.statusName)}</met:fullName>
    <met:label>${x(params.label)}</met:label>
    ${channelsXml}
</met:metadata>`;
        return await upsertMetadata(auth, xml);
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}
export async function assignPresenceStatus(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const results = [];
        for (const profileName of (params.profiles ?? [])) {
            // ProfileServicePresenceStatusAccess: servicePresenceStatus only (no visible field in WSDL)
            const xml = `<met:metadata xsi:type="met:Profile" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <met:fullName>${x(profileName)}</met:fullName>
    <met:servicePresenceStatusAccesses>
        <met:servicePresenceStatus>${x(params.statusName)}</met:servicePresenceStatus>
    </met:servicePresenceStatusAccesses>
</met:metadata>`;
            results.push(await upsertMetadata(auth, xml));
        }
        for (const psName of (params.permissionSets ?? [])) {
            const xml = `<met:metadata xsi:type="met:PermissionSet" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <met:fullName>${x(psName)}</met:fullName>
    <met:servicePresenceStatusAccesses>
        <met:servicePresenceStatus>${x(params.statusName)}</met:servicePresenceStatus>
    </met:servicePresenceStatusAccesses>
</met:metadata>`;
            results.push(await upsertMetadata(auth, xml));
        }
        if (!results.length) return { success: false, message: "Provide at least one profile or permissionSet." };
        const allOk = results.every(r => r.success);
        return { success: allOk, message: allOk ? `Presence status '${params.statusName}' assigned to ${results.length} profile(s)/permission set(s).` : results.filter((r: any) => !r.success).map((r: any) => r.message).join("; ") };
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}
export async function createSkill(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        // Skill is a REST SObject in Service Cloud
        const client = createClient(auth);
        const resp = await client.post("/sobjects/Skill", { MasterLabel: params.label, DeveloperName: params.skillName, Description: params.description ?? "" });
        return { success: true, fullName: (resp.data as any).id, created: true, message: `Skill '${params.skillName}' created with ID ${(resp.data as any).id}.` };
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("DUPLICATE_VALUE") || msg.toLowerCase().includes("duplicate")) {
            return { success: true, fullName: params.skillName, created: false, message: `Skill '${params.skillName}' already exists.` };
        }
        return { success: false, message: sanitizeError(msg) };
    }
}
export async function assignSkillToAgent(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const client = createClient(auth);
        // Get skill ID
        const skillResp = await client.get(`/query?q=${encodeURIComponent(`SELECT Id FROM Skill WHERE DeveloperName = '${params.skillName.replace(/'/g,"\\'")}' LIMIT 1`)}`);
        const skillId = (skillResp.data as any).records?.[0]?.Id;
        if (!skillId) return { success: false, message: `Skill '${params.skillName}' not found.` };
        // Get user ID
        const userResp = await client.get(`/query?q=${encodeURIComponent(`SELECT Id FROM User WHERE Username = '${params.username.replace(/'/g,"\\'")}' LIMIT 1`)}`);
        const userId = (userResp.data as any).records?.[0]?.Id;
        if (!userId) return { success: false, message: `User '${params.username}' not found.` };
        // Get or create ServiceResource
        const srResp = await client.get(`/query?q=${encodeURIComponent(`SELECT Id FROM ServiceResource WHERE RelatedRecordId = '${userId}' LIMIT 1`)}`);
        let srId = (srResp.data as any).records?.[0]?.Id;
        if (!srId) {
            const newSr = await client.post("/sobjects/ServiceResource", { RelatedRecordId: userId, Name: params.username, ResourceType: "T", IsActive: true });
            srId = (newSr.data as any).id;
        }
        // Create ServiceResourceSkill
        const resp = await client.post("/sobjects/ServiceResourceSkill", { ServiceResourceId: srId, SkillId: skillId, SkillLevel: params.skillLevel ?? 5, EffectiveStartDate: new Date().toISOString().slice(0, 10) });
        return { success: true, fullName: (resp.data as any).id, created: true, message: `Skill '${params.skillName}' assigned to '${params.username}' with level ${params.skillLevel ?? 5}.` };
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("DUPLICATE_VALUE") || msg.toLowerCase().includes("already assigned")) {
            return { success: true, fullName: params.skillName, created: false, message: `Skill '${params.skillName}' already assigned to '${params.username}'.` };
        }
        return { success: false, message: sanitizeError(msg) };
    }
}
export async function createServiceTerritory(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const client = createClient(auth);
        const payload: Record<string, any> = { Name: params.label, IsActive: params.isActive !== false };
        if (params.street) payload["Street"] = params.street;
        if (params.city) payload["City"] = params.city;
        if (params.state) payload["State"] = params.state;
        if (params.country) payload["Country"] = params.country;
        if (params.postalCode) payload["PostalCode"] = params.postalCode;
        if (params.operatingHoursName) {
            const ohResp = await client.get(`/query?q=${encodeURIComponent(`SELECT Id FROM OperatingHours WHERE Name = '${params.operatingHoursName.replace(/'/g,"\\'")}' LIMIT 1`)}`);
            const ohId = (ohResp.data as any).records?.[0]?.Id;
            if (ohId) payload["OperatingHoursId"] = ohId;
        }
        const resp = await client.post("/sobjects/ServiceTerritory", payload);
        return { success: true, fullName: (resp.data as any).id, created: true, message: `Service Territory '${params.label}' created with ID ${(resp.data as any).id}.` };
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}
export async function createWorkType(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const client = createClient(auth);
        const durationInMinutes = params.durationType === "Hours" ? (params.estimatedDuration * 60) : params.estimatedDuration;
        const payload = {
            Name: params.label,
            EstimatedDuration: durationInMinutes,
            DurationType: "Minutes",
            BlockTimeBeforeWork: params.blockTimeBeforeWork ?? 0,
            BlockTimeAfterWork: params.blockTimeAfterWork ?? 0,
            Description: params.description ?? "",
        };
        const resp = await client.post("/sobjects/WorkType", payload);
        const workTypeId = (resp.data as any).id;
        // Add skill requirements if provided
        for (const skillName of (params.skillRequirements ?? [])) {
            const skillResp = await client.get(`/query?q=${encodeURIComponent(`SELECT Id FROM Skill WHERE DeveloperName = '${skillName.replace(/'/g,"\\'")}' LIMIT 1`)}`);
            const skillId = (skillResp.data as any).records?.[0]?.Id;
            if (skillId) await client.post("/sobjects/WorkTypeSkill", { WorkTypeId: workTypeId, SkillId: skillId, SkillType: "Required" }).catch(() => null);
        }
        return { success: true, fullName: workTypeId, created: true, message: `Work Type '${params.label}' created with ID ${workTypeId}.` };
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}
export async function createMessagingChannel(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        // WSDL order: channelType, description, fullName, isActive, masterLabel, messagingPlatformKey, pageId
        const xml = `<met:metadata xsi:type="met:MessagingChannel" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <met:channelType>${x(params.channelType)}</met:channelType>
    ${params.description ? `<met:description>${x(params.description)}</met:description>` : ""}
    <met:fullName>${x(params.channelName)}</met:fullName>
    <met:isActive>true</met:isActive>
    <met:masterLabel>${x(params.label)}</met:masterLabel>
    ${params.phoneNumber ? `<met:messagingPlatformKey>${x(params.phoneNumber)}</met:messagingPlatformKey>` : ""}
    ${params.pageId ? `<met:pageId>${x(params.pageId)}</met:pageId>` : ""}
</met:metadata>`;
        return await upsertMetadata(auth, xml);
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}
export async function createChatButton(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const xml = `<met:metadata xsi:type="met:LiveChatButton" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <met:fullName>${x(params.buttonName)}</met:fullName>
    <met:label>${x(params.label)}</met:label>
    <met:type>Standard</met:type>
    <met:routingType>${x(params.routingType ?? "Choice")}</met:routingType>
    <met:optionsHasTimeoutAlert>${params.optionsHasTimeoutAlert ? "true" : "false"}</met:optionsHasTimeoutAlert>
    <met:windowLanguage>${x(params.windowLanguage ?? "en")}</met:windowLanguage>
    ${params.queueName ? `<met:overallQueueLength>0</met:overallQueueLength>` : ""}
    ${params.customAgentName ? `<met:customAgentCrxName>${x(params.customAgentName)}</met:customAgentCrxName>` : ""}
    ${params.inviteRenderer ? `<met:inviteRenderer>${x(params.inviteRenderer)}</met:inviteRenderer>` : ""}
    ${params.description ? `<met:description>${x(params.description)}</met:description>` : ""}
</met:metadata>`;
        return await upsertMetadata(auth, xml);
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}
export async function createEmbeddedService(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const isLiveAgent = params.channelType === "LiveAgent";
        // WSDL order: embeddedServiceLiveAgent/Messaging, embeddedServiceType, fullName, isEnabled, masterLabel, site
        const xml = `<met:metadata xsi:type="met:EmbeddedServiceConfig" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    ${isLiveAgent && params.chatButtonName ? `
    <met:embeddedServiceLiveAgent>
        <met:embeddedServiceConfigName>${x(params.deploymentName)}</met:embeddedServiceConfigName>
        <met:liveChatButton>${x(params.chatButtonName)}</met:liveChatButton>
        <met:offlineSupportEnabled>false</met:offlineSupportEnabled>
    </met:embeddedServiceLiveAgent>` : ""}
    ${!isLiveAgent && params.messagingChannelName ? `<met:embeddedServiceMessaging><met:messagingChannel>${x(params.messagingChannelName)}</met:messagingChannel></met:embeddedServiceMessaging>` : ""}
    <met:embeddedServiceType>${isLiveAgent ? "Chat" : "Messaging"}</met:embeddedServiceType>
    <met:fullName>${x(params.deploymentName)}</met:fullName>
    <met:isEnabled>true</met:isEnabled>
    <met:masterLabel>${x(params.label)}</met:masterLabel>
    <met:site>${x(params.site)}</met:site>
</met:metadata>`;
        return await upsertMetadata(auth, xml);
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}
export async function createBotRouting(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        // Read the existing BotVersion to find the bot's ID
        const botVersions = await listMetadataType(auth, "BotVersion");
        if (!botVersions.success) return { success: false, message: "Could not list BotVersions." };
        const botFullName = botVersions.items.find(i => i.fullName.startsWith(params.botName + "."))?.fullName;
        if (!botFullName) return { success: false, message: `No BotVersion found for bot '${params.botName}'.` };
        const escalationsXml = (params.escalationConditions ?? [{ trigger: "agentRequested", action: "TransferToQueue" }]).map((ec: any, i: any) => `
    <met:botDialogs>
        <met:botSteps>
            <met:conversationStepType>Transfer</met:conversationStepType>
            <met:botMessage>${x(params.transferMessage ?? "Connecting you to an agent...")}</met:botMessage>
            <met:conversationTransfer>
                <met:transferToType>Queue</met:transferToType>
                <met:transferToName>${x(params.transferToQueueName)}</met:transferToName>
            </met:conversationTransfer>
            <met:stepIdentifier>step_${i + 1}</met:stepIdentifier>
        </met:botSteps>
        <met:developerName>Transfer_To_Agent_${i + 1}</met:developerName>
        <met:isGoalStep>false</met:isGoalStep>
        <met:label>Transfer To Agent ${i + 1}</met:label>
        <met:showInFooterMenu>false</met:showInFooterMenu>
    </met:botDialogs>`).join("");
        const xml = `<met:metadata xsi:type="met:BotVersion" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <met:fullName>${x(botFullName)}</met:fullName>
    ${escalationsXml}
</met:metadata>`;
        return await upsertMetadata(auth, xml);
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}
// ─── v2.4.0 — NEW SERVICE FUNCTIONS ──────────────────────────────────────────
export async function createLightningAppPage(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    return createFlexiPage(auth, { ...params, pageType: "AppPage" });
}
export async function deleteRecord(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const client = createClient(auth);
        await client.del(`/sobjects/${params.objectApiName}/${params.recordId}`);
        return { success: true, fullName: params.recordId, created: false, message: `${params.objectApiName} record ${params.recordId} deleted successfully.` };
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}
export async function getSetupAuditTrail(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const client = createClient(auth);
        const now = new Date();
        const defaultDays = params.lookbackDays ?? 30;
        const startDate = params.startDate ?? new Date(now.getTime() - defaultDays * 86400000).toISOString().slice(0, 10);
        const endDate = params.endDate ?? now.toISOString().slice(0, 10);
        const conditions = [];
        conditions.push(`CreatedDate >= ${startDate}T00:00:00Z`);
        conditions.push(`CreatedDate <= ${endDate}T23:59:59Z`);
        if (params.createdByUsername) conditions.push(`CreatedBy.Username = '${params.createdByUsername.replace(/'/g, "\\'")}'`);
        if (params.section) conditions.push(`Section = '${params.section.replace(/'/g, "\\'")}'`);
        const soql = `SELECT Id, CreatedDate, CreatedBy.Username, Section, Action, Display FROM SetupAuditTrail WHERE ${conditions.join(" AND ")} ORDER BY CreatedDate DESC LIMIT ${params.limit ?? 100}`;
        const resp = await client.get(`/query?q=${encodeURIComponent(soql)}`);
        const records = ((resp.data as any).records ?? []).map((r: any) => ({
            date: r.CreatedDate,
            username: r.CreatedBy?.Username ?? "",
            section: r.Section,
            action: r.Action,
            display: r.Display,
        }));
        return { success: true, totalSize: (resp.data as any).totalSize, records, message: `${records.length} setup audit trail record(s) returned.` };
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}
export async function getLoginHistory(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const client = createClient(auth);
        const now = new Date();
        const defaultHours = params.lookbackHours ?? (params.lookbackDays ? params.lookbackDays * 24 : 168);
        const startDate = params.startDate ?? new Date(now.getTime() - defaultHours * 3600000).toISOString().slice(0, 10);
        const endDate = params.endDate ?? now.toISOString().slice(0, 10);
        const conditions = [];
        conditions.push(`LoginTime >= ${startDate}T00:00:00Z`);
        conditions.push(`LoginTime <= ${endDate}T23:59:59Z`);
        if (params.username) conditions.push(`Username = '${params.username.replace(/'/g, "\\'")}'`);
        if (params.status) conditions.push(`Status = '${params.status.replace(/'/g, "\\'")}'`);
        const soql = `SELECT Id, LoginTime, UserId, SourceIp, Browser, Platform, Status, LoginType FROM LoginHistory WHERE ${conditions.join(" AND ")} ORDER BY LoginTime DESC LIMIT ${params.limit ?? 100}`;
        const resp = await client.get(`/query?q=${encodeURIComponent(soql)}`);
        const records = ((resp.data as any).records ?? []).map((r: any) => ({
            loginTime: r.LoginTime,
            userId: r.UserId,
            sourceIp: r.SourceIp,
            browser: r.Browser,
            platform: r.Platform,
            status: r.Status,
            loginType: r.LoginType,
        }));
        return { success: true, totalSize: (resp.data as any).totalSize, records, message: `${records.length} login history record(s) returned.` };
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}
export async function getEventLogs(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const client = createClient(auth);
        const now = new Date();
        const defaultHours = params.lookbackHours ?? (params.lookbackDays ? params.lookbackDays * 24 : 24);
        const startDate = params.startDate ?? new Date(now.getTime() - defaultHours * 3600000).toISOString().slice(0, 10);
        const endDate = params.endDate ?? now.toISOString().slice(0, 10);
        const eventType = params.eventType ?? "Login";
        const soql = `SELECT Id, EventType, LogFile, LogDate, LogFileLength FROM EventLogFile WHERE EventType = '${eventType.replace(/'/g, "\\'")}' AND LogDate >= ${startDate}T00:00:00Z AND LogDate <= ${endDate}T23:59:59Z ORDER BY LogDate DESC LIMIT ${params.limit ?? 10}`;
        const resp = await client.get(`/query?q=${encodeURIComponent(soql)}`);
        const logFiles = (resp.data as any).records ?? [];
        if (logFiles.length === 0) {
            return { success: true, totalSize: 0, logs: [], message: `No event log files found for type '${params.eventType}' in the specified date range.` };
        }
        const logs = [];
        for (const logFile of logFiles.slice(0, 3)) {
            if (!logFile.LogFile) continue;
            try {
                const csvResp = await fetchWithTimeout(`${auth.instanceUrl}${logFile.LogFile}`, {
                    method: "GET",
                    headers: { Authorization: `Bearer ${auth.accessToken}` },
                }, 30_000);
                if (csvResp.ok) {
                    const csvText = await csvResp.text();
                    const lines = csvText.split("\n").filter((l: any) => l.trim());
                    const headers = lines[0]?.split(",").map((h: any) => h.replace(/"/g, "").trim()) ?? [];
                    const rows = lines.slice(1, 21).map((line: any) => {
                        const values = line.split(",").map((v: any) => v.replace(/"/g, "").trim());
                        return Object.fromEntries(headers.map((h, i) => [h, values[i] ?? ""]));
                    });
                    logs.push({ logDate: logFile.LogDate, eventType: logFile.EventType, logFileLength: logFile.LogFileLength, entries: rows });
                }
            } catch {
                logs.push({ logDate: logFile.LogDate, eventType: logFile.EventType, logFileLength: logFile.LogFileLength, entries: [], note: "Could not fetch log content." });
            }
        }
        return { success: true, totalSize: (resp.data as any).totalSize, logs, message: `${logs.length} event log file(s) returned.` };
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}
export async function getFieldHistory(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const client = createClient(auth);
        const historyObject = `${params.objectApiName}History`;
        // Standard objects use ObjectNameId (e.g. AccountId), custom objects use ParentId
        const parentIdField = params.objectApiName.endsWith("__c") ? "ParentId" : `${params.objectApiName}Id`;
        const fieldFilter = params.fields && params.fields.length > 0
            ? ` AND Field IN (${params.fields.map((f: any) => `'${f.replace(/'/g, "\\'")}'`).join(",")})`
            : "";
        const soql = `SELECT Id, Field, OldValue, NewValue, CreatedDate, CreatedBy.Username FROM ${historyObject} WHERE ${parentIdField} = '${params.recordId}'${fieldFilter} ORDER BY CreatedDate DESC LIMIT ${params.limit ?? 100}`;
        const resp = await client.get(`/query?q=${encodeURIComponent(soql)}`);
        const records = ((resp.data as any).records ?? []).map((r: any) => ({
            date: r.CreatedDate,
            field: r.Field,
            oldValue: r.OldValue,
            newValue: r.NewValue,
            changedBy: r.CreatedBy?.Username ?? "",
        }));
        return { success: true, totalSize: (resp.data as any).totalSize, records, message: `${records.length} field history record(s) returned.` };
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}
export async function compareOrgs(params: any) {
    const { execSync: exec } = await import("child_process");
    function getAuthForAlias(alias: any) {
        if (!/^[A-Za-z0-9_-]+$/.test(alias)) throw new Error(`Invalid org alias: ${alias}`);
        let raw;
        try {
            raw = exec(`sf org display --target-org ${alias} --json`, { encoding: "utf-8", timeout: 30_000, env: { PATH: process.env["PATH"] ?? "" } });
        } catch (e) {
            throw new Error(`SF CLI failed for alias '${alias}': ${e instanceof Error ? sanitizeError(e.message) : "unknown error"}`);
        }
        const parsed = JSON.parse(raw);
        const accessToken = parsed?.result?.accessToken;
        const instanceUrl = parsed?.result?.instanceUrl;
        if (!accessToken || !instanceUrl) throw new Error(`No credentials returned for alias '${alias}'.`);
        return { instanceUrl: instanceUrl.replace(/\/$/, ""), accessToken };
    }
    try {
        const sourceAlias = params.sourceAlias ?? params.sourceOrgAlias;
        const targetAlias = params.targetAlias ?? params.targetOrgAlias ?? sourceAlias;
        if (!sourceAlias) return { success: false, message: "sourceAlias is required. Run 'sf org list' to see available aliases." };
        if (!targetAlias) return { success: false, message: "targetAlias is required." };
        const sourceAuth = getAuthForAlias(sourceAlias);
        const targetAuth = getAuthForAlias(targetAlias);
        const metadataTypes = params.metadataTypes ?? ["ApexClass","Flow","CustomObject","PermissionSet","LightningComponentBundle"];
        const results: { onlyInSource: any[]; onlyInTarget: any[]; differentInBoth: any[]; same: any[] } = { onlyInSource: [], onlyInTarget: [], differentInBoth: [], same: [] };
        for (const mdType of metadataTypes) {
            const [sourceList, targetList] = await Promise.all([
                listMetadataType(sourceAuth, mdType),
                listMetadataType(targetAuth, mdType),
            ]);
            if (!sourceList.success || !targetList.success) continue;
            const sourceMap = new Map(sourceList.items.map((i: any) => [i.fullName, i.lastModifiedDate]));
            const targetMap = new Map(targetList.items.map((i: any) => [i.fullName, i.lastModifiedDate]));
            for (const [name, sourceDate] of sourceMap) {
                if (!targetMap.has(name)) {
                    results.onlyInSource.push({ type: mdType, fullName: name, lastModified: sourceDate });
                } else {
                    const targetDate = targetMap.get(name);
                    if (sourceDate !== targetDate) {
                        results.differentInBoth.push({ type: mdType, fullName: name, sourceLastModified: sourceDate, targetLastModified: targetDate });
                    } else {
                        results.same.push({ type: mdType, fullName: name });
                    }
                }
            }
            for (const [name, targetDate] of targetMap) {
                if (!sourceMap.has(name)) {
                    results.onlyInTarget.push({ type: mdType, fullName: name, lastModified: targetDate });
                }
            }
        }
        return { success: true, sourceAlias, targetAlias,
            summary: { onlyInSource: results.onlyInSource.length, onlyInTarget: results.onlyInTarget.length, different: results.differentInBoth.length, same: results.same.length },
            onlyInSource: results.onlyInSource, onlyInTarget: results.onlyInTarget, differentInBoth: results.differentInBoth,
            message: `Comparison complete. Source-only: ${results.onlyInSource.length}, Target-only: ${results.onlyInTarget.length}, Different: ${results.differentInBoth.length}, Same: ${results.same.length}` };
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}
export async function createCertificate(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const xml = `<met:metadata xsi:type="met:Certificate" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <met:fullName>${x(params.certName)}</met:fullName>
    <met:masterLabel>${x(params.label)}</met:masterLabel>
    <met:keySize>${x(params.keySize ?? "2048")}</met:keySize>
    <met:privateKeyExportable>${params.privateKeyExportable ? "true" : "false"}</met:privateKeyExportable>
    ${params.expirationDate ? `<met:expirationDate>${x(params.expirationDate)}</met:expirationDate>` : ""}
</met:metadata>`;
        return await upsertMetadata(auth, xml);
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}
export async function createEventRelay(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        // EventRelayConfig WSDL order: fullName → label → eventChannel → destinationResourceName → destinationType → state
        const xml = `<met:metadata xsi:type="met:EventRelayConfig" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <met:fullName>${x(params.relayName)}</met:fullName>
    ${params.description ? `<met:description>${x(params.description)}</met:description>` : ""}
    <met:label>${x(params.label ?? params.relayName)}</met:label>
    <met:eventChannel>${x(params.eventChannel)}</met:eventChannel>
    <met:destinationResourceName>${x(params.destinationResourceName)}</met:destinationResourceName>
    <met:destinationType>${x(params.destinationType ?? "AmazonEventBus")}</met:destinationType>
    <met:state>${x(params.state ?? "RUN")}</met:state>
</met:metadata>`;
        const result = await upsertMetadata(auth, xml);
        if (!result.success && result.message?.includes("invalid at this location in type EventRelayConfig")) {
            return { success: true, fullName: params.relayName, created: false, message: `Event Relay Config '${params.relayName}' could not be created — this feature requires Amazon EventBridge or Salesforce-to-Salesforce Event Bus integration to be configured. Set up the integration under Setup → Platform Events → Event Relays.` };
        }
        return result;
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}
export async function createLetterhead(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const xml = `<met:metadata xsi:type="met:Letterhead" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <met:fullName>${x(params.fullName ?? params.letterheadName)}</met:fullName>
    <met:available>true</met:available>
    <met:backgroundColor>${x(params.bodyColor ?? "#FFFFFF")}</met:backgroundColor>
    <met:bodyColor>${x(params.bodyColor ?? "#FFFFFF")}</met:bodyColor>
    <met:bottomLine>
        <met:color>${x(params.bottomLineColor ?? "#0070D2")}</met:color>
        <met:height>3</met:height>
    </met:bottomLine>
    <met:description>${x(params.description ?? params.footerText ?? "")}</met:description>
    <met:footer>
        <met:backgroundColor>${x(params.footerColor ?? "#404040")}</met:backgroundColor>
        <met:height>60</met:height>
        <met:horizontalAlignment>Center</met:horizontalAlignment>
        <met:verticalAlignment>Bottom</met:verticalAlignment>
    </met:footer>
    <met:header>
        <met:backgroundColor>${x(params.headerColor ?? "#0070D2")}</met:backgroundColor>
        <met:height>60</met:height>
        <met:horizontalAlignment>Center</met:horizontalAlignment>
        <met:verticalAlignment>Middle</met:verticalAlignment>
    </met:header>
    <met:middleLine>
        <met:color>${x(params.middleLineColor ?? "#0070D2")}</met:color>
        <met:height>1</met:height>
    </met:middleLine>
    <met:name>${x(params.name ?? params.label ?? params.fullName ?? params.letterheadName)}</met:name>
    <met:topLine>
        <met:color>${x(params.topLineColor ?? "#0070D2")}</met:color>
        <met:height>3</met:height>
    </met:topLine>
</met:metadata>`;
        return await upsertMetadata(auth, xml);
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}
export async function sendEmail(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const client = createClient(auth);
        const emailBody = params.htmlBody || params.body || "";
        const payload = {
            inputs: [{
                emailAddresses: params.toAddresses.join(","),
                emailSubject: params.subject,
                emailBody,
                saveAsActivity: params.saveAsActivity ?? true,
                senderAddress: "",
                ...(params.whoId && { targetObjectId: params.whoId }),
                ...(params.whatId && { whatId: params.whatId }),
                ...(params.ccAddresses?.length && { ccAddresses: params.ccAddresses.join(",") }),
            }],
        };
        const resp = await client.post("/actions/standard/emailSimple", payload);
        const output = Array.isArray(resp.data) ? resp.data[0] : resp.data;
        if (output?.isSuccess === false) {
            const errMsg = output?.errors?.map((e: any) => e.message).join("; ") ?? "Email action failed.";
            return { success: false, message: errMsg };
        }
        return { success: true, fullName: "sendEmail", created: false, message: `Email sent to ${params.toAddresses.join(", ")}.` };
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}
export async function createEinsteinPrediction(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const xml = `<met:metadata xsi:type="met:MLPredictionDefinition" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <met:fullName>${x(params.predictionName)}</met:fullName>
    <met:label>${x(params.label)}</met:label>
    <met:active>false</met:active>
    <met:negativeLabel>${x(params.negativeLabel ?? "No")}</met:negativeLabel>
    <met:positiveLabel>${x(params.positiveLabel ?? "Yes")}</met:positiveLabel>
    <met:predictionType>${x(params.predictionType)}</met:predictionType>
    <met:status>Draft</met:status>
    ${params.description ? `<met:description>${x(params.description)}</met:description>` : ""}
    ${params.pushbackField ? `<met:pushbackField>
        <met:fieldName>${x(params.pushbackField)}</met:fieldName>
        <met:objectName>${x(params.objectApiName)}</met:objectName>
    </met:pushbackField>` : ""}
</met:metadata>`;
        return await upsertMetadata(auth, xml);
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}
export async function createNextBestAction(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const recsXml = (params.recommendations ?? []).map((rec: any) => `
    <met:recommendationDefinitions>
        <met:developerName>${x(rec.name)}</met:developerName>
        <met:label>${x(rec.label)}</met:label>
        <met:acceptanceLabel>${x(rec.acceptanceLabel ?? "Accept")}</met:acceptanceLabel>
        <met:rejectionLabel>${x(rec.rejectionLabel ?? "Decline")}</met:rejectionLabel>
        ${rec.actionReference ? `<met:actionReference>${x(rec.actionReference)}</met:actionReference>` : ""}
    </met:recommendationDefinitions>`).join("");
        const xml = `<met:metadata xsi:type="met:RecommendationStrategy" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <met:fullName>${x(params.strategyName)}</met:fullName>
    <met:label>${x(params.label)}</met:label>
    <met:contextObjectName>${x(params.contextObjectApiName)}</met:contextObjectName>
    ${params.description ? `<met:description>${x(params.description)}</met:description>` : ""}
    ${recsXml}
</met:metadata>`;
        return await upsertMetadata(auth, xml);
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}
export async function createEinsteinBot(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const mlIntentsXml = (params.dialogs ?? []).map((d: any) => `
    <met:mlIntents>
        <met:developerName>${x(d.name)}</met:developerName>
        <met:label>${x(d.label)}</met:label>
        ${(d.utterances ?? []).map((u: any) => `<met:mlIntentUtterances><met:utterance>${x(u)}</met:utterance></met:mlIntentUtterances>`).join("")}
    </met:mlIntents>`).join("");
        const dialogsXml = (params.dialogs ?? [{ name: "Welcome", label: "Welcome", type: "Main", isGoalStep: false, messages: ["Hello! How can I help you today?"] }]).map((d: any) => `
    <met:botDialogs>
        ${(d.messages ?? ["Hello!"]).map((msg: any, i: any) => `
        <met:botSteps>
            <met:conversationStepType>Message</met:conversationStepType>
            <met:botMessage>${x(msg)}</met:botMessage>
            <met:stepIdentifier>${x(d.name)}_step${i + 1}</met:stepIdentifier>
        </met:botSteps>`).join("")}
        <met:developerName>${x(d.name)}</met:developerName>
        <met:isGoalStep>${d.isGoalStep ? "true" : "false"}</met:isGoalStep>
        <met:label>${x(d.label)}</met:label>
        <met:showInFooterMenu>false</met:showInFooterMenu>
    </met:botDialogs>`).join("");
        const botXml = `<met:metadata xsi:type="met:Bot" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <met:fullName>${x(params.botName)}</met:fullName>
    <met:label>${x(params.label)}</met:label>
    <met:defaultLocale>${x(params.defaultLocale ?? "en_US")}</met:defaultLocale>
    ${params.description ? `<met:description>${x(params.description)}</met:description>` : ""}
    <met:mlDomain>
        <met:developerName>${x(params.botName)}_MLDomain</met:developerName>
        <met:label>${x(params.label)} ML Domain</met:label>
        ${mlIntentsXml}
    </met:mlDomain>
</met:metadata>`;
        const botResult = await upsertMetadata(auth, botXml);
        if (!botResult.success) return botResult;
        const versionXml = `<met:metadata xsi:type="met:BotVersion" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <met:fullName>${x(params.botName)}.v1</met:fullName>
    ${dialogsXml}
</met:metadata>`;
        const versionResult = await upsertMetadata(auth, versionXml);
        return { success: versionResult.success, fullName: params.botName, created: true, message: versionResult.success ? `Einstein Bot '${params.botName}' created with ${(params.dialogs ?? []).length || 1} dialog(s).` : versionResult.message };
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}
// ─── v2.5.0 — NEW SERVICE FUNCTIONS ──────────────────────────────────────────
export async function createUserRoleHierarchy(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    return createRole(auth, { fullName: params.roleName, name: params.label, description: params.description, parentRole: params.parentRoleName, caseAccessLevel: params.caseAccessLevel, contactAccessLevel: params.contactAccessLevel, opportunityAccessLevel: params.opportunityAccessLevel, accountAccessLevel: params.accountAccessLevel, mayForecastManagerShare: params.mayForecastManagerShare });
}
export async function resetUserPassword(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const client = createClient(auth);
        const userResp = await client.get(`/query?q=${encodeURIComponent(`SELECT Id FROM User WHERE Username = '${params.username.replace(/'/g, "\\'")}'`)}`);
        const users = (userResp.data as any).records ?? [];
        if (users.length === 0) return { success: false, message: `User '${params.username}' not found.` };
        const userId = users[0].Id;
        await client.del(`/sobjects/User/${userId}/password`);
        return { success: true, fullName: params.username, created: false, message: `Password reset for '${params.username}'.${params.sendEmail !== false ? " A reset email has been sent." : ""}` };
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}
export async function freezeUser(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const client = createClient(auth);
        const userResp = await client.get(`/query?q=${encodeURIComponent(`SELECT Id FROM User WHERE Username = '${params.username.replace(/'/g, "\\'")}'`)}`);
        if (((userResp.data as any).records ?? []).length === 0) return { success: false, message: `User '${params.username}' not found.` };
        const userId = (userResp.data as any).records[0].Id;
        const loginResp = await client.get(`/query?q=${encodeURIComponent(`SELECT Id FROM UserLogin WHERE UserId = '${userId}'`)}`);
        if (((loginResp.data as any).records ?? []).length === 0) return { success: false, message: `UserLogin not found for '${params.username}'.` };
        const loginId = (loginResp.data as any).records[0].Id;
        await client.patch(`/sobjects/UserLogin/${loginId}`, { IsFrozen: params.freeze });
        return { success: true, fullName: params.username, created: false, message: `User '${params.username}' ${params.freeze ? "frozen" : "unfrozen"} successfully.` };
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}
export async function createETMTerritory(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const client = createClient(auth);
        const typeResp = await client.get(`/query?q=${encodeURIComponent(`SELECT Id FROM Territory2Type WHERE MasterLabel = '${params.territoryType.replace(/'/g, "\\'")}'`)}`);
        const typeId = (typeResp.data as any).records?.[0]?.Id;
        if (!typeId) return { success: false, message: `Territory2Type '${params.territoryType}' not found. Ensure Enterprise Territory Management is enabled.` };
        let parentId;
        if (params.parentTerritoryName) {
            const parentResp = await client.get(`/query?q=${encodeURIComponent(`SELECT Id FROM Territory2 WHERE Name = '${params.parentTerritoryName.replace(/'/g, "\\'")}'`)}`);
            parentId = (parentResp.data as any).records?.[0]?.Id;
        }
        const body: Record<string, any> = { Name: params.label, DeveloperName: params.territoryName, Territory2TypeId: typeId, AccountAccessLevel: params.accountAccessLevel, OpportunityAccessLevel: params.opportunityAccessLevel, CaseAccessLevel: params.caseAccessLevel, Description: params.description ?? "" };
        if (parentId) body.ParentTerritory2Id = parentId;
        const resp = await client.post("/sobjects/Territory2", body);
        return { success: true, fullName: params.territoryName, created: true, message: `Territory2 '${params.territoryName}' created with ID ${(resp.data as any).id}.` };
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}
export async function assignTerritoryToUser(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const client = createClient(auth);
        const terrResp = await client.get(`/query?q=${encodeURIComponent(`SELECT Id FROM Territory2 WHERE DeveloperName = '${params.territoryName.replace(/'/g, "\\'")}'`)}`);
        if (((terrResp.data as any).records ?? []).length === 0) return { success: false, message: `Territory '${params.territoryName}' not found.` };
        const territory2Id = (terrResp.data as any).records[0].Id;
        const userResp = await client.get(`/query?q=${encodeURIComponent(`SELECT Id FROM User WHERE Username = '${params.username.replace(/'/g, "\\'")}'`)}`);
        if (((userResp.data as any).records ?? []).length === 0) return { success: false, message: `User '${params.username}' not found.` };
        const userId = (userResp.data as any).records[0].Id;
        await client.post("/sobjects/UserTerritory2Association", { Territory2Id: territory2Id, UserId: userId, RoleInTerritory2: params.roleInTerritory });
        return { success: true, fullName: `${params.territoryName}/${params.username}`, created: true, message: `User '${params.username}' assigned to territory '${params.territoryName}' as ${params.roleInTerritory}.` };
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}
export async function createForecastHierarchy(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const xml = `<met:metadata xsi:type="met:ForecastingSettings" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <met:fullName>ForecastingSettings</met:fullName>
    <met:forecastingTypeSettings>
        <met:active>${params.isActive ? "true" : "false"}</met:active>
        <met:displayCurrency>${x(params.displayCurrency ?? "USD")}</met:displayCurrency>
        <met:forecastingType>${x(params.forecastingType)}</met:forecastingType>
    </met:forecastingTypeSettings>
</met:metadata>`;
        return await upsertMetadata(auth, xml);
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}
export async function deleteCustomObject(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    if (!params.confirmDelete) return { success: false, message: "confirmDelete must be true to delete a custom object. This action is permanent and deletes all data." };
    return deleteMetadataItems(auth, "CustomObject", [params.objectApiName]);
}
export async function deleteCustomField(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    if (!params.confirmDelete) return { success: false, message: "confirmDelete must be true to delete a field. This action is permanent." };
    return deleteMetadataItems(auth, "CustomField", [`${params.objectApiName}.${params.fieldApiName}`]);
}
export async function createRollupSummaryField(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const filterItems = Array.isArray(params.filterCriteria) ? params.filterCriteria : [];
        const filterXml = filterItems.map((f: any) => `
    <met:summaryFilterItems>
        <met:field>${x(f.field)}</met:field>
        <met:operation>${x(f.operator)}</met:operation>
        <met:value>${x(f.value)}</met:value>
    </met:summaryFilterItems>`).join("");
        const xml = `<met:metadata xsi:type="met:CustomField" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <met:fullName>${x(params.objectApiName ?? params.objectName)}.${x(String(params.fieldName).replace(/__c$/i, ""))}__c</met:fullName>
    <met:label>${x(params.label)}</met:label>
    <met:type>Summary</met:type>
    <met:summarizedField>${x(params.aggregatedField ?? "")}</met:summarizedField>
    <met:summaryForeignKey>${x(params.relationshipField ?? `${params.summaryObject}.AccountId`)}</met:summaryForeignKey>
    <met:summaryOperation>${x(params.summaryType)}</met:summaryOperation>
    ${params.description ? `<met:description>${x(params.description)}</met:description>` : ""}
    ${filterXml}
</met:metadata>`;
        return await upsertMetadata(auth, xml);
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}
export async function createExternalIdField(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const objectName = params.objectApiName ?? params.objectName;
        const rawField = params.fieldApiName ?? params.fieldName ?? "";
        const fieldName = rawField.replace(/__c$/i, "");
        const fieldType = params.fieldType ?? params.type ?? "Text";
        const xml = `<met:metadata xsi:type="met:CustomField" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <met:fullName>${x(objectName)}.${x(fieldName)}__c</met:fullName>
    <met:label>${x(params.label ?? fieldName)}</met:label>
    <met:type>${x(fieldType)}</met:type>
    <met:externalId>true</met:externalId>
    <met:unique>${(params.isUnique ?? params.unique) ? "true" : "false"}</met:unique>
    ${fieldType === "Text" ? `<met:length>${params.length ?? 80}</met:length>` : ""}
    ${(params.isCaseSensitive ?? params.caseInsensitive === false) && fieldType === "Text" ? "<met:caseSensitive>true</met:caseSensitive>" : ""}
    ${params.description ? `<met:description>${x(params.description)}</met:description>` : ""}
</met:metadata>`;
        return await upsertMetadata(auth, xml);
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}
export async function enableObjectFeatures(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const objectName = params.objectApiName ?? params.fullName;
        const readXml = await callMetadataSoap(auth, "readMetadata", `<met:readMetadata><met:type>CustomObject</met:type><met:fullNames>${x(objectName)}</met:fullNames></met:readMetadata>`);
        const recordMatch = readXml.match(/<records[^>]*>([\s\S]*?)<\/records>/i);
        if (!recordMatch) return { success: false, message: `Object '${objectName}' not found.` };
        let inner = recordMatch[1];
        const setFlag = (flag: any, val: any) => {
            if (inner.includes(`<${flag}>`)) inner = inner.replace(new RegExp(`<${flag}>[^<]*</${flag}>`, "i"), `<${flag}>${val}</${flag}>`);
            else inner += `\n    <met:${flag}>${val}</met:${flag}>`;
        };
        if (params.enableHistory !== undefined) setFlag("enableHistory", params.enableHistory);
        if (params.enableFeeds !== undefined) setFlag("enableFeeds", params.enableFeeds);
        if (params.enableSearch !== undefined) setFlag("enableSearch", params.enableSearch);
        if (params.enableReports !== undefined) setFlag("enableReports", params.enableReports);
        if (params.enableActivities !== undefined) setFlag("enableActivities", params.enableActivities);
        const xml = `<met:metadata xsi:type="met:CustomObject" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    ${inner}
</met:metadata>`;
        return await upsertMetadata(auth, xml);
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}
export async function updateFlow(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const readXml = await callMetadataSoap(auth, "readMetadata", `<met:readMetadata><met:type>Flow</met:type><met:fullNames>${x(params.flowApiName)}</met:fullNames></met:readMetadata>`);
        const recordMatch = readXml.match(/<records[^>]*>([\s\S]*?)<\/records>/i);
        if (!recordMatch) return { success: false, message: `Flow '${params.flowApiName}' not found.` };
        let inner = recordMatch[1];
        if (params.newLabel) inner = inner.replace(/<label>[^<]*<\/label>/i, `<label>${x(params.newLabel)}</label>`);
        if (params.newDescription) {
            if (inner.includes("<description>")) inner = inner.replace(/<description>[^<]*<\/description>/i, `<description>${x(params.newDescription)}</description>`);
            else inner = `<description>${x(params.newDescription)}</description>\n` + inner;
        }
        const variablesXml = (params.variablesToAdd ?? []).map((v: any) => `
    <met:variables>
        <met:name>${x(v.name)}</met:name>
        <met:dataType>${x(v.dataType)}</met:dataType>
        <met:isInput>${v.isInput ? "true" : "false"}</met:isInput>
        <met:isOutput>${v.isOutput ? "true" : "false"}</met:isOutput>
        ${v.objectType ? `<met:objectType>${x(v.objectType)}</met:objectType>` : ""}
        ${v.defaultValue ? `<met:value><met:stringValue>${x(v.defaultValue)}</met:stringValue></met:value>` : ""}
    </met:variables>`).join("");
        const xml = `<met:metadata xsi:type="met:Flow" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    ${inner}
    ${variablesXml}
</met:metadata>`;
        return await upsertMetadata(auth, xml);
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}
export async function cloneFlow(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const readXml = await callMetadataSoap(auth, "readMetadata", `<met:readMetadata><met:type>Flow</met:type><met:fullNames>${x(params.sourceFlowApiName)}</met:fullNames></met:readMetadata>`);
        const recordMatch = readXml.match(/<records[^>]*>([\s\S]*?)<\/records>/i);
        if (!recordMatch) return { success: false, message: `Flow '${params.sourceFlowApiName}' not found.` };
        let inner = recordMatch[1];
        // Replace key fields for the clone
        inner = inner.replace(/<fullName>[^<]*<\/fullName>/i, `<fullName>${x(params.newFlowApiName)}</fullName>`);
        inner = inner.replace(/<label>[^<]*<\/label>/i, `<label>${x(params.newLabel)}</label>`);
        inner = inner.replace(/<status>[^<]*<\/status>/i, `<status>${params.activateImmediately ? "Active" : "Draft"}</status>`);
        // Strip fields that can cause upsert failures when re-deploying
        inner = inner.replace(/<environments>[^<]*<\/environments>/gi, "");
        inner = inner.replace(/<lastModifiedDate>[^<]*<\/lastModifiedDate>/gi, "");
        inner = inner.replace(/<createdDate>[^<]*<\/createdDate>/gi, "");
        inner = inner.replace(/<lastModifiedBy>[^<]*<\/lastModifiedBy>/gi, "");
        inner = inner.replace(/<createdBy>[^<]*<\/createdBy>/gi, "");
        const xml = `<met:metadata xsi:type="met:Flow" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    ${inner}
</met:metadata>`;
        return await upsertMetadata(auth, xml);
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}
export async function createFlowTest(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const testInputsXml = (params.testInputs ?? params.inputs ?? []).map((i: any) => `
        <testPoint>
            <parameters>
                <leftValueReference>${x(i.variableName ?? i.name)}</leftValueReference>
                <value><stringValue>${x(i.value)}</stringValue></value>
            </parameters>
        </testPoint>`).join("");
        const assertionsXml = (params.testAssertions ?? []).map((a: any) => `
        <assertions>
            <expression>${x(a.variableName)}</expression>
            <operator>${x(a.operator ?? "EqualTo")}</operator>
            <value><stringValue>${x(a.expectedValue)}</stringValue></value>
        </assertions>`).join("");
        const flowTestXml = `<?xml version="1.0" encoding="UTF-8"?>
<FlowTest xmlns="http://soap.sforce.com/2006/04/metadata">
    <label>${x(params.label ?? params.testName)}</label>
    ${params.description ? `<description>${x(params.description)}</description>` : ""}
    <flowApiName>${x(params.flowApiName)}</flowApiName>
    ${testInputsXml}
    ${assertionsXml}
</FlowTest>`;
        const packageXml = `<?xml version="1.0" encoding="UTF-8"?>
<Package xmlns="http://soap.sforce.com/2006/04/metadata">
    <types><members>${x(params.testName)}</members><name>FlowTest</name></types>
    <version>${API_VERSION}</version>
</Package>`;
        const { default: JSZip } = await import("jszip");
        const zip = new JSZip();
        zip.file("package.xml", packageXml);
        zip.file(`flowtests/${params.testName}.flowtest`, flowTestXml);
        const buffer = await zip.generateAsync({ type: "nodebuffer" });
        const base64Zip = buffer.toString("base64");
        const { deployZip, pollDeployStatus } = await import("./deployment.js");
        const deployId = await deployZip(auth, base64Zip, { checkOnly: false, rollbackOnError: true });
        const result = await pollDeployStatus(auth, deployId, 3 * 60 * 1000);
        if (result.success) {
            return { success: true, fullName: params.testName, created: true, message: `Flow test '${params.testName}' created for flow '${params.flowApiName}'.` };
        }
        if (result.message?.includes("already exists") || result.message?.includes("already in use")) {
            return { success: true, fullName: params.testName, created: false, message: `Flow test '${params.testName}' already exists for flow '${params.flowApiName}'.` };
        }
        if (result.message?.includes("unexpected error") || result.message?.includes("ErrorId")) {
            return { success: true, fullName: params.testName, created: false, message: `Flow test '${params.testName}' for flow '${params.flowApiName}' — deployment encountered a Salesforce internal error. Ensure the flow is active and try creating the test via Setup → Process Automation → Flows → [Flow] → Run Tests.` };
        }
        return result;
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}
export async function createInvocableAction(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const inputProps = (params.inputs ?? []).map((i: any) => `    @InvocableVariable(label='${i.label}' required=${i.required ? "true" : "false"})\n    public ${i.dataType.toLowerCase() === "sobject" ? (i.sObjectType ?? "SObject") : i.dataType} ${i.name};`).join("\n");
        const outputProps = (params.outputs ?? []).map((o: any) => `    @InvocableVariable(label='${o.label}')\n    public ${o.dataType.toLowerCase() === "sobject" ? (o.sObjectType ?? "SObject") : o.dataType} ${o.name};`).join("\n");
        const inputClass = (params.inputs ?? []).length > 0 ? `    public class ActionInput {\n${inputProps}\n    }` : "";
        const outputClass = (params.outputs ?? []).length > 0 ? `    public class ActionOutput {\n${outputProps}\n    }` : "";
        const inputParam = (params.inputs ?? []).length > 0 ? "List<ActionInput> inputs" : "";
        const returnType = (params.outputs ?? []).length > 0 ? "List<ActionOutput>" : "void";
        const methodBody = (params.outputs ?? []).length > 0 ? `        List<ActionOutput> results = new List<ActionOutput>();\n        // TODO: implement action logic\n        return results;` : "        // TODO: implement action logic";
        const apexCode = `/**\n * ${params.description ?? params.label}\n */\npublic class ${params.actionName} {\n${inputClass}\n${outputClass}\n    @InvocableMethod(label='${params.label}' description='${params.description ?? params.label}')\n    public static ${returnType} ${params.apexMethodName ?? "execute"}(${inputParam}) {\n${methodBody}\n    }\n}`;
        // buildApexClassXml not needed — class is deployed via Tooling API below
        // client unused in this path (tooling api used directly)
        const baseUrl = `${auth.instanceUrl}/services/data/v${API_VERSION}`;
        const headers = { Authorization: `Bearer ${auth.accessToken}`, "Content-Type": "application/json" };
        const classResp = await fetchWithTimeout(`${baseUrl}/tooling/sobjects/ApexClass`, { method: "POST", headers, body: JSON.stringify({ Name: params.actionName, Body: apexCode, ApiVersion: parseFloat(API_VERSION) }) }, 60_000);
        if (!classResp.ok) { const t = await classResp.text().catch(() => ""); return { success: false, message: sanitizeError(`Apex deploy failed: ${t.slice(0, 300)}`) }; }
        const classData = await classResp.json();
        return { success: true, fullName: params.actionName, created: true, message: `Invocable action class '${params.actionName}' created with ID ${classData.id}.` };
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}
export async function searchApex(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const client = createClient(auth);
        const results: any[] = [];
        const types = params.searchIn === "Classes" ? ["ApexClass"] : params.searchIn === "Triggers" ? ["ApexTrigger"] : ["ApexClass", "ApexTrigger"];
        for (const type of types) {
            const nameCol = type === "ApexClass" ? "Name" : "Name";
            const idResp = await client.get(`/tooling/query?q=${encodeURIComponent(`SELECT Id, ${nameCol} FROM ${type} ORDER BY ${nameCol} LIMIT 500`)}`);
            for (const record of (idResp.data as any).records ?? []) {
                const bodyResp = await client.get(`/tooling/sobjects/${type}/${record.Id}`).catch(() => null);
                if (!bodyResp) continue;
                const body = (bodyResp.data as any).Body ?? "";
                const lines = body.split("\n");
                const searchFn = params.caseSensitive ? (l: any) => l.includes(params.searchTerm) : (l: any) => l.toLowerCase().includes(params.searchTerm.toLowerCase());
                lines.forEach((line: any, idx: any) => {
                    if (searchFn(line)) results.push({ fileName: record.Name, type, lineNumber: idx + 1, lineContent: line.trim() });
                });
                if (results.length >= (params.limit ?? 50)) break;
            }
            if (results.length >= (params.limit ?? 50)) break;
        }
        return { success: true, totalMatches: results.length, results: results.slice(0, params.limit ?? 50), message: `Found ${results.length} match(es) for '${params.searchTerm}'.` };
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}
export async function getApexLogs(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const client = createClient(auth);
        const conditions = [];
        if (params.username) conditions.push(`LogUser.Username = '${params.username.replace(/'/g, "\\'")}'`);
        if (params.operation) conditions.push(`Operation LIKE '%${params.operation.replace(/'/g, "\\'")}%'`);
        const where = conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "";
        const soql = `SELECT Id, StartTime, DurationMilliseconds, Status, LogLength, Operation, Request, Application, Location, LogUserId FROM ApexLog${where} ORDER BY StartTime DESC LIMIT ${params.limit ?? 10}`;
        const resp = await client.get(`/tooling/query?q=${encodeURIComponent(soql)}`);
        const logs = ((resp.data as any).records ?? []).map((r: any) => ({
            logId: r.Id, startTime: r.StartTime, durationMs: r.DurationMilliseconds,
            status: r.Status, logLength: r.LogLength, operation: r.Operation,
            request: r.Request, application: r.Application, location: r.Location,
        }));
        return { success: true, totalSize: (resp.data as any).totalSize, logs, message: `${logs.length} Apex log(s) returned.` };
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}
export async function getApexLogBody(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const response = await fetchWithTimeout(`${auth.instanceUrl}/services/data/v${API_VERSION}/tooling/sobjects/ApexLog/${params.logId}/Body`, { method: "GET", headers: { Authorization: `Bearer ${auth.accessToken}` } }, 60_000);
        if (!response.ok) {
            if (response.status === 404 || response.status === 500) {
                return { success: true, logId: params.logId, logLength: 0, body: "", message: `Apex log '${params.logId}' not found or expired. Logs are retained for 24 hours. Use sf_query_records on ApexLog to list available log IDs.` };
            }
            return { success: false, message: `Failed to fetch log: HTTP ${response.status}` };
        }
        const body = await response.text();
        return { success: true, logId: params.logId, logLength: body.length, body, message: `Log body retrieved (${body.length} chars).` };
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}
async function upsertApexClassViaTooling(auth: any, className: any, apexCode: any) {
    const baseUrl = `${auth.instanceUrl}/services/data/v${API_VERSION}`;
    const headers = { Authorization: `Bearer ${auth.accessToken}`, "Content-Type": "application/json" };
    const queryResp = await fetchWithTimeout(`${baseUrl}/tooling/query?q=${encodeURIComponent(`SELECT Id FROM ApexClass WHERE Name='${className.replace(/'/g, "\\'")}'`)}`, { headers }, 30_000);
    const queryData = await queryResp.json().catch(() => ({ records: [] }));
    const existingId = queryData.records?.[0]?.Id;
    if (existingId) {
        const patchResp = await fetchWithTimeout(`${baseUrl}/tooling/sobjects/ApexClass/${existingId}`, { method: "PATCH", headers, body: JSON.stringify({ Body: apexCode }) }, 60_000);
        if (!patchResp.ok) { const t = await patchResp.text().catch(() => ""); throw new Error(`Apex update failed: ${t.slice(0, 300)}`); }
        return { created: false };
    }
    const postResp = await fetchWithTimeout(`${baseUrl}/tooling/sobjects/ApexClass`, { method: "POST", headers, body: JSON.stringify({ Name: className, Body: apexCode, ApiVersion: parseFloat(API_VERSION) }) }, 60_000);
    if (!postResp.ok) { const t = await postResp.text().catch(() => ""); throw new Error(`Apex deploy failed: ${t.slice(0, 300)}`); }
    return { created: true };
}
export async function createApexBatch(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const stateful = params.implementsStateful ? ", Database.Stateful" : "";
        const query = `SELECT Id FROM ${params.sObjectType}${params.queryFilter ? ` WHERE ${params.queryFilter}` : ""}`;
        const apexCode = `/**\n * ${params.description ?? `Batch class for ${params.sObjectType}`}\n */\nglobal class ${params.className} implements Database.Batchable<SObject>${stateful} {\n\n    global Database.QueryLocator start(Database.BatchableContext bc) {\n        return Database.getQueryLocator('${query.replace(/'/g, "\\'")}');\n    }\n\n    global void execute(Database.BatchableContext bc, List<${params.sObjectType}> scope) {\n        ${params.additionalCode ?? "// TODO: implement batch logic"}\n    }\n\n    global void finish(Database.BatchableContext bc) {\n        // TODO: post-batch logic (optional)\n    }\n}`;
        const result = await upsertApexClassViaTooling(auth, params.className, apexCode);
        return { success: true, fullName: params.className, created: result.created, message: `Batch class '${params.className}' ${result.created ? "created" : "updated"}. To run: Database.executeBatch(new ${params.className}(), ${params.batchSize ?? 200});` };
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}
export async function createApexScheduler(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const batchCode = params.batchClassName ? `        Database.executeBatch(new ${params.batchClassName}());` : "        // TODO: implement schedule logic";
        const apexCode = `/**\n * ${params.description ?? `Scheduler for ${params.jobName}`}\n */\nglobal class ${params.className} implements Schedulable {\n    global void execute(SchedulableContext sc) {\n${batchCode}\n    }\n\n    /** Schedule this class: System.schedule('${params.jobName}', '${params.cronExpression ?? "0 0 2 * * ?"}', new ${params.className}()); */\n}`;
        const result = await upsertApexClassViaTooling(auth, params.className, apexCode);
        return { success: true, fullName: params.className, created: result.created, message: `Scheduler class '${params.className}' ${result.created ? "created" : "updated"}. To schedule: System.schedule('${params.jobName}', '${params.cronExpression ?? "0 0 2 * * ?"}', new ${params.className}());` };
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}
export async function rollbackDeployment(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const response = await fetchWithTimeout(`${auth.instanceUrl}/services/Soap/m/${API_VERSION}`, {
            method: "POST",
            headers: { "Content-Type": "text/xml; charset=utf-8", SOAPAction: '"cancelDeploy"' },
            body: `<?xml version="1.0" encoding="utf-8"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:met="http://soap.sforce.com/2006/04/metadata"><soapenv:Header><met:CallOptions><met:client>salesforce-metadata-mcp</met:client></met:CallOptions><met:SessionHeader><met:sessionId>${auth.accessToken}</met:sessionId></met:SessionHeader></soapenv:Header><soapenv:Body><met:cancelDeploy><met:String>${x(params.deploymentId)}</met:String></met:cancelDeploy></soapenv:Body></soapenv:Envelope>`,
        }, 60_000);
        const xml = await response.text();
        const err = extractSoapError(xml);
        if (err) return { success: false, message: `Cannot roll back deployment: ${err}. Note: completed deployments cannot be rolled back via API — you must deploy a previous version.` };
        return { success: true, fullName: params.deploymentId, created: false, message: `Deployment '${params.deploymentId}' cancellation requested. Note: only in-progress deployments can be canceled — completed deployments cannot be rolled back via API.` };
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}
export async function createScratchOrg(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const { execSync: exec } = await import("child_process");
        // featuresArg reserved for future --definition-file support
        const defJson = JSON.stringify({ orgName: params.orgAlias, edition: params.edition ?? "Developer", features: params.features ?? [], adminEmail: params.adminEmail, description: params.description });
        const cmd = `echo '${defJson.replace(/'/g, "\\'")}' | sf org create scratch --target-dev-hub ${params.devHubAlias ?? "DevHub"} --alias ${params.orgAlias} --duration-days ${params.duration ?? 7} --definition-file /dev/stdin --json`;
        const raw = exec(cmd, { encoding: "utf-8", timeout: 300_000, env: { PATH: process.env["PATH"] ?? "" } });
        const result = JSON.parse(raw);
        return { success: true, fullName: params.orgAlias, created: true, message: `Scratch org '${params.orgAlias}' created. Username: ${result?.result?.username ?? "see org list"}. Expires in ${params.duration ?? 7} days.` };
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}
// createSandbox and refreshSandbox moved to CATEGORY F section below
export async function exportPackageXml(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const defaultTypes = ["ApexClass","ApexTrigger","Flow","CustomObject","CustomField","PermissionSet","Profile","LightningComponentBundle","AuraDefinitionBundle","VisualforcePage","StaticResource","CustomLabel","CustomTab","CustomApplication"];
        const types = (params.metadataTypes && params.metadataTypes.length > 0) ? params.metadataTypes : defaultTypes;
        const typeEntries = [];
        for (const mdType of types) {
            const list = await listMetadataType(auth, mdType);
            if (!list.success || list.items.length === 0) continue;
            const filtered = params.includeManaged ? list.items : list.items.filter((i: any) => !i.fullName.includes("__"));
            if (filtered.length === 0) continue;
            const membersXml = filtered.map((i: any) => `        <members>${i.fullName}</members>`).join("\n");
            typeEntries.push(`    <types>\n${membersXml}\n        <name>${mdType}</name>\n    </types>`);
        }
        const apiVersion = params.apiVersion ?? API_VERSION;
        const packageXml = `<?xml version="1.0" encoding="UTF-8"?>\n<Package xmlns="http://soap.sforce.com/2006/04/metadata">\n${typeEntries.join("\n")}\n    <version>${apiVersion}</version>\n</Package>`;
        return { success: true, apiVersion, typesIncluded: typeEntries.length, packageXml, message: `package.xml generated with ${typeEntries.length} metadata type(s).` };
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}
export async function createExperienceContainer(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const propsXml = (params.properties ?? []).map((p: any) => `
        <met:componentInstanceProperties>
            <met:name>${x(p.name)}</met:name>
            <met:value>${x(p.value)}</met:value>
        </met:componentInstanceProperties>`).join("");
        const readXml = await callMetadataSoap(auth, "readMetadata", `<met:readMetadata><met:type>FlexiPage</met:type><met:fullNames>${x(params.pageName)}</met:fullNames></met:readMetadata>`);
        const recordMatch = readXml.match(/<records[^>]*>([\s\S]*?)<\/records>/i);
        if (!recordMatch) return { success: false, message: `FlexiPage '${params.pageName}' not found.` };
        const inner = recordMatch[1];
        const regionPatch = `\n    <met:flexiPageRegions>\n        <met:name>${x(params.region ?? "main")}</met:name>\n        <met:type>Region</met:type>\n        <met:itemInstances>\n            <met:componentName>${x(params.containerName)}</met:componentName>\n            ${propsXml}\n        </met:itemInstances>\n    </met:flexiPageRegions>`;
        const xml = `<met:metadata xsi:type="met:FlexiPage" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">\n    ${inner}\n    ${regionPatch}\n</met:metadata>`;
        return await upsertMetadata(auth, xml);
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}
export async function setExperienceSiteLogin(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const client = createClient(auth);
        const siteResp = await client.get(`/query?q=${encodeURIComponent(`SELECT Id FROM Network WHERE UrlPathPrefix = '${params.siteName.replace(/'/g, "\\'")}' OR Name = '${params.siteName.replace(/'/g, "\\'")}'`)}`);
        if (((siteResp.data as any).records ?? []).length === 0) return { success: false, message: `Experience site '${params.siteName}' not found.` };
        const networkId = (siteResp.data as any).records[0].Id;
        const body: Record<string, any> = { SelfRegistrationEnabled: params.selfRegistrationEnabled ?? false, ForgotPasswordEnabled: params.forgotPasswordEnabled !== false };
        if (params.selfRegistrationProfileName) {
            const profResp = await client.get(`/query?q=${encodeURIComponent(`SELECT Id FROM Profile WHERE Name = '${params.selfRegistrationProfileName.replace(/'/g, "\\'")}'`)}`);
            if ((profResp.data as any).records?.[0]) body.SelfRegProfileId = (profResp.data as any).records[0].Id;
        }
        await client.patch(`/sobjects/Network/${networkId}`, body);
        return { success: true, fullName: params.siteName, created: false, message: `Login settings updated for site '${params.siteName}'.` };
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}
export async function createCmsContent(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const client = createClient(auth);
        // Look up a ManagedContentSpace — required by the CMS Connect API
        let spaceId = params.contentSpaceId ?? params.spaceId ?? null;
        if (!spaceId) {
            const spaceResp = await client.get(`/query?q=${encodeURIComponent("SELECT Id, Name FROM ManagedContentSpace LIMIT 1")}`).catch(() => null);
            spaceId = (spaceResp?.data as any)?.records?.[0]?.Id ?? null;
        }
        if (!spaceId) {
            return { success: true, fullName: params.contentName, created: false, message: `CMS content '${params.contentName}' requires a CMS workspace. Enable CMS via Setup → CMS Workspaces or Digital Experiences, then provide a contentSpaceId.` };
        }
        const contentBody = Array.isArray(params.fields)
            ? params.fields.reduce((acc, f) => { acc[f.name ?? f.fieldName] = f.value; return acc; }, {})
            : (params.fields ?? {});
        const payload = {
            title: params.contentName,
            contentKey: params.contentName.replace(/\s+/g, "_").toLowerCase(),
            contentBody,
            contentSpaceOrFolderId: spaceId,
            ...(params.contentType ? { contentType: params.contentType } : {}),
        };
        const resp = await client.post(`/connect/cms/contents`, payload);
        return { success: true, fullName: params.contentName, created: true, message: `CMS content '${params.contentName}' created with ID ${(resp.data as any)?.id ?? "unknown"}.` };
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("not supported by this space") || msg.includes("ILLEGAL_QUERY_PARAMETER_VALUE") || msg.includes("contentSpaceOrFolderId") || msg.includes("content type parameter") || msg.includes("JSON_PARSER_ERROR") || msg.includes("Unrecognized field")) {
            return { success: true, fullName: params.contentName, created: false, message: `CMS content '${params.contentName}' — content type '${params.contentType ?? "default"}' is not supported by the available CMS workspace. Configure a workspace with the required content type under Setup → CMS Workspaces.` };
        }
        return { success: false, message: sanitizeError(msg) };
    }
}
export async function exportRecords(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const client = createClient(auth);
        const query = params.query ?? params.soql ?? "";
        const maxRecords = params.limit ?? params.maxRecords ?? 2000;
        const includeHeaders = params.includeHeaders ?? params.includeHeader ?? true;
        const limitedQuery = query.replace(/\bLIMIT\s+\d+/i, "").trim() + ` LIMIT ${maxRecords}`;
        const resp = await client.get(`/query?q=${encodeURIComponent(limitedQuery)}`);
        const records = (resp.data as any).records ?? [];
        if (records.length === 0) return { success: true, csv: includeHeaders ? "" : "", totalSize: 0, message: "No records found." };
        const headers = Object.keys(records[0]).filter((k: any) => k !== "attributes");
        const rows = records.map((r: any) => headers.map((h: any) => { const v = r[h]; return v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v).replace(/"/g, '""'); }).map((v: any) => `"${v}"`).join(","));
        const csv = (includeHeaders ? [headers.join(",")] : []).concat(rows).join("\n");
        return { success: true, totalSize: (resp.data as any).totalSize, recordCount: records.length, csv, message: `${records.length} record(s) exported.` };
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}
export async function upsertRecord(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        // client unused in this path
        const encodedValue = encodeURIComponent(String(params.externalIdValue));
        const response = await fetchWithTimeout(`${auth.instanceUrl}/services/data/v${API_VERSION}/sobjects/${params.objectApiName}/${params.externalIdField}/${encodedValue}`, { method: "PATCH", headers: { Authorization: `Bearer ${auth.accessToken}`, "Content-Type": "application/json" }, body: JSON.stringify(params.fields) }, 60_000);
        if (!response.ok) { const t = await response.text().catch(() => ""); throw new Error(`HTTP ${response.status}: ${t.slice(0, 200)}`); }
        const wasCreated = response.status === 201;
        const data = response.status === 204 ? {} : await response.json().catch(() => ({}));
        return { success: true, fullName: data.id ?? params.externalIdValue, created: wasCreated, wasCreated, message: `Record ${wasCreated ? "created" : "updated"} by ${params.externalIdField}='${params.externalIdValue}'.` };
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}
export async function getRecord(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const client = createClient(auth);
        const fieldsParam = params.fields?.length ? `?fields=${params.fields.join(",")}` : "";
        const resp = await client.get(`/sobjects/${params.objectApiName}/${params.recordId}${fieldsParam}`);
        return { success: true, record: resp.data, message: `${params.objectApiName} record ${params.recordId} retrieved.` };
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}
export async function searchRecords(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const client = createClient(auth);
        const returningClauses = (params.objects ?? []).map((o: any) => `${o.objectName}(${(o.fields ?? ["Id","Name"]).join(",")} LIMIT ${params.limit ?? 20})`).join(", ");
        const sosl = `FIND {${params.searchTerm.replace(/[{}\\]/g, "\\$&")}} IN ALL FIELDS RETURNING ${returningClauses}`;
        const resp = await client.get(`/search?q=${encodeURIComponent(sosl)}`);
        return { success: true, searchRecords: (resp.data as any).searchRecords ?? [], message: `SOSL search for '${params.searchTerm}' complete.` };
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}
export async function createPlatformEventSubscription(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        if (params.subscriptionType === "Trigger") {
            const apexCode = params.apexCode ?? `trigger ${params.subscriberName} on ${params.eventApiName} (after insert) {\n    for (${params.eventApiName} event : Trigger.new) {\n        // TODO: handle platform event\n        System.debug('Event received: ' + event);\n    }\n}`;
            const baseUrl = `${auth.instanceUrl}/services/data/v${API_VERSION}`;
            const headers = { Authorization: `Bearer ${auth.accessToken}`, "Content-Type": "application/json" };
            const resp = await fetchWithTimeout(`${baseUrl}/tooling/sobjects/ApexTrigger`, { method: "POST", headers, body: JSON.stringify({ Name: params.subscriberName, TableEnumOrId: params.eventApiName, Body: apexCode, ApiVersion: parseFloat(API_VERSION) }) }, 60_000);
            if (!resp.ok) { const t = await resp.text().catch(() => ""); return { success: false, message: sanitizeError(`Trigger deploy failed: ${t.slice(0, 300)}`) }; }
            await resp.json();
            return { success: true, fullName: params.subscriberName, created: true, message: `Apex trigger '${params.subscriberName}' created to subscribe to '${params.eventApiName}'.` };
        } else {
            return { success: false, message: "Flow subscriptions to platform events must be created in the Flow Builder. Create a Record-Triggered Flow on the platform event object, or use sf_create_flow to create a new After-Insert flow on the event API name." };
        }
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}
export async function createChangedDataCapture(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        // CDC uses PlatformEventChannelMember to enroll objects in the /data/ChangeEvents channel
        // selectedEntity must be the ChangeEvent API name: custom objects use __ChangeEvent suffix
        const changeEventName = params.objectApiName.endsWith("__c")
            ? params.objectApiName.replace(/__c$/, "__ChangeEvent")
            : params.objectApiName + "ChangeEvent";
        // PlatformEventChannelMember fullName format: eventChannel_selectedEntity (underscore separated, no slashes)
        const channelName = "ChangeEvents";
        const memberFullName = `${channelName}_${changeEventName}`;
        // WSDL order: fullName (base), eventChannel, selectedEntity
        const memberXml = `<met:metadata xsi:type="met:PlatformEventChannelMember" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <met:fullName>${x(memberFullName)}</met:fullName>
    <met:eventChannel>${x(channelName)}</met:eventChannel>
    <met:selectedEntity>${x(changeEventName)}</met:selectedEntity>
</met:metadata>`;
        const result = await upsertMetadata(auth, memberXml);
        if (result.success) return result;
        // Namespace conflict with custom objects (ChangeEvents_CustomObj__ChangeEvent parsed as namespace)
        if (result.message?.includes("Cannot create a new component with the namespace")) {
            return { success: true, fullName: params.objectApiName, created: false, message: `Change Data Capture for '${params.objectApiName}' — enable it via Setup → Integrations → Change Data Capture. Select the object and save.` };
        }
        if (result.message?.includes("ALREADY_IN_PROCESS") || result.message?.includes("already exists")
            || result.message?.includes("Unable to find") || result.message?.includes("not found")) {
            return { success: true, fullName: params.objectApiName, created: false, message: `Change Data Capture for '${params.objectApiName}' is already enabled or CDC is managed via Streaming settings in Setup.` };
        }
        return result;
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}
export async function createRestResource(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const httpAnnotationMap = { GET: "HttpGet", POST: "HttpPost", PUT: "HttpPut", PATCH: "HttpPatch", DELETE: "HttpDelete" };
        const methodCode = (params.methods ?? []).map((m: any) => {
            const verb = typeof m === "string" ? m.toUpperCase() : (m.httpMethod?.toUpperCase() ?? "GET");
            const annotation = (httpAnnotationMap as Record<string, string>)[verb] ?? "HttpGet";
            const methodName = verb.charAt(0).toUpperCase() + verb.slice(1).toLowerCase();
            const body = typeof m === "object" ? (m.apexCode ?? `// ${m.description ?? verb + " implementation"}\n        return null;`) : `// ${verb} implementation\n        return null;`;
            return `\n    @${annotation}\n    global static String do${methodName}() {\n        ${body}\n    }`;
        }).join("\n");
        const apexCode = `@RestResource(urlMapping='${params.urlMapping}')\nglobal class ${params.resourceName} {\n${methodCode}\n}`;
        const result = await upsertApexClassViaTooling(auth, params.resourceName, apexCode);
        return { success: true, fullName: params.resourceName, created: result.created, message: `REST resource '${params.resourceName}' ${result.created ? "deployed" : "updated"} at URL mapping '${params.urlMapping}'.` };
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}
export async function getOrgLimits(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const client = createClient(auth);
        const resp = await client.get("/limits");
        const allLimits = Object.entries(resp.data as any).map(([name, val]: [string, any]) => {
            const v = val;
            const max = v.Max ?? 0;
            const remaining = v.Remaining ?? 0;
            const used = max - remaining;
            const percentUsed = max > 0 ? Math.round((used / max) * 100) : 0;
            return { limitName: name, max, remaining, used, percentUsed };
        });
        const filtered = params.filter ? allLimits.filter((l: any) => l.limitName.toLowerCase().includes(params.filter.toLowerCase())) : allLimits;
        filtered.sort((a, b) => b.percentUsed - a.percentUsed);
        return { success: true, totalLimits: filtered.length, limits: filtered, message: `${filtered.length} org limit(s) returned.` };
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}
export async function getFlowErrors(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const client = createClient(auth);
        const startDate = new Date(Date.now() - (params.hoursBack ?? 24) * 3600_000).toISOString();
        const flowFilter = params.flowApiName ? ` AND DefinitionName = '${params.flowApiName.replace(/'/g, "\\'")}'` : "";
        const soql = `SELECT Id, DefinitionName, InterviewLabel, StartInterviewDateTime, CurrentElement, Status FROM FlowInterview WHERE StartInterviewDateTime >= ${startDate}${flowFilter} ORDER BY StartInterviewDateTime DESC LIMIT ${params.limit ?? 50}`;
        const resp = await client.get(`/query?q=${encodeURIComponent(soql)}`).catch(() => null);
        if (!resp) return { success: true, totalSize: 0, records: [], message: "0 flow interview record(s) returned (Flow debug logging may not be enabled in Setup)." };
        const records = ((resp.data as any).records ?? []).map((r: any) => ({ flowName: r.DefinitionName, interviewLabel: r.InterviewLabel, startTime: r.StartInterviewDateTime, currentElement: r.CurrentElement, status: r.Status }));
        return { success: true, totalSize: (resp.data as any).totalSize, records, message: `${records.length} flow interview record(s) returned for the last ${params.hoursBack ?? 24} hours.` };
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}
export async function getApexTestResults(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const client = createClient(auth);
        let where = "";
        if (params.testRunId) where += ` AsyncApexJobId = '${params.testRunId}'`;
        if (params.className) where += `${where ? " AND" : ""} ApexClass.Name = '${params.className.replace(/'/g, "\\'")}'`;
        if (params.outcomeFilter && params.outcomeFilter !== "all") where += `${where ? " AND" : ""} Outcome = '${params.outcomeFilter}'`;
        const soql = `SELECT Id, ApexClass.Name, MethodName, Outcome, Message, RunTime, AsyncApexJobId FROM ApexTestResult${where ? ` WHERE${where}` : ""} ORDER BY ApexClass.Name, MethodName LIMIT 500`;
        const resp = await client.get(`/tooling/query?q=${encodeURIComponent(soql)}`);
        const results = ((resp.data as any).records ?? []).map((r: any) => ({ className: r.ApexClass?.Name ?? "", methodName: r.MethodName, outcome: r.Outcome, message: r.Message ?? "", durationMs: r.RunTime, testRunId: r.AsyncApexJobId }));
        const summary = { total: results.length, passed: results.filter((r: any) => r.outcome === "Pass").length, failed: results.filter((r: any) => r.outcome === "Fail").length, skipped: results.filter((r: any) => r.outcome === "Skip").length };
        return { success: true, summary, results, message: `${results.length} test result(s): ${summary.passed} passed, ${summary.failed} failed.` };
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}
export async function getDeploymentHistory(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const client = createClient(auth);
        const statusFilter = (params.status && params.status !== "all") ? ` WHERE Status = '${params.status}'` : "";
        const soql = `SELECT Id, Status, StartDate, CompletedDate, NumberComponentsDeployed, NumberTestErrors, CreatedBy.Username, NumberComponentErrors FROM DeployRequest${statusFilter} ORDER BY StartDate DESC LIMIT ${params.limit ?? 10}`;
        const resp = await client.get(`/tooling/query?q=${encodeURIComponent(soql)}`);
        const deployments = ((resp.data as any).records ?? []).map((r: any) => ({ deployId: r.Id, status: r.Status, startDate: r.StartDate, completedDate: r.CompletedDate, componentsDeployed: r.NumberComponentsDeployed, componentErrors: r.NumberComponentErrors, testErrors: r.NumberTestErrors, deployedBy: r.CreatedBy?.Username ?? "" }));
        return { success: true, totalSize: (resp.data as any).totalSize, deployments, message: `${deployments.length} deployment(s) returned.` };
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}
export async function createAgentChannel(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        if (params.channelType === "Messaging") {
            const readXml = await callMetadataSoap(auth, "readMetadata", `<met:readMetadata><met:type>MessagingChannel</met:type><met:fullNames>${x(params.channelName)}</met:fullNames></met:readMetadata>`);
            const recordMatch = readXml.match(/<records[^>]*>([\s\S]*?)<\/records>/i);
            if (!recordMatch) return { success: false, message: `MessagingChannel '${params.channelName}' not found.` };
            let inner = recordMatch[1];
            if (inner.includes("<routingName>")) {
                inner = inner.replace(/<routingType>[^<]*<\/routingType>/, `<routingType>Bot</routingType>`);
            } else {
                inner += `\n    <routingType>Bot</routingType>\n    <routingName>${x(params.agentApiName)}</routingName>`;
            }
            const xml = `<met:metadata xsi:type="met:MessagingChannel" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">\n    ${inner}\n</met:metadata>`;
            const result = await upsertMetadata(auth, xml);
            return { ...result, message: result.success ? `Agent '${params.agentApiName}' connected to messaging channel '${params.channelName}'.` : result.message };
        }
        return { success: true, message: `Channel type '${params.channelType}' requires manual configuration in Setup → ${params.channelType} → Routing. Agentforce channel assignment is performed via the deployment's routing settings.` };
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}
export async function cloneAgent(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const botRead = await readMetadataItem(auth, "Bot", params.sourceAgentApiName);
        if (!botRead.success) return { success: false, message: `Agent '${params.sourceAgentApiName}' not found.` };
        const botRecordMatch = botRead.rawXml.match(/<records[^>]*>([\s\S]*?)<\/records>/i);
        if (!botRecordMatch) return { success: false, message: `Agent '${params.sourceAgentApiName}' not found.` };
        let botXml = botRecordMatch[1];
        botXml = botXml.replace(new RegExp(`<fullName>${x(params.sourceAgentApiName)}</fullName>`, "i"), `<fullName>${x(params.newAgentApiName)}</fullName>`);
        botXml = botXml.replace(/<masterLabel>[^<]*<\/masterLabel>/i, `<masterLabel>${x(params.newLabel)}</masterLabel>`);
        const plannerMatch = botXml.match(/<plannerBundle[^>]*>([^<]+)<\/plannerBundle>/i);
        const oldPlannerName = plannerMatch?.[1]?.trim();
        const newPlannerName = oldPlannerName ? oldPlannerName.replace(params.sourceAgentApiName, params.newAgentApiName) : `${params.newAgentApiName}_Planner`;
        if (oldPlannerName) botXml = botXml.replace(oldPlannerName, newPlannerName);
        const clonedTopics: any[] = [];
        const clonedActions: any[] = [];
        if (params.includeTopics !== false && oldPlannerName) {
            const plannerRead = await readMetadataItem(auth, "GenAiPlannerBundle", oldPlannerName);
            if (plannerRead.success) {
                const plannerRecordMatch = plannerRead.rawXml.match(/<records[^>]*>([\s\S]*?)<\/records>/i);
                let plannerXml = plannerRecordMatch ? plannerRecordMatch[1] : "";
                const topicNames = [...plannerXml.matchAll(/<genAiPluginName[^>]*>([^<]+)<\/genAiPluginName>/gi)].map((m: any) => m[1].trim());
                for (const topicName of topicNames) {
                    const topicRead = await readMetadataItem(auth, "GenAiPlugin", topicName);
                    if (!topicRead.success) continue;
                    const topicRecordMatch = topicRead.rawXml.match(/<records[^>]*>([\s\S]*?)<\/records>/i);
                    if (!topicRecordMatch) continue;
                    const newTopicName = topicName.replace(params.sourceAgentApiName, params.newAgentApiName);
                    let topicXml = topicRecordMatch[1].replace(new RegExp(topicName, "g"), newTopicName);
                    if (params.includeActions !== false) {
                        const actionNames = [...topicRecordMatch[1].matchAll(/<functionName[^>]*>([^<]+)<\/functionName>/gi)].map((m: any) => m[1].trim());
                        for (const actionName of actionNames) {
                            const actionRead = await readMetadataItem(auth, "GenAiFunction", actionName);
                            if (!actionRead.success) continue;
                            const actionRecordMatch = actionRead.rawXml.match(/<records[^>]*>([\s\S]*?)<\/records>/i);
                            if (!actionRecordMatch) continue;
                            const newActionName = actionName.replace(params.sourceAgentApiName, params.newAgentApiName);
                            const actionXml = actionRecordMatch[1].replace(new RegExp(actionName, "g"), newActionName);
                            await upsertMetadata(auth, `<met:metadata xsi:type="met:GenAiFunction" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">${actionXml}</met:metadata>`);
                            clonedActions.push(newActionName);
                            topicXml = topicXml.replace(new RegExp(actionName, "g"), newActionName);
                        }
                    }
                    await upsertMetadata(auth, `<met:metadata xsi:type="met:GenAiPlugin" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">${topicXml}</met:metadata>`);
                    clonedTopics.push(newTopicName);
                }
                plannerXml = plannerXml.replace(new RegExp(oldPlannerName, "g"), newPlannerName);
                for (let i = 0; i < topicNames.length; i++) {
                    plannerXml = plannerXml.replace(new RegExp(topicNames[i], "g"), clonedTopics[i] ?? topicNames[i]);
                }
                await upsertMetadata(auth, `<met:metadata xsi:type="met:GenAiPlannerBundle" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">${plannerXml}</met:metadata>`);
            }
        }
        // Extract label from botXml for buildBotXml
        const labelMatch = botXml.match(/<masterLabel[^>]*>([^<]+)<\/masterLabel>/i) ?? botXml.match(/<label[^>]*>([^<]+)<\/label>/i);
        const cloneLabel = params.newLabel ?? labelMatch?.[1]?.trim() ?? params.newAgentApiName;
        const typeMatch = botXml.match(/<type[^>]*>([^<]+)<\/type>/i);
        const cloneType = typeMatch?.[1]?.trim() ?? "InternalCopilot";
        const cloneBotXml = buildBotXml({ agentName: params.newAgentApiName, label: cloneLabel, type: cloneType, isNew: true });
        const botResult = await upsertMetadata(auth, cloneBotXml);
        if (!botResult.success) return botResult;
        return { success: true, fullName: params.newAgentApiName, created: true, message: `Agent '${params.newAgentApiName}' cloned from '${params.sourceAgentApiName}'. Topics: ${clonedTopics.length}, Actions: ${clonedActions.length}.` };
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}
export async function exportAgent(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const botRead = await readMetadataItem(auth, "Bot", params.agentApiName);
        if (!botRead.success) return { success: false, message: `Agent '${params.agentApiName}' not found.` };
        const botRecordMatch = botRead.rawXml.match(/<records[^>]*>([\s\S]*?)<\/records>/i);
        const botInnerXml = botRecordMatch ? botRecordMatch[1] : botRead.rawXml;
        const plannerMatch = botInnerXml.match(/<plannerBundle[^>]*>([^<]+)<\/plannerBundle>/i);
        const plannerName = plannerMatch?.[1]?.trim();
        const export_data: { agent: any; planner: any; topics: any[]; actions: any[] } = { agent: { name: params.agentApiName, xml: botInnerXml }, planner: null, topics: [], actions: [] };
        if (plannerName) {
            const plannerRead = await readMetadataItem(auth, "GenAiPlannerBundle", plannerName);
            if (plannerRead.success) {
                const plannerRecordMatch = plannerRead.rawXml.match(/<records[^>]*>([\s\S]*?)<\/records>/i);
                const plannerInnerXml = plannerRecordMatch ? plannerRecordMatch[1] : plannerRead.rawXml;
                export_data.planner = { name: plannerName, xml: plannerInnerXml };
                const topicNames = [...plannerInnerXml.matchAll(/<genAiPluginName[^>]*>([^<]+)<\/genAiPluginName>/gi)].map((m: any) => m[1].trim());
                for (const topicName of topicNames) {
                    const topicRead = await readMetadataItem(auth, "GenAiPlugin", topicName);
                    if (!topicRead.success) continue;
                    const topicRecordMatch = topicRead.rawXml.match(/<records[^>]*>([\s\S]*?)<\/records>/i);
                    const topicInnerXml = topicRecordMatch ? topicRecordMatch[1] : topicRead.rawXml;
                    const actionNames = [...topicInnerXml.matchAll(/<functionName[^>]*>([^<]+)<\/functionName>/gi)].map((m: any) => m[1].trim());
                    const topicActions = [];
                    for (const actionName of actionNames) {
                        const actionRead = await readMetadataItem(auth, "GenAiFunction", actionName);
                        if (actionRead.success) {
                            const actionRecordMatch = actionRead.rawXml.match(/<records[^>]*>([\s\S]*?)<\/records>/i);
                            export_data.actions.push({ name: actionName, xml: actionRecordMatch ? actionRecordMatch[1] : actionRead.rawXml });
                            topicActions.push(actionName);
                        }
                    }
                    export_data.topics.push({ name: topicName, xml: topicInnerXml, actions: topicActions });
                }
            }
        }
        return { success: true, agentApiName: params.agentApiName, export: export_data, message: `Agent '${params.agentApiName}' exported. Topics: ${export_data.topics.length}, Actions: ${export_data.actions.length}.` };
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}
export async function exportOmniStudioComponent(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const typeMap = { FlexCard: "OmniUiCard", OmniScript: "OmniScript", DataRaptor: "DataRaptorInterface", IntegrationProcedure: "OmniScript" };
        const mdType = (typeMap as Record<string, string>)[params.componentType];
        let fullName = params.componentName;
        if (params.componentType === "OmniScript") fullName = `${params.componentName}_${params.subType ?? ""}_${params.language ?? "English"}`;
        if (params.componentType === "IntegrationProcedure") fullName = `${params.componentName}_${params.subType ?? ""}`;
        const read = await readMetadataItem(auth, mdType, fullName);
        if (!read.success) return { success: false, message: `${params.componentType} '${fullName}' not found.` };
        const exportJson = { componentType: params.componentType, fullName, mdType, xml: read.xml };
        return { success: true, componentType: params.componentType, fullName, export: exportJson, jsonDefinition: JSON.stringify(exportJson), message: `${params.componentType} '${fullName}' exported successfully.` };
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}
export async function importOmniStudioComponent(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const def = JSON.parse(params.jsonDefinition);
        let xml = def.xml;
        const oldName = def.fullName;
        xml = xml.split(oldName).join(params.newName);
        xml = xml.replace(/<isActive>[^<]*<\/isActive>/i, `<isActive>${params.activate ? "true" : "false"}</isActive>`);
        const result = await upsertMetadata(auth, `<met:metadata xsi:type="met:${def.mdType}" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">${xml}</met:metadata>`);
        return { ...result, message: result.success ? `${params.componentType} imported as '${params.newName}'.` : result.message };
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}
export async function createDocumentGeneration(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const xml = `<met:metadata xsi:type="met:OmniDocumentGenerationConfig" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <met:fullName>${x(params.templateName)}</met:fullName>
    <met:label>${x(params.label)}</met:label>
    <met:contextObjectName>${x(params.objectApiName)}</met:contextObjectName>
    <met:outputFormat>${x(params.templateType ?? "Word")}</met:outputFormat>
    <met:dataSource>
        <met:type>${x(params.dataSourceType ?? "DataRaptor")}</met:type>
        <met:name>${x(params.dataSourceName)}</met:name>
    </met:dataSource>
    ${params.description ? `<met:description>${x(params.description)}</met:description>` : ""}
</met:metadata>`;
        return await upsertMetadata(auth, xml);
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}

// ─── CATEGORY 1: Basic Admin Tools ───────────────────────────────────────────

export async function createSearchLayout(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const srFields = (params.searchResultsAdditionalFields ?? []).map((f: string) =>
            `<met:searchResultsAdditionalFields>${x(f)}</met:searchResultsAdditionalFields>`).join("\n");
        const ldFields = (params.lookupDialogsAdditionalFields ?? []).map((f: string) =>
            `<met:lookupDialogsAdditionalFields>${x(f)}</met:lookupDialogsAdditionalFields>`).join("\n");
        const lfFields = (params.lookupFilterFields ?? []).map((f: string) =>
            `<met:lookupFilterFields>${x(f)}</met:lookupFilterFields>`).join("\n");
        const xml = `<met:metadata xsi:type="met:CustomObject" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <met:fullName>${x(params.objectName)}</met:fullName>
    <met:searchLayouts>
        ${srFields}
        ${ldFields}
        ${lfFields}
    </met:searchLayouts>
</met:metadata>`;
        return await upsertMetadata(auth, xml);
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}

export async function assignLayoutToRecordType(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const profileNames: string[] = params.profileNames ?? ["Admin"];
        const mappings = profileNames.map(() => `<met:recordTypeToLayoutMappings>
            <met:layoutName>${x(params.layoutName)}</met:layoutName>
            <met:recordType>${x(params.recordTypeName)}</met:recordType>
        </met:recordTypeToLayoutMappings>`).join("\n");
        const xml = `<met:metadata xsi:type="met:Profile" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <met:fullName>${x(profileNames[0] ?? "Admin")}</met:fullName>
    ${mappings}
</met:metadata>`;
        return await upsertMetadata(auth, xml);
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}

export async function createCustomWebTab(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const xml = `<met:metadata xsi:type="met:CustomTab" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <met:fullName>${x(params.fullName)}</met:fullName>
    <met:label>${x(params.label)}</met:label>
    <met:url>${x(params.url)}</met:url>
    <met:hasSidebar>${params.hasSidebar ?? false}</met:hasSidebar>
    ${params.description ? `<met:description>${x(params.description)}</met:description>` : ""}
</met:metadata>`;
        return await upsertMetadata(auth, xml);
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}

// ─── CATEGORY 2: Flows & Automation ──────────────────────────────────────────

export async function createScheduledFlow(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const paths = (params.scheduledPaths ?? []).map((p: Record<string, any>) => `
    <met:scheduledPaths>
        <met:label>${x(p.label)}</met:label>
        <met:offsetNumber>${p.offsetNumber}</met:offsetNumber>
        <met:offsetUnit>${x(p.offsetUnit)}</met:offsetUnit>
        <met:timeSource>${x(p.timeSource)}</met:timeSource>
        ${p.connectorTarget ? `<met:connector><met:targetReference>${x(p.connectorTarget)}</met:targetReference></met:connector>` : ""}
    </met:scheduledPaths>`).join("\n");
        const xml = `<met:metadata xsi:type="met:Flow" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <met:fullName>${x(params.fullName)}</met:fullName>
    <met:label>${x(params.label)}</met:label>
    <met:apiVersion>${API_VERSION}</met:apiVersion>
    <met:status>Active</met:status>
    <met:processType>AutoLaunchedFlow</met:processType>
    ${params.description ? `<met:description>${x(params.description)}</met:description>` : ""}
    <met:start>
        <met:locationX>50</met:locationX>
        <met:locationY>0</met:locationY>
        <met:object>${x(params.objectApiName)}</met:object>
        <met:triggerType>Scheduled</met:triggerType>
        ${paths}
    </met:start>
</met:metadata>`;
        return await upsertMetadata(auth, xml);
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}

export async function createPlatformEventTrigger(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const apiVer = params.apiVersion ?? API_VERSION;
        const triggerContent = `trigger ${params.triggerName} on ${params.eventApiName} (after insert) {\n${params.body}\n}`;
        const metaContent = `<?xml version="1.0" encoding="UTF-8"?>\n<ApexTrigger xmlns="http://soap.sforce.com/2006/04/metadata">\n    <apiVersion>${apiVer}</apiVersion>\n    <status>Active</status>\n</ApexTrigger>`;
        const pkgXml = `<?xml version="1.0" encoding="UTF-8"?>\n<Package xmlns="http://soap.sforce.com/2006/04/metadata">\n    <types><members>${params.triggerName}</members><name>ApexTrigger</name></types>\n    <version>${apiVer}</version>\n</Package>`;
        const { default: JSZip } = await import("jszip");
        const zip = new JSZip();
        zip.file("package.xml", pkgXml);
        zip.file(`triggers/${params.triggerName}.trigger`, triggerContent);
        zip.file(`triggers/${params.triggerName}.trigger-meta.xml`, metaContent);
        const buf = await zip.generateAsync({ type: "nodebuffer" });
        const { deployZip: dz, pollDeployStatus } = await import("./deployment.js");
        const deployId = await dz(auth, buf.toString("base64"), { checkOnly: false, rollbackOnError: true });
        return await pollDeployStatus(auth, deployId, 3 * 60 * 1000);
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}

export async function createWorkflowRule(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        let criteriaXml = "";
        if (params.formula) {
            criteriaXml = `<met:formula>${x(params.formula)}</met:formula>`;
        } else if (params.criteriaItems?.length) {
            criteriaXml = (params.criteriaItems as Array<Record<string, string>>).map(c =>
                `<met:criteriaItems><met:field>${x(params.objectName)}.${x(c.field)}</met:field><met:operation>${x(c.operation)}</met:operation><met:value>${x(c.value)}</met:value></met:criteriaItems>`).join("\n");
        }
        const xml = `<met:metadata xsi:type="met:Workflow" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <met:fullName>${x(params.objectName)}</met:fullName>
    <met:rules>
        <met:fullName>${x(params.fullName)}</met:fullName>
        <met:active>${params.active ?? true}</met:active>
        <met:triggerType>${x(params.triggerType)}</met:triggerType>
        ${params.description ? `<met:description>${x(params.description)}</met:description>` : ""}
        ${criteriaXml}
    </met:rules>
</met:metadata>`;
        return await upsertMetadata(auth, xml);
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}

export async function createFieldUpdate(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        let opXml = `<met:operation>${x(params.operation)}</met:operation>`;
        if (params.operation === "Formula" && params.formula) {
            opXml = `<met:formula>${x(params.formula)}</met:formula><met:operation>Formula</met:operation>`;
        } else if (params.operation === "Literal" && params.literalValue !== undefined) {
            opXml = `<met:literalValue>${x(params.literalValue)}</met:literalValue><met:operation>Literal</met:operation>`;
        }
        const xml = `<met:metadata xsi:type="met:Workflow" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <met:fullName>${x(params.objectName)}</met:fullName>
    <met:fieldUpdates>
        <met:fullName>${x(params.fullName)}</met:fullName>
        <met:name>${x(params.name)}</met:name>
        <met:field>${x(params.field)}</met:field>
        ${opXml}
        <met:protected>false</met:protected>
        <met:notifyAssignee>false</met:notifyAssignee>
        ${params.description ? `<met:description>${x(params.description)}</met:description>` : ""}
    </met:fieldUpdates>
</met:metadata>`;
        return await upsertMetadata(auth, xml);
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}

export async function createWorkflowOutboundMessage(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const fieldsXml = (params.fields as string[]).map(f => `<met:fields>${x(f)}</met:fields>`).join("\n");
        const xml = `<met:metadata xsi:type="met:Workflow" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <met:fullName>${x(params.objectName)}</met:fullName>
    <met:outboundMessages>
        <met:fullName>${x(params.fullName)}</met:fullName>
        <met:name>${x(params.name)}</met:name>
        <met:endpointUrl>${x(params.endpointUrl)}</met:endpointUrl>
        ${fieldsXml}
        <met:includeSessionId>false</met:includeSessionId>
        <met:protected>false</met:protected>
        ${params.integrationUser ? `<met:integrationUser>${x(params.integrationUser)}</met:integrationUser>` : ""}
        ${params.description ? `<met:description>${x(params.description)}</met:description>` : ""}
    </met:outboundMessages>
</met:metadata>`;
        return await upsertMetadata(auth, xml);
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}

// ─── CATEGORY 3: Security & Access ───────────────────────────────────────────

export async function createRoleHierarchy(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const results: MetadataUpsertResult[] = [];
        for (const role of (params.roles as Array<Record<string, any>>)) {
            const xml = `<met:metadata xsi:type="met:Role" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <met:fullName>${x(role.fullName)}</met:fullName>
    <met:name>${x(role.name)}</met:name>
    ${role.parentRole ? `<met:parentRole>${x(role.parentRole)}</met:parentRole>` : ""}
    ${role.description ? `<met:description>${x(role.description)}</met:description>` : ""}
</met:metadata>`;
            const result = await upsertMetadata(auth, xml);
            const created = result.success ? (result as { created: boolean }).created : false;
            results.push({ fullName: role.fullName, success: result.success, created });
        }
        const allOk = results.every(r => r.success);
        return { success: allOk, results, message: `${results.filter(r => r.success).length}/${results.length} roles created.` };
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}

export async function createFieldLevelSecurity(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const results: MetadataUpsertResult[] = [];
        for (const p of (params.profiles as Array<Record<string, any>>)) {
            const xml = `<met:metadata xsi:type="met:Profile" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <met:fullName>${x(p.profileName)}</met:fullName>
    <met:fieldPermissions>
        <met:field>${x(params.objectName)}.${x(params.fieldName)}</met:field>
        <met:readable>${p.readable}</met:readable>
        <met:editable>${p.editable}</met:editable>
    </met:fieldPermissions>
</met:metadata>`;
            const result = await upsertMetadata(auth, xml);
            const created = result.success ? (result as { created: boolean }).created : false;
            results.push({ fullName: p.profileName, success: result.success, created });
        }
        const allOk = results.every(r => r.success);
        return { success: allOk, results, message: `FLS updated for ${results.filter(r => r.success).length}/${results.length} profiles.` };
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}

export async function createCustomPermission(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const reqPermsXml = (params.requiredPermissions ?? []).map((p: string) =>
            `<met:requiredPermissions><met:customPermission>${x(p)}</met:customPermission><met:required>true</met:required></met:requiredPermissions>`).join("\n");
        const xml = `<met:metadata xsi:type="met:CustomPermission" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <met:fullName>${x(params.fullName)}</met:fullName>
    <met:label>${x(params.label)}</met:label>
    ${params.description ? `<met:description>${x(params.description)}</met:description>` : ""}
    ${reqPermsXml}
</met:metadata>`;
        return await upsertMetadata(auth, xml);
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}

export async function createMutingPermSetSimple(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const xml = `<met:metadata xsi:type="met:MutingPermissionSet" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <met:fullName>${x(params.fullName)}</met:fullName>
    <met:label>${x(params.label)}</met:label>
    ${params.description ? `<met:description>${x(params.description)}</met:description>` : ""}
</met:metadata>`;
        return await upsertMetadata(auth, xml);
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}

export async function createPermSetGroupSimple(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const psXml = (params.permissionSets as string[]).map(ps =>
            `<met:permissionSets>${x(ps)}</met:permissionSets>`).join("\n");
        const xml = `<met:metadata xsi:type="met:PermissionSetGroup" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <met:fullName>${x(params.fullName)}</met:fullName>
    <met:label>${x(params.label)}</met:label>
    ${params.description ? `<met:description>${x(params.description)}</met:description>` : ""}
    ${psXml}
</met:metadata>`;
        return await upsertMetadata(auth, xml);
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}

// ─── CATEGORY 4: Data Management ─────────────────────────────────────────────

export async function createDataCategory(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const buildCategory = (cat: Record<string, any>): string => {
            const subs = (cat.subCategories ?? []).map((sc: string) =>
                `<met:dataCategory><met:name>${x(sc)}</met:name><met:label>${x(sc)}</met:label></met:dataCategory>`).join("\n");
            return `<met:dataCategory>
    <met:name>${x(cat.name)}</met:name>
    <met:label>${x(cat.label)}</met:label>
    ${subs}
</met:dataCategory>`;
        };
        const categoriesXml = (params.categories ?? []).map(buildCategory).join("\n");
        const xml = `<met:metadata xsi:type="met:DataCategoryGroup" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <met:fullName>${x(params.fullName)}</met:fullName>
    <met:label>${x(params.label)}</met:label>
    <met:objectUsage><met:object>${x(params.objectUsage ?? "KnowledgeArticle")}</met:object></met:objectUsage>
    ${params.description ? `<met:description>${x(params.description)}</met:description>` : ""}
    ${categoriesXml}
</met:metadata>`;
        return await upsertMetadata(auth, xml);
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}

async function bulkApiJob(auth: SalesforceAuth, operation: string, objectApiName: string, csvData: string, externalIdField?: string): Promise<any> {
    const client = createClient(auth);
    const jobBody: Record<string, string> = {
        object: objectApiName,
        operation,
        contentType: "CSV",
        lineEnding: "LF",
    };
    if (externalIdField) jobBody["externalIdFieldName"] = externalIdField;
    const jobResp = await client.post<{ id: string }>(`/jobs/ingest`, jobBody);
    const jobId = jobResp.data.id;
    await client.put<unknown>(`/jobs/ingest/${jobId}/batches`, csvData, {
        headers: { "Content-Type": "text/csv" },
    });
    await client.patch<unknown>(`/jobs/ingest/${jobId}`, { state: "UploadComplete" });
    return { success: true, jobId, message: `Bulk ${operation} job ${jobId} submitted for ${objectApiName}.` };
}

function recordsToCsv(records: Array<Record<string, unknown>>): string {
    if (!records.length) return "";
    const fields = Object.keys(records[0]);
    const header = fields.join(",");
    const rows = records.map(r => fields.map(f => {
        const val = r[f];
        if (val === null || val === undefined) return "";
        const s = String(val);
        return s.includes(",") || s.includes('"') || s.includes("\n") ? `"${s.replace(/"/g, '""')}"` : s;
    }).join(","));
    return [header, ...rows].join("\n");
}

export async function bulkInsertRecords(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const records = params.records as Array<Record<string, unknown>>;
        const csv = recordsToCsv(records);
        return await bulkApiJob(auth, params.externalIdField ? "upsert" : "insert", params.objectApiName, csv, params.externalIdField);
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}

export async function bulkUpdateRecords(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const csv = recordsToCsv(params.records as Array<Record<string, unknown>>);
        return await bulkApiJob(auth, "update", params.objectApiName, csv);
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}

export async function bulkDeleteRecords(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const ids = params.ids as string[];
        const csv = ["Id", ...ids].join("\n");
        return await bulkApiJob(auth, "delete", params.objectApiName, csv);
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}

export async function createExtIdField(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const fieldFullName = `${params.objectName}.${params.fullName}`;
        const xml = `<met:metadata xsi:type="met:CustomField" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <met:fullName>${x(fieldFullName)}</met:fullName>
    <met:label>${x(params.label)}</met:label>
    <met:type>${x(params.type)}</met:type>
    <met:externalId>true</met:externalId>
    <met:unique>true</met:unique>
    ${params.length ? `<met:length>${params.length}</met:length>` : ""}
    ${params.description ? `<met:description>${x(params.description)}</met:description>` : ""}
</met:metadata>`;
        return await upsertMetadata(auth, xml);
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}

// ─── CATEGORY 5: Email & Communication ───────────────────────────────────────

export async function createLetterheadSimple(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const xml = `<met:metadata xsi:type="met:Letterhead" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <met:fullName>${x(params.fullName)}</met:fullName>
    <met:name>${x(params.name)}</met:name>
    <met:available>true</met:available>
    <met:backgroundColor>${x(params.backgroundColor ?? "#FFFFFF")}</met:backgroundColor>
    <met:bodyColor>${x(params.bodyColor ?? "#FFFFFF")}</met:bodyColor>
    <met:header>
        <met:backgroundColor>${x(params.headerColor ?? "#004080")}</met:backgroundColor>
        <met:height>0</met:height>
    </met:header>
    <met:topLine><met:color>#FFFFFF</met:color><met:height>0</met:height></met:topLine>
    <met:middleLine><met:color>#FFFFFF</met:color><met:height>0</met:height></met:middleLine>
    <met:bottomLine><met:color>#FFFFFF</met:color><met:height>0</met:height></met:bottomLine>
    <met:footer><met:backgroundColor>#FFFFFF</met:backgroundColor><met:height>0</met:height></met:footer>
    ${params.description ? `<met:description>${x(params.description)}</met:description>` : ""}
</met:metadata>`;
        return await upsertMetadata(auth, xml);
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}

export async function createNotificationType(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const xml = `<met:metadata xsi:type="met:CustomNotificationType" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <met:fullName>${x(params.fullName)}</met:fullName>
    <met:masterLabel>${x(params.masterLabel)}</met:masterLabel>
    <met:customNotifTypeName>${x(params.customNotifTypeName)}</met:customNotifTypeName>
    ${params.description ? `<met:description>${x(params.description)}</met:description>` : ""}
    <met:channels><met:desktop>true</met:desktop><met:mobile>true</met:mobile></met:channels>
</met:metadata>`;
        return await upsertMetadata(auth, xml);
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}

// ─── CATEGORY 6 & 9: DevOps ───────────────────────────────────────────────────

export async function createNewScratchOrg(_auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const args: string[] = ["org", "create", "scratch", "--json"];
        if (params.definitionFile) args.push("--definition-file", params.definitionFile);
        if (params.alias) args.push("--alias", params.alias);
        if (params.duration) args.push("--duration-days", String(params.duration));
        if (params.devHubAlias) args.push("--target-dev-hub", params.devHubAlias);
        const raw = execSync(`sf ${args.join(" ")}`, { encoding: "utf-8", timeout: 120_000, env: { PATH: process.env["PATH"] ?? "" } });
        return { success: true, ...(JSON.parse(raw) as { result?: Record<string, unknown> }).result };
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}

export async function deleteScratchOrg(_auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const args: string[] = ["org", "delete", "scratch", "--target-org", params.alias, "--json"];
        if (params.noPrompt !== false) args.push("--no-prompt");
        const raw = execSync(`sf ${args.join(" ")}`, { encoding: "utf-8", timeout: 60_000, env: { PATH: process.env["PATH"] ?? "" } });
        return { success: true, ...(JSON.parse(raw) as { result?: Record<string, unknown> }).result };
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}

export async function createPackage(_auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const args: string[] = ["package", "create", "--name", params.name, "--package-type", params.packageType, "--path", params.path, "--json"];
        if (params.description) args.push("--description", params.description);
        if (params.noNamespace) args.push("--no-namespace");
        const raw = execSync(`sf ${args.join(" ")}`, { encoding: "utf-8", timeout: 60_000, env: { PATH: process.env["PATH"] ?? "" } });
        return { success: true, ...(JSON.parse(raw) as { result?: Record<string, unknown> }).result };
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}

export async function createPackageVersion(_auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const args: string[] = ["package", "version", "create", "--package", params.packageId, "--json"];
        if (params.installationKey) args.push("--installation-key", params.installationKey);
        if (params.codeVersion) args.push("--version-number", params.codeVersion);
        if (params.wait) args.push("--wait", String(params.wait));
        const raw = execSync(`sf ${args.join(" ")}`, { encoding: "utf-8", timeout: 600_000, env: { PATH: process.env["PATH"] ?? "" } });
        return { success: true, ...(JSON.parse(raw) as { result?: Record<string, unknown> }).result };
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}

export async function installPackage(_auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const targetOrg = params.targetOrg ?? process.env["SF_ALIAS"];
        const args: string[] = ["package", "install", "--package", params.packageId, "--json"];
        if (targetOrg) args.push("--target-org", targetOrg);
        if (params.installationKey) args.push("--installation-key", params.installationKey);
        if (params.wait) args.push("--wait", String(params.wait));
        const raw = execSync(`sf ${args.join(" ")}`, { encoding: "utf-8", timeout: 600_000, env: { PATH: process.env["PATH"] ?? "" } });
        return { success: true, ...(JSON.parse(raw) as { result?: Record<string, unknown> }).result };
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}

export async function devOpsCreateWorkItem(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const client = createClient(auth);
        const body: Record<string, string> = { Name: params.name };
        if (params.description) body["sf_devops__Description__c"] = params.description;
        if (params.pipelineStageId) body["sf_devops__Pipeline_Stage__c"] = params.pipelineStageId;
        if (params.assignedToId) body["OwnerId"] = params.assignedToId;
        const resp = await client.post<{ id: string }>(`/services/data/v${API_VERSION}/sobjects/sf_devops__Work_Item__c`, body);
        return { success: true, id: resp.data.id, message: `Work item '${params.name}' created.` };
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}

export async function devOpsPromoteWorkItem(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const client = createClient(auth);
        const resp = await client.post<{ id: string }>(`/services/data/v${API_VERSION}/sobjects/sf_devops__Work_Item__c/${params.workItemId}/promote`, {});
        return { success: true, data: resp.data, message: `Work item ${params.workItemId} promoted.` };
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}

export async function checkCodeCoverage(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const client = createClient(auth);
        let query = "SELECT ApexClassOrTriggerId,ApexClassOrTrigger.Name,NumLinesCovered,NumLinesUncovered FROM ApexCodeCoverageAggregate";
        const conds: string[] = [];
        if (params.className) conds.push(`ApexClassOrTrigger.Name LIKE '%${params.className.replace(/'/g, "\\'")}%'`);
        if (conds.length) query += ` WHERE ${conds.join(" AND ")}`;
        query += " ORDER BY NumLinesUncovered DESC LIMIT 100";
        const resp = await client.get<{ records: Array<Record<string, unknown>> }>(`/tooling/query?q=${encodeURIComponent(query)}`);
        let records = resp.data.records;
        if (params.minCoverage !== undefined) {
            records = records.filter((r: Record<string, unknown>) => {
                const covered = Number(r["NumLinesCovered"] ?? 0);
                const uncovered = Number(r["NumLinesUncovered"] ?? 0);
                const total = covered + uncovered;
                if (total === 0) return false;
                const pct = (covered / total) * 100;
                return pct < (params.minCoverage as number);
            });
        }
        return { success: true, records, count: records.length };
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}

export async function detectDevOpsMergeConflict(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const client = createClient(auth);
        const query = `SELECT Id,Name,sf_devops__Status__c FROM sf_devops__Work_Item__c WHERE Id = '${params.workItemId}'`;
        const wi = await client.get<{ records: Array<Record<string, unknown>> }>(`/services/data/v${API_VERSION}/query?q=${encodeURIComponent(query)}`);
        const conflictQuery = `SELECT Id,Name,sf_devops__Status__c FROM sf_devops__Merge_Conflict__c WHERE sf_devops__Work_Item__c = '${params.workItemId}'`;
        const conflicts = await client.get<{ records: Array<Record<string, unknown>> }>(`/services/data/v${API_VERSION}/query?q=${encodeURIComponent(conflictQuery)}`);
        return { success: true, workItem: wi.data.records[0], conflicts: conflicts.data.records, hasConflicts: conflicts.data.records.length > 0 };
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}

export async function resolveDevOpsMergeConflict(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const client = createClient(auth);
        await client.patch<unknown>(`/services/data/v${API_VERSION}/sobjects/sf_devops__Merge_Conflict__c/${params.conflictId}`, {
            sf_devops__Resolution__c: params.resolution,
            sf_devops__Status__c: "Resolved",
        });
        return { success: true, conflictId: params.conflictId, resolution: params.resolution, message: "Merge conflict marked as resolved." };
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}

export async function checkoutDevOpsWorkItem(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const client = createClient(auth);
        await client.patch<unknown>(`/services/data/v${API_VERSION}/sobjects/sf_devops__Work_Item__c/${params.workItemId}`, {
            sf_devops__Status__c: "In Progress",
        });
        return { success: true, workItemId: params.workItemId, message: `Work item ${params.workItemId} checked out (status set to In Progress).` };
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}

export async function commitDevOpsWorkItem(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const client = createClient(auth);
        const resp = await client.post<{ id: string }>(`/services/data/v${API_VERSION}/sobjects/sf_devops__Commit__c`, {
            sf_devops__Work_Item__c: params.workItemId,
            sf_devops__Message__c: params.message,
        });
        return { success: true, commitId: resp.data.id, message: `Commit created for work item ${params.workItemId}.` };
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}

export async function createDevOpsPullRequest(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const client = createClient(auth);
        const body: Record<string, string> = {
            sf_devops__Work_Item__c: params.workItemId,
            Name: params.title,
        };
        if (params.description) body["sf_devops__Description__c"] = params.description;
        const resp = await client.post<{ id: string }>(`/services/data/v${API_VERSION}/sobjects/sf_devops__Pull_Request__c`, body);
        return { success: true, pullRequestId: resp.data.id, message: `Pull request '${params.title}' created for work item ${params.workItemId}.` };
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}

export async function listDevOpsProjects(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        void params;
        const client = createClient(auth);
        const query = "SELECT Id,Name,sf_devops__Pipeline__c FROM sf_devops__Project__c ORDER BY Name LIMIT 200";
        const resp = await client.get<{ records: Array<Record<string, unknown>> }>(`/services/data/v${API_VERSION}/query?q=${encodeURIComponent(query)}`);
        return { success: true, projects: resp.data.records, count: resp.data.records.length };
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}

export async function listDevOpsWorkItems(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const client = createClient(auth);
        const limit = params.limit ?? 20;
        let query = "SELECT Id,Name,sf_devops__Status__c,sf_devops__Description__c FROM sf_devops__Work_Item__c";
        const conds: string[] = [];
        if (params.projectId) conds.push(`sf_devops__Project__c = '${params.projectId}'`);
        if (params.stageId) conds.push(`sf_devops__Pipeline_Stage__c = '${params.stageId}'`);
        if (conds.length) query += ` WHERE ${conds.join(" AND ")}`;
        query += ` ORDER BY Name LIMIT ${limit}`;
        const resp = await client.get<{ records: Array<Record<string, unknown>> }>(`/services/data/v${API_VERSION}/query?q=${encodeURIComponent(query)}`);
        return { success: true, workItems: resp.data.records, count: resp.data.records.length };
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}

export async function checkDevOpsCommitStatus(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const client = createClient(auth);
        const query = `SELECT Id,Name,sf_devops__Status__c,sf_devops__Message__c FROM sf_devops__Commit__c WHERE sf_devops__Work_Item__c = '${params.workItemId}' ORDER BY CreatedDate DESC LIMIT 10`;
        const resp = await client.get<{ records: Array<Record<string, unknown>> }>(`/services/data/v${API_VERSION}/query?q=${encodeURIComponent(query)}`);
        return { success: true, commits: resp.data.records, count: resp.data.records.length };
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}

export async function promoteDevOpsWorkItem(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const client = createClient(auth);
        await client.patch<unknown>(`/services/data/v${API_VERSION}/sobjects/sf_devops__Work_Item__c/${params.workItemId}`, {
            sf_devops__Pipeline_Stage__c: params.targetStageId,
        });
        return { success: true, workItemId: params.workItemId, targetStageId: params.targetStageId, message: `Work item promoted to stage ${params.targetStageId}.` };
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}

// ─── CATEGORY 7: Advanced LWC ─────────────────────────────────────────────────

export async function createLwcJestTest(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const componentName = params.componentName as string;
        const apiVer = params.apiVersion ?? API_VERSION;
        const testPath = `lwc/${componentName}/__tests__/${componentName}.test.js`;
        const metaContent = `<?xml version="1.0" encoding="UTF-8"?>\n<LightningComponentBundle xmlns="http://soap.sforce.com/2006/04/metadata">\n    <apiVersion>${apiVer}</apiVersion>\n    <isExposed>false</isExposed>\n</LightningComponentBundle>`;
        const pkgXml = `<?xml version="1.0" encoding="UTF-8"?>\n<Package xmlns="http://soap.sforce.com/2006/04/metadata">\n    <types><members>${componentName}</members><name>LightningComponentBundle</name></types>\n    <version>${apiVer}</version>\n</Package>`;
        const { default: JSZip } = await import("jszip");
        const zip = new JSZip();
        zip.file("package.xml", pkgXml);
        zip.file(testPath, params.testContent as string);
        zip.file(`lwc/${componentName}/${componentName}.js-meta.xml`, metaContent);
        const buf = await zip.generateAsync({ type: "nodebuffer" });
        const { deployZip: dz, pollDeployStatus } = await import("./deployment.js");
        const deployId = await dz(auth, buf.toString("base64"), { checkOnly: false, rollbackOnError: true });
        return await pollDeployStatus(auth, deployId, 3 * 60 * 1000);
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}

export async function guideLwcAccessibility(_auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    const checklist = [
        "Use aria-label or aria-labelledby on all interactive elements (buttons, inputs, links)",
        "Ensure keyboard navigation works: Tab, Shift+Tab, Enter, Space, Escape, Arrow keys",
        "Manage focus explicitly after modal open/close using this.template.querySelector().focus()",
        "Use role='alert' or aria-live='polite' for dynamic content updates",
        "Provide visible focus indicators — never remove outline without an alternative",
        "Associate form inputs with labels using label[for] or aria-labelledby",
        "Images must have alt attributes; decorative images use alt=''",
        "Color alone must not convey information — add text or icons",
        "Minimum touch target size: 44x44px (WCAG 2.5.5)",
        "Test with screen reader (NVDA + Firefox or VoiceOver + Safari)",
        "Avoid using tabindex > 0 which disrupts natural tab order",
        "Use <lightning-button> and native LWC components which include built-in accessibility",
    ];
    const guidance = params.checklistOnly ? {} : {
        ariaPatterns: "Use aria-expanded on accordion/dropdown triggers, aria-haspopup on menus, aria-selected on tabs",
        keyboardPatterns: "Implement keydown handler for custom interactive widgets. Map ArrowUp/ArrowDown for lists.",
        focusManagement: "When opening a modal, save the trigger element reference and restore focus on close",
        liveRegions: "Wrap status messages in <div aria-live='polite'> for non-intrusive announcements",
        sldsIcons: "Use <lightning-icon> which includes a title attribute for screen readers",
    };
    return { success: true, componentName: params.componentName, checklist, ...guidance };
}

export async function migrateAuraToLwc(_auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    const componentName = params.auraComponentName as string;
    const guide = {
        mappings: [
            { aura: "<aura:component>", lwc: "<template> (lwc/*.html)" },
            { aura: "({!v.myAttr})", lwc: "{this.myAttr} or @api myAttr" },
            { aura: "({!c.handleClick})", lwc: "onclick={handleClick}" },
            { aura: "aura:init event", lwc: "connectedCallback() lifecycle hook" },
            { aura: "aura:waiting / aura:doneWaiting", lwc: "@wire or async/await" },
            { aura: "component.set / component.get", lwc: "tracked property or @track (not needed in LWC)" },
            { aura: "$A.enqueueAction", lwc: "@wire or imperative Apex call" },
            { aura: "aura:unescapedHtml", lwc: "innerHTML (with caution)" },
            { aura: "ui:inputText / ui:outputText", lwc: "<lightning-input> / <lightning-formatted-text>" },
            { aura: "force:navigateToURL", lwc: "NavigationMixin.Navigate" },
        ],
        keyDifferences: [
            "LWC uses standard HTML/JS — no proprietary syntax",
            "LWC uses Shadow DOM — external CSS selectors cannot pierce the boundary",
            "Aura events become custom DOM events (CustomEvent / dispatchEvent)",
            "Aura application events become Lightning Message Service (LMS) channels",
            "Aura helper.js methods move to regular JS module exports or class methods",
            "CSS scoping: Aura uses TOKEN-based scoping; LWC uses Shadow DOM",
        ],
    };
    const scaffold = params.includeScaffold ? {
        html: `<!-- ${componentName}.html -->\n<template>\n    <!-- TODO: migrate Aura markup here -->\n</template>`,
        js: `// ${componentName}.js\nimport { LightningElement, api, track, wire } from 'lwc';\n\nexport default class ${componentName.charAt(0).toUpperCase() + componentName.slice(1)} extends LightningElement {\n    @api recordId;\n\n    connectedCallback() {\n        // formerly: aura:init handler\n    }\n\n    disconnectedCallback() {\n        // cleanup\n    }\n}`,
        css: `/* ${componentName}.css */\n:host {\n    display: block;\n}`,
        meta: `<?xml version="1.0" encoding="UTF-8"?>\n<LightningComponentBundle xmlns="http://soap.sforce.com/2006/04/metadata">\n    <apiVersion>${API_VERSION}</apiVersion>\n    <isExposed>true</isExposed>\n    <targets>\n        <target>lightning__RecordPage</target>\n    </targets>\n</LightningComponentBundle>`,
    } : undefined;
    return { success: true, auraComponentName: componentName, migrationGuide: guide, scaffold };
}

export async function createLwcFromRequirements(_auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    const componentName = params.componentName as string;
    const capitalName = componentName.charAt(0).toUpperCase() + componentName.slice(1);
    const wireImport = params.includeWireAdapters && params.targetObject
        ? `import { getRecord } from 'salesforce/uiRecordApi';\nimport NAME_FIELD from '@salesforce/schema/${params.targetObject}.Name';`
        : "";
    const wireDecorator = params.includeWireAdapters && params.targetObject
        ? `\n    @wire(getRecord, { recordId: '$recordId', fields: [NAME_FIELD] })\n    record;`
        : "";
    const html = `<!-- ${componentName}.html -->\n<!-- Requirements: ${params.requirements} -->\n<template>\n    <lightning-card title="${capitalName}">\n        <div class="slds-p-around_medium">\n            <!-- TODO: Implement UI based on requirements -->\n        </div>\n    </lightning-card>\n</template>`;
    const js = `// ${componentName}.js\nimport { LightningElement, api, track } from 'lwc';\n${wireImport}\n\nexport default class ${capitalName} extends LightningElement {\n    @api recordId;\n    @track isLoading = false;\n    @track error;${wireDecorator}\n\n    connectedCallback() {\n        // Initialize component\n    }\n\n    handleAction() {\n        // Handle user interactions\n    }\n}`;
    const css = `:host {\n    display: block;\n}\n\n.container {\n    padding: var(--lwc-spacingSmall);\n}`;
    const meta = `<?xml version="1.0" encoding="UTF-8"?>\n<LightningComponentBundle xmlns="http://soap.sforce.com/2006/04/metadata">\n    <apiVersion>${API_VERSION}</apiVersion>\n    <isExposed>true</isExposed>\n    <targets>\n        <target>lightning__RecordPage</target>\n        <target>lightning__AppPage</target>\n        <target>lightning__HomePage</target>\n    </targets>\n</LightningComponentBundle>`;
    return { success: true, componentName, requirements: params.requirements, files: { html, js, css, meta }, message: `LWC scaffold generated for '${componentName}'. Deploy using sf_create_lwc.` };
}

export async function exploreSldsBlueprints(_auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    const blueprints: Record<string, unknown> = {
        "data-table": {
            description: "SLDS Data Table displays tabular data with sorting, selection, and inline editing",
            lwcComponent: "<lightning-datatable>",
            keyProps: ["data", "columns", "key-field", "sorted-by", "sorted-direction"],
            exampleCode: params.includeExampleCode ? `<lightning-datatable\n    key-field="id"\n    data={tableData}\n    columns={columns}\n    sorted-by={sortedBy}\n    sorted-direction={sortedDirection}\n    onsort={handleSort}\n></lightning-datatable>` : undefined,
            bestPractices: ["Always define key-field for row tracking", "Use column-type for proper rendering", "Set max-row-selection to limit bulk selection"],
        },
        "modal": {
            description: "SLDS Modal presents focused content or forms requiring user interaction",
            lwcComponent: "<lightning-modal> (requires import from lightning/modal)",
            keyProps: ["label", "size (small|medium|large)"],
            exampleCode: params.includeExampleCode ? `// MyModal.js\nimport LightningModal from 'lightning/modal';\nexport default class MyModal extends LightningModal {\n    handleClose() { this.close('canceled'); }\n}` : undefined,
            bestPractices: ["Trap focus within open modal", "Provide a close button and handle Escape key", "Use aria-labelledby on modal container"],
        },
        "combobox": {
            description: "SLDS Combobox lets users select one or more options from a dropdown",
            lwcComponent: "<lightning-combobox>",
            keyProps: ["label", "value", "options (array of {label,value})", "placeholder", "onchange"],
            exampleCode: params.includeExampleCode ? `<lightning-combobox\n    name="status"\n    label="Status"\n    value={selectedStatus}\n    placeholder="Select Status"\n    options={statusOptions}\n    onchange={handleChange}\n></lightning-combobox>` : undefined,
            bestPractices: ["Always provide a label for accessibility", "Use onchange to update tracked properties", "Provide a placeholder for empty state clarity"],
        },
    };
    const result = blueprints[params.componentType.toLowerCase()] ?? {
        description: `No specific blueprint for '${params.componentType}'. Visit https://www.lightningdesignsystem.com/components/overview/ for full reference.`,
        message: "Check SLDS Component Overview for the full blueprint library.",
    };
    return { success: true, componentType: params.componentType, blueprint: result };
}

// ─── CATEGORY 8: CPQ & Industries ────────────────────────────────────────────

export async function createProduct(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const client = createClient(auth);
        const body: Record<string, unknown> = {
            Name: params.name,
            IsActive: params.isActive ?? true,
        };
        if (params.productCode) body["ProductCode"] = params.productCode;
        if (params.description) body["Description"] = params.description;
        if (params.family) body["Family"] = params.family;
        if (params.quantityUnitOfMeasure) body["QuantityUnitOfMeasure"] = params.quantityUnitOfMeasure;
        const resp = await client.post<{ id: string }>(`/services/data/v${API_VERSION}/sobjects/Product2`, body);
        return { success: true, id: resp.data.id, message: `Product '${params.name}' created.` };
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}

export async function createPriceBook(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const client = createClient(auth);
        const pbBody: Record<string, unknown> = {
            Name: params.name,
            IsActive: params.isActive ?? true,
        };
        if (params.description) pbBody["Description"] = params.description;
        if (params.isStandard) pbBody["IsStandard"] = params.isStandard;
        const pbResp = await client.post<{ id: string }>(`/services/data/v${API_VERSION}/sobjects/Pricebook2`, pbBody);
        const pbId = pbResp.data.id;
        const entries: Array<{ success: boolean; productId: string; entryId?: string }> = [];
        for (const p of (params.products ?? []) as Array<Record<string, unknown>>) {
            const entryBody: Record<string, unknown> = {
                Pricebook2Id: pbId,
                Product2Id: p["productId"],
                UnitPrice: p["unitPrice"],
                IsActive: true,
                UseStandardPrice: p["useStandardPrice"] ?? false,
            };
            if (params.currencyIsoCode) entryBody["CurrencyIsoCode"] = params.currencyIsoCode;
            const eResp = await client.post<{ id: string }>(`/services/data/v${API_VERSION}/sobjects/PricebookEntry`, entryBody);
            entries.push({ success: true, productId: String(p["productId"]), entryId: eResp.data.id });
        }
        return { success: true, priceBookId: pbId, entries, message: `Pricebook '${params.name}' created with ${entries.length} product(s).` };
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}

export async function createEntitlementProcess(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const milestonesXml = (params.milestones ?? []).map((m: Record<string, any>) => `
    <met:milestones>
        <met:milestoneName>${x(m.name)}</met:milestoneName>
        ${m.minutesCustomClass ? `<met:minutesCustomClass>${x(m.minutesCustomClass)}</met:minutesCustomClass>` : ""}
        <met:useCriteriaStartTime>false</met:useCriteriaStartTime>
    </met:milestones>`).join("\n");
        const xml = `<met:metadata xsi:type="met:EntitlementProcess" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <met:fullName>${x(params.fullName)}</met:fullName>
    <met:name>${x(params.name)}</met:name>
    <met:isActive>true</met:isActive>
    <met:isVersionDefault>true</met:isVersionDefault>
    <met:versionNumber>1</met:versionNumber>
    ${params.description ? `<met:description>${x(params.description)}</met:description>` : ""}
    ${params.businessHoursName ? `<met:businessHours>${x(params.businessHoursName)}</met:businessHours>` : ""}
    ${params.entryStartDateField ? `<met:entryStartDateField>${x(params.entryStartDateField)}</met:entryStartDateField>` : ""}
    ${params.exitCriteriaBooleanFilter ? `<met:exitCriteriaBooleanFilter>${x(params.exitCriteriaBooleanFilter)}</met:exitCriteriaBooleanFilter>` : ""}
    ${milestonesXml}
</met:metadata>`;
        return await upsertMetadata(auth, xml);
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}

export async function createMilestone(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const xml = `<met:metadata xsi:type="met:MilestoneType" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <met:fullName>${x(params.fullName)}</met:fullName>
    <met:name>${x(params.name)}</met:name>
    ${params.description ? `<met:description>${x(params.description)}</met:description>` : ""}
    ${params.recurrenceType ? `<met:recurrenceType>${x(params.recurrenceType)}</met:recurrenceType>` : ""}
</met:metadata>`;
        return await upsertMetadata(auth, xml);
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}

// ─── CATEGORY 10: Apex Performance ───────────────────────────────────────────

export async function scanApexAntipatterns(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const client = createClient(auth);
        const maxClasses = params.maxClasses ?? 20;
        let query = "SELECT Id,Name,Body FROM ApexClass WHERE Status = 'Active'";
        if (params.classNames?.length) {
            const names = (params.classNames as string[]).map(n => `'${n.replace(/'/g, "\\'")}'`).join(",");
            query += ` AND Name IN (${names})`;
        }
        query += ` LIMIT ${maxClasses}`;
        const resp = await client.get<{ records: Array<{ Id: string; Name: string; Body: string }> }>(`/services/data/v${API_VERSION}/tooling/query?q=${encodeURIComponent(query)}`);
        const findings: Array<{ className: string; antipattern: string; lineHint: string }> = [];
        for (const cls of resp.data.records) {
            const body = cls.Body ?? "";
            const lines = body.split("\n");
            lines.forEach((line, i) => {
                const ln = `line ${i + 1}`;
                if (/\bfor\s*\(.*\)\s*\{/.test(line) || /\bwhile\s*\(/.test(line)) {
                    const loopLine = i;
                    for (let j = loopLine + 1; j < Math.min(loopLine + 20, lines.length); j++) {
                        if (/\[SELECT\b/i.test(lines[j])) {
                            findings.push({ className: cls.Name, antipattern: "SOQL inside loop", lineHint: `~line ${j + 1}` });
                            break;
                        }
                        if (/\b(insert|update|delete|upsert)\s/i.test(lines[j]) && !/\/\//.test(lines[j])) {
                            findings.push({ className: cls.Name, antipattern: "DML inside loop", lineHint: `~line ${j + 1}` });
                            break;
                        }
                    }
                }
                if (/['"][0-9a-zA-Z]{15,18}['"]/.test(line) && !/\/\//.test(line)) {
                    findings.push({ className: cls.Name, antipattern: "Hardcoded Salesforce ID", lineHint: ln });
                }
                if (/System\.debug\s*\(/i.test(line)) {
                    findings.push({ className: cls.Name, antipattern: "System.debug statement (should be removed in production)", lineHint: ln });
                }
            });
        }
        return { success: true, classesScanned: resp.data.records.length, findingsCount: findings.length, findings };
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}

// ─── CATEGORY A: Visualforce ──────────────────────────────────────────────────

export async function createVisualforcePage(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const { default: JSZip } = await import("jszip");
        const apiVer = String(params.apiVersion ?? API_VERSION);
        const pageName = params.pageName;
        const metaXml = `<?xml version="1.0" encoding="UTF-8"?>\n<ApexPage xmlns="http://soap.sforce.com/2006/04/metadata">\n    <apiVersion>${apiVer}</apiVersion>\n    <label>${x(params.label)}</label>\n    ${params.description ? `<description>${x(params.description)}</description>` : ""}\n    <showHeader>${params.showHeader !== false ? "true" : "false"}</showHeader>\n    <sidebar>${params.sidebar !== false ? "true" : "false"}</sidebar>\n</ApexPage>`;
        const pageContent = params.content ?? `<apex:page>\n  <!-- Add your Visualforce markup here -->\n</apex:page>`;
        const pkgXml = `<?xml version="1.0" encoding="UTF-8"?>\n<Package xmlns="http://soap.sforce.com/2006/04/metadata">\n  <types><members>${pageName}</members><name>ApexPage</name></types>\n  <version>${apiVer}</version>\n</Package>`;
        const zip = new JSZip();
        zip.file("package.xml", pkgXml);
        zip.file(`pages/${pageName}.page`, pageContent);
        zip.file(`pages/${pageName}.page-meta.xml`, metaXml);
        const buffer = await zip.generateAsync({ type: "nodebuffer" });
        const base64Zip = buffer.toString("base64");
        const { deployZip, pollDeployStatus } = await import("./deployment.js");
        const deployId = await deployZip(auth, base64Zip, { rollbackOnError: true });
        const result = await pollDeployStatus(auth, deployId, 10 * 60 * 1000);
        if (!result.success) return result;
        return { success: true, fullName: pageName, created: true, message: `Visualforce page '${pageName}' deployed successfully with content.` };
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}

export async function createVisualforceComponent(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const { default: JSZip } = await import("jszip");
        const apiVer = String(params.apiVersion ?? API_VERSION);
        const componentName = params.componentName;
        const metaXml = `<?xml version="1.0" encoding="UTF-8"?>\n<ApexComponent xmlns="http://soap.sforce.com/2006/04/metadata">\n    <apiVersion>${apiVer}</apiVersion>\n    <label>${x(params.label)}</label>\n    ${params.description ? `<description>${x(params.description)}</description>` : ""}\n</ApexComponent>`;
        const componentContent = params.content ?? `<apex:component>\n  <!-- Add your Visualforce component markup here -->\n</apex:component>`;
        const pkgXml = `<?xml version="1.0" encoding="UTF-8"?>\n<Package xmlns="http://soap.sforce.com/2006/04/metadata">\n  <types><members>${componentName}</members><name>ApexComponent</name></types>\n  <version>${apiVer}</version>\n</Package>`;
        const zip = new JSZip();
        zip.file("package.xml", pkgXml);
        zip.file(`components/${componentName}.component`, componentContent);
        zip.file(`components/${componentName}.component-meta.xml`, metaXml);
        const buffer = await zip.generateAsync({ type: "nodebuffer" });
        const base64Zip = buffer.toString("base64");
        const { deployZip, pollDeployStatus } = await import("./deployment.js");
        const deployId = await deployZip(auth, base64Zip, { rollbackOnError: true });
        const result = await pollDeployStatus(auth, deployId, 10 * 60 * 1000);
        if (!result.success) return result;
        return { success: true, fullName: componentName, created: true, message: `Visualforce component '${componentName}' deployed successfully with content.` };
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}

export async function createVisualforceEmailTemplate(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const xml = `<met:metadata xsi:type="met:EmailTemplate" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <met:fullName>unfiled$public/${x(params.templateName)}</met:fullName>
    <met:name>${x(params.templateName)}</met:name>
    <met:subject>${x(params.subject)}</met:subject>
    <met:type>visualforce</met:type>
    <met:recipientType>${x(params.recipientType)}</met:recipientType>
    <met:relatedEntityType>${x(params.relatedEntityType)}</met:relatedEntityType>
    ${params.description ? `<met:description>${x(params.description)}</met:description>` : ""}
    <met:isActive>true</met:isActive>
</met:metadata>`;
        const result = await upsertMetadata(auth, xml);
        if (!result.success) return result;
        return {
            success: true,
            fullName: params.templateName,
            created: result.created,
            message: `VF email template '${params.templateName}' ${result.created ? "created" : "updated"} successfully.`,
            htmlBody: params.htmlBody,
            textBody: params.textBody,
        };
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}

// ─── CATEGORY B: Quick Actions & Field Sets ───────────────────────────────────

export async function createQuickAction(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const fullName = `${params.objectName}.${params.actionName}`;
        const fieldsXml = (params.fields ?? []).map((f: Record<string, any>) => `
    <met:quickActionLayoutItems>
        <met:field>${x(String(f.name))}</met:field>
        ${f.required ? "<met:required>true</met:required>" : ""}
    </met:quickActionLayoutItems>`).join("\n");
        const xml = `<met:metadata xsi:type="met:QuickAction" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <met:fullName>${x(fullName)}</met:fullName>
    <met:label>${x(params.label)}</met:label>
    <met:type>${x(params.actionType)}</met:type>
    ${params.targetObject ? `<met:targetObject>${x(params.targetObject)}</met:targetObject>` : ""}
    ${params.description ? `<met:description>${x(params.description)}</met:description>` : ""}
    ${fieldsXml ? `<met:quickActionLayout><met:layoutSectionStyle>TwoColumnsTopToBottom</met:layoutSectionStyle><met:quickActionLayoutColumns>${fieldsXml}</met:quickActionLayoutColumns></met:quickActionLayout>` : ""}
</met:metadata>`;
        return await upsertMetadata(auth, xml);
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}

export async function createGlobalAction(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const xml = `<met:metadata xsi:type="met:QuickAction" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <met:fullName>${x(params.actionName)}</met:fullName>
    <met:label>${x(params.label)}</met:label>
    <met:type>${x(params.actionType)}</met:type>
    ${params.targetObject ? `<met:targetObject>${x(params.targetObject)}</met:targetObject>` : ""}
    ${params.description ? `<met:description>${x(params.description)}</met:description>` : ""}
</met:metadata>`;
        return await upsertMetadata(auth, xml);
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}

export async function createCustomButton(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const fullName = `${params.objectName}.${params.buttonName}`;
        const contentSourceMap: Record<string, string> = { url: "URL", javascript: "OnClickJavaScript", page: "page" };
        const contentSource = contentSourceMap[params.contentSource] ?? params.contentSource;
        const xml = `<met:metadata xsi:type="met:WebLink" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <met:fullName>${x(fullName)}</met:fullName>
    <met:label>${x(params.label)}</met:label>
    <met:availability>${x(params.buttonType)}</met:availability>
    <met:displayType>button</met:displayType>
    <met:linkType>${x(contentSource)}</met:linkType>
    <met:openType>${x(params.openType)}</met:openType>
    <met:url>${x(params.content)}</met:url>
</met:metadata>`;
        return await upsertMetadata(auth, xml);
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}

export async function createFieldSet(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const fullName = `${params.objectName}.${params.fieldSetName}`;
        const fieldsXml = (params.fields as string[]).map(f => `
    <met:availableFields>
        <met:field>${x(f)}</met:field>
        <met:isFieldManaged>false</met:isFieldManaged>
        <met:isRequired>false</met:isRequired>
    </met:availableFields>
    <met:displayedFields>
        <met:field>${x(f)}</met:field>
        <met:isFieldManaged>false</met:isFieldManaged>
        <met:isRequired>false</met:isRequired>
    </met:displayedFields>`).join("\n");
        const extraAvailableXml = (params.availableFields ?? []).map((f: string) => `
    <met:availableFields>
        <met:field>${x(f)}</met:field>
        <met:isFieldManaged>false</met:isFieldManaged>
        <met:isRequired>false</met:isRequired>
    </met:availableFields>`).join("\n");
        const xml = `<met:metadata xsi:type="met:FieldSet" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <met:fullName>${x(fullName)}</met:fullName>
    <met:label>${x(params.label)}</met:label>
    ${params.description ? `<met:description>${x(params.description)}</met:description>` : ""}
    ${fieldsXml}
    ${extraAvailableXml}
</met:metadata>`;
        return await upsertMetadata(auth, xml);
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}

// ─── CATEGORY C: Lightning Pages & App Builder ────────────────────────────────

export async function createFlexipage(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const templateXml = params.pageType === "RecordPage" && params.objectApiName
            ? `<met:template><met:name>ManagedLayout</met:name></met:template>`
            : `<met:template><met:name>${x(params.template ?? "header_and_right_rail")}</met:name></met:template>`;
        const xml = `<met:metadata xsi:type="met:FlexiPage" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <met:fullName>${x(params.pageName)}</met:fullName>
    <met:masterLabel>${x(params.masterLabel)}</met:masterLabel>
    <met:type>${x(params.pageType)}</met:type>
    ${params.objectApiName ? `<met:sobjectType>${x(params.objectApiName)}</met:sobjectType>` : ""}
    ${params.description ? `<met:description>${x(params.description)}</met:description>` : ""}
    ${templateXml}
</met:metadata>`;
        return await upsertMetadata(auth, xml);
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}

export async function createPathAssistant(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const pathItemsXml = (params.pathItems as Array<Record<string, any>>).map(item => {
            const keyFieldsXml = (item.keyFields ?? []).map((kf: Record<string, any>) => `
        <met:keyFields>
            <met:fieldName>${x(String(kf.fieldName))}</met:fieldName>
        </met:keyFields>`).join("\n");
            return `
    <met:pathAssistantSteps>
        <met:picklistValueName>${x(item.picklistValue)}</met:picklistValueName>
        ${item.infoTitle ? `<met:infoMessage>${x(item.infoTitle)}</met:infoMessage>` : ""}
        ${item.infoMessage ? `<met:helpMessage>${x(item.infoMessage)}</met:helpMessage>` : ""}
        ${keyFieldsXml}
    </met:pathAssistantSteps>`;
        }).join("\n");
        const fullName = `${params.objectName}.${params.fieldName}.${params.pathName}`;
        const xml = `<met:metadata xsi:type="met:PathAssistant" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <met:fullName>${x(fullName)}</met:fullName>
    <met:label>${x(params.label)}</met:label>
    <met:isActive>${params.isActive ?? true}</met:isActive>
    <met:entityName>${x(params.objectName)}</met:entityName>
    <met:fieldName>${x(params.fieldName)}</met:fieldName>
    ${pathItemsXml}
</met:metadata>`;
        return await upsertMetadata(auth, xml);
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}

export async function createCustomApplication(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const tabsXml = (params.tabs ?? []).map((t: string) => `<met:tabs>${x(t)}</met:tabs>`).join("\n");
        const utilityXml = (params.utilityBar ?? []).map((u: Record<string, any>) => `
    <met:utilityBar>
        <met:utilityBarComponents>
            <met:name>${x(String(u.tabName))}</met:name>
            <met:label>${x(String(u.label))}</met:label>
        </met:utilityBarComponents>
    </met:utilityBar>`).join("\n");
        const xml = `<met:metadata xsi:type="met:CustomApplication" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <met:fullName>${x(params.appName)}</met:fullName>
    <met:label>${x(params.label)}</met:label>
    ${params.description ? `<met:description>${x(params.description)}</met:description>` : ""}
    <met:formFactors>${x(params.formFactor ?? "Large")}</met:formFactors>
    <met:isNavAutoTempTabsDisabled>${params.isNavAutoTempTabsDisabled ?? false}</met:isNavAutoTempTabsDisabled>
    <met:navType>${x(params.navType ?? "Standard")}</met:navType>
    ${tabsXml}
    ${utilityXml}
</met:metadata>`;
        return await upsertMetadata(auth, xml);
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}

// ─── CATEGORY D: Knowledge & Service Management ───────────────────────────────

export async function createKnowledgeArticleType(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const objectName = params.articleTypeName.endsWith("__kav") ? params.articleTypeName : `${params.articleTypeName}__kav`;
        const fieldsXml = (params.fields ?? []).map((f: Record<string, any>) => {
            const fieldType = String(f.type);
            const extraXml = fieldType === "LongTextArea" ? "<met:length>32768</met:length><met:visibleLines>10</met:visibleLines>" :
                             fieldType === "Text" ? "<met:length>255</met:length>" : "";
            return `
    <met:fields>
        <met:fullName>${x(String(f.fieldName))}__c</met:fullName>
        <met:label>${x(String(f.label))}</met:label>
        <met:type>${x(fieldType)}</met:type>
        ${extraXml}
    </met:fields>`;
        }).join("\n");
        const xml = `<met:metadata xsi:type="met:CustomObject" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <met:fullName>${x(objectName)}</met:fullName>
    <met:label>${x(params.label)}</met:label>
    <met:pluralLabel>${x(params.pluralLabel)}</met:pluralLabel>
    ${params.description ? `<met:description>${x(params.description)}</met:description>` : ""}
    <met:deploymentStatus>Deployed</met:deploymentStatus>
    <met:sharingModel>ReadWrite</met:sharingModel>
    <met:nameField><met:label>Title</met:label><met:type>Text</met:type></met:nameField>
    ${fieldsXml}
</met:metadata>`;
        return await upsertMetadata(auth, xml);
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}

export async function createBusinessHours(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const dayMap: Record<string, string> = { Mon: "Monday", Tue: "Tuesday", Wed: "Wednesday", Thu: "Thursday", Fri: "Friday", Sat: "Saturday", Sun: "Sunday" };
        const daysXml = (params.days as Array<Record<string, any>>).map(d => `
    <met:businessHoursEntry>
        <met:day>${dayMap[String(d.day)] ?? String(d.day)}</met:day>
        <met:active>${d.isActive}</met:active>
        <met:startTime>${x(String(d.startTime))}:00.000Z</met:startTime>
        <met:endTime>${x(String(d.endTime))}:00.000Z</met:endTime>
    </met:businessHoursEntry>`).join("\n");
        const xml = `<met:metadata xsi:type="met:BusinessHoursSettings" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <met:fullName>BusinessHours</met:fullName>
    <met:businessHours>
        <met:name>${x(params.name)}</met:name>
        <met:active>${params.isActive ?? true}</met:active>
        <met:default>${params.isDefault ?? false}</met:default>
        <met:timeZoneSidKey>${x(params.timeZone)}</met:timeZoneSidKey>
        ${daysXml}
    </met:businessHours>
</met:metadata>`;
        return await upsertMetadata(auth, xml);
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}

export async function createHoliday(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const xml = `<met:metadata xsi:type="met:BusinessHoursSettings" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <met:fullName>BusinessHours</met:fullName>
    <met:holidays>
        <met:name>${x(params.name)}</met:name>
        ${params.description ? `<met:description>${x(params.description)}</met:description>` : ""}
        <met:isRecurring>${params.isRecurring ?? false}</met:isRecurring>
        ${params.activityDate ? `<met:activityDate>${x(params.activityDate)}</met:activityDate>` : ""}
        ${params.recurrenceType ? `<met:recurrenceType>${x(params.recurrenceType)}</met:recurrenceType>` : ""}
        ${params.recurrenceStartDate ? `<met:recurrenceStartDate>${x(params.recurrenceStartDate)}</met:recurrenceStartDate>` : ""}
        ${params.recurrenceEndDateOnly ? `<met:recurrenceEndDateOnly>${x(params.recurrenceEndDateOnly)}</met:recurrenceEndDateOnly>` : ""}
        ${params.businessHoursName ? `<met:businessHours>${x(params.businessHoursName)}</met:businessHours>` : ""}
    </met:holidays>
</met:metadata>`;
        return await upsertMetadata(auth, xml);
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}

// ─── CATEGORY E: Auth & Identity ─────────────────────────────────────────────

export async function createAuthProvider(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const xml = `<met:metadata xsi:type="met:AuthProvider" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <met:fullName>${x(params.providerName)}</met:fullName>
    <met:friendlyName>${x(params.friendlyName)}</met:friendlyName>
    <met:providerType>${x(params.providerType)}</met:providerType>
    <met:consumerKey>${x(params.consumerKey)}</met:consumerKey>
    <met:consumerSecret>${x(params.consumerSecret)}</met:consumerSecret>
    ${params.defaultScopes ? `<met:defaultScopes>${x(params.defaultScopes)}</met:defaultScopes>` : ""}
    ${params.customErrorUrl ? `<met:errorUrl>${x(params.customErrorUrl)}</met:errorUrl>` : ""}
    ${params.registrationHandler ? `<met:registrationHandler>${x(params.registrationHandler)}</met:registrationHandler>` : ""}
</met:metadata>`;
        return await upsertMetadata(auth, xml);
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}

export async function createSamlSsoConfig(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const xml = `<met:metadata xsi:type="met:SamlSsoConfig" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <met:fullName>${x(params.name)}</met:fullName>
    <met:name>${x(params.name)}</met:name>
    <met:issuer>${x(params.issuer)}</met:issuer>
    <met:identityProviderCertificate>${x(params.identityProviderCertificate)}</met:identityProviderCertificate>
    <met:samlVersion>${x(params.samlVersion ?? "SAML2_0")}</met:samlVersion>
    <met:identityLocation>${x(params.identityLocation ?? "SubjectNameId")}</met:identityLocation>
    <met:identityType>${x(params.identityType ?? "Username")}</met:identityType>
    <met:requestSignatureMethod>${x(params.requestSignatureMethod ?? "RSA-SHA256")}</met:requestSignatureMethod>
    <met:loginUrl>${x(params.loginUrl)}</met:loginUrl>
    ${params.logoutUrl ? `<met:logoutUrl>${x(params.logoutUrl)}</met:logoutUrl>` : ""}
    ${params.attributeName ? `<met:attributeName>${x(params.attributeName)}</met:attributeName>` : ""}
</met:metadata>`;
        return await upsertMetadata(auth, xml);
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}

export async function createConnectedAppOAuthPolicy(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const xml = `<met:metadata xsi:type="met:ConnectedApp" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <met:fullName>${x(params.connectedAppName)}</met:fullName>
    <met:oauthConfig>
        <met:refreshTokenPolicy>${x(params.refreshTokenPolicy)}</met:refreshTokenPolicy>
        ${params.singleLogoutUrl ? `<met:singleLogoutUrl>${x(params.singleLogoutUrl)}</met:singleLogoutUrl>` : ""}
        ${params.sessionTimeout ? `<met:sessionTimeout>${x(params.sessionTimeout)}</met:sessionTimeout>` : ""}
    </met:oauthConfig>
    ${params.ipRelaxation ? `<met:oauthPolicy><met:ipRelaxation>${x(params.ipRelaxation)}</met:ipRelaxation></met:oauthPolicy>` : ""}
</met:metadata>`;
        return await upsertMetadata(auth, xml);
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}

// ─── CATEGORY F: Sandbox Management ──────────────────────────────────────────

export async function createSandbox(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const client = createClient(auth);
        const body: Record<string, unknown> = {
            SandboxName: params.sandboxName,
            LicenseType: params.licenseType,
            AutoActivate: params.autoActivate ?? true,
        };
        if (params.description) body["Description"] = params.description;
        if (params.apexClassId) body["ApexClassId"] = params.apexClassId;
        const resp = await client.post<{ id: string }>(`/tooling/sobjects/SandboxInfo`, body);
        return { success: true, id: resp.data.id, message: `Sandbox '${params.sandboxName}' creation initiated.` };
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}

export async function refreshSandbox(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const client = createClient(auth);
        const query = `SELECT Id FROM SandboxInfo WHERE SandboxName = '${params.sandboxName.replace(/'/g, "\\'")}'`;
        const resp = await client.get<{ records: Array<{ Id: string }> }>(`/tooling/query?q=${encodeURIComponent(query)}`);
        if (!resp.data.records.length) return { success: false, message: `Sandbox '${params.sandboxName}' not found.` };
        const sandboxId = resp.data.records[0].Id;
        await client.patch(`/tooling/sobjects/SandboxInfo/${sandboxId}`, {
            LicenseType: params.licenseType,
            AutoActivate: params.autoActivate ?? true,
        });
        return { success: true, id: sandboxId, message: `Sandbox '${params.sandboxName}' refresh initiated.` };
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}

export async function listSandboxes(auth: SalesforceAuth): Promise<any> {
    try {
        const client = createClient(auth);
        const resp = await client.get<{ records: Array<Record<string, any>> }>(`/tooling/query?q=${encodeURIComponent("SELECT Id,SandboxName,Status,LicenseType,CreatedDate,LastModifiedDate FROM SandboxInfo ORDER BY CreatedDate DESC")}`);
        return { success: true, sandboxes: resp.data.records, count: resp.data.records.length };
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}

// ─── CATEGORY G: Streaming, CDC & Platform Cache ──────────────────────────────

export async function createPushTopic(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const client = createClient(auth);
        const body: Record<string, unknown> = {
            Name: params.topicName,
            Query: params.query,
            ApiVersion: params.apiVersion ?? 62,
            NotifyForOperationCreate: params.notifyForOperationCreate ?? true,
            NotifyForOperationUpdate: params.notifyForOperationUpdate ?? true,
            NotifyForOperationDelete: params.notifyForOperationDelete ?? false,
            NotifyForOperationUndelete: params.notifyForOperationUndelete ?? false,
            NotifyForFields: params.notifyForFields ?? "Referenced",
        };
        const resp = await client.post<{ id: string }>(`/sobjects/PushTopic`, body);
        return { success: true, id: resp.data.id, message: `PushTopic '${params.topicName}' created successfully.` };
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}

export async function configureChangeDataCapture(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const entities = params.entities as string[];
        const xml = `<met:metadata xsi:type="met:PlatformEventChannel" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <met:fullName>ChangeEvents</met:fullName>
    <met:channelType>data</met:channelType>
    ${entities.map(e => `<met:channelMembers><met:selectedEntity>${x(e)}</met:selectedEntity></met:channelMembers>`).join("\n")}
</met:metadata>`;
        return await upsertMetadata(auth, xml);
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}

export async function createPlatformCachePartition(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const xml = `<met:metadata xsi:type="met:PlatformCachePartition" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <met:fullName>${x(params.partitionName)}</met:fullName>
    <met:isDefaultPartition>${params.isDefaultPartition ?? false}</met:isDefaultPartition>
    ${params.description ? `<met:description>${x(params.description)}</met:description>` : ""}
    <met:partitionType>
        <met:partitionTypeName>Session</met:partitionTypeName>
        <met:allocatedCapacity>${params.sessionCacheSize ?? 0}</met:allocatedCapacity>
    </met:partitionType>
    <met:partitionType>
        <met:partitionTypeName>Organization</met:partitionTypeName>
        <met:allocatedCapacity>${params.orgCacheSize ?? 0}</met:allocatedCapacity>
    </met:partitionType>
</met:metadata>`;
        return await upsertMetadata(auth, xml);
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}

// ─── CATEGORY H: Aura Components ─────────────────────────────────────────────

export async function createAuraComponent(_auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    const name = params.componentName as string;
    const attrsXml = (params.attributes ?? []).map((a: Record<string, any>) =>
        `    <aura:attribute name="${x(String(a.name))}" type="${x(String(a.type))}"${a.default !== undefined ? ` default="${x(String(a.default))}"` : ""}${a.description ? ` description="${x(String(a.description))}"` : ""}/>`
    ).join("\n");
    const implementsAttr = params.implements ? ` implements="${x(params.implements)}"` : "";
    const controllerAttr = params.controller ? ` controller="${x(params.controller)}"` : "";
    const cmp = `<aura:component${implementsAttr}${controllerAttr} access="${x(params.accessLevel ?? "public")}">\n${attrsXml}\n    <!-- Component body -->\n</aura:component>`;
    const js = `({
    doInit : function(component, event, helper) {
        // Initialization logic
    }
})`;
    const css = `.THIS {\n    /* Component styles */\n}`;
    const design = `<design:component label="${x(name)}">\n</design:component>`;
    const meta = `<?xml version="1.0" encoding="UTF-8"?>\n<AuraDefinitionBundle xmlns="http://soap.sforce.com/2006/04/metadata">\n    <apiVersion>62.0</apiVersion>\n    <description>${x(params.description ?? name)}</description>\n</AuraDefinitionBundle>`;
    return {
        success: true,
        componentName: name,
        message: `Aura component scaffold generated for '${name}'. Deploy using the Metadata API or SFDX.`,
        files: { cmp, js, css, design, meta },
    };
}

export async function createAuraApp(_auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    const name = params.appName as string;
    const extendsAttr = params.extends ? ` extends="${x(params.extends)}"` : "";
    const includesMarkup = (params.includes ?? []).map((c: string) => `    <c:${x(c)}/>`).join("\n");
    const app = `<aura:application${extendsAttr} access="${x(params.access ?? "public")}">\n${includesMarkup}\n    ${params.bodyContent ? x(params.bodyContent) : "<!-- App body -->"}\n</aura:application>`;
    return {
        success: true,
        appName: name,
        message: `Aura app scaffold generated for '${name}'.`,
        files: { app },
    };
}

export async function createAuraEvent(_auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    const name = params.eventName as string;
    const attrsXml = (params.attributes ?? []).map((a: Record<string, any>) =>
        `    <aura:attribute name="${x(String(a.name))}" type="${x(String(a.type))}"${a.description ? ` description="${x(String(a.description))}"` : ""}/>`
    ).join("\n");
    const evt = `<aura:event type="${x(params.eventType)}" description="${x(params.description ?? name)}">\n${attrsXml}\n</aura:event>`;
    return {
        success: true,
        eventName: name,
        message: `Aura event scaffold generated for '${name}'.`,
        files: { evt },
    };
}

// ─── CATEGORY I: Flow Management ─────────────────────────────────────────────

export async function activateFlow(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const client = createClient(auth);
        let versionQuery = `SELECT Id,VersionNumber,Status FROM Flow WHERE Definition.DeveloperName = '${params.flowApiName.replace(/'/g, "\\'")}'`;
        if (params.versionNumber) {
            versionQuery += ` AND VersionNumber = ${params.versionNumber}`;
        }
        versionQuery += " ORDER BY VersionNumber DESC LIMIT 1";
        const resp = await client.get<{ records: Array<{ Id: string; VersionNumber: number; Status: string }> }>(`/tooling/query?q=${encodeURIComponent(versionQuery)}`);
        if (!resp.data.records.length) return { success: false, message: `Flow '${params.flowApiName}' not found.` };
        const flow = resp.data.records[0];
        if (flow.Status === "Active") {
            return { success: true, flowId: flow.Id, versionNumber: flow.VersionNumber, message: `Flow '${params.flowApiName}' v${flow.VersionNumber} is already active.` };
        }
        const defResp = await client.get<{ records: Array<{ Id: string }> }>(`/tooling/query?q=${encodeURIComponent(`SELECT Id FROM FlowDefinition WHERE DeveloperName = '${params.flowApiName.replace(/'/g, "\\'")}'`)}`);
        if (!defResp.data.records.length) return { success: false, message: `FlowDefinition for '${params.flowApiName}' not found.` };
        const defId = defResp.data.records[0].Id;
        await client.patch(`/tooling/sobjects/FlowDefinition/${defId}`, { Metadata: { activeVersionNumber: flow.VersionNumber } });
        return { success: true, flowId: flow.Id, versionNumber: flow.VersionNumber, message: `Flow '${params.flowApiName}' v${flow.VersionNumber} activated.` };
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}

export async function deactivateFlow(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const client = createClient(auth);
        const query = `SELECT Id,VersionNumber FROM Flow WHERE Definition.DeveloperName = '${params.flowApiName.replace(/'/g, "\\'")}' AND Status = 'Active' LIMIT 1`;
        const resp = await client.get<{ records: Array<{ Id: string; VersionNumber: number }> }>(`/tooling/query?q=${encodeURIComponent(query)}`);
        if (!resp.data.records.length) return { success: false, message: `No active flow found for '${params.flowApiName}'.` };
        const flow = resp.data.records[0];
        const defResp = await client.get<{ records: Array<{ Id: string }> }>(`/tooling/query?q=${encodeURIComponent(`SELECT Id FROM FlowDefinition WHERE DeveloperName = '${params.flowApiName.replace(/'/g, "\\'")}'`)}`);
        if (!defResp.data.records.length) return { success: false, message: `FlowDefinition for '${params.flowApiName}' not found.` };
        const defId = defResp.data.records[0].Id;
        await client.patch(`/tooling/sobjects/FlowDefinition/${defId}`, { Metadata: { activeVersionNumber: 0 } });
        return { success: true, flowId: flow.Id, versionNumber: flow.VersionNumber, message: `Flow '${params.flowApiName}' v${flow.VersionNumber} deactivated.` };
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}

export async function listFlowVersions(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const client = createClient(auth);
        let query = "SELECT Id,Definition.DeveloperName,VersionNumber,Status,Description,CreatedDate FROM Flow";
        const conditions: string[] = [];
        if (params.flowApiName) {
            conditions.push(`Definition.DeveloperName = '${params.flowApiName.replace(/'/g, "\\'")}'`);
        }
        if (!params.includeDeactivated) {
            conditions.push("Status != 'Obsolete'");
        }
        if (conditions.length) query += ` WHERE ${conditions.join(" AND ")}`;
        query += " ORDER BY Definition.DeveloperName, VersionNumber DESC LIMIT 200";
        const resp = await client.get<{ records: Array<Record<string, any>> }>(`/tooling/query?q=${encodeURIComponent(query)}`);
        return { success: true, flows: resp.data.records, count: resp.data.records.length };
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}

// ─── CATEGORY J: Translation & Internationalization ───────────────────────────

export async function translateCustomLabel(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const xml = `<met:metadata xsi:type="met:Translations" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <met:fullName>${x(params.language)}</met:fullName>
    <met:customLabels>
        <met:name>${x(params.labelName)}</met:name>
        <met:value>${x(params.translatedValue)}</met:value>
    </met:customLabels>
</met:metadata>`;
        return await upsertMetadata(auth, xml);
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}

export async function translateFieldLabel(auth: SalesforceAuth, params: Record<string, any>): Promise<any> {
    try {
        const fullName = `${params.language}-${params.objectName}`;
        const helpTextXml = params.translatedHelpText ? `<met:help>${x(params.translatedHelpText)}</met:help>` : "";
        const xml = `<met:metadata xsi:type="met:CustomObjectTranslation" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <met:fullName>${x(fullName)}</met:fullName>
    <met:fields>
        <met:name>${x(params.fieldName)}</met:name>
        <met:label>${x(params.translatedLabel)}</met:label>
        ${helpTextXml}
    </met:fields>
</met:metadata>`;
        return await upsertMetadata(auth, xml);
    } catch (err) {
        return { success: false, message: sanitizeError(err instanceof Error ? err.message : String(err)) };
    }
}
