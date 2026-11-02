// @ts-check
// POST /api/login {password} -> sets the session cookie.

import { checkPassword, clientIp, jsonError, makeToken, passwordConfigured, sessionCookie } from './_lib/auth.js';
import { take } from './_lib/ratelimit.js';

/** @param {Request} request */
export async function POST(request) {
  if (!passwordConfigured()) {
    return jsonError(500, 'Lösenordet är inte inställt ännu (APP_PASSWORD saknas). Säg till Hamza.');
  }
  const lim = take(`login:${clientIp(request)}`, 10, 15 * 60_000);
  if (!lim.ok) return jsonError(429, 'För många försök. Vänta en kvart och försök igen.');
  // Also a limit across all visitors, so guessing from many addresses at once is slowed down too.
  if (!take('login:all', 60, 60 * 60_000).ok) return jsonError(429, 'För många försök. Vänta en stund och försök igen.');
  let password = '';
  try {
    const body = await request.json();
    password = typeof body?.password === 'string' ? body.password : '';
  } catch {
    return jsonError(400, 'Skriv lösenordet och försök igen.');
  }
  if (!(await checkPassword(password))) return jsonError(401, 'Fel lösenord. Försök igen.');
  return Response.json({ ok: true }, { headers: { 'set-cookie': sessionCookie(await makeToken()), 'cache-control': 'no-store' } });
}
