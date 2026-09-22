"use strict";
/* =============================================================================
 * TEMPLATES (équivalent du DictLoader Jinja2 — mêmes styles, mêmes pages)
 * ========================================================================== */
const { escapeHtml, fmtFcfa } = require("./utils");
const { labelSource } = require("./search");

const CSS = `
:root{--bg:#0e1420;--card:#172033;--gold:#e0b64a;--txt:#f3efe6;--mut:#94a0b8;--ok:#1f7a55;--ko:#b3402f}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--txt);font:16px/1.55 Georgia,"Times New Roman",serif}
header{display:flex;flex-wrap:wrap;gap:.4rem .9rem;align-items:center;justify-content:space-between;padding:.7rem 1rem;background:#080c14;border-bottom:1px solid var(--gold)}
header a{color:var(--gold);text-decoration:none}
nav{display:flex;flex-wrap:wrap;gap:.4rem .9rem;align-items:center}
main{max-width:720px;margin:0 auto;padding:1rem}
.card{background:var(--card);border-radius:10px;padding:1rem;margin:0 0 1rem}
label{font-size:.9rem;color:var(--mut)}
input,select,textarea{width:100%;padding:.7rem;margin:.25rem 0 .8rem;border-radius:8px;border:1px solid #2d3a55;background:#0b111c;color:var(--txt);font:inherit}
button{background:var(--gold);color:#1a1405;border:0;border-radius:8px;padding:.65rem 1.1rem;font:inherit;font-weight:700;cursor:pointer}
button.ghost{background:transparent;color:var(--gold);border:1px solid var(--gold)}
button.danger{background:var(--ko);color:#fff}
button.linklike{background:none;color:var(--gold);padding:0;font-weight:400}
button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible,a:focus-visible{outline:2px solid var(--gold);outline-offset:2px}
.flash{padding:.7rem 1rem;border-radius:8px;margin-bottom:1rem;background:#26314a}
.flash.ok{background:#173d2e}.flash.err{background:#4a1f1a}
.mut{color:var(--mut);font-size:.9rem}
.row{display:flex;gap:.6rem;flex-wrap:wrap}.row>*{flex:1}
.chatlog{height:58vh;overflow-y:auto;display:flex;flex-direction:column;gap:.5rem;padding:.25rem}
.msg{padding:.6rem .9rem;border-radius:14px;max-width:88%;white-space:pre-wrap;overflow-wrap:anywhere}
.msg.me{align-self:flex-end;background:var(--gold);color:#1a1405}
.msg.bot{align-self:flex-start;background:var(--card)}
.msg.sys{align-self:center;background:#26314a;color:var(--mut);font-size:.85rem;max-width:95%}
table{width:100%;border-collapse:collapse;font-size:.88rem}
td,th{padding:.4rem;border-bottom:1px solid #2a3652;text-align:left;vertical-align:top}
.scroll{overflow-x:auto}
.reel{scroll-snap-type:y mandatory;height:calc(100vh - 64px);overflow-y:scroll}
.reel section{scroll-snap-align:start;height:calc(100vh - 64px);display:flex;flex-direction:column;justify-content:center;align-items:center;gap:.5rem;padding:.5rem}
iframe{width:min(100%,360px);aspect-ratio:9/16;border:0;border-radius:10px;background:#000}
form.inline{display:inline}
`;

function nav(ctx) {
  if (ctx.me) {
    return `
    <a href="/chat">Chat IA</a>
    <a href="/messages">💬 Admin${ctx.unreadDm ? ` <b>(${ctx.unreadDm})</b>` : ""}</a>
    <a href="/search" aria-label="Rechercher">🔎</a>
    <a href="/feed">Fil</a>
    <a href="/shorts">Shorts</a>
    <a href="/wallet">Portefeuille</a>
    <a href="/support">Aide</a>
    <form class="inline" method="post" action="/logout">
      <input type="hidden" name="csrf_token" value="${escapeHtml(ctx.csrfToken)}">
      <button class="linklike" type="submit">Quitter</button>
    </form>`;
  }
  return `<a href="/login">Connexion</a><a href="/register">Créer un compte</a>`;
}

