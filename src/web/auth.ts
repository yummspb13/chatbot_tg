// Аутентификация мини-PWA: пароль из env → подписанная HMAC httpOnly-cookie.

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { config } from '../config';

const COOKIE_NAME = 'fxagent_session';
const MAX_AGE_MS = 30 * 86400_000;

function sign(value: string): string {
  return createHmac('sha256', config.sessionSecret).update(value).digest('base64url');
}

export function makeSessionCookie(): string {
  const ts = String(Date.now());
  return `${ts}.${sign(ts)}`;
}

export function verifySessionCookie(raw: string | undefined): boolean {
  if (!raw) return false;
  const [ts, sig] = raw.split('.');
  if (!ts || !sig) return false;
  const expected = sign(ts);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
  const age = Date.now() - Number(ts);
  return Number.isFinite(age) && age >= 0 && age < MAX_AGE_MS;
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

export function isAuthed(req: Request): boolean {
  return verifySessionCookie(parseCookies(req.headers.cookie)[COOKIE_NAME]);
}

export function checkPassword(password: unknown): boolean {
  if (!config.adminPassword || typeof password !== 'string') return false;
  const a = Buffer.from(password);
  const b = Buffer.from(config.adminPassword);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function setSessionCookie(req: Request, res: Response): void {
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  res.setHeader(
    'Set-Cookie',
    `${COOKIE_NAME}=${makeSessionCookie()}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE_MS / 1000}${secure ? '; Secure' : ''}`,
  );
}

export function clearSessionCookie(res: Response): void {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!config.adminPassword) {
    res.status(503).json({ error: 'ADMIN_PASSWORD не задан — админка выключена' });
    return;
  }
  if (!isAuthed(req)) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  next();
}
