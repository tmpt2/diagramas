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
  constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; }
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
    // always revalidate, so a new image version never runs with a stale app.js
    const lastModified = st.mtime.toUTCString();
    const since = Date.parse(req.headers["if-modified-since"] || "");
    if (since && Math.floor(st.mtimeMs / 1000) <= Math.floor(since / 1000)) {
      res.writeHead(304, { ...SECURITY_HEADERS, "Last-Modified": lastModified, "Cache-Control": "no-cache" });
      return res.end();
    }
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      "Content-Type": TYPES[ext] || "application/octet-stream",
      "Content-Length": st.size,
      "Last-Modified": lastModified,
      "Cache-Control": "no-cache",
    });
    if (req.method === "HEAD") return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

/* ---------------- diagrams ----------------
 * A diagram ("doc") is a set of sheets: "root" (level 1) plus one sheet per detailed box.
 * Every change to a sheet bumps the doc's revision counter and stamps the sheet with it, so
 * clients poll "what changed since rev N" and saves are checked against the rev they started from.
 */
const ROLE_RANK = { view: 1, edit: 2, owner: 3 };
const bestRole = (...roles) => roles.filter(Boolean).sort((a, b) => ROLE_RANK[b] - ROLE_RANK[a])[0] || null;
const cleanName = (s, def) => String(s == null ? "" : s).trim().slice(0, 120) || def;
function intId(s) {
  const n = Number(s);
  if (!Number.isInteger(n) || n <= 0) fail(400, "Identificador inválido.");
  return n;
}
function cleanSheet(d, id) {
  if (!d || typeof d !== "object" || Array.isArray(d)) fail(400, "Diagrama inválido.");
  if (!Array.isArray(d.nodes) || !Array.isArray(d.edges)) fail(400, "O diagrama tem de ter 'nodes' e 'edges'.");
  const level = Number(d.level);
  if (!(level >= 1 && level <= 4)) fail(400, "Nível inválido (1 a 4).");
  if (d.parentId != null && !ID_RE.test(String(d.parentId))) fail(400, "parentId inválido.");
  return { ...d, id, level, updatedAt: Number(d.updatedAt) || Date.now() };
}
function cleanSheetMap(src) {
  if (!src || typeof src !== "object" || !src.root) fail(400, "Ficheiro sem o mapa principal ('root').");
  const list = Object.entries(src).map(([id, d]) => {
    if (!ID_RE.test(id)) fail(400, `Identificador inválido: ${id}`);
    return cleanSheet(d, id);
  });
  if (list.length > 5000) fail(400, "Demasiados níveis num só diagrama.");
  return list;
}
const emptyRoot = name => ({ id: "root", name, level: 1, parentId: null, parentNodeId: null, nodes: [], edges: [], updatedAt: Date.now() });

async function createDoc(exec, { ownerId, folderId, name, sheets, byUserId }) {
  const now = Date.now();
  const r = await exec(`INSERT INTO ${T.docs} (owner_id, folder_id, name, rev, updated_at, updated_by) VALUES (?, ?, ?, 1, ?, ?)`,
    [ownerId, folderId || null, name, now, byUserId || ownerId]);
  for (const s of sheets) {
    const data = s.id === "root" ? { ...s, name } : s;
    await exec(`INSERT INTO ${T.sheets} (doc_id, id, rev, data) VALUES (?, ?, 1, ?)`, [r.insertId, s.id, JSON.stringify(data)]);
  }
  return r.insertId;
}
async function seedExample(userId) {
  const sheets = Object.values(EXAMPLE).map(d => ({ ...d, updatedAt: Date.now() }));
  await tx(exec => createDoc(exec, { ownerId: userId, name: cleanName(EXAMPLE.root.name, "Exemplo"), sheets }));
}