function page(ctx, { title = "ToutBot Prestige", body, outer = false }) {
  const flashHtml = (ctx.flashes || [])
    .map(([cat, msg]) => `<div class="flash ${escapeHtml(cat)}">${escapeHtml(msg)}</div>`)
    .join("");
  const content = outer ? body : `<main>${flashHtml}${body}</main>`;
  return `<!doctype html>
<html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${CSS}</style></head><body>
<header>
  <a href="/"><b>💎 ToutBot Prestige</b></a>
  <nav>${nav(ctx)}</nav>
</header>
${content}
</body></html>`;
}

// -------------------------------------------------------------------- macros
function postCard(p) {
  return `
<article class="card">
  <div class="mut"><a style="color:var(--gold)" href="/creator/${escapeHtml(p.user_id_code)}">${escapeHtml(p.author)}</a>
    — ${escapeHtml(p.created_at)}${p.visibility === "ABONNES" ? " — 🔒 abonnés" : ""}</div>
  <p style="white-space:pre-wrap;overflow-wrap:anywhere">${escapeHtml(p.content)}</p>
  ${p.yt ? `<iframe src="https://www.youtube-nocookie.com/embed/${escapeHtml(p.yt)}" loading="lazy" allowfullscreen referrerpolicy="strict-origin-when-cross-origin" title="Vidéo"></iframe>` : ""}
</article>`;
}

function bubble(m, mine) {
  const cls = m.sender === "SYSTEM" ? "sys" : m.sender === mine ? "me" : "bot";
  const d = String(m.created_at || "");
  return `
<div class="msg ${cls}">
  ${escapeHtml(m.message)}
  <span class="mut" style="display:block;font-size:.72rem">${d.slice(8, 10)}/${d.slice(5, 7)} ${d.slice(11, 16)}</span>
</div>`;
}

function chatJs(nonce, pollUrl, mine) {
  return `<script nonce="${nonce}">
(function(){
const log=document.getElementById('log'); if(!log) return;
let last=parseInt(log.dataset.last||'0',10); const mine=log.dataset.mine; const url=log.dataset.poll;
function bubble(m){
  const d=document.createElement('div');
  d.className='msg '+(m.sender==='SYSTEM'?'sys':(m.sender===mine?'me':'bot'));
  d.appendChild(document.createTextNode(m.message));
  const t=document.createElement('span'); t.className='mut'; t.style.cssText='display:block;font-size:.72rem';
  t.textContent=m.created_at.slice(8,10)+'/'+m.created_at.slice(5,7)+' '+m.created_at.slice(11,16);
  d.appendChild(t); log.appendChild(d);
}
log.scrollTop=log.scrollHeight;
async function poll(){
  if(document.hidden) return;
  try{
    const r=await fetch(url+'?after='+last,{headers:{'Accept':'application/json'}});
    if(!r.ok) return;
    const list=await r.json();
    if(list.length){
      const atBottom=log.scrollHeight-log.scrollTop-log.clientHeight<80;
      list.forEach(m=>{bubble(m); last=Math.max(last,m.id);});
      if(atBottom) log.scrollTop=log.scrollHeight;
    }
  }catch(e){}
}
setInterval(poll,8000);
})();
</script>`;
}

// -------------------------------------------------------------------- pages

function home(ctx) {
  return page(ctx, {
    title: "ToutBot Prestige",
    body: `
<div class="card">
  <h1>Ton assistant IA, ton portefeuille, tes créateurs.</h1>
  <p>Pose n'importe quelle question au bot, publie, abonne-toi et paie en Mobile Money.</p>
  <div class="row">
    <a href="/register"><button style="width:100%">Créer un compte</button></a>
    <a href="/login"><button class="ghost" style="width:100%">Se connecter</button></a>
  </div>
</div>`,
  });
}

function auth(ctx, { title, isRegister }) {
  return page(ctx, {
    title,
    body: `
<div class="card"><h2>${escapeHtml(title)}</h2>
<form method="post">
  <input type="hidden" name="csrf_token" value="${escapeHtml(ctx.csrfToken)}">
  <label for="pseudo">Pseudo ou numéro de téléphone</label>
  <input id="pseudo" name="pseudo" required minlength="3" maxlength="32" autocomplete="username">
  <label for="password">Mot de passe (8 caractères minimum)</label>
  <input id="password" type="password" name="password" required minlength="8" maxlength="128"
         autocomplete="${isRegister ? "new-password" : "current-password"}">
  <button type="submit" style="width:100%">${escapeHtml(title)}</button>
</form>
<p class="mut">
${isRegister
    ? `Déjà inscrit ? <a style="color:var(--gold)" href="/login">Connexion</a>`
    : `Pas de compte ? <a style="color:var(--gold)" href="/register">Créer un compte</a>`}
</p></div>`,
  });
}

