/**
 * IW Design Library — Figma Changelog Generator (Full + AI Refinement)
 * ----------------------------------------------------------------------
 * Tracks ALL design changes and refines descriptions via Claude API.
 *
 * ES module (.js). Matches a package.json with "type": "module".
 * node-fetch v3 is ESM-only and loaded via dynamic import() below.
 *
 * Colour token names come from a committed variables.json (exported from Figma
 * via the Desktop Bridge — works on any plan). The Enterprise-only Variables
 * REST API is used only as a fallback.
 */

import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

const FIGMA_TOKEN    = process.env.FIGMA_TOKEN;
const FIGMA_FILE_ID  = process.env.FIGMA_FILE_ID;
const ANTHROPIC_KEY  = process.env.ANTHROPIC_API_KEY;
const JIRA_BASE_URL  = 'https://interwetten.atlassian.net/browse';
const CHANGELOG_PATH = 'changelog-data.json';
const SNAPSHOT_PATH  = 'styles-snapshot.json';
// Look for variables.json next to this script first, then in the working dir,
// so it's found regardless of where the workflow runs `node` from.
const VARIABLES_CANDIDATES = [join(__dirname, 'variables.json'), 'variables.json'];

// Bumped whenever the component snapshot shape/value representation changes, so
// a format migration is adopted silently instead of reporting every layer.
// (v4: colours resolve to token names. v5: analyse ALL variants of a set, not
// just the first — the set node comes from containingStateGroup.nodeId.
// v6: also snapshot each variant's raw property values — e.g. Variant =
// "Secondary Black (Default)" — keyed by the variant's own node ID, so
// renaming a property value is detected even when nothing visual changed.
// v7: the top-level `components` map is now keyed by the SET's node ID
// instead of its display name (name lives inside the value as `.name`), so
// renaming a whole component/component set is detected as "changed" instead
// of a false remove+add.)
const COMPONENT_FMT = 7;

// Built during variable loading:
//   VARIABLE_NAMES        : variableId → token name (for fills BOUND to a variable)
//   COLOR_TOKENS_BY_HEX   : resolved hex → [{ name, collection }] (for fills whose
//                           resolved hex matches a token's value)
let VARIABLE_NAMES = {};
let COLOR_TOKENS_BY_HEX = {};

// Values in a layer signature are ";"/"="-delimited, so keep token names clear of those.
const safeToken = s => String(s).replace(/[;=]/g, '-');

// When one hex maps to several tokens, prefer a primitive-collection token,
// then the shortest name.
function pickToken(list) {
  if (list.length === 1) return list[0].name;
  const prim = list.filter(t => /primitive/i.test(t.collection));
  const pool = prim.length ? prim : list;
  pool.sort((a, b) => a.name.length - b.name.length || a.name.localeCompare(b.name));
  return pool[0].name;
}

// ── OUTPUT HELPER (for GitHub Actions step outputs) ────────────────────────────
// Writes `key=value` to $GITHUB_OUTPUT so later workflow steps can read it via
// steps.<id>.outputs.<key>. No-ops locally when GITHUB_OUTPUT isn't set.
function setOutput(key, value) {
  if (!process.env.GITHUB_OUTPUT) return;
  appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
}

// ── HELPERS ───────────────────────────────────────────────────────────────────

function today() { return new Date().toISOString().split('T')[0]; }

function extractTicket(str = '') {
  const match = str.match(/([A-Z]+-\d+)/);
  return match ? match[1] : null;
}

function autoVersion() {
  // "2026-08-03" in Vienna time, regardless of the runner's UTC clock
  const date = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Vienna' });
  const run  = process.env.GITHUB_RUN_NUMBER || '0';
  return `v${date.replace(/-/g, '.')}.${run}`; // → "v2026.08.03.18"
}

function round2(n) { return Math.round(n * 100) / 100; }

function formatTextStyleValues(v) {
  const parts = [];
  if (v.fontSize)                              parts.push(`${v.fontSize}px`);
  if (v.lineHeight)                            parts.push(`lh ${v.lineHeight}px`);
  if (v.fontWeight)                            parts.push(`w${v.fontWeight}`);
  if (v.fontFamily && v.fontFamily !== 'Roboto') parts.push(v.fontFamily);
  if (v.letterSpacing)                         parts.push(`ls ${v.letterSpacing}`);
  return parts.join(' · ');
}

// Parses a Figma variant node name like:
//   "Variant=Secondary Black (Default), Size=M"
// into { Variant: "Secondary Black (Default)", Size: "M" }.
// Standalone (non-variant) components have no "=" and yield {}.
function parseVariantProps(name = '') {
  const props = {};
  for (const part of name.split(',')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (key) props[key] = val;
  }
  return props;
}

// ── FIGMA API ─────────────────────────────────────────────────────────────────

async function figmaGet(path) {
  const res = await fetch(`https://api.figma.com/v1${path}`, {
    headers: { 'X-Figma-Token': FIGMA_TOKEN }
  });
  if (!res.ok) throw new Error(`Figma API error ${res.status}: ${path}`);
  return res.json();
}

