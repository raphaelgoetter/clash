// À charger avec `node --import @clash/commun/testing/registerFakeRedis.js` :
// remplace @upstash/redis par le Redis en mémoire, pour qu'aucun test ni
// outil local n'atteigne l'Upstash de production.
import { registerHooks } from "node:module";

const FAKE_REDIS_URL = new URL("./fakeRedis.js", import.meta.url).href;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@upstash/redis") return { url: FAKE_REDIS_URL, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});
