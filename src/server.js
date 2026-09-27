"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const config = require("./config");
const db = require("./db");
const auth = require("./auth");
const { q, tx, T } = db;

const log = (...a) => console.log(new Date().toISOString(), ...a);
const PUBLIC = path.join(__dirname, "..", "public");
const EXAMPLE = JSON.parse(fs.readFileSync(path.join(__dirname, "example.json"), "utf8"));
const MAX_BODY = 10 * 1024 * 1024;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/* ---------------- helpers ---------------- */
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new HttpError(status, message); };

function parseCookies(req) {
  const out = {};
  (req.headers.cookie || "").split(";").forEach(p => {
    const i = p.indexOf("=");
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}
function isHttps(req) {
  if (req.socket.encrypted) return true;
  return config.trustProxy && String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim() === "https";
}
function sessionCookie(req, token, expires) {
  const secure = config.cookieSecure === "true" || (config.cookieSecure === "auto" && isHttps(req));
  const parts = [`${auth.COOKIE}=${token || ""}`, "Path=/", "HttpOnly", "SameSite=Lax"];
  parts.push(token ? `Expires=${expires.toUTCString()}` : "Max-Age=0");
  if (secure) parts.push("Secure");
  return parts.join("; ");
}
function clientIp(req) {
  if (config.trustProxy && req.headers["x-forwarded-for"]) return String(req.headers["x-forwarded-for"]).split(",")[0].trim();
  return req.socket.remoteAddress || "";
}
const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "same-origin",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; " +
    "font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'; " +
    "frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
};
function send(res, status, body, headers = {}) {
  const isJson = typeof body !== "string" && !Buffer.isBuffer(body);
  const data = isJson ? JSON.stringify(body) : body;
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    "Content-Type": isJson ? "application/json; charset=utf-8" : "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(data);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", c => {
      size += c.length;
      if (size > MAX_BODY) { reject(new HttpError(413, "Pedido demasiado grande.")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch (_) { reject(new HttpError(400, "JSON inválido.")); }
    });
    req.on("error", reject);
  });
}

/* ---------------- static files ---------------- */
const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json", ".txt": "text/plain; charset=utf-8",
};
function serveStatic(req, res, pathname) {
  let rel = pathname === "/" ? "/index.html" : pathname;
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep)) return send(res, 404, "Não encontrado");
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      // unknown paths without an extension fall back to the app
      if (!path.extname(rel)) return serveStatic(req, res, "/");
      return send(res, 404, "Não encontrado");
    }
    const ext = path.extname(file);
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      "Content-Type": TYPES[ext] || "application/octet-stream",
      "Content-Length": st.size,
      "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=300",
    });
    if (req.method === "HEAD") return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

/* ---------------- diagrams ---------------- */
function cleanDiagram(d, id) {
  if (!d || typeof d !== "object" || Array.isArray(d)) fail(400, "Diagrama inválido.");
  if (!Array.isArray(d.nodes) || !Array.isArray(d.edges)) fail(400, "O diagrama tem de ter 'nodes' e 'edges'.");
  const level = Number(d.level);
  if (!(level >= 1 && level <= 4)) fail(400, "Nível inválido (1 a 4).");
  if (d.parentId != null && !ID_RE.test(String(d.parentId))) fail(400, "parentId inválido.");
  return { ...d, id, level, updatedAt: Number(d.updatedAt) || Date.now() };
}
async function listDiagrams(userId) {
  const rows = await q(`SELECT data FROM ${T.diagrams} WHERE user_id = ?`, [userId]);
  return rows.map(r => { try { return JSON.parse(r.data); } catch (_) { return null; } }).filter(Boolean);
}
async function putDiagram(exec, userId, d) {
  await exec(
    `INSERT INTO ${T.diagrams} (user_id, id, data, updated_at) VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE data = VALUES(data), updated_at = VALUES(updated_at)`,
    [userId, d.id, JSON.stringify(d), d.updatedAt]);
}
async function seedExample(userId) {
  const now = Date.now();
  await tx(async exec => {
    for (const d of Object.values(EXAMPLE)) await putDiagram(exec, userId, { ...d, updatedAt: now });
  });
}