// ── NORMALIZERS ───────────────────────────────────────────────────────────────

function normalizeColor(r, g, b, a = 1) {
  const hex = [r, g, b].map(v => Math.round(v * 255).toString(16).padStart(2, '0')).join('');
  return `#${hex.toUpperCase()}${a < 1 ? ` (${Math.round(a * 100)}%)` : ''}`;
}

function normalizePaint(paint) {
  if (!paint) return 'unknown';
  if (paint.type === 'SOLID') {
    const { r, g, b } = paint.color;
    return normalizeColor(r, g, b, paint.opacity ?? 1);
  }
  if (paint.type.includes('GRADIENT')) return paint.type.toLowerCase().replace('_', ' ');
  if (paint.type === 'IMAGE') return 'image fill';
  return paint.type;
}

function normalizeTextStyle(style = {}) {
  return {
    fontSize:      style.fontSize ?? null,
    lineHeight:    style.lineHeightPx ? Math.round(style.lineHeightPx) : null,
    fontWeight:    style.fontWeight ?? null,
    fontFamily:    style.fontFamily ?? null,
    letterSpacing: style.letterSpacing ? round2(style.letterSpacing) : 0,
  };
}

function normalizeEffectStyle(effects = []) {
  return effects.map(e => {
    if (e.type === 'DROP_SHADOW' || e.type === 'INNER_SHADOW') {
      const { r, g, b, a } = e.color;
      return `${e.type.toLowerCase().replace('_', ' ')}: offset ${e.offset.x}/${e.offset.y} blur ${e.radius} color ${normalizeColor(r, g, b, a)}`;
    }
    return `${e.type.toLowerCase().replace('_', ' ')}: radius ${e.radius}`;
  }).join(' | ');
}

function normalizeGridStyle(grids = []) {
  return grids.map(g =>
    `${g.pattern} count:${g.count ?? 'auto'} size:${g.sectionSize ?? g.gutterSize ?? '?'} gutter:${g.gutterSize ?? '?'}`
  ).join(' | ');
}

// ── COMPONENT VISUAL SIGNATURES ────────────────────────────────────────────────
// Per component: a map of layer → its resolved visual value(s), each a set of
// "prop=value" tokens. Diffing names the exact property that changed
// (e.g. "fill: Accent Light Mode/Default Green/600 → …/400") and hides unchanged
// properties. Colours resolve to token names whether bound to a variable or a
// hardcoded hex that matches a token's value.

const PROP_LABEL = {
  fill:         'fill',
  stroke:       'border color',
  strokeWeight: 'border width',
  effects:      'effects',
  radius:       'corner radius',
  opacity:      'opacity',
};

function paintSig(paints = []) {
  return paints.map(p => {
    if (!p || p.visible === false) return '';
    if (p.type === 'SOLID') {
      const varId = p.boundVariables?.color?.id;
      const bound = varId && VARIABLE_NAMES[varId];
      if (bound) return safeToken(bound);
      const { r = 0, g = 0, b = 0 } = p.color || {};
      const hex = normalizeColor(r, g, b, p.opacity ?? 1);
      const match = COLOR_TOKENS_BY_HEX[hex];
      if (match?.length) return safeToken(pickToken(match));
      return hex;
    }
    if (p.type === 'IMAGE') return `img:${p.imageRef ?? ''}`;
    if (p.type?.includes('GRADIENT')) {
      const stops = (p.gradientStops || [])
        .map(s => { const { r = 0, g = 0, b = 0, a = 1 } = s.color || {}; return `${normalizeColor(r, g, b, a)}@${round2(s.position ?? 0)}`; })
        .join(',');
      return `${p.type}:${stops}`;
    }
    return p.type ?? '';
  }).filter(Boolean).join('|');
}

function layerSig(n) {
  const f = paintSig(n.fills);
  const s = paintSig(n.strokes);
  const bits = [
    f ? `fill=${f}` : '',
    s ? `stroke=${s}` : '',
    n.strokeWeight != null ? `strokeWeight=${n.strokeWeight}` : '',
    (Array.isArray(n.effects) && n.effects.length) ? `effects=${normalizeEffectStyle(n.effects)}` : '',
    n.cornerRadius != null ? `radius=${n.cornerRadius}` : '',
    (n.opacity != null && n.opacity !== 1) ? `opacity=${round2(n.opacity)}` : '',
  ].filter(Boolean);
  return bits.join(';');
}

function parseSig(sig) {
  const obj = {};
  for (const tok of String(sig).split(';')) {
    const idx = tok.indexOf('=');
    if (idx === -1) continue;
    obj[tok.slice(0, idx)] = tok.slice(idx + 1);
  }
  return obj;
}

