/**
 * IW Design Library — Figma Changelog Generator (Full + AI Refinement)
 * ----------------------------------------------------------------------
 * Tracks ALL design changes and refines descriptions via Claude API.
 *
 * CommonJS build (.js). Runs on plain Node without "type": "module".
 * node-fetch v3 is ESM-only, so it is loaded via dynamic import() below.
 */

const { readFileSync, writeFileSync, existsSync } = require('fs');
const { createHash } = require('crypto');

const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

const FIGMA_TOKEN    = process.env.FIGMA_TOKEN;
const FIGMA_FILE_ID  = process.env.FIGMA_FILE_ID;
const ANTHROPIC_KEY  = process.env.ANTHROPIC_API_KEY;
const JIRA_BASE_URL  = 'https://interwetten.atlassian.net/browse';
const CHANGELOG_PATH = 'changelog-data.json';
const SNAPSHOT_PATH  = 'styles-snapshot.json';

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

// ── COMPONENT VISUAL SIGNATURE ─────────────────────────────────────────────────
// These let us detect visual changes that never touch top-level metadata:
// nested component edits (e.g. a shared .Notifications badge going green600 →
// green700), swapped styles, or rebound variables. We read the resolved node
// tree and hash its paints/strokes/effects.

function paintSig(paints = []) {
  return paints.map(p => {
    if (!p || p.visible === false) return '';
    if (p.type === 'SOLID') {
      const { r = 0, g = 0, b = 0 } = p.color || {};
      return normalizeColor(r, g, b, p.opacity ?? 1);
    }
    if (p.type === 'IMAGE') return `img:${p.imageRef ?? ''}`;
    if (p.type?.includes('GRADIENT')) {
      const stops = (p.gradientStops || [])
        .map(s => { const { r = 0, g = 0, b = 0, a = 1 } = s.color || {}; return `${normalizeColor(r, g, b, a)}@${round2(s.position ?? 0)}`; })
        .join(',');
      return `${p.type}:${stops}`;
    }
    return p.type ?? '';
  }).join('|');
}