// The user's role on a doc: owner, or the best of a direct share and a share of its project.
async function docAccess(userId, docId) {
  const r = (await q(
    `SELECT d.id, d.owner_id, d.folder_id, d.name, d.rev,
            (SELECT role FROM ${T.docShares} WHERE doc_id = d.id AND user_id = ?) AS dr,
            (SELECT role FROM ${T.folderShares} WHERE folder_id = d.folder_id AND user_id = ?) AS fr
     FROM ${T.docs} d WHERE d.id = ?`, [userId, userId, docId]))[0];
  if (!r) return null;
  const role = r.owner_id === userId ? "owner" : bestRole(r.dr, r.fr);
  return role ? { ...r, role } : null;
}
async function folderAccess(userId, folderId) {
  const r = (await q(
    `SELECT f.id, f.owner_id, f.name,
            (SELECT role FROM ${T.folderShares} WHERE folder_id = f.id AND user_id = ?) AS fr
     FROM ${T.folders} f WHERE f.id = ?`, [userId, folderId]))[0];
  if (!r) return null;
  const role = r.owner_id === userId ? "owner" : r.fr;
  return role ? { ...r, role } : null;
}
async function need(kind, user, id, min) {
  const a = kind === "doc" ? await docAccess(user.id, id) : await folderAccess(user.id, id);
  if (!a) fail(404, kind === "doc" ? "Diagrama não encontrado ou sem acesso." : "Projeto não encontrado ou sem acesso.");
  if (ROLE_RANK[a.role] < ROLE_RANK[min]) {
    fail(403, min === "owner" ? "Só o dono pode fazer isto." : "Só tem permissão para ver.");
  }
  return a;
}

// Who else has the diagram open (kept in memory; refreshed by each client's polling).
const presence = new Map(); // docId -> Map(userId -> {id, name, email, t})
function seen(docId, user) {
  let m = presence.get(docId);
  if (!m) presence.set(docId, (m = new Map()));
  m.set(user.id, { id: user.id, name: user.name, email: user.email, t: Date.now() });
  const out = [];
  for (const [id, p] of m) {
    if (Date.now() - p.t > 20e3) m.delete(id);
    else if (id !== user.id) out.push({ id: p.id, name: p.name, email: p.email });
  }
  if (!m.size) presence.delete(docId);
  return out;
}
setInterval(() => { for (const [docId, m] of presence) { for (const [id, p] of m) if (Date.now() - p.t > 20e3) m.delete(id); if (!m.size) presence.delete(docId); } }, 60e3).unref();

