"use strict";
/* =============================================================================
 * SESSIONS (cookie "sid" opaque -> ligne SQLite). Équivalent fonctionnel de
 * la session signée de Flask, mais stockée côté serveur (plus simple et
 * tout aussi sûr, tant que le cookie est HttpOnly + Secure en prod).
 * ========================================================================== */
const crypto = require("node:crypto");
const { run, one } = require("./db");

const SESSION_TTL_MS = 7 * 24 * 3600 * 1000; // 7 jours, comme PERMANENT_SESSION_LIFETIME

function parseCookies(header) {
  const out = {};
  (header || "").split(";").forEach((part) => {
    const i = part.indexOf("=");
    if (i === -1) return;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  });
  return out;
}

function loadSession(req) {
  const cookies = parseCookies(req.headers.cookie);
  const sid = cookies.sid;
  if (sid) {
    const row = one("SELECT data, expires_at FROM sessions WHERE sid=?", [sid]);
    if (row && row.expires_at > Date.now()) {
      try {
        return { sid, data: JSON.parse(row.data), isNew: false };
      } catch { /* données corrompues -> nouvelle session */ }
    }
    if (row) run("DELETE FROM sessions WHERE sid=?", [sid]);
  }
  return { sid: crypto.randomBytes(24).toString("hex"), data: {}, isNew: true };
}

function saveSession(session) {
  run(
    "INSERT INTO sessions (sid, data, expires_at) VALUES (?, ?, ?) " +
      "ON CONFLICT (sid) DO UPDATE SET data=excluded.data, expires_at=excluded.expires_at",
    [session.sid, JSON.stringify(session.data), Date.now() + SESSION_TTL_MS]
  );
}

function clearSession(session) {
  run("DELETE FROM sessions WHERE sid=?", [session.sid]);
  session.sid = crypto.randomBytes(24).toString("hex");
  session.data = {};
  session.isNew = true;
}

function sessionCookieHeader(session, cookieSecure) {
  const parts = [
    `sid=${session.sid}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  ];
  if (cookieSecure) parts.push("Secure");
  return parts.join("; ");
}

module.exports = { loadSession, saveSession, clearSession, sessionCookieHeader };
