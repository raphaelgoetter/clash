// Redis en mémoire (sous-ensemble de l'API @upstash/redis) pour les tests et outils locaux.
const store = new Map();
const hash = (k) => { if (!store.has(k)) store.set(k, new Map()); return store.get(k); };
// Ensembles triés : membre → score, dans un espace séparé.
const zsets = new Map();
const zset = (k) => { if (!zsets.has(k)) zsets.set(k, new Map()); return zsets.get(k); };
const present = (k) => (store.has(k) && !(store.get(k) instanceof Map && store.get(k).size === 0)) || zsets.has(k);
export class Redis {
  // Permet à un test de vérifier qu'il ne tourne pas sur l'Upstash de production.
  static isFake = true;
  async get(k) { const v = store.get(k); return typeof v === "string" ? v : null; }
  async set(k, v, opts = {}) { if (opts.nx && store.has(k)) return null; store.set(k, v); return "OK"; }
  async del(...ks) { let n = 0; for (const k of ks) n += store.delete(k) | zsets.delete(k) ? 1 : 0; return n; }
  async exists(...ks) { return ks.filter(present).length; }
  async hget(k, f) { return hash(k).get(f) ?? null; }
  async hmget(k, ...fs) { const h = hash(k); return Object.fromEntries(fs.map((f) => [f, h.get(f) ?? null])); }
  async hdel(k, ...fs) { let n = 0; for (const f of fs) n += hash(k).delete(f) ? 1 : 0; return n; }
  async hlen(k) { const h = store.get(k); return h instanceof Map ? h.size : 0; }
  async hset(k, obj) { for (const [f, v] of Object.entries(obj)) hash(k).set(f, String(v)); return 1; }
  async hsetnx(k, f, v) { if (hash(k).has(f)) return 0; hash(k).set(f, v); return 1; }
  async hkeys(k) { const h = store.get(k); return h instanceof Map ? [...h.keys()] : []; }
  async hgetall(k) { const h = store.get(k); return h instanceof Map ? [...h].flat() : []; }
  async expire() { return 1; }
  async incr(k) { const n = Number(store.get(k) || 0) + 1; store.set(k, String(n)); return n; }
  async scan(_c, { match }) { const re = new RegExp("^" + match.replace(/\*/g, ".*") + "$"); return ["0", [...new Set([...store.keys(), ...zsets.keys()])].filter((k) => re.test(k))]; }
  async zincrby(k, inc, m) { const z = zset(k); z.set(String(m), (z.get(String(m)) || 0) + Number(inc)); return z.get(String(m)); }
  async zrange(k, start, stop, { rev = false, withScores = false } = {}) {
    const sorted = [...(zsets.get(k) || [])].sort((a, b) => (rev ? b[1] - a[1] : a[1] - b[1]));
    const sliced = sorted.slice(start, stop === -1 ? undefined : stop + 1);
    return withScores ? sliced.flat() : sliced.map(([m]) => m);
  }
}
