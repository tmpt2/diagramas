"use strict";
const fs = require("fs");
const path = require("path");

function env(name, def) {
  const v = process.env[name];
  return v === undefined || v === "" ? def : v;
}
function bool(name, def) {
  const v = env(name, undefined);
  if (v === undefined) return def;
  return /^(1|true|yes|sim|on)$/i.test(String(v).trim());
}
function int(name, def) {
  const v = parseInt(env(name, ""), 10);
  return Number.isFinite(v) ? v : def;
}
// Allows DB_PASSWORD_FILE (Docker secrets) as an alternative to DB_PASSWORD.
function secret(name) {
  const file = env(name + "_FILE", undefined);
  if (file) {
    try { return fs.readFileSync(file, "utf8").trim(); }
    catch (e) { throw new Error(`Não foi possível ler ${name}_FILE (${file}): ${e.message}`); }
  }
  return env(name, "");
}

const prefix = env("DB_TABLE_PREFIX", "camadas_");
if (!/^[A-Za-z0-9_]{0,32}$/.test(prefix)) throw new Error("DB_TABLE_PREFIX só pode ter letras, números e _");

const sslMode = String(env("DB_SSL", "false")).toLowerCase();
let ssl;
if (/^(1|true|yes|sim|on|required)$/.test(sslMode)) {
  ssl = { rejectUnauthorized: true };
  const ca = env("DB_SSL_CA", "");
  if (ca) ssl.ca = fs.readFileSync(ca, "utf8");
} else if (sslMode === "skip-verify") {
  ssl = { rejectUnauthorized: false };
}

const config = {
  port: int("PORT", 3000),
  appName: env("APP_NAME", "Camadas"),
  trustProxy: bool("TRUST_PROXY", true),
  cookieSecure: String(env("COOKIE_SECURE", "auto")).toLowerCase(), // auto | true | false
  sessionDays: int("SESSION_DAYS", 30),
  allowRegistration: bool("ALLOW_REGISTRATION", false),
  exampleForNewUsers: bool("EXAMPLE_FOR_NEW_USERS", true),
  // Files attached to boxes: where they are kept (a Docker volume) and the largest allowed.
  filesDir: path.resolve(env("FILES_DIR", path.join(__dirname, "..", "data", "files"))),
  maxFileMb: Math.max(1, int("MAX_FILE_MB", 25)),
  admin: {
    email: env("ADMIN_EMAIL", "").trim().toLowerCase(),
    password: secret("ADMIN_PASSWORD"),
    name: env("ADMIN_NAME", "Administrador"),
  },
  db: {
    host: env("DB_HOST", "127.0.0.1"),
    port: int("DB_PORT", 3306),
    database: env("DB_NAME", "camadas"),
    user: env("DB_USER", "camadas"),
    password: secret("DB_PASSWORD"),
    connectionLimit: int("DB_CONNECTION_LIMIT", 10),
    connectTimeout: int("DB_CONNECT_TIMEOUT_MS", 10000),
    ssl,
    prefix,
  },
};

module.exports = config;
