#!/usr/bin/env node
/**
 * Load normalized tasks into the PM system through pm-app's /api/import
 * endpoint (idempotent upsert on (source, source_id)).
 *
 * Usage: PM_APP_URL=https://<project>.supabase.co/functions/v1/pm-app/<UI_SECRET> node load.js
 */
const fs = require('fs');
const path = require('path');

const BASE = process.env.PM_APP_URL;
if (!BASE) {
  console.error('PM_APP_URL env var required (includes the UI secret)');
  process.exit(1);
}

const BATCH = 50;

async function main() {
  const tasks = [
    ...JSON.parse(fs.readFileSync(path.join(__dirname, 'normalized-trello.json'), 'utf8')),
    ...JSON.parse(fs.readFileSync(path.join(__dirname, 'normalized-github.json'), 'utf8')),
  ];
  console.log(`loading ${tasks.length} tasks in batches of ${BATCH}...`);
  let inserted = 0, updated = 0, comments = 0;
  for (let i = 0; i < tasks.length; i += BATCH) {
    const batch = tasks.slice(i, i + BATCH);
    const res = await fetch(`${BASE}/api/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(batch),
    });
    if (!res.ok) {
      console.error(`batch ${i / BATCH} failed: HTTP ${res.status}: ${await res.text()}`);
      process.exit(1);
    }
    const r = await res.json();
    if (r.error) {
      console.error(`batch ${i / BATCH} error:`, r.error);
      process.exit(1);
    }
    inserted += r.inserted; updated += r.updated; comments += r.comments;
    process.stdout.write(`\r${Math.min(i + BATCH, tasks.length)}/${tasks.length}`);
  }
  console.log(`\ndone: inserted=${inserted} updated=${updated} comments=${comments}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
