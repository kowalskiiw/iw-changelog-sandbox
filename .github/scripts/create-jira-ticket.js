/**
 * IW Design Library — Changelog → Jira Ticket Creator
 * ----------------------------------------------------------------------
 * Erstellt nach einem erfolgreichen Figma-Changelog-Update automatisch
 * einen Subtask ("UX Task") unter CXI-1186 mit einer sauber formatierten
 * ADF-Beschreibung der Änderungen.
 */

const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));
import { readFileSync } from 'fs';

const DOMAIN      = process.env.ATLASSIAN_DOMAIN;
const EMAIL       = process.env.ATLASSIAN_EMAIL;
const TOKEN       = process.env.ATLASSIAN_API_TOKEN;
const PROJECT_KEY = 'CXI';
const PARENT_KEY  = 'CXI-1186';
const CHANGELOG_URL_BASE = 'https://iw-changelog.netlify.app/#';
const auth        = Buffer.from(`${EMAIL}:${TOKEN}`).toString('base64');

const TYPE_LABELS = {
  new: 'NEW',
  changed: 'CHANGED',
  fixed: 'FIXED',
  deprecated: 'DEPRECATED',
};

// ── ADF BUILDER ────────────────────────────────────────────────────────────

function heading(text, level = 3) {
  return { type: 'heading', attrs: { level }, content: [{ type: 'text', text }] };
}

function paragraph(children) {
  return { type: 'paragraph', content: children };
}

function text(str, marks = []) {
  return marks.length ? { type: 'text', text: str, marks } : { type: 'text', text: str };
}

function bulletList(itemsContent) {
  return {
    type: 'bulletList',
    content: itemsContent.map(content => ({
      type: 'listItem',
      content: [paragraph(content)],
    })),
  };
}

function link(str, href) {
  return { type: 'text', text: str, marks: [{ type: 'link', attrs: { href } }] };
}

function buildDescriptionADF(entry) {
  const content = [];

  content.push(paragraph([
    text(`Design Library update `),
    text(entry.version, [{ type: 'strong' }]),
    text(` — ${entry.date}`),
  ]));

  for (const group of entry.groups) {
    content.push(heading(group.title, 3));

    const items = group.items.map(item => [
      text(`[${TYPE_LABELS[item.type] || item.type.toUpperCase()}] `, [{ type: 'strong' }]),
      text(`${item.title}: `),
      text(item.desc || ''),
    ]);

    content.push(bulletList(items));
  }

  if (entry.actions?.length) {
    content.push(heading('Action required', 3));
    content.push(bulletList(entry.actions.map(a => [text(a)])));
  }

  content.push(paragraph([
    text('Full changelog: '),
    link('IW Design Library Changelog', CHANGELOG_URL_BASE + entry.version),
  ]));

  return { type: 'doc', version: 1, content };
}

// ── MAIN ─────────────────────────────────────────────────────────────────

async function main() {
  if (!DOMAIN)  throw new Error('Missing ATLASSIAN_DOMAIN');
  if (!EMAIL)   throw new Error('Missing ATLASSIAN_EMAIL');
  if (!TOKEN)   throw new Error('Missing ATLASSIAN_API_TOKEN');

  const changelog = JSON.parse(readFileSync('changelog-data.json', 'utf8'));
  const latest = changelog[0]; // neuester Eintrag steht oben (unshift in generate-changelog.js)

  const summary = `Design Library Update ${latest.version} — ${latest.date}`;
  const descriptionADF = buildDescriptionADF(latest);

  const res = await fetch(`https://${DOMAIN}/rest/api/3/issue`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      fields: {
        project: { key: PROJECT_KEY },
        parent: { key: PARENT_KEY },
        summary,
        description: descriptionADF,
        issuetype: { name: 'UX Task' }, // korrekter Subtask-Typ im CXI-Projekt
      },
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Jira create failed: ${res.status} ${errText}`);
  }

  const data = await res.json();
  console.log(`✅ Jira ticket created: ${data.key} (parent: ${PARENT_KEY})`);
}

main().catch(err => {
  console.error('❌ Jira ticket creation failed:', err.message);
  process.exit(1);
});
