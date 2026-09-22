"use strict";
/* =============================================================================
 * 💎 TOUTBOT PRESTIGE — PORTAGE NODE.JS (sans dépendance externe)
 * =============================================================================
 * Portage fidèle de toutbot_app.py (Flask) vers Node.js pur : node:http +
 * node:sqlite (natifs à Node ≥ 22). Aucun `npm install` requis.
 *
 * Simplifications assumées (voir README.md) :
 *   - Elasticsearch / Qdrant (optionnels et désactivés par défaut côté
 *     Python) ne sont pas portés. Le reste (FTS5, racines FR, vecteurs
 *     par hachage, Wikipedia/DuckDuckGo/Brave/SearXNG, RRF) l'est.
 *   - Le proxy HTTP sortant (TOUTBOT_HTTP_PROXY) n'est pas porté (fetch()
 *     natif ne le supporte pas sans lib tierce).
 * ========================================================================== */
const http = require("node:http");
const crypto = require("node:crypto");
const querystring = require("node:querystring");

const { run, all, one, initDb } = require("./db");
const {
  BusinessError, AIUnavailable, nowIso, fmtFcfa,
  PSEUDO_RE, PHONE_RE, YOUTUBE_RE, ISSUE_TYPES,
  generatePasswordHash, checkPasswordHash, DUMMY_HASH, timingSafeEqualStr,
} = require("./utils");
const { loadSession, saveSession, clearSession, sessionCookieHeader } = require("./session");
const business = require("./business");
const search = require("./search");
const ai = require("./ai");
const tpl = require("./templates");

// --------------------------------------------------------------- config
const HOST = process.env.TOUTBOT_HOST || "0.0.0.0";
const PORT = Number(process.env.TOUTBOT_PORT || "3000");
const DEBUG = process.env.TOUTBOT_DEBUG === "1";
const COOKIE_SECURE = process.env.TOUTBOT_COOKIE_SECURE === "1";
const ADMIN_PASSWORD = process.env.TOUTBOT_ADMIN_PASSWORD || "Numberone_100_ans";
const MAX_CONTENT_LENGTH = 64 * 1024;

let FTS_OK = true;

// --------------------------------------------------------------- rate limiter
class RateLimiter {
  constructor() { this.hits = new Map(); }
  allow(key, limit, windowMs) {
    const now = Date.now();
    if (this.hits.size > 20000) {
      for (const [k, arr] of this.hits) {
        if (!arr.length || arr[arr.length - 1] < now - 3600_000) this.hits.delete(k);
      }
    }
    let arr = this.hits.get(key);
    if (!arr) { arr = []; this.hits.set(key, arr); }
    while (arr.length && arr[0] <= now - windowMs) arr.shift();
    if (arr.length >= limit) return false;
    arr.push(now);
    return true;
  }
}
const LIMITER = new RateLimiter();

// --------------------------------------------------------------- erreurs HTTP
class HttpAbort extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const ERROR_MESSAGES = {
  400: "Requête refusée (session expirée ou formulaire invalide). Recharge la page.",
  401: "Connecte-toi d'abord.",
  403: "Accès interdit.",
  404: "Page introuvable.",
  405: "Méthode non autorisée.",
  413: "Message trop volumineux.",
  429: "Trop de demandes. Patiente un moment puis réessaie.",
};

// --------------------------------------------------------------- utilisateur
function currentUser(session) {
  const code = session.data.uid;
  if (!code) return null;
  const row = one("SELECT * FROM users WHERE user_id_code=?", [code]);
  if (!row) { delete session.data.uid; return null; }
  return row;
}

function startSession(session, userCode) {
  session.data = { uid: userCode, csrf: crypto.randomBytes(16).toString("hex") };
}

function flash(session, message, category = "ok") {
  session.data.flashes = session.data.flashes || [];
  session.data.flashes.push([category, message]);
}

function unreadDmCount(user) {
  if (!user) return 0;
  const row = one("SELECT COUNT(*) AS n FROM direct_messages WHERE user_id_code=? AND read_by_user=0", [user.user_id_code]);
  return row ? row.n : 0;
}

