"use strict";
const mysql = require("mysql2/promise");
const config = require("./config");

const P = config.db.prefix;
const T = {
  users: `\`${P}users\``,
  sessions: `\`${P}sessions\``,
  diagrams: `\`${P}diagrams\``,
  migrations: `\`${P}schema_migrations\``,
};

const pool = mysql.createPool({
  host: config.db.host,
  port: config.db.port,
  database: config.db.database,
  user: config.db.user,
  password: config.db.password,
  ssl: config.db.ssl,
  connectionLimit: config.db.connectionLimit,
  connectTimeout: config.db.connectTimeout,
  waitForConnections: true,
  charset: "utf8mb4",
  timezone: "Z",
  dateStrings: false,
  supportBigNumbers: true,
  enableKeepAlive: true,
});

const q = async (sql, params) => (await pool.query(sql, params))[0];

// Each migration runs once, in order. Never edit an old entry: append a new one.
const MIGRATIONS = [
  [1, `CREATE TABLE IF NOT EXISTS ${T.users} (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT,
      email VARCHAR(190) NOT NULL,
      name VARCHAR(120) NOT NULL DEFAULT '',
      password_hash VARCHAR(255) NOT NULL,
      is_admin TINYINT(1) NOT NULL DEFAULT 0,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_login_at DATETIME NULL,
      PRIMARY KEY (id),
      UNIQUE KEY uq_email (email)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`],
  [2, `CREATE TABLE IF NOT EXISTS ${T.sessions} (
      id CHAR(64) NOT NULL,
      user_id INT UNSIGNED NOT NULL,
      expires_at DATETIME NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_user (user_id),
      KEY idx_expires (expires_at),
      CONSTRAINT fk_${P}sessions_user FOREIGN KEY (user_id) REFERENCES ${T.users} (id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`],
  [3, `CREATE TABLE IF NOT EXISTS ${T.diagrams} (
      user_id INT UNSIGNED NOT NULL,
      id VARCHAR(64) NOT NULL,
      data LONGTEXT NOT NULL,
      updated_at BIGINT NOT NULL,
      PRIMARY KEY (user_id, id),
      CONSTRAINT fk_${P}diagrams_user FOREIGN KEY (user_id) REFERENCES ${T.users} (id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`],
];

async function waitForDb(log, attempts = 30) {
  for (let i = 1; i <= attempts; i++) {
    try {
      await q("SELECT 1");
      return;
    } catch (e) {
      const hint = e.code === "ER_ACCESS_DENIED_ERROR" ? " (utilizador ou password errados, ou sem permissão a partir deste IP)"
        : e.code === "ER_BAD_DB_ERROR" ? " (a base de dados não existe: crie-a primeiro)"
        : e.code === "ECONNREFUSED" ? " (MariaDB não aceita ligações neste host/porta: veja bind-address)"
        : e.code === "ENOTFOUND" ? " (nome do host não encontrado)" : "";
      log(`MariaDB indisponível [${e.code || e.message}]${hint} — tentativa ${i}/${attempts}`);
      if (e.code === "ER_ACCESS_DENIED_ERROR" || e.code === "ER_BAD_DB_ERROR" || i === attempts) throw e;
      await new Promise(r => setTimeout(r, 3000));
    }
  }
}

async function migrate(log) {
  await q(`CREATE TABLE IF NOT EXISTS ${T.migrations} (
      version INT NOT NULL PRIMARY KEY,
      applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  const done = new Set((await q(`SELECT version FROM ${T.migrations}`)).map(r => r.version));
  for (const [v, sql] of MIGRATIONS) {
    if (done.has(v)) continue;
    await q(sql);
    await q(`INSERT INTO ${T.migrations} (version) VALUES (?)`, [v]);
    log(`Migração ${v} aplicada`);
  }
}

async function tx(fn) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const res = await fn(async (sql, params) => (await conn.query(sql, params))[0]);
    await conn.commit();
    return res;
  } catch (e) {
    try { await conn.rollback(); } catch (_) {}
    throw e;
  } finally {
    conn.release();
  }
}

module.exports = { pool, q, tx, T, waitForDb, migrate };
