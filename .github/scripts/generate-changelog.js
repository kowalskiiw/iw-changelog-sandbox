/**
 * IW Design Library — Figma Changelog Generator (Full + AI Refinement)
 * ----------------------------------------------------------------------
 * Tracks ALL design changes and refines descriptions via Claude API.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';

const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

const FIGMA_TOKEN      = process.env.FIGMA_TOKEN;
const FIGMA_FILE_ID    = process.env.FIGMA_FILE_ID;
const ANTHROPIC_KEY    = process.env.ANTHROPIC_API_KEY;
const JIRA_BASE_URL    = 'https://interwetten.atlassian.net/browse';
const CHANGELOG_PATH   = 'changelog-data.json';
const SNAPSHOT_PATH    = 'styles-snapshot.json';

// ── HELPERS ──────────────────────────────────────────────────────────────────

function today() {
  return new Date().toISOString().split('T')[0];
}

function extractTicket(str = '') {
  const match = str.match(/([A-Z]+-\d+)/);
  return match ? match[1] : null;
}

function nextVersion(changelog) {
  if (!changelog.length) return 'v1.0';
  const [major, minor] = changelog[0].version.replace('v', '').split('.').map(Number);
  return `v${major}.${minor + 1}`;
}

function round2(n) {
  return Math.round(n * 100) / 100;
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
    if (e.type === 'LAYER_BLUR' || e.type === 'BACKGROUND_BLUR') {
      return `${e.type.toLowerCase().replace('_', ' ')}: radius ${e.radius}`;
    }
    return e.type;
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
  for (const s of styles) {
    if (byType[s.style_type]) byType[s.style_type].push(s);
  }

  async function fetchNodes(styleList) {
    if (!styleList.length) return {};
    const result = {};
    for (let i = 0; i < styleList.length; i += 50) {
      const batch = styleList.slice(i, i + 50);
      const ids = batch.map(s => s.node_id).join(',');
      const { nodes } = await figmaGet(`/files/${FIGMA_FILE_ID}/nodes?ids=${ids}`);
      for (const s of batch) {
        result[s.name] = nodes?.[s.node_id]?.document ?? null;
      }
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
    if (node) snapshot.text[name] = normalizeTextStyle(node.style ?? {});
  }
  for (const [name, node] of Object.entries(fillNodes)) {
    if (node?.fills?.length) snapshot.fill[name] = normalizePaint(node.fills[0]);
  }
  for (const [name, node] of Object.entries(effectNodes)) {
    if (node?.effects?.length) snapshot.effect[name] = normalizeEffectStyle(node.effects);
  }
  for (const [name, node] of Object.entries(gridNodes)) {
    if (node?.layoutGrids?.length) snapshot.grid[name] = normalizeGridStyle(node.layoutGrids);
  }

  try {
    const varData = await figmaGet(`/files/${FIGMA_FILE_ID}/variables/local`);
    const collections = varData.meta?.variableCollections ?? {};
    const variables   = varData.meta?.variables ?? {};
    for (const [, variable] of Object.entries(variables)) {
      const collection = collections[variable.variableCollectionId];
      const collName   = collection?.name ?? 'Unknown';
      const key        = `${collName} / ${variable.name}`;
      const modeId     = collection?.defaultModeId ?? Object.keys(variable.valuesByMode ?? {})[0];
      snapshot.variables[key] = JSON.stringify(variable.valuesByMode?.[modeId] ?? null);
    }
    console.log(`   Found ${Object.keys(snapshot.variables).length} variables`);
  } catch (e) {
    console.warn('   Variables not accessible:', e.message);
  }

  try {
    const compData = await figmaGet(`/files/${FIGMA_FILE_ID}/components`);
    for (const c of compData.meta?.components ?? []) {
      snapshot.components[c.name] = c.key;
    }
    console.log(`   Found ${Object.keys(snapshot.components).length} components`);
  } catch (e) {
    console.warn('   Components fetch failed:', e.message);
  }

  return snapshot;
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

function describeTextChange(old, nw) {
  const parts = [];
  if (old.fontSize      !== nw.fontSize)      parts.push(`fontSize: ${old.fontSize}px → ${nw.fontSize}px`);
  if (old.lineHeight    !== nw.lineHeight)     parts.push(`lineHeight: ${old.lineHeight}px → ${nw.lineHeight}px`);
  if (old.fontWeight    !== nw.fontWeight)     parts.push(`fontWeight: ${old.fontWeight} → ${nw.fontWeight}`);
  if (old.fontFamily    !== nw.fontFamily)     parts.push(`fontFamily: ${old.fontFamily} → ${nw.fontFamily}`);
  if (old.letterSpacing !== nw.letterSpacing)  parts.push(`letterSpacing: ${old.letterSpacing} → ${nw.letterSpacing}`);
  return parts.join(' · ');
}

function describeSimpleChange(oldVal, newVal) {
  return oldVal !== newVal ? `${oldVal} → ${newVal}` : '';
}

function buildDiff(oldSnap, newSnap) {
  return {
    text:       diffMap(oldSnap.text       ?? {}, newSnap.text,       describeTextChange),
    fill:       diffMap(oldSnap.fill       ?? {}, newSnap.fill,       describeSimpleChange),
    effect:     diffMap(oldSnap.effect     ?? {}, newSnap.effect,     describeSimpleChange),
    grid:       diffMap(oldSnap.grid       ?? {}, newSnap.grid,       describeSimpleChange),
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
    for (const s of d.added)   items.push({ type: 'new',        title: s.name, desc: typeof s.value === 'string' ? s.value : JSON.stringify(s.value) });
    for (const s of d.changed) items.push({ type: 'changed',    title: s.name, desc: s.desc });
    for (const s of d.removed) items.push({ type: 'deprecated', title: s.name, desc: 'Removed from library.' });
    groups.push({ title: label, items });
  }
  return groups;
}

// ── CLAUDE AI REFINEMENT ──────────────────────────────────────────────────────

async function refineWithClaude(groups, version, ticket) {
  if (!ANTHROPIC_KEY) {
    console.log('⚠ No ANTHROPIC_API_KEY — skipping AI refinement');
    return groups;
  }

  console.log('🤖 Refining descriptions with Claude...');

  const rawSummary = groups.map(g =>
    `${g.title}:\n${g.items.map(i => `  [${i.type}] ${i.title}: ${i.desc}`).join('\n')}`
  ).join('\n\n');

  const prompt = `You are a design system documentation writer for Interwetten, an online betting platform.

A Figma Design Library update (${version}${ticket ? `, Jira: ${ticket}` : ''}) has been published with the following raw technical changes:

${rawSummary}

Rewrite each item's description into a short, clear, human-readable sentence (max 15 words) that explains WHAT changed and WHY it matters — written for developers, designers and testers.

Rules:
- Keep it factual and concise
- For "changed" items: mention old and new value if relevant
- For "new" items: explain what it's used for
- For "deprecated" items: mention it was removed
- Do not invent reasons — only describe what the data shows
- Write in English

Return ONLY a valid JSON array, no markdown, no explanation. Format:
[
  { "title": "exact style name", "desc": "your refined description" },
  ...
]`;

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
        max_tokens: 1024,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!res.ok) throw new Error(`Anthropic API error: ${res.status}`);
    const data = await res.json();
    const text = data.content?.[0]?.text ?? '';

    // Parse JSON response
    const refined = JSON.parse(text.replace(/```json|```/g, '').trim());
    const refinedMap = Object.fromEntries(refined.map(r => [r.title, r.desc]));

    // Apply refined descriptions back to groups
    const updatedGroups = groups.map(group => ({
      ...group,
      items: group.items.map(item => ({
        ...item,
        desc: refinedMap[item.title] ?? item.desc,
      })),
    }));

    console.log(`   ✅ Refined ${refined.length} descriptions`);
    return updatedGroups;

  } catch (e) {
    console.warn('   ⚠ AI refinement failed, using raw descriptions:', e.message);
    return groups;
  }
}

// ── BUILD ACTIONS ─────────────────────────────────────────────────────────────

function buildActions(diff) {
  const actions = [];
  if (diff.text.changed.length || diff.text.added.length)
    actions.push('Developer: Check all text style implementations — sizes or weights may have changed.');
  if (diff.fill.changed.length || diff.fill.added.length)
    actions.push('Developer: Review color token updates in global stylesheet.');
  if (diff.components.added.length)
    actions.push('Developer: New components available in Figma — check Dev Mode for specs.');
  if (diff.components.removed.length)
    actions.push('Developer: Some components were removed — check for usages in codebase.');
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

  const newSnap = await fetchAllStyles();
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

  // Build raw groups then refine with Claude
  const rawGroups     = buildGroups(diff);
  const refinedGroups = await refineWithClaude(rawGroups, version, ticket);
  const actions       = buildActions(diff);

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