function chatPage(ctx, { history }) {
  const log = !history.length
    ? `<div class="msg bot">Bonjour ! Pose-moi ta question.</div>`
    : history.map((m) => `<div class="msg ${m.sender === "USER" ? "me" : "bot"}">${escapeHtml(m.message)}</div>`).join("");
  return page(ctx, {
    title: "Chat IA",
    body: `
<div class="card">
  <div id="log" class="chatlog" aria-live="polite">${log}</div>
  <form id="f" class="row" style="margin-top:.75rem;flex-wrap:nowrap">
    <input id="q" maxlength="2000" autocomplete="off" placeholder="Écris ta question…" required style="margin:0" aria-label="Ta question">
    <button id="btn" type="submit" style="flex:0 0 auto">Envoyer</button>
  </form>
</div>
<script nonce="${ctx.nonce}">
const log=document.getElementById('log'),f=document.getElementById('f'),q=document.getElementById('q'),btn=document.getElementById('btn');
function add(cls,text){const d=document.createElement('div');d.className='msg '+cls;d.textContent=text;log.appendChild(d);log.scrollTop=log.scrollHeight;return d;}
log.scrollTop=log.scrollHeight;
f.addEventListener('submit',async(e)=>{
  e.preventDefault();
  const text=q.value.trim(); if(!text) return;
  q.value=''; add('me',text); const wait=add('bot','…'); btn.disabled=true;
  try{
    const r=await fetch('/api/chat',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':'${ctx.csrfToken}'},body:JSON.stringify({message:text})});
    const j=await r.json();
    wait.textContent=j.reply||j.error||'Erreur inconnue.';
    if(j.sources&&j.sources.length){
      const s=document.createElement('span'); s.className='mut'; s.style.cssText='display:block;font-size:.75rem;margin-top:.4rem';
      s.appendChild(document.createTextNode('Sources : '));
      let n=0;
      j.sources.forEach(x=>{
        if(!/^(https?:[/][/]|[/])/.test(x.url)) return;
        if(n++) s.appendChild(document.createTextNode(' · '));
        const a=document.createElement('a'); a.textContent=x.title; a.href=x.url; a.rel='noopener noreferrer'; a.target='_blank'; a.style.color='var(--gold)';
        s.appendChild(a);
      });
      if(n) wait.appendChild(s);
    }
  }catch(err){wait.textContent='Connexion perdue. Réessaie.';}
  btn.disabled=false; q.focus();
});
</script>`,
  });
}