async function shareList(kind, id) {
  const table = kind === "doc" ? T.docShares : T.folderShares, col = kind === "doc" ? "doc_id" : "folder_id";
  const rows = await q(
    `SELECT u.id, u.name, u.email, s.role FROM ${table} s JOIN ${T.users} u ON u.id = s.user_id
     WHERE s.${col} = ? ORDER BY u.name, u.email`, [id]);
  return rows.map(r => ({ userId: r.id, name: r.name, email: r.email, role: r.role }));
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

/* ----- library: projects and diagrams the user can open ----- */
route("GET", "/api/library", async ({ user }) => {
  const folders = await q(
    `SELECT f.id, f.name, f.owner_id, u.name AS owner_name, u.email AS owner_email, fs.role,
            (SELECT COUNT(*) FROM ${T.folderShares} x WHERE x.folder_id = f.id) AS shares
     FROM ${T.folders} f JOIN ${T.users} u ON u.id = f.owner_id
     LEFT JOIN ${T.folderShares} fs ON fs.folder_id = f.id AND fs.user_id = ?
     WHERE f.owner_id = ? OR fs.user_id IS NOT NULL
     ORDER BY f.name`, [user.id, user.id]);
  const docs = await q(
    `SELECT d.id, d.name, d.folder_id, d.owner_id, d.updated_at, u.name AS owner_name, u.email AS owner_email,
            ub.name AS upd_name, ub.email AS upd_email, d.updated_by, ds.role AS dr, fs.role AS fr,
            (SELECT COUNT(*) FROM ${T.docShares} x WHERE x.doc_id = d.id) AS shares,
            (SELECT COUNT(*) FROM ${T.sheets} s WHERE s.doc_id = d.id AND s.deleted = 0) AS sheets
     FROM ${T.docs} d JOIN ${T.users} u ON u.id = d.owner_id
     LEFT JOIN ${T.users} ub ON ub.id = d.updated_by
     LEFT JOIN ${T.docShares} ds ON ds.doc_id = d.id AND ds.user_id = ?
     LEFT JOIN ${T.folderShares} fs ON fs.folder_id = d.folder_id AND fs.user_id = ?
     WHERE d.owner_id = ? OR ds.user_id IS NOT NULL OR fs.user_id IS NOT NULL
     ORDER BY d.updated_at DESC`, [user.id, user.id, user.id]);
  const owner = r => ({ id: r.owner_id, name: r.owner_name, email: r.owner_email });
  return {
    folders: folders.map(r => ({ id: r.id, name: r.name, owner: owner(r),
      role: r.owner_id === user.id ? "owner" : r.role, shares: Number(r.shares) })),
    docs: docs.map(r => ({ id: r.id, name: r.name, folderId: r.folder_id, owner: owner(r), updatedAt: Number(r.updated_at),
      updatedBy: r.updated_by ? { id: r.updated_by, name: r.upd_name, email: r.upd_email } : null,
      role: r.owner_id === user.id ? "owner" : bestRole(r.dr, r.fr), shares: Number(r.shares), sheets: Number(r.sheets) })),
  };
});

/* ----- projects ----- */
route("POST", "/api/folders", async ({ user, body }) => {
  const r = await q(`INSERT INTO ${T.folders} (owner_id, name) VALUES (?, ?)`, [user.id, cleanName(body.name, "Novo projeto")]);
  return { id: r.insertId };
});
route("PATCH", "/api/folders/:id", async ({ user, params, body }) => {
  const f = await need("folder", user, intId(params.id), "owner");
  await q(`UPDATE ${T.folders} SET name = ? WHERE id = ?`, [cleanName(body.name, f.name), f.id]);
  return { ok: true };
});
// The project's diagrams are kept: they move out to "Sem projeto".
route("DELETE", "/api/folders/:id", async ({ user, params }) => {
  const f = await need("folder", user, intId(params.id), "owner");
  await q(`DELETE FROM ${T.folders} WHERE id = ?`, [f.id]);
  return { ok: true };
});

/* ----- diagrams ----- */
// New diagram, empty or from an exported file ({name, folderId, sheets}).
route("POST", "/api/docs", async ({ user, body }) => {
  let ownerId = user.id, folderId = null;
  if (body.folderId != null) {
    const f = await need("folder", user, intId(body.folderId), "edit");
    ownerId = f.owner_id; folderId = f.id; // a diagram belongs to whoever owns its project
  }
  const sheets = body.sheets ? cleanSheetMap(body.sheets) : null;
  const name = cleanName(body.name, sheets ? cleanName(sheets.find(s => s.id === "root").name, "Sem nome") : "Novo diagrama");
  const id = await tx(exec => createDoc(exec, { ownerId, folderId, name, sheets: sheets || [emptyRoot(name)], byUserId: user.id }));
  return { id };
});

route("GET", "/api/docs/:id", async ({ user, params }) => {
  const a = await need("doc", user, intId(params.id), "view");
  const rows = await q(`SELECT id, rev, data FROM ${T.sheets} WHERE doc_id = ? AND deleted = 0`, [a.id]);
  return {
    doc: { id: a.id, name: a.name, rev: Number(a.rev), role: a.role, folderId: a.folder_id, ownerId: a.owner_id },
    sheets: rows.map(r => ({ id: r.id, rev: Number(r.rev), data: r.data })),
    presence: seen(a.id, user),
  };
});

// Changes since a revision (sheets saved or deleted by anyone), plus who else is here.
route("GET", "/api/docs/:id/sync", async ({ user, params, url }) => {
  const a = await need("doc", user, intId(params.id), "view");
  const since = Math.max(0, parseInt(url.searchParams.get("since"), 10) || 0);
  const rows = Number(a.rev) > since
    ? await q(`SELECT id, rev, deleted, data FROM ${T.sheets} WHERE doc_id = ? AND rev > ?`, [a.id, since])
    : [];
  return {
    rev: Number(a.rev), name: a.name, role: a.role,
    sheets: rows.map(r => ({ id: r.id, rev: Number(r.rev), deleted: !!r.deleted, data: r.deleted ? null : r.data })),
    presence: seen(a.id, user),
  };
});

route("PATCH", "/api/docs/:id", async ({ user, params, body }) => {
  const a = await need("doc", user, intId(params.id), body.folderId !== undefined ? "owner" : "edit");
  if (body.folderId !== undefined) {
    let folderId = null;
    if (body.folderId !== null) {
      const f = await need("folder", user, intId(body.folderId), "owner");
      folderId = f.id;
    }
    await q(`UPDATE ${T.docs} SET folder_id = ? WHERE id = ?`, [folderId, a.id]);
  }
  if (body.name !== undefined) {
    const name = cleanName(body.name, a.name);
    // the name also lives in the root sheet, which open editors pick up through /sync
    await tx(async exec => {
      const doc = (await exec(`SELECT rev FROM ${T.docs} WHERE id = ? FOR UPDATE`, [a.id]))[0];
      const root = (await exec(`SELECT data FROM ${T.sheets} WHERE doc_id = ? AND id = 'root'`, [a.id]))[0];
      const rev = Number(doc.rev) + 1;
      if (root) {
        let data; try { data = JSON.parse(root.data); } catch (_) { data = emptyRoot(name); }
        data.name = name;
        await exec(`UPDATE ${T.sheets} SET data = ?, rev = ? WHERE doc_id = ? AND id = 'root'`, [JSON.stringify(data), rev, a.id]);
      }
      await exec(`UPDATE ${T.docs} SET name = ?, rev = ?, updated_at = ?, updated_by = ? WHERE id = ?`,
        [name, rev, Date.now(), user.id, a.id]);
    });
  }
  return { ok: true };
});

route("DELETE", "/api/docs/:id", async ({ user, params }) => {
  const a = await need("doc", user, intId(params.id), "owner");
  await q(`DELETE FROM ${T.docs} WHERE id = ?`, [a.id]);
  presence.delete(a.id);
  return { ok: true };
});

route("POST", "/api/docs/:id/duplicate", async ({ user, params }) => {
  const a = await need("doc", user, intId(params.id), "view");
  const rows = await q(`SELECT data FROM ${T.sheets} WHERE doc_id = ? AND deleted = 0`, [a.id]);
  const sheets = rows.map(r => JSON.parse(r.data));
  // the copy goes to the same project only if the user owns it
  const folderId = a.owner_id === user.id ? a.folder_id : null;
  const id = await tx(exec => createDoc(exec, { ownerId: user.id, folderId, name: cleanName(a.name + " (cópia)", "Cópia"), sheets }));
  return { id };
});

// Save one sheet. baseRev is the revision the client's copy started from; if someone else saved
// in the meantime the answer is 409 with the current version, which the client merges and resends.
route("PUT", "/api/docs/:id/sheets/:sid", async ({ user, params, body }) => {
  const a = await need("doc", user, intId(params.id), "edit");
  if (!ID_RE.test(params.sid)) fail(400, "Identificador inválido.");
  const sheet = cleanSheet(body.data, params.sid);
  const baseRev = Number(body.baseRev) || 0;
  return tx(async exec => {
    const doc = (await exec(`SELECT rev FROM ${T.docs} WHERE id = ? FOR UPDATE`, [a.id]))[0];
    const cur = (await exec(`SELECT rev, deleted, data FROM ${T.sheets} WHERE doc_id = ? AND id = ?`, [a.id, sheet.id]))[0];
    const conflict = cur ? (cur.deleted ? baseRev > 0 : Number(cur.rev) !== baseRev) : baseRev > 0;
    if (conflict) {
      const gone = !cur || cur.deleted;
      throw new HttpError(409, "Alterado por outra pessoa.", { rev: cur ? Number(cur.rev) : 0, data: gone ? null : cur.data });
    }
    const rev = Number(doc.rev) + 1, data = JSON.stringify(sheet);
    await exec(
      `INSERT INTO ${T.sheets} (doc_id, id, rev, deleted, data) VALUES (?, ?, ?, 0, ?)
       ON DUPLICATE KEY UPDATE rev = VALUES(rev), deleted = 0, data = VALUES(data)`, [a.id, sheet.id, rev, data]);
    const name = sheet.id === "root" ? cleanName(sheet.name, a.name) : null;
    await exec(`UPDATE ${T.docs} SET rev = ?, updated_at = ?, updated_by = ?${name ? ", name = ?" : ""} WHERE id = ?`,
      name ? [rev, Date.now(), user.id, name, a.id] : [rev, Date.now(), user.id, a.id]);
    return { rev };
  });
});

route("DELETE", "/api/docs/:id/sheets/:sid", async ({ user, params }) => {
  const a = await need("doc", user, intId(params.id), "edit");
  if (!ID_RE.test(params.sid)) fail(400, "Identificador inválido.");
  if (params.sid === "root") fail(400, "O mapa principal não pode ser apagado.");
  await tx(async exec => {
    const doc = (await exec(`SELECT rev FROM ${T.docs} WHERE id = ? FOR UPDATE`, [a.id]))[0];
    const rev = Number(doc.rev) + 1;
    // keep a tombstone so other open editors learn about the deletion through /sync
    const r = await exec(`UPDATE ${T.sheets} SET deleted = 1, data = '', rev = ? WHERE doc_id = ? AND id = ? AND deleted = 0`,
      [rev, a.id, params.sid]);
    if (r.affectedRows) await exec(`UPDATE ${T.docs} SET rev = ?, updated_at = ?, updated_by = ? WHERE id = ?`, [rev, Date.now(), user.id, a.id]);
  });
  return { ok: true };
});

/* ----- sharing (kind = doc | folder) ----- */
function shareKind(k) { if (k !== "doc" && k !== "folder") fail(404, "Rota desconhecida."); return k; }

route("GET", "/api/shares/:kind/:id", async ({ user, params }) => {
  const kind = shareKind(params.kind);
  const a = await need(kind, user, intId(params.id), "view");
  const o = (await q(`SELECT id, name, email FROM ${T.users} WHERE id = ?`, [a.owner_id]))[0];
  return { role: a.role, owner: o ? { userId: o.id, name: o.name, email: o.email } : null, shares: await shareList(kind, a.id) };
});

route("POST", "/api/shares/:kind/:id", async ({ user, params, body }) => {
  const kind = shareKind(params.kind);
  const a = await need(kind, user, intId(params.id), "owner");
  const email = String(body.email || "").trim().toLowerCase();
  const role = body.role === "view" ? "view" : "edit";
  const target = (await q(`SELECT id FROM ${T.users} WHERE email = ?`, [email]))[0];
  if (!target) fail(404, "Não existe nenhum utilizador registado com esse email.");
  if (target.id === a.owner_id) fail(400, "Essa pessoa já é o dono.");
  const table = kind === "doc" ? T.docShares : T.folderShares, col = kind === "doc" ? "doc_id" : "folder_id";
  await q(`INSERT INTO ${table} (${col}, user_id, role) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE role = VALUES(role)`,
    [a.id, target.id, role]);
  log(`Partilha: ${kind} ${a.id} com ${email} (${role})`);
  return { shares: await shareList(kind, a.id) };
});

// The owner removes someone, or a user leaves something that was shared with them.
route("DELETE", "/api/shares/:kind/:id/:userId", async ({ user, params }) => {
  const kind = shareKind(params.kind);
  const targetId = intId(params.userId);
  const a = await need(kind, user, intId(params.id), targetId === user.id ? "view" : "owner");
  const table = kind === "doc" ? T.docShares : T.folderShares, col = kind === "doc" ? "doc_id" : "folder_id";
  await q(`DELETE FROM ${table} WHERE ${col} = ? AND user_id = ?`, [a.id, targetId]);
  return { shares: targetId === user.id ? [] : await shareList(kind, a.id) };
});

/* ----- admin ----- */
route("GET", "/api/admin/users", async () => {
  const rows = await q(
    `SELECT u.id, u.email, u.name, u.is_admin, u.created_at, u.last_login_at,
            (SELECT COUNT(*) FROM ${T.docs} d WHERE d.owner_id = u.id) AS diagrams
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
  await q(`DELETE FROM ${T.users} WHERE id = ?`, [id]); // sessions, projects, diagrams and shares go with it (ON DELETE CASCADE)
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
    const out = await r.handler({ req, res, url, params, body, user, token });
    send(res, 200, out);
  } catch (e) {
    if (e instanceof HttpError) return send(res, e.status, { error: e.message, ...e.extra });
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
