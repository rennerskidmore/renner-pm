#!/usr/bin/env node
/**
 * Normalize Trello board exports (migration/source/*.json) into a single
 * backend-agnostic tasks file: migration/normalized-trello.json
 *
 * Preserves: titles, descriptions, buckets (original list names), derived
 * status, labels, derived priority, due dates, creation dates (from the
 * Trello id timestamp), completion dates (dateCompleted), checklists with
 * item states, comments (from backfilled actions), attachment URLs,
 * assignees, archived flags, and Trello short URLs for traceability.
 */
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, 'source');

const BOARDS = [
  { file: 'personal.json', key: 'personal', name: 'Personal' },
  { file: 'intuitive-intel.json', key: 'intuitive-intel', name: 'Intuitive Intel' },
  { file: 'votf.json', key: 'votf', name: 'VOTF' },
];

// Lists that hold reference material / planning notes rather than work items.
const REFERENCE_LISTS = new Set([
  'team info', 'project overview', 'votf project', 'josh waldo notes',
  '3, 6, 12 month goals', 'daily practices', 'weekly goal tracking',
  'monthly goal tracking', 'annual goal tracking', 'leads',
  'outreach for follow up', 'short term scheduling goals',
]);

function listStatus(listName) {
  const n = listName.trim().toLowerCase();
  if (REFERENCE_LISTS.has(n)) return 'reference';
  if (n.includes('icebox') || n.includes('ice box')) return 'icebox';
  if (n === 'todo' || n === 'work hit list') return 'todo';
  if (n === 'doing' || n.startsWith('friday call')) return 'doing';
  // Everything else on these boards is a done bucket: "DONE", "Done March 26",
  // "April 26", "Done Nov 13th - Dec 13th", "February 2026", etc.
  return 'done';
}

function idToDate(trelloId) {
  // First 8 hex chars of a Trello/Mongo ObjectId are seconds since epoch.
  return new Date(parseInt(trelloId.slice(0, 8), 16) * 1000).toISOString();
}

// Priority signals present in the historical data.
function derivePriority(labelNames) {
  const names = labelNames.map((l) => l.trim().toLowerCase());
  if (names.includes('priority') || names.includes('1')) return 'high';
  if (names.includes('2')) return 'medium';
  return 'none';
}

const NAME_FIX = { 'renner_is_working': 'Renner Skidmore' };

const out = [];
const stats = {};

for (const board of BOARDS) {
  const data = JSON.parse(fs.readFileSync(path.join(SRC, board.file), 'utf8'));
  const lists = Object.fromEntries(data.lists.map((l) => [l.id, l]));
  const members = Object.fromEntries(
    data.members.map((m) => [m.id, NAME_FIX[m.username] || m.fullName])
  );
  const checklistsByCard = {};
  for (const cl of data.checklists) {
    (checklistsByCard[cl.idCard] ||= []).push(cl);
  }
  const commentsByCard = {};
  const createdByCard = {};
  for (const a of data.actions) {
    if (a.type === 'commentCard' || a.type === 'copyCommentCard') {
      (commentsByCard[a.data.card.id] ||= []).push({
        author: a.memberCreator ? (NAME_FIX[a.memberCreator.username] || a.memberCreator.fullName) : 'Unknown',
        date: a.date,
        text: a.data.text || '',
      });
    } else if (a.type === 'createCard' || a.type === 'copyCard') {
      createdByCard[a.data.card.id] = a.date;
    }
  }

  let nComments = 0;
  for (const card of data.cards) {
    const list = lists[card.idList];
    const listName = list ? list.name.trim() : 'Unknown';
    const labelNames = (card.labels || [])
      .map((l) => (l.name || '').trim())
      .filter(Boolean);
    const colorOnlyLabels = (card.labels || [])
      .filter((l) => !(l.name || '').trim())
      .map((l) => l.color);
    const checklists = (checklistsByCard[card.id] || [])
      .sort((a, b) => a.pos - b.pos)
      .map((cl) => ({
        name: cl.name,
        items: cl.checkItems
          .sort((a, b) => a.pos - b.pos)
          .map((it) => ({ name: it.name, done: it.state === 'complete' })),
      }));
    const comments = (commentsByCard[card.id] || []).sort((a, b) =>
      a.date.localeCompare(b.date)
    );
    nComments += comments.length;
    const status = listStatus(listName);

    out.push({
      source: 'trello',
      source_id: card.id,
      source_url: card.shortUrl,
      board: board.key,
      title: card.name,
      description: card.desc || '',
      bucket: listName,
      status,
      archived: !!(card.closed || (list && list.closed)),
      priority: derivePriority(labelNames),
      labels: labelNames,
      label_colors: colorOnlyLabels,
      due: card.due,
      due_complete: !!card.dueComplete,
      created_at: createdByCard[card.id] || idToDate(card.id),
      completed_at: card.dateCompleted || null,
      position: card.pos,
      assignees: (card.idMembers || []).map((id) => members[id]).filter(Boolean),
      checklists,
      comments,
      attachments: (card.attachments || [])
        .filter((a) => a.url)
        .map((a) => ({ name: a.name, url: a.url })),
    });
  }

  stats[board.key] = {
    cards: data.cards.length,
    comments: nComments,
    withDue: data.cards.filter((c) => c.due).length,
    withChecklists: data.cards.filter((c) => (checklistsByCard[c.id] || []).length).length,
  };
}

fs.writeFileSync(
  path.join(__dirname, 'normalized-trello.json'),
  JSON.stringify(out, null, 1)
);
console.log(JSON.stringify(stats, null, 2));
console.log(`total tasks: ${out.length}`);
const byStatus = {};
for (const t of out) byStatus[t.status] = (byStatus[t.status] || 0) + 1;
console.log('by status:', JSON.stringify(byStatus));
const byPriority = {};
for (const t of out) byPriority[t.priority] = (byPriority[t.priority] || 0) + 1;
console.log('by priority:', JSON.stringify(byPriority));
