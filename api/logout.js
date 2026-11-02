// @ts-check
// POST /api/logout -> clears the session cookie.

import { clearCookie } from './_lib/auth.js';

export function POST() {
  return Response.json({ ok: true }, { headers: { 'set-cookie': clearCookie(), 'cache-control': 'no-store' } });
}
