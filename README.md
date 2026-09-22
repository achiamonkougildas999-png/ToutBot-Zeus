# ToutBot Prestige — version Node.js

Portage complet de `toutbot_app.py` (Flask) vers **Node.js pur**, sans aucune
dépendance npm : uniquement les modules natifs `node:http` et `node:sqlite`
(disponibles depuis Node 22). Donc **pas de `npm install`** nécessaire.

## Lancer en local

```bash
node --version   # il faut Node >= 22.5
node server.js
# ou : npm start
```

Le serveur écoute par défaut sur `http://0.0.0.0:3000`. Le mot de passe
admin par défaut est `Numberone_100_ans` (change-le avec la variable
d'environnement `TOUTBOT_ADMIN_PASSWORD` !).

## Fichiers

- `server.js` — serveur HTTP, routage, sécurité (CSRF, en-têtes, limite de débit), toutes les routes.
- `db.js` — schéma SQLite (`node:sqlite`, natif), migrations, FTS5.
- `session.js` — sessions par cookie, stockées côté serveur en SQLite.
- `business.js` — dépôts/retraits, abonnements, messages privés (logique métier).
- `search.js` — recherche interne (mots exacts, racines FR, vecteurs par hachage) + web (Wikipedia, DuckDuckGo, **DuckDuckGo Actu (Direct)**, **Google News (Temps Réel)**, Brave, SearXNG) + fusion RRF.
- `ai.js` — client Pollinations (chat IA), avec repli automatique sur la recherche si l'IA ne répond pas.
- `templates.js` — toutes les pages HTML (même design/CSS que la version Python).
- `utils.js` — fonctions utilitaires (dates, montants, hachage de mot de passe, etc.).

## Variables d'environnement (mêmes noms que la version Python)

| Variable | Rôle | Défaut |
|---|---|---|
| `TOUTBOT_HOST` / `TOUTBOT_PORT` | Adresse/port d'écoute | `0.0.0.0` / `3000` |
| `TOUTBOT_DB` | Chemin du fichier SQLite | `./toutbot.db` |
| `TOUTBOT_ADMIN_PASSWORD` | Mot de passe admin | `Numberone_100_ans` |
| `TOUTBOT_SECRET_KEY` | (non utilisé — sessions stockées en base, pas de cookie signé) | — |
| `TOUTBOT_COOKIE_SECURE` | `1` pour forcer les cookies `Secure` (HTTPS) | `0` |
| `POLLINATIONS_KEY` | Clé API Pollinations pour l'IA | vide |
| `TOUTBOT_AI_ENDPOINT` / `TOUTBOT_AI_MODEL` | Réglages du moteur IA | auto |
| `TOUTBOT_WEB_SEARCH` | `1`/`0` pour activer la recherche internet | `1` |
| `TOUTBOT_DDG_NEWS` | `1`/`0` pour activer DuckDuckGo Actu (Direct) | `1` |
| `TOUTBOT_GOOGLE_NEWS` | `1`/`0` pour activer Google News (Temps Réel) | `1` |
| `BRAVE_API_KEY`, `SEARXNG_URL` | Moteurs de recherche web optionnels | vide |

### Actu en temps réel (DuckDuckGo Actu + Google News)

Deux sources d'actualité en direct sont désormais fusionnées avec les autres
résultats web (Wikipedia, DuckDuckGo, Brave, SearXNG) via RRF, et injectées
dans le contexte donné à l'IA (`buildContext`) — donc le chat peut répondre
avec des infos très récentes, sourcées et citées `[n]` :

- **DuckDuckGo Actu (Direct)** — interroge `html.duckduckgo.com/html/` avec
  un filtre « dernières 24h » (`df=d`), sans clé API. Aucune API "news"
  officielle et gratuite n'existant chez DuckDuckGo, c'est l'équivalent le
  plus proche d'un flux d'actu en direct via leur moteur.
- **Google News (Temps Réel)** — lit le flux RSS public
  `https://news.google.com/rss/search?q=...&hl=fr&gl=FR&ceid=FR:fr`, sans
  clé API. Les résultats incluent la date de publication (`pubDate`).

Ces deux sources sont activées par défaut et peuvent être désactivées
individuellement via `TOUTBOT_DDG_NEWS=0` / `TOUTBOT_GOOGLE_NEWS=0` si un
hébergeur bloque ces domaines. Le cache web (`WEB_CACHE_TTL`) a été raccourci
à 2 minutes pour rester cohérent avec du "temps réel".

> Remarque sandbox : dans certains environnements d'exécution restreints
> (liste blanche de domaines sortants), `html.duckduckgo.com` et
> `news.google.com` peuvent être bloqués (`host_not_allowed`). Ce n'est pas
> un bug du code — vérifie juste que ton hébergeur final autorise ces deux
> domaines en sortie (la plupart des hébergeurs Node listés plus haut n'ont
> pas ce genre de restriction).

## Différences assumées avec la version Python

1. **Elasticsearch / Qdrant non portés.** Ils étaient optionnels et
   désactivés par défaut dans le fichier Python d'origine. La recherche
   interne (mots exacts FTS5, racines françaises, vecteurs par hachage) et
   la recherche web (Wikipedia, DuckDuckGo, DuckDuckGo Actu, Google News,
   Brave, SearXNG) sont, elles, entièrement portées (et enrichies des deux
   sources d'actu temps réel) puis fusionnées par RRF comme avant.
2. **Proxy HTTP sortant non porté** (`TOUTBOT_HTTP_PROXY`) : `fetch()`
   natif de Node ne le supporte pas sans librairie tierce (`undici`'s
   `ProxyAgent`). À ajouter toi-même si ton hébergeur en a besoin.
3. **Sessions** : stockées côté serveur dans une table SQLite plutôt que
   dans un cookie signé (comme Flask le fait par défaut). Fonctionnellement
   équivalent, et plus simple à auditer.

## Déploiement

N'importe quel hébergeur qui exécute Node.js ≥ 22 convient (Render, Fly.io,
Railway, un VPS avec `pm2`, etc.). Le point d'entrée est `server.js` (ou
`npm start`). Pense à définir `TOUTBOT_ADMIN_PASSWORD` et, si tu veux le
chat IA, `POLLINATIONS_KEY`.

Contrairement à PythonAnywhere, la plupart de ces hébergeurs n'imposent pas
de liste blanche de domaines sortants — donc l'IA et la recherche web
devraient fonctionner directement, sans les soucis d'allowlist rencontrés
avec la version Python.

## Test rapide

`test_flow.js` est un petit script de fumée (inscription, connexion,
publication, recherche, chat, portefeuille) que j'ai utilisé pour valider
ce portage. Pour le relancer :

```bash
node server.js &        # démarre le serveur sur le port 3000
node test_flow.js       # (ajuste le port en tête du fichier si besoin)
```