/* ---------------- routes ---------------- */
const routes = [];
const route = (method, pattern, handler, opts = {}) => {
  const keys = [];
  const re = new RegExp("^" + pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), "([^/]+)")) + "$");
  routes.push({ method, re, keys, handler, opts });
};

route("GET", "/healthz", async () => {
  await q("SELECT 1");
  return { ok: true };
}, { public: true });

route("GET", "/api/config", async () => ({
  appName: config.appName, allowRegistration: config.allowRegistration,
}), { public: true });

route("POST", "/api/auth/register", async ({ req, res, body }) => {
  if (!config.allowRegistration) fail(403, "O registo está fechado. Peça uma conta ao administrador.");
  if (auth.rateLimited("reg:" + clientIp(req), 10, 60 * 60e3)) fail(429, "Demasiadas tentativas. Tente mais tarde.");
  const email = String(body.email || "").trim().toLowerCase();
  const name = String(body.name || "").trim();
  if (!auth.validEmail(email)) fail(400, "Email inválido.");
  const pp = auth.passwordProblem(body.password); if (pp) fail(400, pp);
  if ((await q(`SELECT id FROM ${T.users} WHERE email = ?`, [email])).length) fail(409, "Já existe uma conta com este email.");
  const id = await auth.createUser({ email, name, password: body.password, isAdmin: false });
  if (config.exampleForNewUsers) await seedExample(id);
  const s = await auth.createSession(id);
  res.setHeader("Set-Cookie", sessionCookie(req, s.token, s.expires));
  log(`Conta criada: ${email}`);
  return { user: { id, email, name, isAdmin: false } };
}, { public: true });

route("POST", "/api/auth/login", async ({ req, res, body }) => {
  const email = String(body.email || "").trim().toLowerCase();
  const key = "login:" + clientIp(req) + ":" + email;
  if (auth.rateLimited(key, 10)) fail(429, "Demasiadas tentativas. Espere 15 minutos.");
  const rows = await q(`SELECT id, email, name, password_hash, is_admin FROM ${T.users} WHERE email = ?`, [email]);
  if (!rows.length) { await auth.dummyVerify(String(body.password || "")); fail(401, "Email ou password errados."); }
  const u = rows[0];
  if (!(await auth.verifyPassword(String(body.password || ""), u.password_hash))) fail(401, "Email ou password errados.");
  auth.clearRate(key);
  const s = await auth.createSession(u.id);
  res.setHeader("Set-Cookie", sessionCookie(req, s.token, s.expires));
  return { user: { id: u.id, email: u.email, name: u.name, isAdmin: !!u.is_admin } };
}, { public: true });

route("POST", "/api/auth/logout", async ({ req, res, token }) => {
  await auth.destroySession(token);
  res.setHeader("Set-Cookie", sessionCookie(req, null));
  return { ok: true };
}, { public: true });

route("GET", "/api/auth/me", async ({ user }) => ({ user }));

route("POST", "/api/auth/password", async ({ user, body, token }) => {
  const rows = await q(`SELECT password_hash FROM ${T.users} WHERE id = ?`, [user.id]);
  if (!(await auth.verifyPassword(String(body.current || ""), rows[0].password_hash))) fail(400, "A password atual está errada.");
  const pp = auth.passwordProblem(body.password); if (pp) fail(400, pp);
  await q(`UPDATE ${T.users} SET password_hash = ? WHERE id = ?`, [await auth.hashPassword(body.password), user.id]);
  await auth.destroyUserSessions(user.id, token); // sign out other devices
  return { ok: true };
});

route("PATCH", "/api/auth/profile", async ({ user, body }) => {
  const name = String(body.name || "").trim().slice(0, 120);
  await q(`UPDATE ${T.users} SET name = ? WHERE id = ?`, [name, user.id]);
  return { user: { ...user, name } };
});

route("GET", "/api/diagrams", async ({ user }) => ({ diagrams: await listDiagrams(user.id) }));

