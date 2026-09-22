"use strict";
/* =============================================================================
 * MOTEUR D'IA (Pollinations)
 * ========================================================================== */
const { AIUnavailable } = require("./utils");

const AI_API_KEY = (process.env.POLLINATIONS_KEY || "").trim();
const AI_ENDPOINT =
  process.env.TOUTBOT_AI_ENDPOINT ||
  (AI_API_KEY ? "https://gen.pollinations.ai/v1/chat/completions" : "https://text.pollinations.ai/");
const AI_MODEL = process.env.TOUTBOT_AI_MODEL || (AI_API_KEY ? "openai/gpt-5.4-nano" : "openai");
const AI_TIMEOUT = Number(process.env.TOUTBOT_AI_TIMEOUT || "25") * 1000;
const AI_RETRIES = Number(process.env.TOUTBOT_AI_RETRIES || "2");
const AI_SYSTEM_PROMPT =
  "Tu es ToutBot, l'assistant de la plateforme ToutBot Prestige. " +
  "Réponds toujours dans la langue de l'utilisateur, de façon claire, utile et honnête. " +
  "Si tu ne sais pas, dis-le. Refuse poliment ce qui est dangereux ou illégal.";

// Remarque : Node fetch() ne prend pas de proxy HTTP sans lib tierce ;
// TOUTBOT_HTTP_PROXY (utilisé côté Python via urllib) n'est donc pas porté.
// Si ton hébergeur a besoin d'un proxy sortant, utilise `undici`'s
// ProxyAgent (à ajouter en dépendance si nécessaire).

function extractText(raw) {
  raw = String(raw || "").trim();
  if (raw.startsWith("{")) {
    try {
      const data = JSON.parse(raw);
      if (data && typeof data === "object") {
        if (data.choices) {
          return String((data.choices[0] || {}).message?.content || "").trim();
        }
        return String(data.content || data.text || "").trim();
      }
    } catch { /* pas du JSON exploitable, on renvoie le texte brut */ }
  }
  return raw;
}

function explain(err, status, bodyText) {
  if (status) {
    let why;
    if (status === 401 || status === 403) {
      why = "Accès refusé : clé Pollinations absente, fausse, ou sans droit.";
    } else if (status === 402) {
      why = "Plus de crédit (Pollen) sur le compte Pollinations.";
    } else if (status === 429) {
      why = "Trop de demandes envoyées à Pollinations. Attends un peu.";
    } else {
      why = `Pollinations a répondu par une erreur ${status}.`;
    }
    return `${why} (HTTP ${status}) ${(bodyText || "").slice(0, 300)}`.trim();
  }
  const text = String(err && err.message || err);
  if (err && err.name === "AbortError") {
    return `Délai dépassé : Pollinations n'a pas répondu en ${(AI_TIMEOUT / 1000).toFixed(0)} s. [détail : ${text}]`;
  }
  return `Connexion impossible. [détail : ${text}]`;
}

let lastError = "";

async function ask(history, question, context = "") {
  const system = AI_SYSTEM_PROMPT + (context ? "\n\n" + context : "");
  const messages = [{ role: "system", content: system }, ...history, { role: "user", content: question }];
  const body = { messages, model: AI_MODEL };
  const headers = { "Content-Type": "application/json", "User-Agent": "ToutBot-Prestige-JS/1.0" };
  if (AI_API_KEY) headers.Authorization = `Bearer ${AI_API_KEY}`;
  else body.private = true;

  lastError = "";
  for (let attempt = 1; attempt <= AI_RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), AI_TIMEOUT);
    try {
      const res = await fetch(AI_ENDPOINT, {
        method: "POST", headers, body: JSON.stringify(body), signal: controller.signal,
      });
      const raw = await res.text();
      if (!res.ok) {
        lastError = explain(null, res.status, raw);
        console.error(`IA : essai ${attempt}/${AI_RETRIES} : ${lastError}`);
        if ([401, 402, 403].includes(res.status)) break;
        clearTimeout(timer);
        if (attempt < AI_RETRIES) await new Promise((r) => setTimeout(r, 800 * attempt));
        continue;
      }
      const text = extractText(raw);
      if (text) return text.slice(0, 6000);
      lastError = "Pollinations a répondu, mais avec un message vide.";
      console.warn(`IA : réponse vide (essai ${attempt})`);
    } catch (err) {
      lastError = explain(err);
      console.error(`IA : essai ${attempt}/${AI_RETRIES} : ${lastError}`);
    } finally {
      clearTimeout(timer);
    }
    if (attempt < AI_RETRIES) await new Promise((r) => setTimeout(r, 800 * attempt));
  }
  throw new AIUnavailable(lastError || "Le moteur d'IA ne répond pas.");
}

module.exports = { ask, AI_ENDPOINT, AI_MODEL, AI_API_KEY, get lastError() { return lastError; } };