// --------------------------------------------------------------- routeur
const routes = []; // { method, regex, keys, handler }
function addRoute(method, path, handler) {
  const keys = [];
  const pattern = path.replace(/:[A-Za-z_]+/g, (m) => { keys.push(m.slice(1)); return "([^/]+)"; });
  routes.push({ method, regex: new RegExp(`^${pattern}$`), keys, handler });
}
const get = (path, handler) => addRoute("GET", path, handler);
const post = (path, handler) => addRoute("POST", path, handler);
const getpost = (path, handler) => { addRoute("GET", path, handler); addRoute("POST", path, handler); };

// --------------------------------------------------------------- middlewares
function loginRequired(handler) {
  return async (ctx) => {
    if (!currentUser(ctx.session)) {
      if (ctx.path.startsWith("/api/")) throw new HttpAbort(401, ERROR_MESSAGES[401]);
      return ctx.redirect("/login");
    }
    return handler(ctx);
  };
}

function adminRequired(handler) {
  return async (ctx) => {
    const startedAt = ctx.session.data.adminAt || 0;
    if (!ctx.session.data.admin || Date.now() / 1000 - startedAt > 7200) {
      delete ctx.session.data.admin;
      return ctx.redirect("/admin/login");
    }
    return handler(ctx);
  };
}

function rateLimited(name, limit, windowSec, byUser = false) {
  return (handler) => async (ctx) => {
    if (ctx.method === "POST") {
      const who = byUser ? ctx.session.data.uid || ctx.clientIp : ctx.clientIp;
      if (!LIMITER.allow(`${name}:${who}`, limit, windowSec * 1000)) throw new HttpAbort(429, ERROR_MESSAGES[429]);
    }
    return handler(ctx);
  };
}

// =============================================================================
// ROUTES — Authentification
// =============================================================================

get("/", async (ctx) => {
  if (currentUser(ctx.session)) return ctx.redirect("/chat");
  return ctx.html(tpl.home(ctx.pageCtx()));
});

getpost("/register", rateLimited("register", 5, 3600)(async (ctx) => {
  if (currentUser(ctx.session)) return ctx.redirect("/chat");
  if (ctx.method === "POST") {
    const pseudo = (ctx.body.pseudo || "").trim();
    const password = ctx.body.password || "";
    if (!PSEUDO_RE.test(pseudo) && !PHONE_RE.test(pseudo)) {
      flash(ctx.session, "Pseudo ou numéro invalide.", "err");
    } else if (password.length < 8) {
      flash(ctx.session, "Mot de passe trop court (8 caractères min).", "err");
    } else {
      const code = require("./utils").newCode("USR");
      try {
        run(
          "INSERT INTO users (user_id_code, phone_or_pseudo, password_hash, created_at) VALUES (?, ?, ?, ?)",
          [code, pseudo, generatePasswordHash(password), nowIso()]
        );
        startSession(ctx.session, code);
        business.audit(code, "REGISTER", pseudo);
        flash(ctx.session, "Compte créé. Bienvenue !", "ok");
        return ctx.redirect("/chat");
      } catch (e) {
        flash(ctx.session, "Ce pseudo ou numéro est déjà pris.", "err");
      }
    }
  }
  return ctx.html(tpl.auth(ctx.pageCtx(), { title: "Créer un compte", isRegister: true }));
}));

getpost("/login", rateLimited("login", 10, 600)(async (ctx) => {
  if (currentUser(ctx.session)) return ctx.redirect("/chat");
  if (ctx.method === "POST") {
    const pseudo = (ctx.body.pseudo || "").trim();
    const password = ctx.body.password || "";
    const row = one("SELECT * FROM users WHERE phone_or_pseudo=?", [pseudo]);
    if (row && checkPasswordHash(row.password_hash || DUMMY_HASH, password)) {
      startSession(ctx.session, row.user_id_code);
      business.audit(row.user_id_code, "LOGIN", pseudo);
      return ctx.redirect("/chat");
    }
    checkPasswordHash(DUMMY_HASH, password); // anti-timing
    flash(ctx.session, "Identifiants incorrects.", "err");
  }
  return ctx.html(tpl.auth(ctx.pageCtx(), { title: "Connexion", isRegister: false }));
}));