function collectVisualMap(root) {
  const map = {};
  const variants = root.type === 'COMPONENT_SET' ? (root.children ?? []) : [root];
  for (const v of variants) {
    const walk = (n, path) => {
      const sig = layerSig(n);
      if (sig) {
        const key = path.length ? path.join(' / ') : (n.name ?? 'layer');
        (map[key] ??= new Set()).add(sig);
      }
      for (const c of n.children ?? []) walk(c, [...path, c.name ?? '?']);
    };
    for (const c of v.children ?? []) walk(c, [c.name ?? '?']);
    const rootSig = layerSig(v);
    if (rootSig) (map['(root)'] ??= new Set()).add(rootSig);
  }
  const out = {};
  for (const [k, set] of Object.entries(map)) out[k] = [...set].sort();
  return out;
}

// ── VARIABLE / COLOUR TOKEN LOADING ─────────────────────────────────────────────
// Preferred: committed variables.json exported from Figma via the Desktop Bridge
// (any plan). Fallback: the Enterprise-only Variables REST API.
async function loadVariables(snapshot) {
  const varsPath = VARIABLES_CANDIDATES.find(p => existsSync(p));
  if (varsPath) {
    try {
      const vj = JSON.parse(readFileSync(varsPath, 'utf8'));
      for (const [hex, name] of Object.entries(vj.colorTokens ?? {})) {
        (COLOR_TOKENS_BY_HEX[hex] ??= []).push({ name, collection: 'Color Styles' });
      }
      console.log(`   Loaded ${varsPath} (${Object.keys(vj.colorTokens ?? {}).length} colour tokens)`);
      return; // file wins; skip REST (which 403s on non-Enterprise plans)
    } catch (e) {
      console.warn(`   ${varsPath} unreadable, falling back to REST:`, e.message);
    }
  } else {
    console.warn('   variables.json not found next to script or in working dir.');
  }

  // Fallback: REST Variables API (Enterprise only)
  try {
    const varData = await figmaGet(`/files/${FIGMA_FILE_ID}/variables/local`);
    const collections = varData.meta?.variableCollections ?? {};
    const variables   = varData.meta?.variables ?? {};

    for (const [id, variable] of Object.entries(variables)) {
      const collection = collections[variable.variableCollectionId];
      VARIABLE_NAMES[id] = variable.name;
      const key = `${collection?.name ?? 'Unknown'} / ${variable.name}`;
      const modeId = collection?.defaultModeId ?? Object.keys(variable.valuesByMode ?? {})[0];
      snapshot.variables[key] = JSON.stringify(variable.valuesByMode?.[modeId] ?? null);
    }

    const resolveColorVar = (id, seen = new Set()) => {
      if (!id || seen.has(id)) return null;
      seen.add(id);
      const v = variables[id];
      if (!v || v.resolvedType !== 'COLOR') return null;
      const coll = collections[v.variableCollectionId];
      const modeId = coll?.defaultModeId ?? Object.keys(v.valuesByMode ?? {})[0];
      const val = v.valuesByMode?.[modeId];
      if (val && val.type === 'VARIABLE_ALIAS') return resolveColorVar(val.id, seen);
      if (val && typeof val === 'object' && 'r' in val) return val;
      return null;
    };
    for (const [id, v] of Object.entries(variables)) {
      if (v.resolvedType !== 'COLOR') continue;
      const rgba = resolveColorVar(id);
      if (!rgba) continue;
      const hex = normalizeColor(rgba.r, rgba.g, rgba.b, rgba.a ?? 1);
      (COLOR_TOKENS_BY_HEX[hex] ??= []).push({
        name: v.name,
        collection: collections[v.variableCollectionId]?.name ?? '',
      });
    }
    console.log(`   Variables via REST (${Object.keys(snapshot.variables).length} vars, ${Object.keys(COLOR_TOKENS_BY_HEX).length} colours)`);
  } catch (e) {
    console.warn('   Variables not accessible (no variables.json, REST failed):', e.message);
  }
}

// ── FETCH ALL STYLES ──────────────────────────────────────────────────────────

