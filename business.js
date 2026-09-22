"use strict";
/* =============================================================================
 * LOGIQUE MÉTIER (équivalent des transactions atomiques Python)
 * ========================================================================== */
const { db, run, all, one, transaction } = require("./db");
const { BusinessError, nowIso, fmtFcfa, newCode } = require("./utils");

const config = {
  MIN_AMOUNT: 100,
  MAX_AMOUNT: 5_000_000,
  COMMISSION_RATE: 0.08,
  COMMISSION_FLOOR: 15,
  SUBSCRIPTION_DAYS: 30,
  TIER_PRICES: [100, 250, 500, 1000, 2500, 5000],
  POST_VISIBILITIES: ["PUBLIC", "ABONNES"],
  MOBILE_NUMBERS: ["01 60 42 8847", "0585167882"],
};

function commissionFor(amount) {
  return Math.max(config.COMMISSION_FLOOR, Math.round(amount * config.COMMISSION_RATE));
}

function parseAmount(raw) {
  const value = Number(String(raw ?? "").trim().replace(/\s/g, ""));
  if (!Number.isInteger(value)) throw new BusinessError("Montant invalide.");
  if (value < config.MIN_AMOUNT || value > config.MAX_AMOUNT) {
    throw new BusinessError(
      `Le montant doit être entre ${fmtFcfa(config.MIN_AMOUNT)} et ${fmtFcfa(config.MAX_AMOUNT)}.`
    );
  }
  return value;
}

function audit(actor, action, detail) {
  try {
    run("INSERT INTO audit_log (actor, action, detail, created_at) VALUES (?, ?, ?, ?)", [
      actor, action, String(detail).slice(0, 500), nowIso(),
    ]);
  } catch (e) {
    console.error("Échec d'écriture du journal d'audit", e);
  }
}

function countPending(userCode) {
  const row = one("SELECT COUNT(*) AS n FROM transactions WHERE user_id_code=? AND status='EN_ATTENTE'", [userCode]);
  return row ? row.n : 0;
}

function requestDeposit(userCode, amount, phone) {
  if (countPending(userCode) >= 5) throw new BusinessError("Tu as déjà 5 demandes en attente. Attends leur traitement.");
  const ticket = newCode("DEP");
  run(
    `INSERT INTO transactions (type, user_id_code, amount_requested, commission_taken, net_amount,
      user_reference_phone, status, ticket_code, created_at)
     VALUES ('DEPOT', ?, ?, 0, ?, ?, 'EN_ATTENTE', ?, ?)`,
    [userCode, amount, amount, phone, ticket, nowIso()]
  );
  return ticket;
}

function requestWithdrawal(userCode, amount, phone) {
  if (countPending(userCode) >= 5) throw new BusinessError("Tu as déjà 5 demandes en attente. Attends leur traitement.");
  const commission = commissionFor(amount);
  const net = amount - commission;
  const ticket = newCode("RET");
  transaction(() => {
    const res = run("UPDATE users SET balance = balance - ? WHERE user_id_code=? AND balance >= ?", [amount, userCode, amount]);
    if (res.changes !== 1) throw new BusinessError("Solde insuffisant.");
    run(
      `INSERT INTO transactions (type, user_id_code, amount_requested, commission_taken, net_amount,
        user_reference_phone, status, ticket_code, created_at)
       VALUES ('RETRAIT', ?, ?, ?, ?, ?, 'EN_ATTENTE', ?, ?)`,
      [userCode, amount, commission, net, phone, ticket, nowIso()]
    );
  });
  return ticket;
}

function decisionText(tx, approve) {
  const ticket = tx.ticket_code, amount = fmtFcfa(tx.amount_requested);
  if (tx.type === "DEPOT") {
    return approve
      ? `✅ Ton dépôt de ${amount} (ticket ${ticket}) est validé. Ton solde est crédité.`
      : `❌ Ton dépôt de ${amount} (ticket ${ticket}) est refusé. Si tu as bien payé, écris-moi ici.`;
  }
  return approve
    ? `✅ Ton retrait de ${amount} (ticket ${ticket}) est validé : tu reçois ${fmtFcfa(tx.net_amount)} sur le ${tx.user_reference_phone}.`
    : `❌ Ton retrait de ${amount} (ticket ${ticket}) est refusé. Le montant est remboursé sur ton solde.`;
}

