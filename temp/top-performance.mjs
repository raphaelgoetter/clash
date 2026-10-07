// Classement Performance GDC (3 semaines) des membres actuels des 3 clans, lecture seule Redis.
import "dotenv/config";
import fs from "node:fs";
import { Redis } from "@upstash/redis";
const players = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const redis = new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN, automaticDeserialization: false });
const raw = await redis.hgetall("matchupPerf:war");
const all = Array.isArray(raw) ? Object.fromEntries(raw.flatMap((v, i) => (i % 2 ? [] : [[v, raw[i + 1]]]))) : raw;
const minT = Date.now() - 21 * 864e5;
const rows = players.map((p) => {
  const s = JSON.parse(all?.[p.tag.replace("#", "")] ?? "[]").filter((x) => x.t >= minT);
  const w = s.filter((x) => x.w).length;
  const exp = s.reduce((a, x) => a + x.p, 0);
  const sd = Math.sqrt(s.reduce((a, x) => a + x.p * (1 - x.p), 0));
  return { name: p.name, clan: p.clan.name, n: s.length, w, exp, gap: w - exp, sig: sd > 0 && Math.abs(w - exp) >= 2 * sd };
}).filter((r) => r.n >= 4).sort((a, b) => b.gap - a.gap);
console.log(Object.keys(all ?? {}).length, rows.length);
console.log(JSON.stringify(Object.values(all ?? {})[0]).slice(0, 200));
for (const r of rows.slice(0, 15)) console.log(`${r.name} | ${r.clan} | ${r.w}/${r.n} | ${r.exp.toFixed(1)} | ${r.gap >= 0 ? "+" : ""}${r.gap.toFixed(1)} | ${r.sig ? "SIG" : ""}`);
const ts = Object.values(all).flatMap((v) => JSON.parse(v).map((x) => x.t));
console.log(new Date(Math.min(...ts)).toISOString(), new Date(Math.max(...ts)).toISOString());