post("/logout", async (ctx) => {
  clearSession(ctx.session);
  return ctx.redirect("/");
});

// =============================================================================
// ROUTES — Chat IA
// =============================================================================

get("/chat", loginRequired(async (ctx) => {
  const user = currentUser(ctx.session);
  const rows = all(
    "SELECT sender, message FROM chat_messages WHERE user_id_code=? ORDER BY id DESC LIMIT ?",
    [user.user_id_code, 20]
  ).reverse();
  return ctx.html(tpl.chatPage(ctx.pageCtx(), { history: rows }));
}));

post("/api/chat", loginRequired(rateLimited("chat", 20, 60, true)(async (ctx) => {
  const user = currentUser(ctx.session);
  const question = String((ctx.json && ctx.json.message) || "").trim().slice(0, 2000);
  if (!question) return ctx.json_({ error: "Message vide." }, 400);

  const rows = all(
    "SELECT sender, message FROM chat_messages WHERE user_id_code=? ORDER BY id DESC LIMIT ?",
    [user.user_id_code, 20]
  ).reverse();
  const history = rows.map((r) => ({ role: r.sender === "USER" ? "user" : "assistant", content: r.message }));

  const results = await search.hybridSearch(question, user.user_id_code, FTS_OK);
  const context = search.buildContext(results);

  let reply;
  try {
    reply = await ai.ask(history, question, context);
  } catch (e) {
    if (!(e instanceof AIUnavailable)) throw e;
    reply = search.fallbackReply(results);
    console.warn("IA indisponible :", e.message);
  }

  const stamp = nowIso();
  run("INSERT INTO chat_messages (user_id_code, sender, message, created_at) VALUES (?, 'USER', ?, ?)", [user.user_id_code, question, stamp]);
  run("INSERT INTO chat_messages (user_id_code, sender, message, created_at) VALUES (?, 'BOT', ?, ?)", [user.user_id_code, reply, stamp]);
  run(
    `DELETE FROM chat_messages WHERE user_id_code=? AND id NOT IN
     (SELECT id FROM chat_messages WHERE user_id_code=? ORDER BY id DESC LIMIT 100)`,
    [user.user_id_code, user.user_id_code]
  );

  return ctx.json_({ reply, sources: search.publicSources(results) });
})));

// =============================================================================
// ROUTES — Portefeuille
// =============================================================================

get("/wallet", loginRequired(async (ctx) => {
  const user = currentUser(ctx.session);
  const txs = all("SELECT * FROM transactions WHERE user_id_code=? ORDER BY id DESC LIMIT 50", [user.user_id_code]);
  return ctx.html(tpl.wallet(ctx.pageCtx(), {
    user, txs,
    minAmount: business.config.MIN_AMOUNT, maxAmount: business.config.MAX_AMOUNT,
    rate: business.config.COMMISSION_RATE, floor: business.config.COMMISSION_FLOOR,
    tiers: business.config.TIER_PRICES, days: business.config.SUBSCRIPTION_DAYS,
    numbers: business.config.MOBILE_NUMBERS,
  }));
}));

post("/wallet/deposit", loginRequired(rateLimited("deposit", 10, 3600, true)(async (ctx) => {
  const user = currentUser(ctx.session);
  try {
    const amount = business.parseAmount(ctx.body.amount);
    const phone = (ctx.body.phone || "").trim();
    if (!PHONE_RE.test(phone)) throw new BusinessError("Numéro de téléphone invalide.");
    const ticket = business.requestDeposit(user.user_id_code, amount, phone);
    business.addDirectMessage(user.user_id_code, "SYSTEM", `Demande de dépôt ${ticket} de ${fmtFcfa(amount)} enregistrée. En attente de validation.`, "admin", ticket);
    flash(ctx.session, `Dépôt déclaré (ticket ${ticket}). L'admin va vérifier.`, "ok");
  } catch (e) {
    if (!(e instanceof BusinessError)) throw e;
    flash(ctx.session, e.message, "err");
  }
  return ctx.redirect("/wallet");
})));

