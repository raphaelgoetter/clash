#!/usr/bin/env node
// Remove all _cumul fields from snapshot JSON files (post-processing).

import fs from 'fs/promises';
import path from 'path';

const SNAP_DIR = path.resolve('./data/snapshots');

async function run() {
  const files = await fs.readdir(SNAP_DIR);
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    const filePath = path.join(SNAP_DIR, f);
    const raw = await fs.readFile(filePath, 'utf8');
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!Array.isArray(data)) continue;

    let changed = false;
    for (const week of data) {
      if (!week.days || !Array.isArray(week.days)) continue;
      for (const day of week.days) {
        if (Object.prototype.hasOwnProperty.call(day, '_cumul')) {
          delete day._cumul;
          changed = true;
        }
      }
    }

    if (changed) {
      await fs.writeFile(filePath, JSON.stringify(data, null, 2));
      console.log('Stripped _cumul from', f);
    }
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