function nodeVisualSig(node) {
  const parts = [];
  const walk = (n) => {
    if (!n) return;
    const bits = [
      n.name ?? '',
      paintSig(n.fills),
      paintSig(n.strokes),
      n.strokeWeight != null ? `sw${n.strokeWeight}` : '',
      Array.isArray(n.effects) && n.effects.length ? normalizeEffectStyle(n.effects) : '',
      n.cornerRadius != null ? `r${n.cornerRadius}` : '',
      n.opacity != null && n.opacity !== 1 ? `o${round2(n.opacity)}` : '',
    ].filter(Boolean);
    if (bits.length) parts.push(bits.join(';'));
    for (const c of n.children ?? []) walk(c);
  };
  walk(node);
  return createHash('sha1').update(parts.join('\n')).digest('hex').slice(0, 12);
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

  try {
    const varData = await figmaGet(`/files/${FIGMA_FILE_ID}/variables/local`);
    const collections = varData.meta?.variableCollections ?? {};
    const variables   = varData.meta?.variables ?? {};
    for (const [, variable] of Object.entries(variables)) {
      const collection = collections[variable.variableCollectionId];
      const key = `${collection?.name ?? 'Unknown'} / ${variable.name}`;
      const modeId = collection?.defaultModeId ?? Object.keys(variable.valuesByMode ?? {})[0];
      snapshot.variables[key] = JSON.stringify(variable.valuesByMode?.[modeId] ?? null);
    }
    console.log(`   Found ${Object.keys(snapshot.variables).length} variables`);
  } catch (e) {
    console.warn('   Variables not accessible:', e.message);
  }

  // ── COMPONENTS ────────────────────────────────────────────────────────────
  // Fix 1 (naming):  group variants under their SET name, not the raw
  //                  "Type=…, Notification=…" variant name.
  // Fix 2 (desc):    pull the real Figma description from the component set.
  // Fix 3 (content): store "variantCount::visualHash". The hash is computed
  //                  from each set's resolved node tree, so visual edits are
  //                  caught — INCLUDING ripple changes from nested components
  //                  (e.g. a shared .Notifications badge changing color), which
  //                  never bump the consumer's own updated_at.
  try {
    const compData = await figmaGet(`/files/${FIGMA_FILE_ID}/components`);

    // set node_id → { name, description }
    const sets = {};
    try {
      const setData = await figmaGet(`/files/${FIGMA_FILE_ID}/component_sets`);
      for (const cs of setData.meta?.component_sets ?? []) {
        sets[cs.node_id] = { name: cs.name, description: cs.description || '' };
      }
    } catch (e) {
      console.warn('   Component sets fetch failed:', e.message);
    }

    // displayName → { nodeId, keys:[], description:'' }
    const setInfo = {};
    for (const c of compData.meta?.components ?? []) {
      const set = sets[c.component_set_id];
      const name =
        set?.name ??                                          // 1st: real set name
        c.containing_frame?.containingStateGroup?.name ??     // 2nd: older files
        (c.name.includes('=')                                 // 3rd: strip "Prop=Value" suffix
          ? (c.name.split(',')[0].split('=').slice(1).join('=').trim() || c.name)
          : c.name);                                          // 4th: standalone component

      const info = (setInfo[name] ??= { nodeId: null, keys: [], description: '' });
      info.keys.push(c.key);
      // Prefer the SET node (contains all variants + their nested instances);
      // fall back to the component's own node for standalone components.
      if (c.component_set_id && sets[c.component_set_id]) info.nodeId = c.component_set_id;
      else if (!info.nodeId) info.nodeId = c.node_id;
      if (!info.description) info.description = set?.description || c.description || '';
    }

    // Fetch each set's full node tree and hash its resolved visuals.
    const nodeIds = [...new Set(Object.values(setInfo).map(i => i.nodeId).filter(Boolean))];
    const hashes = {};
    for (let i = 0; i < nodeIds.length; i += 50) {
      const batch = nodeIds.slice(i, i + 50);
      const { nodes } = await figmaGet(`/files/${FIGMA_FILE_ID}/nodes?ids=${batch.join(',')}`);
      for (const id of batch) {
        const doc = nodes?.[id]?.document;
        hashes[id] = doc ? nodeVisualSig(doc) : '';
      }
    }

    // Store "variantCount::visualHash" → detects BOTH structural and visual edits.
    for (const [name, info] of Object.entries(setInfo)) {
      const count = info.keys.length;
      const hash  = hashes[info.nodeId] ?? '';
      snapshot.components[name] = `${count}::${hash}`;
      if (info.description) figmaDescriptions[name] = info.description; // feeds AI + fallback
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

// Component values are "variantCount::visualHash".
function describeComponentChange(oldVal, newVal) {
  if (oldVal === newVal) return '';
  const [oldCount] = oldVal.split('::');
  const [newCount] = newVal.split('::');
  if (oldCount !== newCount) return `variants: ${oldCount} → ${newCount}`;
  return 'component visuals updated in Figma';
}

function buildDiff(oldSnap, newSnap) {
  return {
    text:       diffMap(oldSnap.text   ?? {}, newSnap.text,   (o, n) => describeWrappedChange(o, n, describeTextValueChange)),
    fill:       diffMap(oldSnap.fill   ?? {}, newSnap.fill,   (o, n) => describeWrappedChange(o, n, describeSimpleValueChange)),
    effect:     diffMap(oldSnap.effect ?? {}, newSnap.effect, (o, n) => describeWrappedChange(o, n, describeSimpleValueChange)),
    grid:       diffMap(oldSnap.grid   ?? {}, newSnap.grid,   (o, n) => describeWrappedChange(o, n, describeSimpleValueChange)),
    variables:  diffMap(oldSnap.variables  ?? {}, newSnap.variables,  describeSimpleChange),
    components: diffMap(oldSnap.components ?? {}, newSnap.components, describeComponentChange),
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
        const count = String(s.value).split('::')[0];
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
       • For components (titles like "Avatar/XS", "Badges/Casino"): write 1 short sentence describing what the component is and its role in the UI, inferred from its name and variant count. Do NOT invent specific visual claims you cannot verify (e.g. do not assert exact colors or pixel values).
   - "changed" styles/components: always include old → new values / the nature of the change. If a Figma description exists, weave it in as context. Note: "component visuals updated in Figma" often means an underlying token or nested component changed — describe it as a visual/style update rather than guessing specifics.
   - "deprecated" items: write 1 short sentence explaining it was removed, and what to use instead if obvious from the name.
   - Max 30 words per description. Be specific, not generic. Never contradict the Figma description if one was given.

2. "actions" — an array of 2-4 specific, actionable strings for the "Action required" section. Each action must:
   - Start with the role: "Developer:", "Designer:", or "Tester:"
   - Be specific to the actual changes (mention style names, token names, or affected screens)
   - Not be generic like "run regression tests" unless there are visual changes that require it
   - Mention specific CSS properties, token names, or component names where relevant

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
        max_tokens: 4096,
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
    actions.push(`Developer: ${diff.components.changed.length} component(s) visually changed — verify rendering against Figma.`);
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
}

main().catch(err => {
  console.error('❌ Script failed:', err.message);
  process.exit(1);
});