function wallet(ctx, { user, txs, minAmount, maxAmount, rate, floor, tiers, days, numbers }) {
  const numbersHtml = numbers.map((n, i) => `<b>${escapeHtml(n)}</b>${i < numbers.length - 1 ? " ou " : ""}`).join("");
  const tiersHtml = tiers
    .map((t) => `<option value="${t}" ${t === user.tier_price ? "selected" : ""}>${escapeHtml(fmtFcfa(t))}</option>`)
    .join("");
  const txsHtml = txs.length
    ? txs
        .map(
          (t) => `<tr><td>${escapeHtml(t.type)}</td><td>${escapeHtml(fmtFcfa(t.type === "REVENU" ? t.net_amount : t.amount_requested))}</td><td>${escapeHtml(t.status)}</td><td>${escapeHtml(t.ticket_code)}</td></tr>`
        )
        .join("")
    : `<tr><td colspan="4" class="mut">Aucune opération pour l'instant.</td></tr>`;
  return page(ctx, {
    title: "Portefeuille",
    body: `
<div class="card"><div class="mut">Solde</div><h1 style="margin:.2rem 0">${escapeHtml(fmtFcfa(user.balance))}</h1>
<div class="mut">Ton code : ${escapeHtml(user.user_id_code)} — ${user.views_count} visite(s) sur ton profil —
<a style="color:var(--gold)" href="/creator/${escapeHtml(user.user_id_code)}">voir mon profil</a></div></div>

<div class="card"><h3>Déposer de l'argent</h3>
<p><a style="color:var(--gold)" href="/messages">💬 Discuter en privé avec l'admin</a></p>
<p class="mut">Envoie ton Mobile Money à : ${numbersHtml}.
Ensuite remplis ce formulaire. Ton dépôt est ajouté après vérification.</p>
<form method="post" action="/wallet/deposit">
  <input type="hidden" name="csrf_token" value="${escapeHtml(ctx.csrfToken)}">
  <label for="da">Montant envoyé (FCFA)</label><input id="da" name="amount" type="number" min="${minAmount}" max="${maxAmount}" required>
  <label for="dp">Numéro depuis lequel tu as payé</label><input id="dp" name="phone" inputmode="tel" required maxlength="20">
  <button type="submit">Déclarer mon dépôt</button>
</form></div>

<div class="card"><h3>Retirer de l'argent</h3>
<p><a style="color:var(--gold)" href="/messages">💬 Discuter en privé avec l'admin</a></p>
<p class="mut">Commission : ${Math.round(rate * 100)} % (minimum ${escapeHtml(fmtFcfa(floor))}).</p>
<form method="post" action="/wallet/withdraw">
  <input type="hidden" name="csrf_token" value="${escapeHtml(ctx.csrfToken)}">
  <label for="wa">Montant à retirer (FCFA)</label><input id="wa" name="amount" type="number" min="${minAmount}" max="${maxAmount}" required>
  <label for="wp">Numéro qui reçoit l'argent</label><input id="wp" name="phone" inputmode="tel" required maxlength="20">
  <button type="submit">Demander le retrait</button>
</form></div>

<div class="card"><h3>Mon prix d'abonnement</h3>
<form method="post" action="/wallet/tier">
  <input type="hidden" name="csrf_token" value="${escapeHtml(ctx.csrfToken)}">
  <label for="tp">Ce que paient mes abonnés pour ${days} jours</label>
  <select id="tp" name="tier">${tiersHtml}</select>
  <button type="submit">Enregistrer</button>
</form></div>

<div class="card"><h3>Historique</h3><div class="scroll"><table>
<tr><th>Type</th><th>Montant</th><th>État</th><th>Ticket</th></tr>${txsHtml}
</table></div></div>`,
  });
}

function feed(ctx, { posts }) {
  const postsHtml = posts.length ? posts.map(postCard).join("") : `<p class="mut">Rien à voir pour l'instant. Publie le premier message !</p>`;
  return page(ctx, {
    title: "Fil",
    body: `
<div class="card"><form method="post" action="/post">
  <input type="hidden" name="csrf_token" value="${escapeHtml(ctx.csrfToken)}">
  <label for="c">Publier (tu peux coller un lien YouTube / Shorts)</label>
  <textarea id="c" name="content" rows="3" maxlength="1000" required></textarea>
  <div class="row"><select name="visibility" aria-label="Visibilité">
    <option value="PUBLIC">Public</option><option value="ABONNES">Réservé aux abonnés</option></select>
  <button type="submit">Publier</button></div>
</form></div>
${postsHtml}`,
  });
}

function shorts(ctx, { posts }) {
  const sectionsHtml = posts.length
    ? posts
        .map(
          (p) => `<section>
  <iframe src="https://www.youtube-nocookie.com/embed/${escapeHtml(p.yt)}" loading="lazy" allowfullscreen referrerpolicy="strict-origin-when-cross-origin" title="Vidéo"></iframe>
  <div class="mut"><a style="color:var(--gold)" href="/creator/${escapeHtml(p.user_id_code)}">${escapeHtml(p.author)}</a> — ${escapeHtml(String(p.content).slice(0, 120))}</div>
</section>`
        )
        .join("")
    : `<section><p class="mut">Aucune vidéo pour l'instant. Publie un lien YouTube dans le fil.</p></section>`;
  return page(ctx, { title: "Shorts", outer: true, body: `<div class="reel">${sectionsHtml}</div>` });
}

