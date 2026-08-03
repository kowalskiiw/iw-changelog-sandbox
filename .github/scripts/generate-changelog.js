/**
 * IW Design Library — Figma Changelog Generator (Full + AI Refinement)
 * ----------------------------------------------------------------------
 * Tracks ALL design changes and refines descriptions via Claude API.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';

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

function nextVersion(changelog) {
  if (!changelog.length) return 'v1.0';
  const [major, minor] = changelog[0].version.replace('v', '').split('.').map(Number);
  return `v${major}.${minor + 1}`;
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
  console.log('   Descriptions:', JSON.stringify(figmaDescriptions, null, 2)); // ← neu, temporär zum Debuggen

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

  try {
    const compData = await figmaGet(`/files/${FIGMA_FILE_ID}/components`);
    for (const c of compData.meta?.components ?? []) snapshot.components[c.name] = c.key;
    console.log(`   Found ${Object.keys(snapshot.components).length} components`);
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

function buildDiff(oldSnap, newSnap) {
  return {
    text:       diffMap(oldSnap.text   ?? {}, newSnap.text,   (o, n) => describeWrappedChange(o, n, describeTextValueChange)),
    fill:       diffMap(oldSnap.fill   ?? {}, newSnap.fill,   (o, n) => describeWrappedChange(o, n, describeSimpleValueChange)),
    effect:     diffMap(oldSnap.effect ?? {}, newSnap.effect, (o, n) => describeWrappedChange(o, n, describeSimpleValueChange)),
    grid:       diffMap(oldSnap.grid   ?? {}, newSnap.grid,   (o, n) => describeWrappedChange(o, n, describeSimpleValueChange)),
    variables:  diffMap(oldSnap.variables  ?? {}, newSnap.variables,  describeSimpleChange),
    components: diffMap(oldSnap.components ?? {}, newSnap.components, describeSimpleChange),
  };
}

function totalChanges(diff) {
  return Object.values(diff).reduce((sum, d) =>
    sum + d.added.length + d.changed.length + d.removed.length, 0);
}

// ── BUILD RAW GROUPS ──────────────────────────────────────────────────────────

function buildGroups(diff) {
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

1. "items" — an array of refined descriptions for each changed style. For each item:
   - If a "Figma description" is provided in the input, treat it as the PRIMARY source of truth. Base your description on it directly — closely paraphrase or lightly tighten it, but do NOT replace it with a generic invented description or ignore it in favor of the raw values.
   - If NO Figma description is provided, fall back to: for "new" styles, write 1 short sentence explaining what the style is and when to use it, based on the raw values (size, weight, etc).
   - "changed" styles: always include old → new values. If a Figma description exists, weave it in as context for why/what the style is for.
   - "deprecated" styles: write 1 short sentence explaining it was removed, and what to use instead if obvious from the name.
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
        max_tokens: 2048,
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
  const version    = process.env.MANUAL_VERSION || nextVersion(changelog);
  const ticketUrl  = ticket ? `${JIRA_BASE_URL}/${ticket}` : '';

  const rawGroups = buildGroups(diff);
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
