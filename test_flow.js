const BASE = "http://127.0.0.1:3311";
let cookie = "";

function extractCsrf(html) {
  const m = html.match(/name="csrf_token" value="([a-f0-9]+)"/);
  return m ? m[1] : null;
}

async function req(method, path, { form, json, headers = {} } = {}) {
  const opts = { method, headers: { ...headers }, redirect: "manual" };
  if (cookie) opts.headers.Cookie = cookie;
  if (form) {
    opts.headers["Content-Type"] = "application/x-www-form-urlencoded";
    opts.body = new URLSearchParams(form).toString();
  } else if (json) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(json);
  }
  const res = await fetch(BASE + path, opts);
  const setCookie = res.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0];
  return res;
}

async function main() {
  let res = await req("GET", "/register");
  let html = await res.text();
  let tok = extractCsrf(html);
  console.log("GET /register ->", res.status, "csrf?", !!tok);

  res = await req("POST", "/register", { form: { pseudo: "testuser1", password: "Password123", csrf_token: tok } });
  console.log("POST /register ->", res.status, res.headers.get("location"));

  res = await req("GET", "/feed");
  console.log("GET /feed ->", res.status);
  html = await res.text();
  tok = extractCsrf(html);

  res = await req("POST", "/post", { form: { content: "Bonjour le monde https://youtu.be/dQw4w9WgXcQ", visibility: "PUBLIC", csrf_token: tok } });
  console.log("POST /post ->", res.status, res.headers.get("location"));

  res = await req("GET", "/search?q=bonjour");
  console.log("GET /search ->", res.status);
  if (res.status >= 500) console.log(await res.text());

  res = await req("GET", "/chat");
  html = await res.text();
  tok = extractCsrf(html);
  console.log("GET /chat ->", res.status);

  res = await req("POST", "/api/chat", { json: { message: "Bonjour" }, headers: { "X-CSRF-Token": tok } });
  console.log("POST /api/chat ->", res.status, await res.text());

  res = await req("GET", "/wallet");
  console.log("GET /wallet ->", res.status);
  html = await res.text();
  tok = extractCsrf(html);

  res = await req("POST", "/wallet/deposit", { form: { amount: "1000", phone: "0102030405", csrf_token: tok } });
  console.log("POST /wallet/deposit ->", res.status, res.headers.get("location"));

  res = await req("GET", "/wallet");
  html = await res.text();
  console.log("wallet page contains ticket DEP?", html.includes("DEP-"));

  res = await req("GET", "/support");
  console.log("GET /support ->", res.status);

  res = await req("GET", "/messages");
  console.log("GET /messages ->", res.status);

  res = await req("GET", "/shorts");
  html = await res.text();
  console.log("GET /shorts ->", res.status, "has video?", html.includes("youtube-nocookie"));

  res = await req("GET", "/creator/" + "USR-0000"); // inconnu -> 404
  console.log("GET /creator/unknown ->", res.status);

  // --- Admin flow ---
  let adminCookie = cookie;
  cookie = ""; // nouvelle session pour l'admin
  res = await req("GET", "/admin/login");
  html = await res.text();
  tok = extractCsrf(html);
  res = await req("POST", "/admin/login", { form: { password: "Numberone_100_ans", csrf_token: tok } });
  console.log("POST /admin/login ->", res.status, res.headers.get("location"));

  res = await req("GET", "/admin");
  console.log("GET /admin ->", res.status);
  html = await res.text();
  console.log("admin sees pending deposit?", html.includes("DEP-"));

  res = await req("GET", "/admin/ia");
  console.log("GET /admin/ia ->", res.status);

  res = await req("GET", "/admin/search");
  console.log("GET /admin/search ->", res.status);

  console.log("\nALL DONE — pas d'erreur 500 ci-dessus = tout est bon.");
}

main().catch((e) => { console.error("TEST FAILED", e); process.exit(1); });
