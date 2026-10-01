// Redis en mémoire (sous-ensemble utilisé par elixirDuel.js) pour les tests locaux
const store = new Map();
const hash = (k) => { if (!store.has(k)) store.set(k, new Map()); return store.get(k); };
export class Redis {
  async get(k) { const v = store.get(k); return typeof v === "string" ? v : null; }
  async set(k, v) { store.set(k, v); return "OK"; }
  async del(...ks) { let n = 0; for (const k of ks) n += store.delete(k) ? 1 : 0; return n; }
  async hget(k, f) { return hash(k).get(f) ?? null; }
  async hset(k, obj) { for (const [f, v] of Object.entries(obj)) hash(k).set(f, String(v)); return 1; }
  async hsetnx(k, f, v) { if (hash(k).has(f)) return 0; hash(k).set(f, v); return 1; }
  async hgetall(k) { const h = store.get(k); return h instanceof Map ? [...h].flat() : []; }
  async scan(_c, { match }) { const re = new RegExp("^" + match.replace(/\*/g, ".*") + "$"); return ["0", [...store.keys()].filter((k) => re.test(k))]; }
}