post("/wallet/withdraw", loginRequired(rateLimited("withdraw", 10, 3600, true)(async (ctx) => {
  const user = currentUser(ctx.session);
  try {
    const amount = business.parseAmount(ctx.body.amount);
    const phone = (ctx.body.phone || "").trim();
    if (!PHONE_RE.test(phone)) throw new BusinessError("Numéro de téléphone invalide.");
    const ticket = business.requestWithdrawal(user.user_id_code, amount, phone);
    business.addDirectMessage(user.user_id_code, "SYSTEM", `Demande de retrait ${ticket} de ${fmtFcfa(amount)} enregistrée.`, "admin", ticket);
    flash(ctx.session, `Retrait demandé (ticket ${ticket}).`, "ok");
  } catch (e) {
    if (!(e instanceof BusinessError)) throw e;
    flash(ctx.session, e.message, "err");
  }
  return ctx.redirect("/wallet");
})));

post("/wallet/tier", loginRequired(async (ctx) => {
  const user = currentUser(ctx.session);
  const tier = Number(ctx.body.tier || 0);
  if (!business.config.TIER_PRICES.includes(tier)) {
    flash(ctx.session, "Prix d'abonnement invalide.", "err");
  } else {
    run("UPDATE users SET tier_price=? WHERE user_id_code=?", [tier, user.user_id_code]);
    flash(ctx.session, "Prix d'abonnement mis à jour.", "ok");
  }
  return ctx.redirect("/wallet");
}));

// =============================================================================
// ROUTES — Fil, Shorts, Créateur, Abonnement
// =============================================================================

function withYoutube(row) {
  const d = { ...row };
  const m = YOUTUBE_RE.exec(d.content || "");
  d.yt = m ? m[1] : null;
  return d;
}

get("/feed", loginRequired(async (ctx) => {
  const user = currentUser(ctx.session);
  const rows = all(
    `SELECT p.*, u.phone_or_pseudo AS author FROM posts p JOIN users u ON u.user_id_code = p.user_id_code
     WHERE ${search.VISIBLE_POSTS_SQL} ORDER BY p.id DESC LIMIT 50`,
    [user.user_id_code, user.user_id_code, nowIso()]
  );
  return ctx.html(tpl.feed(ctx.pageCtx(), { posts: rows.map(withYoutube) }));
}));

post("/post", loginRequired(rateLimited("post", 15, 3600, true)(async (ctx) => {
  const user = currentUser(ctx.session);
  const content = (ctx.body.content || "").trim().slice(0, 1000);
  let visibility = ctx.body.visibility || "PUBLIC";
  if (!business.config.POST_VISIBILITIES.includes(visibility)) visibility = "PUBLIC";
  if (!content) {
    flash(ctx.session, "Message vide.", "err");
    return ctx.redirect("/feed");
  }
  run("INSERT INTO posts (user_id_code, content, visibility, created_at) VALUES (?, ?, ?, ?)", [user.user_id_code, content, visibility, nowIso()]);
  const row = one("SELECT id FROM posts WHERE user_id_code=? ORDER BY id DESC LIMIT 1", [user.user_id_code]);
  if (row) search.storeInternal(row.id, content, FTS_OK);
  flash(ctx.session, "Publication ajoutée.", "ok");
  return ctx.redirect("/feed");
})));

get("/shorts", loginRequired(async (ctx) => {
  const user = currentUser(ctx.session);
  const rows = all(
    `SELECT p.*, u.phone_or_pseudo AS author FROM posts p JOIN users u ON u.user_id_code = p.user_id_code
     WHERE ${search.VISIBLE_POSTS_SQL} ORDER BY p.id DESC LIMIT 30`,
    [user.user_id_code, user.user_id_code, nowIso()]
  );
  const posts = rows.map(withYoutube).filter((p) => p.yt);
  return ctx.html(tpl.shorts(ctx.pageCtx(), { posts }));
}));

