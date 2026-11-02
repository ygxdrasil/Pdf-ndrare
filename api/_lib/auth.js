// @ts-check
// Password login with a signed, httpOnly session cookie. Uses only Web Crypto,
// so the same code runs in Vercel Functions, Routing Middleware and Vite dev.

export const COOKIE = 'pa_session';
const DAYS = 30;
const enc = new TextEncoder();

/** Signing secret derived from the password: changing APP_PASSWORD logs everyone out. */
function secret() {
  const pw = process.env.APP_PASSWORD;
  if (!pw) return null;
  return `${process.env.AUTH_SECRET ?? ''}|pdf-andraren|${pw}`;
}

/** @param {string} s */
async function hmacKey(s) {
  return crypto.subtle.importKey('raw', enc.encode(s), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

/** @param {ArrayBuffer} buf */
function b64url(buf) {
  let s = '';
  for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** @param {string} s */
function fromB64url(s) {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export function passwordConfigured() {
  return !!process.env.APP_PASSWORD;
}

/** Constant-time password check (both sides are HMAC'd before comparing). */
export async function checkPassword(/** @type {string} */ given) {
  const s = secret();
  if (!s || typeof given !== 'string') return false;
  const key = await hmacKey(s);
  const a = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(`pw:${given}`)));
  const b = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(`pw:${process.env.APP_PASSWORD}`)));
  let diff = a.length ^ b.length;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export async function makeToken() {
  const s = secret();
  if (!s) throw new Error('APP_PASSWORD saknas');
  const exp = String(Date.now() + DAYS * 864e5);
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(s), enc.encode(exp));
  return `${exp}.${b64url(sig)}`;
}

/** @param {string | null | undefined} token */
export async function verifyToken(token) {
  const s = secret();
  if (!s || !token) return false;
  const [exp, sig] = token.split('.');
  if (!exp || !sig || !/^\d+$/.test(exp) || Number(exp) < Date.now()) return false;
  try {
    return await crypto.subtle.verify('HMAC', await hmacKey(s), fromB64url(sig), enc.encode(exp));
  } catch {
    return false;
  }
}

/** @param {Request} request @param {string} name */
export function getCookie(request, name) {
  const header = request.headers.get('cookie') ?? '';
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

/** @param {Request} request */
export async function isLoggedIn(request) {
  return verifyToken(getCookie(request, COOKIE));
}

/** @param {string} token */
export function sessionCookie(token) {
  return `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${DAYS * 86400}`;
}

export function clearCookie() {
  return `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

/** Swedish JSON error. @param {number} status @param {string} message */
export function jsonError(status, message, extra = {}) {
  return Response.json({ error: message, ...extra }, { status, headers: { 'cache-control': 'no-store' } });
}

/** @param {Request} request */
export function clientIp(request) {
  return (request.headers.get('x-forwarded-for') ?? '').split(',')[0].trim() || request.headers.get('x-real-ip') || 'okänd';
}
