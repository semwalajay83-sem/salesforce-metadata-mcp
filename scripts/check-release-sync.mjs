#!/usr/bin/env node
/**
 * Release metadata drift checker.
 *
 * The version and the tool count are each duplicated across roughly a dozen places in this repo, and
 * every one of them has gone stale at least once:
 *
 *   - `src/index.ts` hardcoded the version and advertised 2.10.0 to MCP clients while package.json
 *     said 2.11.1 (fixed in a3548f4 by reading package.json at runtime).
 *   - The GitHub About description went stale THREE times: 132 -> 212 -> 223 -> 228. It is repo
 *     metadata rather than a file, so nothing in the working tree ever corrects it.
 *   - QUICKSTART.md went stale because it is not in package.json's `files` array, so publishing
 *     never surfaces it.
 *
 * Every one of those was found by accident. This finds them on purpose.
 *
 * Two values are treated as the single source of truth, and everything else is DERIVED from them:
 *   version    <- package.json
 *   toolCount  <- the actual registerTool/server.tool registrations in src/tools/*.ts
 *
 * Usage:
 *   node scripts/check-release-sync.mjs            # verify; exit 1 on any drift
 *   node scripts/check-release-sync.mjs --fix      # rewrite derived values to match
 *   node scripts/check-release-sync.mjs --github   # also check the GitHub About description
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIX = process.argv.includes("--fix");
const CHECK_GITHUB = process.argv.includes("--github");

const problems = [];
const fixed = [];
const notes = [];

// ─── Source of truth ──────────────────────────────────────────────────────────

const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const VERSION = pkg.version;

/**
 * Counts tool registrations from source.
 *
 * Deliberately multiline-aware: roughly half of this repo's registrations put the tool name on the
 * line AFTER `server.registerTool(`, and a single-line regex undercounts them badly (this is how the
 * count drifted to 212 while the real number was 223).
 */