function decideTransaction(txId, approve) {
  let tx;
  transaction(() => {
    tx = one("SELECT * FROM transactions WHERE id=?", [txId]);
    if (!tx) throw new BusinessError("Transaction introuvable.");
    if (tx.status !== "EN_ATTENTE") throw new BusinessError("Cette transaction est déjà traitée.");
    if (!["DEPOT", "RETRAIT"].includes(tx.type)) throw new BusinessError("Ce type de transaction ne se valide pas à la main.");
    if (approve && tx.type === "DEPOT") {
      run("UPDATE users SET balance = balance + ? WHERE user_id_code=?", [tx.amount_requested, tx.user_id_code]);
    }
    if (!approve && tx.type === "RETRAIT") {
      run("UPDATE users SET balance = balance + ? WHERE user_id_code=?", [tx.amount_requested, tx.user_id_code]);
    }
    run("UPDATE transactions SET status=?, processed_at=? WHERE id=?", [approve ? "VALIDE" : "REJETE", nowIso(), txId]);
  });
  audit("admin", approve ? "TX_VALIDE" : "TX_REJETE", `${tx.ticket_code} ${tx.type} ${tx.amount_requested}`);
  addDirectMessage(tx.user_id_code, "SYSTEM", decisionText(tx, approve), "user", tx.ticket_code);
  return tx.ticket_code;
}

function activeSubscription(subscriberCode, creatorCode) {
  const row = one(
    "SELECT expires_at FROM subscriptions WHERE subscriber_id=? AND creator_id=? AND expires_at > ?",
    [subscriberCode, creatorCode, nowIso()]
  );
  return row ? row.expires_at : null;
}

function subscribeTo(subscriberCode, creatorCode) {
  if (subscriberCode === creatorCode) throw new BusinessError("Tu ne peux pas t'abonner à toi-même.");
  let expiresIso;
  transaction(() => {
    const creator = one("SELECT tier_price FROM users WHERE user_id_code=?", [creatorCode]);
    if (!creator) throw new BusinessError("Créateur introuvable.");
    const price = Number(creator.tier_price);
    const commission = commissionFor(price);
    const revenue = price - commission;

    const res = run("UPDATE users SET balance = balance - ? WHERE user_id_code=? AND balance >= ?", [price, subscriberCode, price]);
    if (res.changes !== 1) throw new BusinessError(`Solde insuffisant : l'abonnement coûte ${fmtFcfa(price)}.`);
    run("UPDATE users SET balance = balance + ? WHERE user_id_code=?", [revenue, creatorCode]);

    let start = new Date();
    const existing = one("SELECT expires_at FROM subscriptions WHERE subscriber_id=? AND creator_id=?", [subscriberCode, creatorCode]);
    if (existing) {
      const currentEnd = new Date(existing.expires_at + (existing.expires_at.endsWith("Z") ? "" : "Z"));
      if (!Number.isNaN(currentEnd.getTime()) && currentEnd > start) start = currentEnd;
    }
    const expires = new Date(start.getTime() + config.SUBSCRIPTION_DAYS * 86400_000);
    expiresIso = expires.toISOString().replace(/\.\d+Z$/, "");
    const stamp = nowIso();
    run(
      `INSERT INTO subscriptions (subscriber_id, creator_id, expires_at, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (subscriber_id, creator_id) DO UPDATE SET expires_at = excluded.expires_at`,
      [subscriberCode, creatorCode, expiresIso, stamp]
    );
    for (const [owner, kind] of [[subscriberCode, "ABONNEMENT"], [creatorCode, "REVENU"]]) {
      run(
        `INSERT INTO transactions (type, user_id_code, amount_requested, commission_taken, net_amount,
          user_reference_phone, status, ticket_code, created_at, processed_at)
         VALUES (?, ?, ?, ?, ?, '-', 'VALIDE', ?, ?, ?)`,
        [kind, owner, price, commission, revenue, newCode("ABO"), stamp, stamp]
      );
    }
  });
  return expiresIso.slice(0, 10);
}

function addDirectMessage(userCode, sender, message, notify, ticket = "") {
  const readAdmin = notify === "admin" ? 0 : 1;
  const readUser = notify === "admin" ? 1 : 0;
  try {
    run(
      `INSERT INTO direct_messages (user_id_code, sender, message, ticket_code, read_by_admin, read_by_user, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [userCode, sender, String(message).slice(0, 1000), ticket, readAdmin, readUser, nowIso()]
    );
    run(
      `DELETE FROM direct_messages WHERE user_id_code=? AND id NOT IN
       (SELECT id FROM direct_messages WHERE user_id_code=? ORDER BY id DESC LIMIT 500)`,
      [userCode, userCode]
    );
  } catch (e) {
    console.error("Échec d'enregistrement d'un message privé", e);
  }
}

module.exports = {
  config, commissionFor, parseAmount, audit, countPending,
  requestDeposit, requestWithdrawal, decideTransaction,
  activeSubscription, subscribeTo, addDirectMessage,
};