async function fetchAllStyles() {
  console.log('📡 Fetching all styles from Figma...');
  const { meta } = await figmaGet(`/files/${FIGMA_FILE_ID}/styles`);
  const styles = meta?.styles ?? [];
  console.log(`   Found ${styles.length} styles total`);

  const byType = { TEXT: [], FILL: [], EFFECT: [], GRID: [] };
  const figmaDescriptions = {};
  for (const s of styles) {
    if (byType[s.style_type]) byType[s.style_type].push(s);
    if (s.description) figmaDescriptions[s.name] = s.description;
  }
  console.log(`   Found ${Object.keys(figmaDescriptions).length} style descriptions`);

  async function fetchNodes(styleList) {
    if (!styleList.length) return {};
    const result = {};
    for (let i = 0; i < styleList.length; i += 50) {
      const batch = styleList.slice(i, i + 50);
      const ids = batch.map(s => s.node_id).join(',');
      const { nodes } = await figmaGet(`/files/${FIGMA_FILE_ID}/nodes?ids=${ids}`);
      for (const s of batch) result[s.name] = nodes?.[s.node_id]?.document ?? null;
    }
    return result;
  }

  const [textNodes, fillNodes, effectNodes, gridNodes] = await Promise.all([
    fetchNodes(byType.TEXT),
    fetchNodes(byType.FILL),
    fetchNodes(byType.EFFECT),
    fetchNodes(byType.GRID),
  ]);

  const snapshot = { text: {}, fill: {}, effect: {}, grid: {}, variables: {}, components: {} };

  for (const [name, node] of Object.entries(textNodes)) {
    if (node) snapshot.text[name] = {
      value: normalizeTextStyle(node.style ?? {}),
      description: figmaDescriptions[name] ?? null,
    };
  }
  for (const [name, node] of Object.entries(fillNodes)) {
    if (node?.fills?.length) snapshot.fill[name] = {
      value: normalizePaint(node.fills[0]),
      description: figmaDescriptions[name] ?? null,
    };
  }
  for (const [name, node] of Object.entries(effectNodes)) {
    if (node?.effects?.length) snapshot.effect[name] = {
      value: normalizeEffectStyle(node.effects),
      description: figmaDescriptions[name] ?? null,
    };
  }
  for (const [name, node] of Object.entries(gridNodes)) {
    if (node?.layoutGrids?.length) snapshot.grid[name] = {
      value: normalizeGridStyle(node.layoutGrids),
      description: figmaDescriptions[name] ?? null,
    };
  }

  // Colour tokens (variables.json preferred, REST fallback) — must run before
  // components so paintSig can resolve colour names.
  await loadVariables(snapshot);

  // ── COMPONENTS ────────────────────────────────────────────────────────────
  // Stored as { count, layers, variants, fmt } per set:
  //   count    → detects variants added/removed
  //   layers   → { "Layer / Path": [values] } → detects & names visual changes,
  //              including ripples from nested components and variable rebinding.
  //   variants → { [nodeId]: { PropName: value, ... } } → each variant's raw
  //              property values (e.g. Variant="Secondary Black (Default)"),
  //              keyed by the variant's OWN node ID so a rename is caught even
  //              though nothing visual changed. Matching by node ID (rather
  //              than by value) means a genuine delete+recreate correctly
  //              shows up as add/remove instead of a false rename.
  //   fmt      → snapshot format version (see COMPONENT_FMT).
  try {
    const compData = await figmaGet(`/files/${FIGMA_FILE_ID}/components`);

    const sets = {};
    try {
      const setData = await figmaGet(`/files/${FIGMA_FILE_ID}/component_sets`);
      for (const cs of setData.meta?.component_sets ?? []) {
        sets[cs.node_id] = { name: cs.name, description: cs.description || '' };
      }
    } catch (e) {
      console.warn('   Component sets fetch failed:', e.message);
    }

    // groupKey → { name, nodeId, keys:[], description:'', variants:{} }
    // The set's node id lives on containing_frame.containingStateGroup.nodeId
    // (the REST /components response has NO component_set_id field). Using it
    // means we fetch the whole SET and walk EVERY variant — not just the first.
    const setInfo = {};
    for (const c of compData.meta?.components ?? []) {
      const sg = c.containing_frame?.containingStateGroup;
      const setNodeId = sg?.nodeId || null;
      const displayName =
        sg?.name ??                                   // variant set name
        (c.name.includes('=')                         // strip "Prop=Value" suffix
          ? (c.name.split(',')[0].split('=').slice(1).join('=').trim() || c.name)
          : c.name);                                  // standalone component

      const groupKey = setNodeId || c.node_id;        // group all variants of a set together
      const info = (setInfo[groupKey] ??= {
        name: displayName,
        nodeId: setNodeId || c.node_id,               // SET node (all variants) or standalone node
        keys: [],
        description: '',
        variants: {},                                 // nodeId → { PropName: value }
      });
      info.keys.push(c.key);
      info.variants[c.node_id] = parseVariantProps(c.name);
      if (!info.description) info.description = sets[setNodeId]?.description || c.description || '';
    }

    // Fetch each set's full node tree and build its per-layer visual map.
    const nodeIds = [...new Set(Object.values(setInfo).map(i => i.nodeId).filter(Boolean))];
    const maps = {};
    for (let i = 0; i < nodeIds.length; i += 50) {
      const batch = nodeIds.slice(i, i + 50);
      const { nodes } = await figmaGet(`/files/${FIGMA_FILE_ID}/nodes?ids=${batch.join(',')}`);
      for (const id of batch) {
        const doc = nodes?.[id]?.document;
        maps[id] = doc ? collectVisualMap(doc) : {};
      }
    }

    for (const info of Object.values(setInfo)) {
      // Keyed by node ID (stable across renames), not by name — see COMPONENT_FMT v7.
      snapshot.components[info.nodeId] = {
        name: info.name,
        count: info.keys.length,
        layers: maps[info.nodeId] ?? {},
        variants: info.variants,
        fmt: COMPONENT_FMT,
      };
      if (info.description) figmaDescriptions[info.name] = info.description;
    }
    console.log(`   Found ${Object.keys(snapshot.components).length} component sets`);
  } catch (e) {
    console.warn('   Components fetch failed:', e.message);
  }

  return { snapshot, figmaDescriptions };
}