function creator(ctx, { creator: c, posts, isOwner, expires, locked, days }) {
  const postsHtml = posts.length ? posts.map(postCard).join("") : `<p class="mut">Aucune publication visible.</p>`;
  return page(ctx, {
    title: c.phone_or_pseudo,
    body: `
<div class="card"><h2 style="margin:0">${escapeHtml(c.phone_or_pseudo)}</h2>
<div class="mut">Abonnement : ${escapeHtml(fmtFcfa(c.tier_price))} pour ${days} jours</div>
${
  isOwner
    ? `<p class="mut">C'est ton profil.</p>`
    : `${expires ? `<p>✅ Abonné jusqu'au ${escapeHtml(expires.slice(0, 10))}</p>` : ""}
  <form method="post" action="/subscribe/${escapeHtml(c.user_id_code)}">
    <input type="hidden" name="csrf_token" value="${escapeHtml(ctx.csrfToken)}">
    <button type="submit">${expires ? "Prolonger" : "S'abonner"} (${escapeHtml(fmtFcfa(c.tier_price))})</button>
  </form>`
}
${locked ? `<p class="mut">🔒 ${locked} publication(s) réservée(s) aux abonnés.</p>` : ""}</div>
${postsHtml}`,
  });
}

function support(ctx, { tickets, issues }) {
  const issuesHtml = issues
    .map((i) => `<option value="${i}">${escapeHtml(i.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()).toLowerCase().replace(/^./, (c) => c.toUpperCase()))}</option>`)
    .join("");
  const ticketsHtml = tickets.length
    ? tickets
        .map(
          (s) => `<p><b>${escapeHtml(s.tx_ticket_code)}</b> — ${escapeHtml(s.status)}<br><span class="mut">${escapeHtml(s.message)}</span><br>Réponse : ${escapeHtml(s.admin_reply)}</p>`
        )
        .join("")
    : `<p class="mut">Aucune demande.</p>`;
  return page(ctx, {
    title: "Aide",
    body: `
<div class="card"><h3>Un problème avec une opération ?</h3>
<form method="post">
  <input type="hidden" name="csrf_token" value="${escapeHtml(ctx.csrfToken)}">
  <label for="t">Code du ticket (ex. DEP-1A2B3C4D)</label><input id="t" name="ticket" required maxlength="20">
  <label for="i">Type de problème</label>
  <select id="i" name="issue">${issuesHtml}</select>
  <label for="m">Explique en quelques mots</label><textarea id="m" name="message" rows="4" minlength="10" maxlength="1000" required></textarea>
  <button type="submit">Envoyer</button>
</form></div>
<div class="card"><h3>Mes demandes</h3>${ticketsHtml}</div>`,
  });
}

function searchPage(ctx, { q, results }) {
  const resultsHtml = results.length
    ? results
        .map(
          (r) => `<div class="card">
    <div class="mut">${escapeHtml(labelSource(r.source))}${r.found_by ? ` · ${escapeHtml(r.found_by.join(", "))}` : ""}</div>
    <h3 style="margin:.2rem 0"><a style="color:var(--gold)" href="${escapeHtml(r.url)}">${escapeHtml(r.title)}</a></h3>
    <p>${escapeHtml(r.snippet)}</p>
  </div>`
        )
        .join("")
    : q
    ? `<p class="mut">Aucun résultat.</p>`
    : "";
  return page(ctx, {
    title: "Recherche",
    body: `
<div class="card">
  <h2>Recherche</h2>
  <form method="get">
    <input name="q" value="${escapeHtml(q || "")}" placeholder="Mots-clés…" maxlength="200" required>
    <button type="submit">Chercher</button>
  </form>
</div>
${resultsHtml}`,
  });
}

function messagesPage(ctx, { messages, lastId }) {
  const log = messages.length
    ? messages.map((m) => bubble(m, "USER")).join("")
    : `<div class="msg bot">Écris ici pour discuter avec l'admin (dépôts, retraits, problèmes…).</div>`;
  return page(ctx, {
    title: "Messages Admin",
    body: `
<div class="card">
  <h2>Discussion privée avec l'admin</h2>
  <div id="log" class="chatlog" data-last="${lastId}" data-mine="USER" data-poll="/messages/poll">${log}</div>
  <form method="post" class="row" style="margin-top:.75rem;flex-wrap:nowrap">
    <input type="hidden" name="csrf_token" value="${escapeHtml(ctx.csrfToken)}">
    <input name="message" maxlength="1000" autocomplete="off" placeholder="Ton message…" required style="margin:0" aria-label="Message">
    <button type="submit" style="flex:0 0 auto">Envoyer</button>
  </form>
</div>
${chatJs(ctx.nonce)}`,
  });
}