get("/creator/:code", loginRequired(async (ctx) => {
  const me = currentUser(ctx.session);
  const code = ctx.params.code;
  const c = one("SELECT * FROM users WHERE user_id_code=?", [code]);
  if (!c) throw new HttpAbort(404, ERROR_MESSAGES[404]);
  const isOwner = me.user_id_code === code;
  const expires = isOwner ? null : business.activeSubscription(me.user_id_code, code);
  const rows = all(
    `SELECT p.*, u.phone_or_pseudo AS author FROM posts p JOIN users u ON u.user_id_code = p.user_id_code
     WHERE p.user_id_code=? AND ${search.VISIBLE_POSTS_SQL} ORDER BY p.id DESC LIMIT 30`,
    [code, me.user_id_code, me.user_id_code, nowIso()]
  );
  const posts = rows.map(withYoutube);
  let locked = 0;
  if (!isOwner && !expires) {
    const lr = one("SELECT COUNT(*) AS n FROM posts WHERE user_id_code=? AND visibility='ABONNES'", [code]);
    locked = lr ? lr.n : 0;
  }
  if (!isOwner) run("UPDATE users SET views_count = views_count + 1 WHERE user_id_code=?", [code]);
  return ctx.html(tpl.creator(ctx.pageCtx(), { creator: c, posts, isOwner, expires, locked, days: business.config.SUBSCRIPTION_DAYS }));
}));

post("/subscribe/:code", loginRequired(rateLimited("subscribe", 10, 3600, true)(async (ctx) => {
  const me = currentUser(ctx.session);
  try {
    const expires = business.subscribeTo(me.user_id_code, ctx.params.code);
    flash(ctx.session, `Abonnement actif jusqu'au ${expires}.`, "ok");
  } catch (e) {
    if (!(e instanceof BusinessError)) throw e;
    flash(ctx.session, e.message, "err");
  }
  return ctx.redirect(`/creator/${ctx.params.code}`);
})));

// =============================================================================
// ROUTES — Support, Recherche, Messages privés
// =============================================================================

getpost("/support", loginRequired(async (ctx) => {
  const user = currentUser(ctx.session);
  if (ctx.method === "POST") {
    const ticket = (ctx.body.ticket || "").trim().slice(0, 20);
    let issue = ctx.body.issue || "AUTRE";
    const message = (ctx.body.message || "").trim().slice(0, 1000);
    if (!ISSUE_TYPES.includes(issue)) issue = "AUTRE";
    if (message.length < 10) {
      flash(ctx.session, "Message trop court.", "err");
    } else {
      run(
        "INSERT INTO support_tickets (user_id_code, tx_ticket_code, issue_type, message, created_at) VALUES (?, ?, ?, ?, ?)",
        [user.user_id_code, ticket, issue, message, nowIso()]
      );
      flash(ctx.session, "Demande envoyée.", "ok");
      return ctx.redirect("/support");
    }
  }
  const tickets = all("SELECT * FROM support_tickets WHERE user_id_code=? ORDER BY id DESC LIMIT 20", [user.user_id_code]);
  return ctx.html(tpl.support(ctx.pageCtx(), { tickets, issues: ISSUE_TYPES }));
}));

get("/search", loginRequired(async (ctx) => {
  const q = (ctx.query.get("q") || "").trim().slice(0, 200);
  const user = currentUser(ctx.session);
  const results = q ? await search.searchPosts(q, user.user_id_code, 20, FTS_OK) : [];
  return ctx.html(tpl.searchPage(ctx.pageCtx(), { q, results }));
}));