// ── DIFF ENGINE ───────────────────────────────────────────────────────────────

function diffMap(oldMap, newMap, describeChangeFn) {
  const added = [], changed = [], removed = [];
  for (const [name, newVal] of Object.entries(newMap)) {
    if (oldMap[name] === undefined) {
      added.push({ name, value: newVal });
    } else {
      const desc = describeChangeFn(oldMap[name], newVal);
      if (desc) changed.push({ name, desc });
    }
  }
  for (const name of Object.keys(oldMap)) {
    if (newMap[name] === undefined) removed.push({ name });
  }
  return { added, changed, removed };
}

function describeTextValueChange(old, nw) {
  const parts = [];
  if (old.fontSize      !== nw.fontSize)      parts.push(`fontSize: ${old.fontSize}px → ${nw.fontSize}px`);
  if (old.lineHeight    !== nw.lineHeight)     parts.push(`lineHeight: ${old.lineHeight}px → ${nw.lineHeight}px`);
  if (old.fontWeight    !== nw.fontWeight)     parts.push(`fontWeight: ${old.fontWeight} → ${nw.fontWeight}`);
  if (old.fontFamily    !== nw.fontFamily)     parts.push(`fontFamily: ${old.fontFamily} → ${nw.fontFamily}`);
  if (old.letterSpacing !== nw.letterSpacing)  parts.push(`letterSpacing: ${old.letterSpacing} → ${nw.letterSpacing}`);
  return parts.join(' · ');
}

function describeSimpleValueChange(oldVal, newVal) {
  return oldVal !== newVal ? `${oldVal} → ${newVal}` : '';
}

function describeWrappedChange(old, nw, formatValueFn) {
  const parts = [];
  const valueDiff = formatValueFn(old.value, nw.value);
  if (valueDiff) parts.push(valueDiff);
  if ((old.description ?? '') !== (nw.description ?? '')) parts.push('description updated in Figma');
  return parts.join(' · ');
}

function describeSimpleChange(oldVal, newVal) {
  return oldVal !== newVal ? `${oldVal} → ${newVal}` : '';
}

function asComp(v) {
  if (v && typeof v === 'object') return {
    name: v.name ?? '',
    count: v.count ?? 0,
    layers: v.layers ?? {},
    variants: v.variants ?? {},
    fmt: v.fmt,
    _migrated: false,
  };
  const [c] = String(v).split('::');
  return { name: '', count: Number(c) || 0, layers: {}, variants: {}, fmt: undefined, _migrated: true };
}

// Rewrites any path segment matching a known old component/variant name to its
// new name (whole-segment match only, not substring, to avoid accidental
// collisions). Used to normalize layer-path keys before diffing, so a pure
// rename ripple (every nested layer whose path mirrors a renamed component)
// cancels out instead of showing as spurious layer add/remove noise.
function applyRenames(pathKey, renameMap) {
  if (!renameMap || !Object.keys(renameMap).length) return pathKey;
  return pathKey.split(' / ').map(seg => renameMap[seg] ?? seg).join(' / ');
}

function diffLayers(oldL = {}, newL = {}, renameMap = {}) {
  const oldNormalized = {};
  for (const [k, v] of Object.entries(oldL)) {
    oldNormalized[applyRenames(k, renameMap)] = v;
  }
  oldL = oldNormalized;

  const out = [];
  const keys = new Set([...Object.keys(oldL), ...Object.keys(newL)]);
  for (const k of keys) {
    const oArr = oldL[k] ?? [];
    const nArr = newL[k] ?? [];
    const oSet = new Set(oArr), nSet = new Set(nArr);
    const removed = [...oSet].filter(x => !nSet.has(x));
    const added   = [...nSet].filter(x => !oSet.has(x));
    if (!removed.length && !added.length) continue;

    if (!oldL[k]) { out.push(`${k} — layer added`); continue; }
    if (!newL[k]) { out.push(`${k} — layer removed`); continue; }

    if (removed.length === 1 && added.length === 1) {
      const o = parseSig(removed[0]);
      const n = parseSig(added[0]);
      const props = new Set([...Object.keys(o), ...Object.keys(n)]);
      const changes = [];
      for (const p of props) {
        if (o[p] !== n[p]) {
          const label = PROP_LABEL[p] ?? p;
          changes.push(`${label}: ${o[p] ?? '∅'} → ${n[p] ?? '∅'}`);
        }
      }
      if (changes.length) out.push(`${k} — ${changes.join(', ')}`);
      continue;
    }

    out.push(`${k} — ${removed.join(' / ') || '∅'} → ${added.join(' / ') || '∅'}`);
  }
  return [...new Set(out)];
}

