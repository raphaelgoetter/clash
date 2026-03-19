#!/usr/bin/env node

/**
 * Script de génération d'une liste de joueurs en transfert entre les clans de la famille.
 *
 * Usage:
 *   node scripts/listFamilyTransfers.js
 *   node scripts/listFamilyTransfers.js --out=transfers.json
 *
 * Note : ce script charge automatiquement le fichier `.env` (via dotenv)
 * afin que CLASH_API_KEY soit disponible en local.
 */

import 'dotenv/config';
import fs from 'fs/promises';
import path from 'path';
import { ALLOWED_CLANS, buildClanAnalysis } from '../backend/routes/clan.js';

const args = process.argv.slice(2);
const outArg = args.find((a) => a.startsWith('--out='));
const outputFile = outArg ? outArg.split('=')[1] : null;

async function main() {
  const transfers = [];

  for (const clanTag of ALLOWED_CLANS) {
    process.stdout.write(`Scanning ${clanTag}... `);
    try {
      const analysis = await buildClanAnalysis(clanTag);
      const clanTransfers = (analysis.members ?? [])
        .filter((m) => m.isFamilyTransfer)
        .map((m) => ({
          tag: m.tag,
          name: m.name,
          fromClan: m.transferFromClan ?? null,
          transferWeek: m.transferWeek ?? null,
          score: m.activityScore ?? null,
          verdict: m.verdict ?? null,
        }));

      transfers.push(...clanTransfers);
      console.log(`${clanTransfers.length} transfer(s) found`);
    } catch (err) {
      console.error(`failed (${err.message})`);
    }
  }

  if (outputFile) {
    const dest = path.resolve(process.cwd(), outputFile);
    await fs.writeFile(dest, JSON.stringify(transfers, null, 2));
    console.log(`Saved ${transfers.length} transfers to ${dest}`);
  } else {
    if (transfers.length === 0) {
      console.log('No transfers found.');
    } else {
      console.table(transfers);
    }
  }
}

main().catch((err) => {
  console.error('Unhandled error', err);
  process.exit(1);
});