getpost("/messages", loginRequired(async (ctx) => {
  const user = currentUser(ctx.session);
  if (ctx.method === "POST") {
    const msg = (ctx.body.message || "").trim().slice(0, 1000);
    if (msg) business.addDirectMessage(user.user_id_code, "USER", msg, "admin");
    return ctx.redirect("/messages");
  }
  run("UPDATE direct_messages SET read_by_user=1 WHERE user_id_code=? AND read_by_user=0", [user.user_id_code]);
  const rows = all("SELECT * FROM direct_messages WHERE user_id_code=? ORDER BY id ASC LIMIT 200", [user.user_id_code]);
  const lastId = rows.length ? rows[rows.length - 1].id : 0;
  return ctx.html(tpl.messagesPage(ctx.pageCtx(), { messages: rows, lastId }));
}));

get("/messages/poll", loginRequired(async (ctx) => {
  const user = currentUser(ctx.session);
  const after = Number(ctx.query.get("after") || 0);
  const rows = all(
    "SELECT id, sender, message, created_at FROM direct_messages WHERE user_id_code=? AND id > ? ORDER BY id ASC LIMIT 50",
    [user.user_id_code, after]
  );
  if (rows.length) {
    run("UPDATE direct_messages SET read_by_user=1 WHERE user_id_code=? AND id > ? AND read_by_user=0", [user.user_id_code, after]);
  }
  return ctx.json_(rows.map((r) => ({ id: r.id, sender: r.sender, message: r.message, created_at: r.created_at })));
}));

// =============================================================================
// ROUTES — Admin
// =============================================================================

getpost("/admin/login", rateLimited("admin_login", 8, 600)(async (ctx) => {
  if (ctx.method === "POST") {
    const pwd = ctx.body.password || "";
    if (timingSafeEqualStr(pwd, ADMIN_PASSWORD)) {
      ctx.session.data.admin = true;
      ctx.session.data.adminAt = Date.now() / 1000;
      return ctx.redirect("/admin");
    }
    flash(ctx.session, "Mot de passe incorrect.", "err");
  }
  return ctx.html(tpl.adminLogin(ctx.pageCtx()));
}));

post("/admin/logout", async (ctx) => {
  delete ctx.session.data.admin;
  delete ctx.session.data.adminAt;
  return ctx.redirect("/admin/login");
});

get("/admin", adminRequired(async (ctx) => {
  const stats = {
    users: one("SELECT COUNT(*) AS n FROM users").n,
    total: one("SELECT COALESCE(SUM(balance),0) AS s FROM users").s,
    pending: one("SELECT COUNT(*) AS n FROM transactions WHERE status='EN_ATTENTE'").n,
    unread: one("SELECT COUNT(*) AS n FROM direct_messages WHERE read_by_admin=0").n,
  };
  const pending = all("SELECT * FROM transactions WHERE status='EN_ATTENTE' ORDER BY id ASC LIMIT 50");
  const tickets = all("SELECT * FROM support_tickets WHERE status='OUVERT' ORDER BY id ASC LIMIT 30");
  const logs = all("SELECT * FROM audit_log ORDER BY id DESC LIMIT 20");
  return ctx.html(tpl.adminDashboard(ctx.pageCtx(), { stats, pending, tickets, logs }));
}));

post("/admin/tx/:tx_id/:action", adminRequired(async (ctx) => {
  try {
    const ticket = business.decideTransaction(Number(ctx.params.tx_id), ctx.params.action === "approve");
    flash(ctx.session, `Transaction ${ticket} traitée.`, "ok");
  } catch (e) {
    if (!(e instanceof BusinessError)) throw e;
    flash(ctx.session, e.message, "err");
  }
  return ctx.redirect("/admin");
}));

post("/admin/ticket/:tid", adminRequired(async (ctx) => {
  const reply = (ctx.body.reply || "").trim().slice(0, 1000);
  if (reply) {
    run("UPDATE support_tickets SET admin_reply=?, status='CLOS' WHERE id=?", [reply, Number(ctx.params.tid)]);
    flash(ctx.session, "Réponse enregistrée.", "ok");
  }
  return ctx.redirect("/admin");
}));