// Compares each variant's raw property values (e.g. Variant="Secondary Black
// (Default)") across two snapshots, matched by the variant's own node ID.
// A node ID present in both sides with a changed value is a rename. A node ID
// missing from one side is ignored here — that's an add/remove, already
// surfaced via the `count` check in describeComponentChange.
function diffVariantProps(oldV = {}, newV = {}) {
  const out = [];
  const nodeIds = new Set([...Object.keys(oldV), ...Object.keys(newV)]);
  for (const id of nodeIds) {
    const oProps = oldV[id];
    const nProps = newV[id];
    if (!oProps || !nProps) continue; // added/removed variant, not a rename
    const keys = new Set([...Object.keys(oProps), ...Object.keys(nProps)]);
    for (const key of keys) {
      if (oProps[key] !== nProps[key]) {
        out.push(`${key}: "${oProps[key] ?? '∅'}" → "${nProps[key] ?? '∅'}"`);
      }
    }
  }
  return [...new Set(out)];
}

function describeComponentChange(oldVal, newVal, renameMap = {}) {
  const o = asComp(oldVal), n = asComp(newVal);
  if (o._migrated || o.fmt !== n.fmt) return ''; // format migration → adopt silently

  const lines = [];
  // Whole-component/set rename — same node ID, different display name.
  if (o.name && n.name && o.name !== n.name) {
    lines.push(`component renamed: "${o.name}" → "${n.name}"`);
  }
  if (o.count !== n.count) lines.push(`variants: ${o.count} → ${n.count}`);
  lines.push(...diffVariantProps(o.variants, n.variants));
  lines.push(...diffLayers(o.layers, n.layers, renameMap));

  if (!lines.length) return '';
  const MAX = 5;
  const shown = lines.slice(0, MAX).join(' · ');
  return lines.length > MAX ? `${shown} · +${lines.length - MAX} more` : shown;
}

// Diffs the top-level `components` map, matched by the SET's node ID (the map
// key) rather than by name — so a rename shows up as "changed" (same node ID,
// different `.name`) instead of a false remove+add. `s.name` on every
// added/changed/removed entry is always the *current* display name available
// on that side of the diff, ready to use directly in buildGroups().
//
// A full-format migration (e.g. adopting node-ID keys for the first time,
// or any COMPONENT_FMT bump) is detected up front: if none of the old
// entries match the current format, the whole map is treated as a fresh
// baseline instead of reporting every component as removed+added.
function diffComponents(oldMap = {}, newMap = {}) {
  const oldValues = Object.values(oldMap);
  const isMigration = oldValues.length > 0 && oldValues.every(v => asComp(v).fmt !== COMPONENT_FMT);
  if (isMigration) return { added: [], changed: [], removed: [] };

  // Pass 1: collect every component-level rename first (same node ID, name
  // changed). Other components that merely CONTAIN a nested instance of a
  // renamed component (e.g. "Alerts Default (Inline)" using "Primary
  // Buttons-test") will have layer paths that shifted purely because Figma
  // mirrors an instance's default name onto its main component's name — this
  // rename map lets diffLayers cancel out that ripple instead of reporting a
  // flood of spurious layer add/remove lines for every downstream consumer.
  const renameMap = {};
  for (const [nodeId, newVal] of Object.entries(newMap)) {
    const oldVal = oldMap[nodeId];
    if (!oldVal) continue;
    const oName = asComp(oldVal).name, nName = asComp(newVal).name;
    if (oName && nName && oName !== nName) renameMap[oName] = nName;
  }

  const added = [], changed = [], removed = [];
  for (const [nodeId, newVal] of Object.entries(newMap)) {
    const oldVal = oldMap[nodeId];
    if (oldVal === undefined) {
      added.push({ name: asComp(newVal).name || nodeId, value: newVal });
    } else {
      const desc = describeComponentChange(oldVal, newVal, renameMap);
      if (desc) changed.push({ name: asComp(newVal).name || nodeId, desc });
    }
  }
  for (const [nodeId, oldVal] of Object.entries(oldMap)) {
    if (newMap[nodeId] === undefined) removed.push({ name: asComp(oldVal).name || nodeId });
  }
  return { added, changed, removed };
}

function buildDiff(oldSnap, newSnap) {
  return {
    text:       diffMap(oldSnap.text   ?? {}, newSnap.text,   (o, n) => describeWrappedChange(o, n, describeTextValueChange)),
    fill:       diffMap(oldSnap.fill   ?? {}, newSnap.fill,   (o, n) => describeWrappedChange(o, n, describeSimpleValueChange)),
    effect:     diffMap(oldSnap.effect ?? {}, newSnap.effect, (o, n) => describeWrappedChange(o, n, describeSimpleValueChange)),
    grid:       diffMap(oldSnap.grid   ?? {}, newSnap.grid,   (o, n) => describeWrappedChange(o, n, describeSimpleValueChange)),
    variables:  diffMap(oldSnap.variables  ?? {}, newSnap.variables,  describeSimpleChange),
    components: diffComponents(oldSnap.components ?? {}, newSnap.components ?? {}),
  };
}

function totalChanges(diff) {
  return Object.values(diff).reduce((sum, d) =>
    sum + d.added.length + d.changed.length + d.removed.length, 0);
}

