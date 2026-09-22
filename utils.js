"use strict";
/* =============================================================================
 * UTILITAIRES (équivalent des fonctions "OUTILS DE BASE" du fichier Python)
 * ========================================================================== */
const crypto = require("node:crypto");

class BusinessError extends Error {}
class AIUnavailable extends Error {}

function nowIso() {
  // Comme utcnow().isoformat() côté Python : secondes, pas de microsecondes.
  return new Date().toISOString().replace(/\.\d+Z$/, "");
}

function parseIso(value) {
  if (!value) return null;
  const d = new Date(value.endsWith("Z") || /[+-]\d\d:\d\d$/.test(value) ? value : value + "Z");
  return Number.isNaN(d.getTime()) ? null : d;
}

function fmtFcfa(value) {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n)) return "0 FCFA";
  return n.toLocaleString("fr-FR").replace(/\u202f|\u00a0/g, " ") + " FCFA";
}

const PSEUDO_RE = /^[A-Za-z0-9_.+-]{3,32}$/;
const PHONE_RE = /^\+?[0-9 ]{8,20}$/;
const YOUTUBE_RE = /(?:youtube\.com\/(?:shorts\/|watch\?v=)|youtu\.be\/)([A-Za-z0-9_-]{11})/;
const ISSUE_TYPES = ["DEPOT_NON_CREDITE", "RETRAIT_NON_RECU", "ABONNEMENT", "AUTRE"];

function newCode(prefix) {
  return `${prefix}-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// --- mots de passe : scrypt (équivalent maison de werkzeug.security) -------
function generatePasswordHash(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt:16384:8:1:${salt.toString("base64")}:${hash.toString("base64")}`;
}

function checkPasswordHash(stored, password) {
  try {
    const [algo, N, r, p, saltB64, hashB64] = String(stored).split(":");
    if (algo !== "scrypt") return false;
    const salt = Buffer.from(saltB64, "base64");
    const expected = Buffer.from(hashB64, "base64");
    const actual = crypto.scryptSync(password, salt, expected.length, {
      N: Number(N), r: Number(r), p: Number(p),
    });
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

const DUMMY_HASH = generatePasswordHash("mot-de-passe-bidon-anti-chronometrage");

function timingSafeEqualStr(a, b) {
  const ba = Buffer.from(String(a ?? ""), "utf8");
  const bb = Buffer.from(String(b ?? ""), "utf8");
  if (ba.length !== bb.length) {
    // comparaison quand même pour éviter une fuite de timing sur la longueur
    crypto.timingSafeEqual(ba, ba.length ? ba : Buffer.from("x"));
    return false;
  }
  return crypto.timingSafeEqual(ba, bb);
}

module.exports = {
  BusinessError, AIUnavailable,
  nowIso, parseIso, fmtFcfa,
  PSEUDO_RE, PHONE_RE, YOUTUBE_RE, ISSUE_TYPES,
  newCode, escapeHtml,
  generatePasswordHash, checkPasswordHash, DUMMY_HASH,
  timingSafeEqualStr,
};
