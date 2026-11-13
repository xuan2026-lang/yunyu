const crypto = require('node:crypto');
const { now } = require('./db');

const SESSION_COOKIE = 'yunyu_session';
const SESSION_DAYS = 30;

const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    username: user.username,
    display_name: user.display_name,
    avatar_color: user.avatar_color,
    created_at: user.created_at
  };
}

function getUserByToken(db, token) {
  if (!token || typeof token !== 'string') return null;
  const tokenHash = hashToken(token);
  const row = db.prepare(`SELECT u.*, s.expires_at AS session_expires_at
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ?`).get(tokenHash);
  if (!row) return null;
  if (row.session_expires_at <= now()) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
    return null;
  }
  return row;
}

function createSession(db, userId, res) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now());
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
    .run(hashToken(token), userId, expiresAt, now());
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.COOKIE_SECURE === '1',
    maxAge: SESSION_DAYS * 86400000,
    path: '/'
  });
  return expiresAt;
}

function destroySession(db, req, res) {
  const token = req.cookies?.[SESSION_COOKIE];
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
  res.clearCookie(SESSION_COOKIE, { httpOnly: true, sameSite: 'lax', path: '/' });
}

function attachUser(db) {
  return (req, _res, next) => {
    req.user = getUserByToken(db, req.cookies?.[SESSION_COOKIE]);
    next();
  };
}

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: '请先登录后再操作' });
  next();
}

function parseCookieHeader(header) {
  const result = {};
  if (!header) return result;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    try { result[key] = decodeURIComponent(value); } catch { result[key] = value; }
  }
  return result;
}

module.exports = {
  SESSION_COOKIE,
  publicUser,
  getUserByToken,
  createSession,
  destroySession,
  attachUser,
  requireAuth,
  parseCookieHeader
};