route("PUT", "/api/diagrams/:id", async ({ user, params, body }) => {
  if (!ID_RE.test(params.id)) fail(400, "Identificador inválido.");
  const d = cleanDiagram(body, params.id);
  await putDiagram(q, user.id, d);
  return { ok: true, updatedAt: d.updatedAt };
});

route("DELETE", "/api/diagrams/:id", async ({ user, params }) => {
  if (!ID_RE.test(params.id)) fail(400, "Identificador inválido.");
  if (params.id === "root") fail(400, "O mapa principal não pode ser apagado.");
  await q(`DELETE FROM ${T.diagrams} WHERE user_id = ? AND id = ?`, [user.id, params.id]);
  return { ok: true };
});

// Replaces all of the user's diagrams at once (used by Import).
route("POST", "/api/diagrams/import", async ({ user, body }) => {
  const src = body && body.diagrams;
  if (!src || typeof src !== "object" || !src.root) fail(400, "Ficheiro sem o mapa principal ('root').");
  const list = Object.entries(src).map(([id, d]) => {
    if (!ID_RE.test(id)) fail(400, `Identificador inválido: ${id}`);
    return cleanDiagram(d, id);
  });
  if (list.length > 5000) fail(400, "Demasiados diagramas.");
  await tx(async exec => {
    await exec(`DELETE FROM ${T.diagrams} WHERE user_id = ?`, [user.id]);
    for (const d of list) await putDiagram(exec, user.id, d);
  });
  return { ok: true, count: list.length };
});

/* ----- admin ----- */
route("GET", "/api/admin/users", async () => {
  const rows = await q(
    `SELECT u.id, u.email, u.name, u.is_admin, u.created_at, u.last_login_at,
            (SELECT COUNT(*) FROM ${T.diagrams} d WHERE d.user_id = u.id) AS diagrams
     FROM ${T.users} u ORDER BY u.created_at`);
  return { users: rows.map(r => ({ id: r.id, email: r.email, name: r.name, isAdmin: !!r.is_admin,
    createdAt: r.created_at, lastLoginAt: r.last_login_at, diagrams: Number(r.diagrams) })) };
}, { admin: true });

route("POST", "/api/admin/users", async ({ body }) => {
  const email = String(body.email || "").trim().toLowerCase();
  if (!auth.validEmail(email)) fail(400, "Email inválido.");
  const pp = auth.passwordProblem(body.password); if (pp) fail(400, pp);
  if ((await q(`SELECT id FROM ${T.users} WHERE email = ?`, [email])).length) fail(409, "Já existe uma conta com este email.");
  const id = await auth.createUser({ email, name: String(body.name || "").trim(), password: body.password, isAdmin: !!body.isAdmin });
  if (config.exampleForNewUsers) await seedExample(id);
  log(`Conta criada pelo administrador: ${email}`);
  return { id };
}, { admin: true });

route("PATCH", "/api/admin/users/:id", async ({ user, params, body }) => {
  const id = parseInt(params.id, 10);
  const target = (await q(`SELECT id FROM ${T.users} WHERE id = ?`, [id]))[0];
  if (!target) fail(404, "Utilizador não encontrado.");
  if (body.password !== undefined) {
    const pp = auth.passwordProblem(body.password); if (pp) fail(400, pp);
    await q(`UPDATE ${T.users} SET password_hash = ? WHERE id = ?`, [await auth.hashPassword(body.password), id]);
    await auth.destroyUserSessions(id);
  }
  if (body.isAdmin !== undefined) {
    if (id === user.id && !body.isAdmin) fail(400, "Não pode retirar a si próprio o papel de administrador.");
    await q(`UPDATE ${T.users} SET is_admin = ? WHERE id = ?`, [body.isAdmin ? 1 : 0, id]);
  }
  if (body.name !== undefined) await q(`UPDATE ${T.users} SET name = ? WHERE id = ?`, [String(body.name).slice(0, 120), id]);
  return { ok: true };
}, { admin: true });

route("DELETE", "/api/admin/users/:id", async ({ user, params }) => {
  const id = parseInt(params.id, 10);
  if (id === user.id) fail(400, "Não pode apagar a sua própria conta.");
  await q(`DELETE FROM ${T.users} WHERE id = ?`, [id]); // sessions and diagrams go with it (ON DELETE CASCADE)
  return { ok: true };
}, { admin: true });