function adminLogin(ctx) {
  return page(ctx, {
    title: "Administration",
    body: `
<div class="card"><h2>Administration</h2>
<form method="post"><input type="hidden" name="csrf_token" value="${escapeHtml(ctx.csrfToken)}">
<label for="p">Mot de passe admin</label><input id="p" type="password" name="password" required autocomplete="current-password">
<button type="submit">Entrer</button></form></div>`,
  });
}

function adminDashboard(ctx, { stats, pending, tickets, logs }) {
  const pendingHtml = pending.length
    ? pending
        .map(
          (t) => `<tr><td>${escapeHtml(t.ticket_code)}</td><td>${escapeHtml(t.type)}</td><td>${escapeHtml(fmtFcfa(t.amount_requested))}</td>
<td>${escapeHtml(fmtFcfa(t.net_amount))}</td><td>${escapeHtml(t.user_reference_phone)}</td>
<td><a style="color:var(--gold)" href="/admin/chat/${escapeHtml(t.user_id_code)}">💬 Discuter</a><br>
${[["approve", "Valider", ""], ["reject", "Refuser", "danger"]]
  .map(
    ([act, label, cls]) =>
      `<form class="inline" method="post" action="/admin/tx/${t.id}/${act}"><input type="hidden" name="csrf_token" value="${escapeHtml(ctx.csrfToken)}"><button class="${cls}" type="submit">${label}</button></form>`
  )
  .join("")}</td></tr>`
        )
        .join("")
    : `<tr><td colspan="6" class="mut">Rien en attente.</td></tr>`;
  const ticketsHtml = tickets.length
    ? tickets
        .map(
          (s) => `<div style="margin-bottom:1rem"><b>${escapeHtml(s.tx_ticket_code)}</b> — ${escapeHtml(s.issue_type)} — membre ${escapeHtml(s.user_id_code)}<br>
<span class="mut">${escapeHtml(s.message)}</span>
<form method="post" action="/admin/ticket/${s.id}"><input type="hidden" name="csrf_token" value="${escapeHtml(ctx.csrfToken)}">
<textarea name="reply" rows="2" maxlength="1000" required aria-label="Réponse"></textarea><button type="submit">Répondre et clore</button></form></div>`
        )
        .join("")
    : `<p class="mut">Aucune demande ouverte.</p>`;
  const logsHtml = logs.map((a) => `<tr><td>${escapeHtml(a.created_at)}</td><td>${escapeHtml(a.actor)}</td><td>${escapeHtml(a.action)}</td><td>${escapeHtml(a.detail)}</td></tr>`).join("");
  return page(ctx, {
    title: "Admin",
    body: `
<div class="card"><h2 style="margin-top:0">Tableau de bord</h2>
<p>${stats.users} membre(s) — ${escapeHtml(fmtFcfa(stats.total))} sur les portefeuilles — ${stats.pending} opération(s) en attente</p>
<p><a style="color:var(--gold)" href="/admin/messages">💬 Discussions avec les membres${stats.unread ? ` — <b>${stats.unread} non lu(s)</b>` : ""}</a></p>
<p><a style="color:var(--gold)" href="/admin/ia">🔧 Tester l'IA (diagnostic)</a></p>
<p><a style="color:var(--gold)" href="/admin/search">🧭 Moteurs de recherche</a></p>
<form method="post" action="/admin/logout"><input type="hidden" name="csrf_token" value="${escapeHtml(ctx.csrfToken)}"><button class="ghost" type="submit">Quitter l'admin</button></form></div>

<div class="card"><h3>Dépôts et retraits à traiter</h3><div class="scroll"><table>
<tr><th>Ticket</th><th>Type</th><th>Montant</th><th>À envoyer</th><th>Numéro</th><th></th></tr>${pendingHtml}
</table></div></div>

<div class="card"><h3>Demandes d'aide ouvertes</h3>${ticketsHtml}</div>

<div class="card"><h3>Journal (20 derniers)</h3><div class="scroll"><table>${logsHtml}</table></div></div>`,
  });
}