// ── BUILD RAW GROUPS ──────────────────────────────────────────────────────────

function buildGroups(diff, figmaDescriptions = {}) {
  const groups = [];
  const CATEGORIES = [
    { key: 'text',       label: 'Typography / Text Styles' },
    { key: 'fill',       label: 'Color Styles' },
    { key: 'effect',     label: 'Effect Styles' },
    { key: 'grid',       label: 'Grid Styles' },
    { key: 'variables',  label: 'Variables' },
    { key: 'components', label: 'Components' },
  ];

  for (const { key, label } of CATEGORIES) {
    const d = diff[key];
    if (!d.added.length && !d.changed.length && !d.removed.length) continue;

    const items = [];

    for (const s of d.added) {
      let desc = '';
      if (key === 'text' && s.value?.value) {
        desc = formatTextStyleValues(s.value.value);
      } else if (['fill', 'effect', 'grid'].includes(key) && s.value?.value !== undefined) {
        desc = s.value.value;
      } else if (key === 'components') {
        const count = (s.value && typeof s.value === 'object') ? s.value.count : String(s.value).split('::')[0];
        desc = figmaDescriptions[s.name] || `${count} variant(s)`;
      } else {
        desc = typeof s.value === 'string' ? s.value : JSON.stringify(s.value);
      }
      items.push({ type: 'new', title: s.name, desc });
    }

    for (const s of d.changed) {
      items.push({ type: 'changed', title: s.name, desc: s.desc });
    }

    for (const s of d.removed) {
      items.push({ type: 'deprecated', title: s.name, desc: 'Removed from library.' });
    }

    groups.push({ title: label, items });
  }
  return groups;
}

// ── CLAUDE AI REFINEMENT ──────────────────────────────────────────────────────

async function refineWithClaude(groups, diff, version, ticket, figmaDescriptions = {}) {
  if (!ANTHROPIC_KEY) {
    console.log('⚠ No ANTHROPIC_API_KEY — skipping AI refinement');
    return { groups, actions: buildFallbackActions(diff) };
  }

  console.log('🤖 Refining descriptions and actions with Claude...');

  const rawSummary = groups.map(g =>
    `${g.title}:\n${g.items.map(i => {
      const figmaDesc = figmaDescriptions[i.title]
        ? `\n    Figma description (PRIMARY SOURCE — use this): "${figmaDescriptions[i.title]}"`
        : '';
      return `  [${i.type}] ${i.title}: ${i.desc}${figmaDesc}`;
    }).join('\n')}`
  ).join('\n\n');

  const prompt = `You are a design system documentation writer for Interwetten, an online sports betting and casino platform. The IW Design Library is a Figma-based design system used across multiple markets (Germany, Austria, Spain, Sweden, Cyprus). It is maintained by the CXI team and consumed by frontend developers, QA testers, and UX designers.

A new library update has been published (${version}${ticket ? `, Jira ticket: ${ticket}` : ''}). Here are the raw technical changes detected by comparing the Figma file before and after:

${rawSummary}

Your task is to return a JSON object with two keys:

1. "items" — an array of refined descriptions for each changed style OR component. For each item:
   - If a "Figma description" is provided in the input, treat it as the PRIMARY source of truth. Base your description on it directly — closely paraphrase or lightly tighten it, but do NOT replace it with a generic invented description or ignore it in favor of the raw values.
   - If NO Figma description is provided:
       • For text/color/effect/grid styles: write 1 short sentence explaining what the style is and when to use it, based on the raw values (size, weight, etc).
       • For components (titles like "Avatar/XS", "Badges/Casino"): write 1 short sentence describing what the component is and its role in the UI, inferred from its name. Do NOT invent specific visual claims you cannot verify.
   - "changed" items: PRESERVE any concrete old → new values already present in the raw change (e.g. "fill: Accent Light Mode/Default Green/600 → Accent Light Mode/Default Green/400", "corner radius: 75 → 80", Variant: "Secondary Black (Default)" → "Secondary Neutral Black (Default)", or component renamed: "Primary Buttons" → "Primary Buttons-test"). Keep those exact property labels and token/values — do not drop, round, or rename them — and add a short plain-language framing around them. This precise before/after is the most useful part of the entry.
   - "deprecated" items: write 1 short sentence explaining it was removed, and what to use instead if obvious from the name.
   - Max 30 words per description. Be specific, not generic. Never contradict the Figma description if one was given.

2. "actions" — an array of 2-4 specific, actionable strings for the "Action required" section. Each action must:
   - Start with the role: "Developer:", "Designer:", or "Tester:"
   - Be specific to the actual changes (mention style names, token names, or affected screens)
   - Not be generic like "run regression tests" unless there are visual changes that require it
   - Mention specific CSS properties, token names, or component names where relevant
   - If a component variant's property value was renamed, or a whole component/set was renamed, call out that any code referencing the old variant/component name must be updated

Context about the codebase:
- CSS token naming convention: --body-xl-size, --body-xl-line-height, --label-m-size etc.
- Text styles are used in React components across betting UI: odds displays, match cards, navigation, account screens
- Markets: DE, AT, ES, SE, CY — some styles are market-specific

Return ONLY valid JSON, no markdown, no explanation:
{
  "items": [
    { "title": "exact style name from input", "desc": "refined description" }
  ],
  "actions": [
    "Developer: specific action here",
    "Tester: specific action here"
  ]
}`;

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 8192,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!res.ok) throw new Error(`Anthropic API error: ${res.status}`);
    const data = await res.json();
    const text = data.content?.[0]?.text ?? '';
    const parsed = JSON.parse(text.replace(/```json|```/g, '').trim());

    const refinedMap = Object.fromEntries((parsed.items ?? []).map(r => [r.title, r.desc]));
    const refinedGroups = groups.map(group => ({
      ...group,
      items: group.items.map(item => ({
        ...item,
        desc: refinedMap[item.title] ?? item.desc,
      })),
    }));

    const actions = parsed.actions?.length ? parsed.actions : buildFallbackActions(diff);

    console.log(`   ✅ Refined ${(parsed.items ?? []).length} descriptions, ${actions.length} actions`);
    return { groups: refinedGroups, actions };

  } catch (e) {
    console.warn('   ⚠ AI refinement failed, using raw descriptions:', e.message);
    return { groups, actions: buildFallbackActions(diff) };
  }
}

