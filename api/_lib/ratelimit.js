// @ts-check
// Simple sliding-window rate limits kept in the function instance's memory.
// They stop a leaked link or a stuck browser from running up the bill; the
// hard ceiling is the monthly spend limit set on the Anthropic account.

/** @type {Map<string, number[]>} */
const hits = new Map();

/**
 * @param {string} key
 * @param {number} limit
 * @param {number} windowMs
 * @returns {{ ok: boolean, retryAfter: number }}
 */
export function take(key, limit, windowMs) {
  const now = Date.now();
  const list = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  if (list.length >= limit) {
    hits.set(key, list);
    return { ok: false, retryAfter: Math.ceil((windowMs - (now - list[0])) / 1000) };
  }
  list.push(now);
  hits.set(key, list);
  if (hits.size > 5000) for (const [k, v] of hits) if (!v.some((t) => now - t < windowMs)) hits.delete(k);
  return { ok: true, retryAfter: 0 };
}

const num = (/** @type {string | undefined} */ v, /** @type {number} */ d) => (v && /^\d+$/.test(v) ? Number(v) : d);

/** Limits for the AI route: per visitor and for the whole app. */
export function chatLimits() {
  return {
    perIpPer10Min: num(process.env.RATE_LIMIT_PER_10_MIN, 30),
    perDay: num(process.env.RATE_LIMIT_PER_DAY, 300),
  };
}
