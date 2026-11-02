// @ts-check
// Vercel Routing Middleware: every page and API route needs the session
// cookie, except the login page and the login endpoint.

import { next } from '@vercel/functions';
import { isLoggedIn } from './api/_lib/auth.js';

export const config = {
  matcher: ['/((?!login\\.html|api/login|favicon\\.svg).*)'],
};

/** @param {Request} request */
export default async function middleware(request) {
  if (await isLoggedIn(request)) return next();
  const url = new URL(request.url);
  if (url.pathname.startsWith('/api/')) {
    return Response.json({ error: 'Du är utloggad. Ladda om sidan och logga in igen.' }, { status: 401 });
  }
  return Response.redirect(new URL('/login.html', request.url), 302);
}