get("/admin/ia", adminRequired(async (ctx) => {
  const start = Date.now();
  let error = null, answer = null;
  try {
    answer = await ai.ask([], "Dis juste « OK » si tu fonctionnes.");
  } catch (e) {
    if (!(e instanceof AIUnavailable)) throw e;
    error = e.message;
  }
  const seconds = ((Date.now() - start) / 1000).toFixed(2);
  const info = {
    endpoint: ai.AI_ENDPOINT, model: ai.AI_MODEL,
    keyLen: ai.AI_API_KEY.length, keyStart: ai.AI_API_KEY ? ai.AI_API_KEY.slice(0, 6) + "…" : "",
    onPa: /pythonanywhere/i.test(process.env.HOSTNAME || ""),
  };
  return ctx.html(tpl.adminIa(ctx.pageCtx(), { error, answer, seconds, info }));
}));

get("/admin/search", adminRequired(async (ctx) => {
  return ctx.html(tpl.adminSearch(ctx.pageCtx(), { internal: search.internalStatus(FTS_OK) }));
}));

post("/admin/reindex", adminRequired(async (ctx) => {
  const total = search.reindexAll(FTS_OK);
  flash(ctx.session, `Index reconstruits (${total} publications).`, "ok");
  return ctx.redirect("/admin/search");
}));

get("/admin/messages", adminRequired(async (ctx) => {
  const rows = all(
    `SELECT u.user_id_code, u.phone_or_pseudo,
            (SELECT COUNT(*) FROM direct_messages d WHERE d.user_id_code=u.user_id_code AND d.read_by_admin=0) AS unread
     FROM users u WHERE EXISTS (SELECT 1 FROM direct_messages d WHERE d.user_id_code=u.user_id_code)
     ORDER BY unread DESC, u.phone_or_pseudo`
  );
  return ctx.html(tpl.adminMessages(ctx.pageCtx(), { users: rows }));
}));

getpost("/admin/chat/:code", adminRequired(async (ctx) => {
  const code = ctx.params.code;
  const user = one("SELECT * FROM users WHERE user_id_code=?", [code]);
  if (!user) throw new HttpAbort(404, ERROR_MESSAGES[404]);
  if (ctx.method === "POST") {
    const msg = (ctx.body.message || "").trim().slice(0, 1000);
    if (msg) business.addDirectMessage(code, "ADMIN", msg, "user");
    return ctx.redirect(`/admin/chat/${code}`);
  }
  run("UPDATE direct_messages SET read_by_admin=1 WHERE user_id_code=? AND read_by_admin=0", [code]);
  const rows = all("SELECT * FROM direct_messages WHERE user_id_code=? ORDER BY id ASC LIMIT 200", [code]);
  const lastId = rows.length ? rows[rows.length - 1].id : 0;
  return ctx.html(tpl.adminChat(ctx.pageCtx(), { user, messages: rows, lastId }));
}));

get("/admin/chat/:code/poll", adminRequired(async (ctx) => {
  const code = ctx.params.code;
  const after = Number(ctx.query.get("after") || 0);
  const rows = all(
    "SELECT id, sender, message, created_at FROM direct_messages WHERE user_id_code=? AND id > ? ORDER BY id ASC LIMIT 50",
    [code, after]
  );
  if (rows.length) run("UPDATE direct_messages SET read_by_admin=1 WHERE user_id_code=? AND id > ? AND read_by_admin=0", [code, after]);
  return ctx.json_(rows.map((r) => ({ id: r.id, sender: r.sender, message: r.message, created_at: r.created_at })));
}));

