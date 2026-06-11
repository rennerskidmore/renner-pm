#!/usr/bin/env node
/**
 * Normalize the live GitHub issues from rennerskidmore/renner-pm
 * (migration/source/github-issues.json, captured 2026-06-11 via the GitHub
 * API) into the same shape as normalized-trello.json.
 * Output: migration/normalized-github.json
 *
 * Mapping rules:
 *  - board: label `in2` -> intuitive-intel, `votf` -> votf, `personal` ->
 *    personal; unlabeled defaults to intuitive-intel (the two unlabeled real
 *    issues, #28 LinkedIn post and #26 round-2 decisions, are work items;
 *    #29 mentions VOTF explicitly and is mapped to votf).
 *  - status: CLOSED -> done; label `doing` -> doing; else todo.
 *  - priority: label `priority:high|medium|low`, else "Priority: X" line in
 *    the body, else none.
 *  - due: "**Due:** YYYY-MM-DD" or "Due: <weekday> (Month D)" body lines
 *    (year inferred as 2026).
 *  - Test issues #24 and #27 are excluded.
 */
const fs = require('fs');
const path = require('path');

const issues = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'source', 'github-issues.json'), 'utf8')
);

const EXCLUDE = new Set([24, 27]);
const BOARD_BY_LABEL = { in2: 'intuitive-intel', votf: 'votf', personal: 'personal' };
const MONTHS = ['january','february','march','april','may','june','july','august','september','october','november','december'];

const decode = (s) =>
  s.replace(/&#39;/g, "'").replace(/&#34;/g, '"').replace(/&amp;/g, '&');

function parseDue(body) {
  let m = body.match(/\*\*Due:\*\*\s*(\d{4}-\d{2}-\d{2})/i);
  if (m) return `${m[1]}T17:00:00.000Z`;
  m = body.match(/Due:\s*\w+\s*\((\w+)\s+(\d{1,2})\)/i);
  if (m) {
    const month = MONTHS.indexOf(m[1].toLowerCase());
    if (month >= 0) {
      const d = new Date(Date.UTC(2026, month, parseInt(m[2], 10), 17));
      return d.toISOString();
    }
  }
  return null;
}

function parsePriority(labels, body) {
  for (const l of labels) {
    const m = l.match(/^priority:(high|medium|low)$/);
    if (m) return m[1];
  }
  const m = body.match(/Priority:\s*(high|medium|low)/i);
  if (m) return m[1].toLowerCase();
  return 'none';
}

const out = [];
for (const is of issues) {
  if (EXCLUDE.has(is.number)) continue;
  const body = decode(is.body || '');
  const labels = is.labels || [];
  let board = 'intuitive-intel';
  for (const l of labels) if (BOARD_BY_LABEL[l]) board = BOARD_BY_LABEL[l];
  if (is.number === 29) board = 'votf';
  const status =
    is.state === 'CLOSED' ? 'done' : labels.includes('doing') ? 'doing' : 'todo';
  const extraLabels = labels.filter(
    (l) => !BOARD_BY_LABEL[l] && !['todo', 'doing'].includes(l) && !l.startsWith('priority:')
  );

  out.push({
    source: 'github',
    source_id: `renner-pm#${is.number}`,
    source_url: `https://github.com/rennerskidmore/renner-pm/issues/${is.number}`,
    board,
    title: decode(is.title),
    description: body,
    bucket: status === 'done' ? 'DONE' : status === 'doing' ? 'DOING' : 'TODO',
    status,
    archived: false,
    priority: parsePriority(labels, body),
    labels: extraLabels,
    label_colors: [],
    due: parseDue(body),
    due_complete: false,
    created_at: is.created_at,
    completed_at: is.state === 'CLOSED' ? is.updated_at : null,
    position: is.number * 1000,
    assignees: ['Renner Skidmore'],
    checklists: [],
    comments: [],
    attachments: [],
  });
}

fs.writeFileSync(
  path.join(__dirname, 'normalized-github.json'),
  JSON.stringify(out, null, 1)
);
const byBoard = {};
for (const t of out) byBoard[t.board] = (byBoard[t.board] || 0) + 1;
console.log(`tasks: ${out.length}`, JSON.stringify(byBoard));
const byStatus = {};
for (const t of out) byStatus[t.status] = (byStatus[t.status] || 0) + 1;
console.log('by status:', JSON.stringify(byStatus));
console.log('with due:', out.filter((t) => t.due).length, '| with priority:', out.filter((t) => t.priority !== 'none').length);