function countTools() {
  const dir = join(ROOT, "src", "tools");
  const names = new Set();
  for (const file of readdirSync(dir).filter(f => f.endsWith(".ts"))) {
    const src = readFileSync(join(dir, file), "utf8");
    for (const m of src.matchAll(/(?:registerTool|server\.tool)\(\s*["'`]([A-Za-z0-9_]+)["'`]/g)) {
      names.add(m[1]);
    }
  }
  return names.size;
}

const TOOL_COUNT = countTools();

// ─── Derived locations ────────────────────────────────────────────────────────

/**
 * CHANGELOG.md is deliberately absent from this list. It is a historical record — its older entries
 * legitimately say 212, 222, 223, and "fixing" them would falsify the history.
 *
 * `optional: true` entries are checked only when present, so this script stays useful for anyone who
 * clones the repo without having built the bundle.
 */
const COUNT_FILES = [
  { path: "README.md" },
  { path: "TOOLS.md" },
  { path: "QUICKSTART.md" },
  { path: "CLAUDE.md" },
  { path: "package.json" },
  { path: "server.json" },
  { path: "mcpb/manifest.json", optional: true },
];

/**
 * Every way this repo writes the tool count in prose or metadata. Kept as patterns rather than exact
 * sentences so rewording a doc does not silently disable the check.
 */
const COUNT_PATTERNS = [
  /\b(\d{2,4})\s+tools\b/g,      // "228 tools"
  /\b(\d{2,4})\s+total\b/g,      // "— 228 total."
  /\b(\d{2,4})-tool\b/g,         // "the full 228-tool table"
  /Tool count:\s*(\d{2,4})/g,    // CLAUDE.md
];

function checkCounts() {
  for (const { path: rel, optional } of COUNT_FILES) {
    const path = join(ROOT, rel);
    if (!existsSync(path)) {
      if (optional) notes.push(`${rel} not present — tool-count check skipped`);
      else problems.push(`${rel}: MISSING`);
      continue;
    }
    let text = readFileSync(path, "utf8");
    let changed = false;

    for (const pattern of COUNT_PATTERNS) {
      text = text.replace(pattern, (match, num) => {
        if (Number(num) === TOOL_COUNT) return match;
        if (FIX) { changed = true; return match.replace(num, String(TOOL_COUNT)); }
        problems.push(`${rel}: says "${match.trim()}" but there are ${TOOL_COUNT} tools`);
        return match;
      });
    }
    if (changed) { writeFileSync(path, text); fixed.push(`${rel}: tool count -> ${TOOL_COUNT}`); }
  }
}

function checkVersions() {
  const path = join(ROOT, "server.json");
  if (!existsSync(path)) { problems.push("server.json: MISSING"); return; }
  const raw = readFileSync(path, "utf8");
  const server = JSON.parse(raw);

  // Two independent version fields: the server's own, and the npm package it points at. Both must
  // track package.json — a mismatch publishes a registry entry aimed at a version that may not exist.
  const found = [
    ["server.json version", server.version],
    ["server.json packages[0].version", server.packages?.[0]?.version],
  ];
  let out = raw;
  for (const [label, value] of found) {
    if (value === VERSION) continue;
    if (FIX) continue; // handled by the structured rewrite below
    problems.push(`${label}: "${value}" but package.json is "${VERSION}"`);
  }
  if (FIX && found.some(([, v]) => v !== VERSION)) {
    server.version = VERSION;
    if (server.packages?.[0]) server.packages[0].version = VERSION;
    out = JSON.stringify(server, null, 2) + "\n";
    writeFileSync(path, out);
    fixed.push(`server.json: versions -> ${VERSION}`);
  }

  // The npm identifier must match the package actually being published, or the registry entry points
  // at someone else's package entirely.
  const identifier = server.packages?.[0]?.identifier;
  if (identifier && identifier !== pkg.name) {
    problems.push(`server.json packages[0].identifier is "${identifier}" but this package is "${pkg.name}"`);
  }

  // The official MCP registry rejects descriptions over 100 chars with a 422 — npm's practical limit
  // is ~250, so a description that is fine for npm can fail the registry publish.
  if (typeof server.description === "string" && server.description.length > 100) {
    problems.push(`server.json description is ${server.description.length} chars; the MCP registry caps it at 100`);
  }
  if (typeof pkg.description === "string" && pkg.description.length > 250) {
    problems.push(`package.json description is ${pkg.description.length} chars; npm search truncates around 250`);
  }
}

/**
 * The MCPB bundle manifest carries its own version field. Checked only if the bundle exists, so this
 * script stays useful before/without it.
 */
function checkBundle() {
  const path = join(ROOT, "mcpb", "manifest.json");
  if (!existsSync(path)) { notes.push("mcpb/manifest.json not present — bundle check skipped"); return; }
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  if (manifest.version !== VERSION) {
    if (FIX) {
      manifest.version = VERSION;
      writeFileSync(path, JSON.stringify(manifest, null, 2) + "\n");
      fixed.push(`mcpb/manifest.json: version -> ${VERSION}`);
    } else {
      problems.push(`mcpb/manifest.json version: "${manifest.version}" but package.json is "${VERSION}"`);
    }
  }
  // A thin bundle resolves the server from npm at run time, so it never carries stale server code.
  // If someone converts it to a fat bundle, that property is lost and this should be reconsidered.
  const args = manifest.server?.mcp_config?.args ?? [];
  if (!args.some(a => String(a).includes(pkg.name))) {
    problems.push(`mcpb/manifest.json: mcp_config no longer references "${pkg.name}" — is this still a thin bundle?`);
  }
}

/**
 * Guards the one mistake that would turn the Dockerfile into per-release maintenance: pinning the
 * published package version instead of building from the source already in the image.
 */
function checkDockerfile() {
  const path = join(ROOT, "Dockerfile");
  if (!existsSync(path)) { notes.push("Dockerfile not present — Docker check skipped"); return; }
  const text = readFileSync(path, "utf8");
  const pinned = text.match(new RegExp(`${pkg.name}@[\\d.]+`));
  if (pinned) {
    problems.push(`Dockerfile pins "${pinned[0]}" — build from source instead so it needs no per-release update`);
  }
}

/**
 * The GitHub About description is repo metadata, not a file, so it is invisible to every other check
 * here and has gone stale three times. Network + token, so it is opt-in and degrades to a note.
 */
function checkGitHub() {
  const repo = "semwalajay83-sem/salesforce-metadata-mcp";
  let body;
  try {
    body = execFileSync("curl", ["-s", `https://api.github.com/repos/${repo}`], { encoding: "utf8", timeout: 20000 });
  } catch {
    notes.push("GitHub About: could not reach the API — check skipped");
    return;
  }
  let description;
  try { description = JSON.parse(body).description; } catch { notes.push("GitHub About: unparseable response"); return; }
  if (!description) { notes.push("GitHub About: empty"); return; }
  const m = description.match(/\b(\d{2,4})\s+tools\b/);
  if (!m) { notes.push(`GitHub About mentions no tool count: "${description.slice(0, 60)}..."`); return; }
  if (Number(m[1]) !== TOOL_COUNT) {
    problems.push(
      `GitHub About says "${m[1]} tools" but there are ${TOOL_COUNT}. This is repo metadata, not a file — ` +
      `fix with: git credential fill -> curl -X PATCH https://api.github.com/repos/${repo} -d '{"description":"..."}'`
    );
  }
}

// ─── Run ──────────────────────────────────────────────────────────────────────

checkCounts();
checkVersions();
checkBundle();
checkDockerfile();
if (CHECK_GITHUB) checkGitHub();

console.log(`source of truth: version ${VERSION}, ${TOOL_COUNT} tools registered in src/tools/`);
for (const n of notes) console.log(`  note: ${n}`);
for (const f of fixed) console.log(`  fixed: ${f}`);

if (problems.length > 0) {
  console.error(`\n${problems.length} drift problem(s):`);
  for (const p of problems) console.error(`  - ${p}`);
  console.error(FIX ? "\nSome problems need a human — see above." : "\nRe-run with --fix to update the derived values automatically.");
  process.exit(1);
}
console.log(fixed.length > 0 ? "\nAll derived values updated and in sync." : "\nAll release metadata in sync.");
