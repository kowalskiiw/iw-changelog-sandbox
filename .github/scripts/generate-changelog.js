/**
 * IW Design Library — Figma Changelog Generator
 * ------------------------------------------------
 * Fetches current text styles from Figma API,
 * compares against the saved snapshot,
 * generates a new entry in changelog-data.json,
 * and updates the snapshot for the next run.
 *
 * Environment variables required:
 *   FIGMA_TOKEN     — Figma Personal Access Token
 *   FIGMA_FILE_ID   — Figma file ID (from URL)
 *
 * Optional:
 *   MANUAL_VERSION  — e.g. "v1.3" (overrides auto-increment)
 *   MANUAL_TICKET   — e.g. "CXI-2010" (overrides branch name extraction)
 *   BRANCH_NAME     — passed from webhook payload
 *   TICKET_FROM_WEBHOOK — passed from webhook payload
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

// ── CONFIG ──────────────────────────────────────────────────────────────────

const FIGMA_TOKEN   = process.env.FIGMA_TOKEN;
const FIGMA_FILE_ID = process.env.FIGMA_FILE_ID;
const JIRA_BASE_URL = 'https://interwetten.atlassian.net/browse';

const CHANGELOG_PATH = 'changelog-data.json';
const SNAPSHOT_PATH  = 'styles-snapshot.json';

// ── HELPERS ─────────────────────────────────────────────────────────────────

function today() {
  return new Date().toISOString().split('T')[0]; // "2026-07-10"
}

/**
 * Extract ticket number from branch name.
 * Expects format: "CXI-1946-some-description" or "CXI-1946"
 */
function extractTicket(branchName = '') {
  const match = branchName.match(/([A-Z]+-\d+)/);
  return match ? match[1] : null;
}

/**
 * Auto-increment version from existing changelog.
 * e.g. "v1.2" → "v1.3"
 */
function nextVersion(changelog) {
  if (!changelog.length) return 'v1.0';
  const latest = changelog[0].version; // newest first
  const [major, minor] = latest.replace('v', '').split('.').map(Number);
  return `v${major}.${minor + 1}`;
}

/**
 * Normalize Figma style into a clean object for comparison.
 */
function normalizeStyle(style) {
  const t = style.style || {};
  return {
    name:       style.name,
    fontSize:   t.fontSize   ?? null,
    lineHeight: typeof t.lineHeightPx !== 'undefined' ? Math.round(t.lineHeightPx) : null,
    fontWeight: t.fontWeight ?? null,
    fontFamily: t.fontFamily ?? null,
    letterSpacing: t.letterSpacing ?? 0,
  };
}

/**
 * Map change type to a human-readable description.
 */
function describeChange(oldStyle, newStyle) {
  const parts = [];
  if (oldStyle.fontSize !== newStyle.fontSize)
    parts.push(`fontSize: ${oldStyle.fontSize}px → ${newStyle.fontSize}px`);
  if (oldStyle.lineHeight !== newStyle.lineHeight)
    parts.push(`lineHeight: ${oldStyle.lineHeight}px → ${newStyle.lineHeight}px`);
  if (oldStyle.fontWeight !== newStyle.fontWeight)
    parts.push(`fontWeight: ${oldStyle.fontWeight} → ${newStyle.fontWeight}`);
  if (oldStyle.fontFamily !== newStyle.fontFamily)
    parts.push(`fontFamily: ${oldStyle.fontFamily} → ${newStyle.fontFamily}`);
  if (oldStyle.letterSpacing !== newStyle.letterSpacing)
    parts.push(`letterSpacing: ${oldStyle.letterSpacing} → ${newStyle.letterSpacing}`);
  return parts.join(' · ');
}

/**
 * Format a new style as description string.
 */
function describeNew(style) {
  const parts = [];
  if (style.fontSize)   parts.push(`${style.fontSize}px`);
  if (style.lineHeight) parts.push(`lh ${style.lineHeight}px`);
  if (style.fontWeight) parts.push(`w${style.fontWeight}`);
  if (style.fontFamily && style.fontFamily !== 'Roboto') parts.push(style.fontFamily);
  return parts.join(' · ');
}

// ── FETCH FIGMA STYLES ───────────────────────────────────────────────────────

async function fetchFigmaStyles() {
  console.log(`📡 Fetching styles from Figma file: ${FIGMA_FILE_ID}`);

  // Step 1: get style metadata (names + nodeIds)
  const metaRes = await fetch(
    `https://api.figma.com/v1/files/${FIGMA_FILE_ID}/styles`,
    { headers: { 'X-Figma-Token': FIGMA_TOKEN } }
  );
  if (!metaRes.ok) throw new Error(`Figma API error: ${metaRes.status} ${metaRes.statusText}`);
  const meta = await metaRes.json();

  // Filter to text styles only
  const textStyles = (meta.meta?.styles ?? []).filter(s => s.style_type === 'TEXT');
  console.log(`   Found ${textStyles.length} text styles`);

  if (!textStyles.length) {
    throw new Error('No text styles found. Check FIGMA_FILE_ID and token permissions.');
  }

  // Step 2: fetch actual style properties via nodes endpoint
  const nodeIds = textStyles.map(s => s.node_id).join(',');
  const nodesRes = await fetch(
    `https://api.figma.com/v1/files/${FIGMA_FILE_ID}/nodes?ids=${nodeIds}`,
    { headers: { 'X-Figma-Token': FIGMA_TOKEN } }
  );
  if (!nodesRes.ok) throw new Error(`Figma nodes API error: ${nodesRes.status}`);
  const nodes = await nodesRes.json();

  // Build normalized style map: { "Body/XL/Regular": { fontSize, lineHeight, ... } }
  const styleMap = {};
  for (const ts of textStyles) {
    const node = nodes.nodes?.[ts.node_id]?.document;
    if (!node) continue;
    const normalized = normalizeStyle({ name: ts.name, style: node.style ?? {} });
    styleMap[ts.name] = normalized;
  }

  return styleMap;
}