/* ---------------- request handling ---------------- */
async function handle(req, res) {
  const url = new URL(req.url, "http://x");
  const pathname = decodeURIComponent(url.pathname);
  if (!pathname.startsWith("/api/") && pathname !== "/healthz") {
    if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "Método não permitido");
    return serveStatic(req, res, pathname);
  }
  const r = routes.find(r => r.method === req.method && r.re.test(pathname));
  if (!r) return send(res, 404, { error: "Rota desconhecida." });
  try {
    // CSRF protection: state-changing API calls must come from the app itself.
    if (req.method !== "GET" && req.headers["x-camadas"] !== "1") fail(403, "Pedido recusado.");
    const m = pathname.match(r.re);
    const params = Object.fromEntries(r.keys.map((k, i) => [k, m[i + 1]]));
    const token = parseCookies(req)[auth.COOKIE];
    const user = token ? await auth.userFromToken(token) : null;
    if (!r.opts.public && !user) fail(401, "Sessão terminada. Entre novamente.");
    if (r.opts.admin && !user.isAdmin) fail(403, "Só administradores.");
    const body = req.method === "GET" || req.method === "DELETE" ? {} : await readBody(req);
    const out = await r.handler({ req, res, params, body, user, token });
    send(res, 200, out);
  } catch (e) {
    if (e instanceof HttpError) return send(res, e.status, { error: e.message });
    log("Erro:", req.method, pathname, e.code || "", e.message);
    send(res, 500, { error: "Erro no servidor. Tente de novo." });
  }
}

/* ---------------- startup ---------------- */
async function ensureAdmin() {
  const admins = await q(`SELECT COUNT(*) AS n FROM ${T.users} WHERE is_admin = 1`);
  if (Number(admins[0].n) > 0) return;
  if (!config.admin.email || !config.admin.password) {
    log("AVISO: não existe nenhum administrador. Defina ADMIN_EMAIL e ADMIN_PASSWORD no .env e reinicie, " +
        "ou corra: docker compose exec app node src/cli.js create-admin <email> <password>");
    return;
  }
  const pp = auth.passwordProblem(config.admin.password);
  if (pp) { log("AVISO: ADMIN_PASSWORD inválida: " + pp); return; }
  const existing = (await q(`SELECT id FROM ${T.users} WHERE email = ?`, [config.admin.email]))[0];
  if (existing) {
    await q(`UPDATE ${T.users} SET is_admin = 1 WHERE id = ?`, [existing.id]);
    log(`Utilizador ${config.admin.email} promovido a administrador`);
  } else {
    const id = await auth.createUser({ email: config.admin.email, name: config.admin.name, password: config.admin.password, isAdmin: true });
    if (config.exampleForNewUsers) await seedExample(id);
    log(`Administrador criado: ${config.admin.email}`);
  }
}

async function main() {
  log(`A ligar a MariaDB em ${config.db.host}:${config.db.port}/${config.db.database} como ${config.db.user}` +
      (config.db.ssl ? " (TLS)" : ""));
  await db.waitForDb(log);
  await db.migrate(log);
  await ensureAdmin();
  setInterval(() => auth.purgeExpired().catch(() => {}), 60 * 60e3).unref();
  const server = http.createServer((req, res) => {
    handle(req, res).catch(e => { log("Erro inesperado:", e.message); try { send(res, 500, { error: "Erro no servidor." }); } catch (_) {} });
  });
  server.listen(config.port, "0.0.0.0", () =>
    log(`${config.appName} a correr na porta ${config.port} (registo ${config.allowRegistration ? "aberto" : "fechado"})`));
  const stop = sig => { log(`${sig} recebido, a terminar…`); server.close(() => db.pool.end().then(() => process.exit(0))); setTimeout(() => process.exit(0), 8000).unref(); };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));
}

if (require.main === module) {
  main().catch(e => { log("Falha ao arrancar:", e.code || "", e.message); process.exit(1); });
}
module.exports = { handle };
