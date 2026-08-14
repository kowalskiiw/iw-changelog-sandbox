/**
 * IW Design Library — variables.json Builder
 * ----------------------------------------------------------------------
 * Reusable, generic transform: raw figma-console:figma_get_variables API
 * responses (one file per collection, or an array of responses per file) →
 * the variables.json consumed by generate-changelog.js.
 *
 * WORKFLOW FOR FUTURE UPDATES (no manual value transcription required):
 *   1. For each Figma variable collection, call:
 *        figma-console:figma_get_variables
 *          fileUrl: <the library URL>
 *          format: 'filtered'
 *          collection: '<collection name>'
 *          resolveAliases: true
 *          verbosity: 'summary'
 *      (paginate with page/pageSize if a collection has >50 variables)
 *   2. Save each raw JSON response's `.data` object AS-IS into raw/*.json
 *      (a single file may also contain an ARRAY of such objects).
 *   3. Run: node build-variables-json.mjs
 *      → writes variables.json with both `colorTokens` (hex→name, for
 *        resolving fills inside components) and `variables` (full
 *        name→value snapshot, for diffing every variable type).
 *
 * No values are ever hand-typed — this script reads them straight out of
 * whatever Figma's API returned.
 */

import { readFileSync, readdirSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RAW_DIR = join(__dirname, 'raw');
const OUTPUT_PATH = join(__dirname, 'variables.json');
const EXPORTED_FROM = 'sandbox-library (74KWB0uqjxyNZR1LkOUtce)';

// ── Load every raw dump (single object or array of objects per file) ──────────
function loadRawDumps() {
  const files = readdirSync(RAW_DIR).filter(f => f.endsWith('.json'));
  const dumps = [];
  for (const f of files) {
    const parsed = JSON.parse(readFileSync(join(RAW_DIR, f), 'utf8'));
    const arr = Array.isArray(parsed) ? parsed : [parsed];
    dumps.push(...arr);
  }
  return dumps;
}

// ── Colour hex formatting (matches generate-changelog.js's normalizeColor) ─────
function toScriptHex(h) {
  h = h.toUpperCase();
  if (h.length === 9) {
    const rgb = h.slice(0, 7);
    const a = parseInt(h.slice(7, 9), 16) / 255;
    return `${rgb} (${Math.round(a * 100)}%)`;
  }
  return h;
}

// On collision (two tokens sharing a colour) keep the deeper-nested ramp name,
// tie-break alphabetically — same rule as the original Desktop Bridge export.
function betterTokenName(a, b) {
  const da = (a.match(/\//g) || []).length;
  const db = (b.match(/\//g) || []).length;
  if (da !== db) return da > db ? a : b;
  return a < b ? a : b;
}

function main() {
  const dumps = loadRawDumps();

  const collectionNames = {}; // collectionId → name
  for (const dump of dumps) {
    for (const c of dump.variableCollections ?? []) {
      collectionNames[c.id] = c.name;
    }
  }

  const colorTokens = {};
  const variables = {};

  for (const dump of dumps) {
    for (const v of dump.variables ?? []) {
      const collectionName = collectionNames[v.variableCollectionId] ?? 'Unknown';
      const modeNames = Object.keys(v.resolvedValuesByMode ?? {});
      const multiMode = modeNames.length > 1;

      for (const modeName of modeNames) {
        const raw = v.resolvedValuesByMode[modeName];
        const value = raw && typeof raw === 'object' ? raw.value : raw;

        // Flatten multi-mode variables as "Name (ModeName)"; single-mode as "Name".
        const displayName = multiMode ? `${v.name} (${modeName})` : v.name;
        variables[`${collectionName} / ${displayName}`] = value;

        if (v.resolvedType === 'COLOR' && typeof value === 'string') {
          const key = toScriptHex(value);
          colorTokens[key] = colorTokens[key] ? betterTokenName(colorTokens[key], v.name) : v.name;
        }
      }
    }
  }

  const out = {
    _generator: 'figma desktop bridge export (build-variables-json.mjs)',
    _note: "colorTokens: hex → colour token name, used to resolve fills inside components. variables: full name → value snapshot for ALL variable types, used to diff the 'Variables' changelog category. To regenerate: dump each collection's figma_get_variables response into raw/*.json and re-run this script — no manual value entry needed.",
    _exportedFrom: EXPORTED_FROM,
    colorTokens,
    variables,
  };

  writeFileSync(OUTPUT_PATH, JSON.stringify(out, null, 2));
  console.log(`Wrote ${Object.keys(colorTokens).length} colour tokens and ${Object.keys(variables).length} variables to ${OUTPUT_PATH}`);
}

main();
