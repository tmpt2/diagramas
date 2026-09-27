"use strict";
const crypto = require("crypto");
const { q, T } = require("./db");
const config = require("./config");

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
const COOKIE = "camadas_sid";

function scrypt(password, salt, o) {
  return new Promise((resolve, reject) =>
    crypto.scrypt(password, salt, o.keylen, { N: o.N, r: o.r, p: o.p, maxmem: 64 * 1024 * 1024 },
      (err, key) => (err ? reject(err) : resolve(key))));
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64")}$${key.toString("base64")}`;
}

async function verifyPassword(password, stored) {
  try {
    const [alg, N, r, p, saltB64, keyB64] = String(stored).split("$");
    if (alg !== "scrypt") return false;
    const key = Buffer.from(keyB64, "base64");
    const test = await scrypt(password, Buffer.from(saltB64, "base64"), { N: +N, r: +r, p: +p, keylen: key.length });
    return crypto.timingSafeEqual(key, test);
  } catch (_) {
    return false;
  }
}

// A fixed hash so that "unknown email" takes as long as "wrong password".
let dummyHash = null;
async function dummyVerify(password) {
  if (!dummyHash) dummyHash = await hashPassword("nao-e-uma-password-real");
  await verifyPassword(password, dummyHash);
}

function validEmail(e) {
  return typeof e === "string" && e.length <= 190 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
}
function passwordProblem(p) {
  if (typeof p !== "string" || p.length < 8) return "A password tem de ter pelo menos 8 caracteres.";
  if (p.length > 200) return "A password é demasiado longa.";
  return null;
}

const sha256 = s => crypto.createHash("sha256").update(s).digest("hex");

async function createSession(userId) {
  const token = crypto.randomBytes(32).toString("base64url");
  const expires = new Date(Date.now() + config.sessionDays * 864e5);
  await q(`INSERT INTO ${T.sessions} (id, user_id, expires_at) VALUES (?, ?, ?)`, [sha256(token), userId, expires]);
  await q(`UPDATE ${T.users} SET last_login_at = UTC_TIMESTAMP() WHERE id = ?`, [userId]);
  return { token, expires };
}

async function userFromToken(token) {
  if (!token || token.length > 100) return null;
  const rows = await q(
    `SELECT u.id, u.email, u.name, u.is_admin FROM ${T.sessions} s JOIN ${T.users} u ON u.id = s.user_id
     WHERE s.id = ? AND s.expires_at > UTC_TIMESTAMP()`, [sha256(token)]);
  if (!rows.length) return null;
  const u = rows[0];
  return { id: u.id, email: u.email, name: u.name, isAdmin: !!u.is_admin };
}

async function destroySession(token) {
  if (token) await q(`DELETE FROM ${T.sessions} WHERE id = ?`, [sha256(token)]);
}
async function destroyUserSessions(userId, exceptToken) {
  if (exceptToken) await q(`DELETE FROM ${T.sessions} WHERE user_id = ? AND id <> ?`, [userId, sha256(exceptToken)]);
  else await q(`DELETE FROM ${T.sessions} WHERE user_id = ?`, [userId]);
}
async function purgeExpired() {
  await q(`DELETE FROM ${T.sessions} WHERE expires_at <= UTC_TIMESTAMP()`);
}

// Simple in-memory limiter for login/registration attempts.
const attempts = new Map();
function rateLimited(key, max = 10, windowMs = 15 * 60e3) {
  const now = Date.now();
  const a = (attempts.get(key) || []).filter(t => now - t < windowMs);
  a.push(now);
  attempts.set(key, a);
  if (attempts.size > 10000) for (const [k, v] of attempts) if (!v.some(t => now - t < windowMs)) attempts.delete(k);
  return a.length > max;
}
function clearRate(key) { attempts.delete(key); }

async function createUser({ email, name, password, isAdmin }) {
  const hash = await hashPassword(password);
  const r = await q(`INSERT INTO ${T.users} (email, name, password_hash, is_admin) VALUES (?, ?, ?, ?)`,
    [email, (name || "").slice(0, 120), hash, isAdmin ? 1 : 0]);
  return r.insertId;
}

module.exports = {
  COOKIE, hashPassword, verifyPassword, dummyVerify, validEmail, passwordProblem,
  createSession, userFromToken, destroySession, destroyUserSessions, purgeExpired,
  rateLimited, clearRate, createUser,
};