function adminIa(ctx, { error, answer, seconds, info }) {
  return page(ctx, {
    title: "Test IA",
    body: `
<div class="card"><h2 style="margin-top:0">Test du moteur d'IA</h2>
${error ? `<div class="flash err"><b>❌ L'IA ne répond pas.</b><br>${escapeHtml(error)}</div>` : `<div class="flash ok"><b>✅ L'IA répond :</b> ${escapeHtml(answer)}</div>`}
<p class="mut">Temps : ${seconds} s</p>
<h3>Réglages vus par le programme</h3>
<table>
<tr><td>Adresse</td><td>${escapeHtml(info.endpoint)}</td></tr>
<tr><td>Modèle</td><td>${escapeHtml(info.model)}</td></tr>
<tr><td>Clé POLLINATIONS_KEY</td><td>${info.keyLen ? `oui (${info.keyLen} caractères, commence par ${escapeHtml(info.keyStart)})` : "NON — absente"}</td></tr>
<tr><td>Sur PythonAnywhere</td><td>${info.onPa ? "oui" : "non"}</td></tr>
</table>
<p><a style="color:var(--gold)" href="/admin">← Retour admin</a></p></div>`,
  });
}

function adminSearch(ctx, { internal }) {
  return page(ctx, {
    title: "Moteurs de recherche",
    body: `
<div class="card">
  <h2>État des moteurs</h2>
  <p class="mut">Interne : ${internal.stem_ok ? "racines OK" : "racines off"} · ${internal.vectors} vecteurs (hachage local)</p>
  <p class="mut">Web : Wikipedia, DuckDuckGo${process.env.BRAVE_API_KEY ? ", Brave" : ""}${process.env.SEARXNG_URL ? ", SearXNG" : ""}.
  Elasticsearch/Qdrant ne sont pas portés dans cette version JS (ils étaient optionnels et désactivés par défaut).</p>
  <form method="post" action="/admin/reindex" style="margin-top:1rem">
    <input type="hidden" name="csrf_token" value="${escapeHtml(ctx.csrfToken)}">
    <button type="submit">Reconstruire les index internes</button>
  </form>
  <p><a style="color:var(--gold)" href="/admin">← Retour admin</a></p>
</div>`,
  });
}

function adminMessages(ctx, { users }) {
  const usersHtml = users.length
    ? users
        .map(
          (u) => `<p><a style="color:var(--gold)" href="/admin/chat/${escapeHtml(u.user_id_code)}">${escapeHtml(u.phone_or_pseudo)} (${escapeHtml(u.user_id_code)})</a>${u.unread ? ` — <b>${u.unread} non lu(s)</b>` : ""}</p>`
        )
        .join("")
    : `<p class="mut">Aucune discussion.</p>`;
  return page(ctx, {
    title: "Discussions membres",
    body: `<div class="card"><h2>Discussions privées</h2>${usersHtml}</div><p><a style="color:var(--gold)" href="/admin">← Retour</a></p>`,
  });
}

function adminChat(ctx, { user, messages, lastId }) {
  const log = messages.length ? messages.map((m) => bubble(m, "ADMIN")).join("") : `<div class="msg bot">Aucun message pour l'instant.</div>`;
  return page(ctx, {
    title: "Chat membre",
    body: `
<div class="card">
  <h2>Discussion avec ${escapeHtml(user.phone_or_pseudo)}</h2>
  <div id="log" class="chatlog" data-last="${lastId}" data-mine="ADMIN" data-poll="/admin/chat/${escapeHtml(user.user_id_code)}/poll">${log}</div>
  <form method="post" class="row" style="margin-top:.75rem;flex-wrap:nowrap">
    <input type="hidden" name="csrf_token" value="${escapeHtml(ctx.csrfToken)}">
    <input name="message" maxlength="1000" autocomplete="off" placeholder="Répondre…" required style="margin:0">
    <button type="submit" style="flex:0 0 auto">Envoyer</button>
  </form>
</div>
${chatJs(ctx.nonce)}
<p><a style="color:var(--gold)" href="/admin/messages">← Retour</a></p>`,
  });
}

function errorPage(ctx, { code, msg }) {
  return page(ctx, {
    title: `Erreur ${code}`,
    body: `<div class="card"><h2>Erreur ${code}</h2><p>${escapeHtml(msg)}</p><a href="/"><button>Retour à l'accueil</button></a></div>`,
  });
}

module.exports = {
  home, auth, chatPage, wallet, feed, shorts, creator, support,
  searchPage, messagesPage, adminLogin, adminDashboard, adminIa,
  adminSearch, adminMessages, adminChat, errorPage,
};