// ── FALLBACK ACTIONS (no AI) ──────────────────────────────────────────────────

function buildFallbackActions(diff) {
  const actions = [];
  if (diff.text.added.length)
    actions.push(`Developer: Add ${diff.text.added.length} new text style token(s) to global stylesheet.`);
  if (diff.text.changed.length)
    actions.push(`Developer: Update ${diff.text.changed.length} text style token(s) — check font sizes and line heights.`);
  if (diff.fill.changed.length || diff.fill.added.length)
    actions.push('Developer: Review color token updates in global stylesheet.');
  if (diff.components.added.length)
    actions.push(`Developer: ${diff.components.added.length} new component(s) in Figma — check Dev Mode for specs.`);
  if (diff.components.changed.length)
    actions.push(`Developer: ${diff.components.changed.length} component(s) changed (visual and/or variant naming) — check Dev Mode for updated specs and update any code referencing old variant values.`);
  if (diff.components.removed.length)
    actions.push(`Developer: ${diff.components.removed.length} component(s) removed — check codebase for usages.`);
  if (diff.variables.changed.length || diff.variables.added.length)
    actions.push('Developer: Variable values updated — sync token export.');
  actions.push('Tester: Run regression tests on affected screens.');
  return actions;
}

// ── MAIN ──────────────────────────────────────────────────────────────────────

async function main() {
  if (!FIGMA_TOKEN)   throw new Error('Missing FIGMA_TOKEN');
  if (!FIGMA_FILE_ID) throw new Error('Missing FIGMA_FILE_ID');

  const changelog = existsSync(CHANGELOG_PATH)
    ? JSON.parse(readFileSync(CHANGELOG_PATH, 'utf8')) : [];

  const oldSnap = existsSync(SNAPSHOT_PATH)
    ? JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf8'))
    : { text: {}, fill: {}, effect: {}, grid: {}, variables: {}, components: {} };

  const { snapshot: newSnap, figmaDescriptions } = await fetchAllStyles();
  const diff    = buildDiff(oldSnap, newSnap);
  const total   = totalChanges(diff);

  writeFileSync(SNAPSHOT_PATH, JSON.stringify(newSnap, null, 2));

  if (total === 0) {
    console.log('✅ No changes detected — changelog not updated.');
    setOutput('has_changes', 'false');
    return;
  }

  const branchName = process.env.BRANCH_NAME || '';
  const ticket     = process.env.MANUAL_TICKET || extractTicket(branchName) || extractTicket(process.env.TICKET_FROM_WEBHOOK || '') || '';
  const version    = process.env.MANUAL_VERSION || autoVersion();
  const ticketUrl  = ticket ? `${JIRA_BASE_URL}/${ticket}` : '';

  const rawGroups = buildGroups(diff, figmaDescriptions);
  const { groups: refinedGroups, actions } = await refineWithClaude(rawGroups, diff, version, ticket, figmaDescriptions);

  const newEntry = { version, date: today(), ticket, ticketUrl, groups: refinedGroups, actions };
  changelog.unshift(newEntry);
  writeFileSync(CHANGELOG_PATH, JSON.stringify(changelog, null, 2));

  console.log(`✅ Changelog updated: ${version} — ${total} changes across ${refinedGroups.length} categories`);
  if (!ticket) console.log('   ⚠ No ticket detected — add manually if needed');

  // Signal to the workflow that a real changelog entry was created, so the
  // downstream "Create Jira ticket" step knows whether to run.
  setOutput('has_changes', 'true');
  setOutput('version', version);
  setOutput('total_changes', String(total));
}

main().catch(err => {
  console.error('❌ Script failed:', err.message);
  process.exit(1);
});
