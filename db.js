"use strict";
/* =============================================================================
 * PERSISTANCE (équivalent SovereignDatabase, en SQLite natif Node 22+)
 * ========================================================================== */
const { DatabaseSync } = require("node:sqlite");
const path = require("node:path");

const DB_PATH = process.env.TOUTBOT_DB || path.join(__dirname, "toutbot.db");

const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA foreign_keys = ON;");

function run(sql, params = []) {
  return db.prepare(sql).run(...params);
}
function all(sql, params = []) {
  return db.prepare(sql).all(...params);
}
function one(sql, params = []) {
  const rows = db.prepare(sql).all(...params);
  return rows.length ? rows[0] : null;
}
function exec(sql) {
  db.exec(sql);
}

// Exécute plusieurs opérations comme une transaction atomique (≈ BEGIN IMMEDIATE).
function transaction(fn) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch { /* ignore */ }
    throw e;
  }
}

function initDb() {
  exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id_code TEXT UNIQUE NOT NULL,
      phone_or_pseudo TEXT UNIQUE NOT NULL,
      balance INTEGER NOT NULL DEFAULT 0 CHECK (balance >= 0),
      tier_price INTEGER NOT NULL DEFAULT 500,
      views_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      password_hash TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      user_id_code TEXT NOT NULL,
      amount_requested INTEGER NOT NULL,
      commission_taken INTEGER NOT NULL DEFAULT 0,
      net_amount INTEGER NOT NULL,
      user_reference_phone TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'EN_ATTENTE',
      ticket_code TEXT UNIQUE NOT NULL,
      created_at TEXT NOT NULL,
      processed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id_code TEXT NOT NULL,
      content TEXT NOT NULL,
      visibility TEXT NOT NULL DEFAULT 'PUBLIC',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      subscriber_id TEXT NOT NULL,
      creator_id TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (subscriber_id, creator_id)
    );

    CREATE TABLE IF NOT EXISTS support_tickets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id_code TEXT NOT NULL,
      tx_ticket_code TEXT NOT NULL,
      issue_type TEXT NOT NULL,
      message TEXT NOT NULL,
      admin_reply TEXT NOT NULL DEFAULT 'En attente de réponse',
      status TEXT NOT NULL DEFAULT 'OUVERT',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id_code TEXT NOT NULL,
      sender TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      actor TEXT NOT NULL,
      action TEXT NOT NULL,
      detail TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS direct_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id_code TEXT NOT NULL,
      sender TEXT NOT NULL,
      message TEXT NOT NULL,
      ticket_code TEXT NOT NULL DEFAULT '',
      read_by_admin INTEGER NOT NULL DEFAULT 0,
      read_by_user INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      sid TEXT PRIMARY KEY,
      data TEXT NOT NULL DEFAULT '{}',
      expires_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_tx_user ON transactions (user_id_code, id DESC);
    CREATE INDEX IF NOT EXISTS idx_tx_status ON transactions (status);
    CREATE INDEX IF NOT EXISTS idx_posts_user ON posts (user_id_code, id DESC);
    CREATE INDEX IF NOT EXISTS idx_subs_creator ON subscriptions (creator_id);
    CREATE INDEX IF NOT EXISTS idx_posts_created ON posts (id DESC);
    CREATE INDEX IF NOT EXISTS idx_chat_user ON chat_messages (user_id_code, id ASC);
    CREATE INDEX IF NOT EXISTS idx_dm_user ON direct_messages (user_id_code, id);
    CREATE INDEX IF NOT EXISTS idx_dm_unread_admin ON direct_messages (read_by_admin, user_id_code);
  `);

  // Recherche interne : FTS5 (mots exacts) + FTS5 sur racines (stems).
  // Contrairement à la version Python, on tient l'index à jour "à la main"
  // dans business.js (pas de triggers SQL, node:sqlite ne les gère pas
  // toujours bien avec les tables virtuelles) : simple et fiable.
  let ftsOk = true;
  try {
    exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS posts_fts USING fts5(
        content, tokenize='unicode61 remove_diacritics 2'
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS posts_stem USING fts5(
        stems, tokenize='unicode61'
      );
    `);
  } catch (e) {
    ftsOk = false;
    console.warn("[toutbot] FTS5 indisponible, recherche interne en mode simple :", e.message);
  }

  exec(`
    CREATE TABLE IF NOT EXISTS post_vectors (
      post_id INTEGER PRIMARY KEY,
      dim INTEGER NOT NULL,
      vec TEXT NOT NULL
    );
  `);

  return { ftsOk };
}

module.exports = { db, run, all, one, exec, transaction, initDb, DB_PATH };