// ── DIFF ─────────────────────────────────────────────────────────────────────

function diffStyles(oldMap, newMap) {
  const added   = [];
  const changed = [];
  const removed = [];

  // Check for new and changed
  for (const [name, newStyle] of Object.entries(newMap)) {
    if (!oldMap[name]) {
      added.push({ name, style: newStyle });
    } else {
      const desc = describeChange(oldMap[name], newStyle);
      if (desc) changed.push({ name, style: newStyle, desc });
    }
  }

  // Check for removed
  for (const name of Object.keys(oldMap)) {
    if (!newMap[name]) removed.push({ name });
  }

  return { added, changed, removed };
}

// ── GROUP CHANGES ─────────────────────────────────────────────────────────────

/**
 * Groups changes by their style category prefix.
 * "Body/XL/Regular" → "Body"
 * "Headlines/H1/Desktop" → "Headlines"
 */
function groupChanges(diff) {
  const groups = {};

  const add = (category, item) => {
    if (!groups[category]) groups[category] = [];
    groups[category].push(item);
  };

  for (const s of diff.added) {
    const cat = s.name.split('/')[0];
    add(cat, { type: 'new', title: s.name, desc: describeNew(s.style) });
  }
  for (const s of diff.changed) {
    const cat = s.name.split('/')[0];
    add(cat, { type: 'changed', title: s.name, desc: s.desc });
  }
  for (const s of diff.removed) {
    const cat = s.name.split('/')[0];
    add(cat, { type: 'deprecated', title: s.name, desc: 'Style removed from library.' });
  }

  return Object.entries(groups).map(([title, items]) => ({ title, items }));
}

// ── MAIN ──────────────────────────────────────────────────────────────────────

async function main() {
  if (!FIGMA_TOKEN)   throw new Error('Missing FIGMA_TOKEN environment variable');
  if (!FIGMA_FILE_ID) throw new Error('Missing FIGMA_FILE_ID environment variable');

  // 1. Load existing data
  const changelog = existsSync(CHANGELOG_PATH)
    ? JSON.parse(readFileSync(CHANGELOG_PATH, 'utf8'))
    : [];
  const snapshot = existsSync(SNAPSHOT_PATH)
    ? JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf8'))
    : {};

  // 2. Fetch current styles from Figma
  const currentStyles = await fetchFigmaStyles();

  // 3. Diff against snapshot
  const diff = diffStyles(snapshot, currentStyles);
  const totalChanges = diff.added.length + diff.changed.length + diff.removed.length;

  if (totalChanges === 0) {
    console.log('✅ No style changes detected. Changelog not updated.');
    // Still update snapshot in case node IDs shifted
    writeFileSync(SNAPSHOT_PATH, JSON.stringify(currentStyles, null, 2));
    return;
  }

  console.log(`📝 Changes detected: +${diff.added.length} new, ~${diff.changed.length} changed, -${diff.removed.length} removed`);

  // 4. Determine version and ticket
  const branchName  = process.env.BRANCH_NAME || '';
  const ticketAuto  = extractTicket(branchName) || extractTicket(process.env.TICKET_FROM_WEBHOOK || '');
  const version     = process.env.MANUAL_VERSION  || nextVersion(changelog);
  const ticket      = process.env.MANUAL_TICKET   || ticketAuto || '';
  const ticketUrl   = ticket ? `${JIRA_BASE_URL}/${ticket}` : '';

  // 5. Build groups
  const groups = groupChanges(diff);

  // 6. Build actions (generic — can be manually refined after commit)
  const actions = [];
  if (diff.changed.length)
    actions.push('Developer: Check all implementations of changed styles — values may have shifted.');
  if (diff.added.length)
    actions.push('Developer: Add new tokens to global stylesheet.');
  if (diff.added.length)
    actions.push('Designer: Review new styles in Figma before using in designs.');
  if (diff.removed.length)
    actions.push('Developer: Remove deprecated tokens from codebase.');
    actions.push('Tester: Run regression tests on affected screens.');

  // 7. Build new changelog entry
  const newEntry = {
    version,
    date: today(),
    ticket,
    ticketUrl,
    groups,
    actions,
  };

  // 8. Prepend to changelog (newest first)
  changelog.unshift(newEntry);

  // 9. Write files
  writeFileSync(CHANGELOG_PATH, JSON.stringify(changelog, null, 2));
  writeFileSync(SNAPSHOT_PATH,  JSON.stringify(currentStyles, null, 2));

  console.log(`✅ Changelog updated: ${version} (${today()}) — ${totalChanges} changes across ${groups.length} groups`);
  console.log(`   Ticket: ${ticket || '(none — add manually)'}`);
}

main().catch(err => {
  console.error('❌ Script failed:', err.message);
  process.exit(1);
});
