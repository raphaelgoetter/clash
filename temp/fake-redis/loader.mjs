export async function resolve(specifier, context, next) {
  if (specifier === "@upstash/redis") return { url: new URL("./redis.mjs", import.meta.url).href, shortCircuit: true };
  return next(specifier, context);
}