// =============================================================================
// MOTEUR HTTP
// =============================================================================

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_CONTENT_LENGTH) {
        req.destroy();
        reject(new HttpAbort(413, ERROR_MESSAGES[413]));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function securityHeaders(res, nonce) {
  res.setHeader(
    "Content-Security-Policy",
    `default-src 'self'; script-src 'nonce-${nonce}'; style-src 'self' 'unsafe-inline'; ` +
      `img-src 'self' data:; frame-src https://www.youtube-nocookie.com; ` +
      `base-uri 'none'; form-action 'self'; frame-ancestors 'none'`
  );
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("Permissions-Policy", "geolocation=(), camera=(), microphone=()");
  res.setHeader("Cache-Control", "no-store");
  if (COOKIE_SECURE) res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
}

const server = http.createServer(async (req, res) => {
  const clientIp = (req.socket && req.socket.remoteAddress) || "?";
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const method = req.method;
  const path = url.pathname;

  const session = loadSession(req);
  if (!session.data.csrf) session.data.csrf = crypto.randomBytes(16).toString("hex");

  const nonce = crypto.randomBytes(12).toString("base64url");
  securityHeaders(res, nonce);

  let body = {}, json = {};
  try {
    if (method === "POST") {
      const raw = await readBody(req);
      const ctype = (req.headers["content-type"] || "").split(";")[0].trim();
      if (ctype === "application/json") {
        try { json = raw.length ? JSON.parse(raw.toString("utf8")) : {}; } catch { json = {}; }
      } else {
        body = querystring.parse(raw.toString("utf8"));
      }
      const sent = body.csrf_token || req.headers["x-csrf-token"] || "";
      if (!timingSafeEqualStr(sent, session.data.csrf)) throw new HttpAbort(400, ERROR_MESSAGES[400]);
    }

    const match = routes.find((r) => r.method === method && r.regex.test(path));
    if (!match) throw new HttpAbort(404, ERROR_MESSAGES[404]);
    const values = match.regex.exec(path).slice(1);
    const params = {};
    match.keys.forEach((k, i) => { params[k] = decodeURIComponent(values[i]); });

    let responded = false;
    const ctx = {
      req, res, session, params, query: url.searchParams, body, json,
      method, path, clientIp, nonce,
      pageCtx() {
        const me = currentUser(session);
        const flashes = session.data.flashes || [];
        session.data.flashes = [];
        return { me, csrfToken: session.data.csrf, nonce, flashes, unreadDm: unreadDmCount(me) };
      },
      html(content, status = 200) {
        responded = true;
        res.statusCode = status;
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.setHeader("Set-Cookie", sessionCookieHeader(session, COOKIE_SECURE));
        res.end(content);
      },
      json_(obj, status = 200) {
        responded = true;
        res.statusCode = status;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.setHeader("Set-Cookie", sessionCookieHeader(session, COOKIE_SECURE));
        res.end(JSON.stringify(obj));
      },
      redirect(location, status = 302) {
        responded = true;
        res.statusCode = status;
        res.setHeader("Location", location);
        res.setHeader("Set-Cookie", sessionCookieHeader(session, COOKIE_SECURE));
        res.end();
      },
    };

    await match.handler(ctx);
    if (!responded) throw new Error("Le gestionnaire de route n'a produit aucune réponse.");
    saveSession(session);
  } catch (err) {
    try {
      const status = err instanceof HttpAbort ? err.status : 500;
      const message = err instanceof HttpAbort ? err.message : "Erreur interne. Réessaie dans un instant.";
      if (!(err instanceof HttpAbort)) console.error("Erreur interne", err);
      saveSession(session);
      if (path.startsWith("/api/")) {
        res.statusCode = status;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ error: message }));
      } else {
        const me = currentUser(session);
        const ctxForError = { me, csrfToken: session.data.csrf, nonce, flashes: [], unreadDm: unreadDmCount(me) };
        res.statusCode = status;
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(tpl.errorPage(ctxForError, { code: status, msg: message }));
      }
    } catch (fatal) {
      console.error("Erreur fatale dans le gestionnaire d'erreurs", fatal);
      res.statusCode = 500;
      res.end("Erreur interne.");
    }
  }
});

function bootstrap() {
  const { ftsOk } = initDb();
  FTS_OK = ftsOk;
  console.log(`[toutbot] ToutBot Prestige (Node.js) prêt — DB=${require("./db").DB_PATH} — FTS5=${FTS_OK}`);
}

if (require.main === module) {
  bootstrap();
  server.listen(PORT, HOST, () => {
    console.log(`[toutbot] En écoute sur http://${HOST}:${PORT} (debug=${DEBUG})`);
  });
}

module.exports = { server, bootstrap };
