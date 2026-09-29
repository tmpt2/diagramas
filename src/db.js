"use strict";
const mysql = require("mysql2/promise");
const config = require("./config");

const P = config.db.prefix;
const T = {
  users: `\`${P}users\``,
  sessions: `\`${P}sessions\``,
  diagrams: `\`${P}diagrams\``,        // v1 storage (one workspace per user); kept only as a backup after migration 5
  folders: `\`${P}folders\``,
  docs: `\`${P}docs\``,
  sheets: `\`${P}sheets\``,
  docShares: `\`${P}doc_shares\``,
  folderShares: `\`${P}folder_shares\``,
  files: `\`${P}files\``,
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
  // Several diagrams per user, grouped in projects (folders) and shared with other users.
  // A diagram ("doc") is made of sheets: the root map plus one sheet per detailed box (levels 2-4).
  [4, [
    `CREATE TABLE IF NOT EXISTS ${T.folders} (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT,
      owner_id INT UNSIGNED NOT NULL,
      name VARCHAR(120) NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_owner (owner_id),
      CONSTRAINT fk_${P}folders_owner FOREIGN KEY (owner_id) REFERENCES ${T.users} (id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS ${T.docs} (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT,
      owner_id INT UNSIGNED NOT NULL,
      folder_id INT UNSIGNED NULL,
      name VARCHAR(120) NOT NULL,
      rev BIGINT NOT NULL DEFAULT 0,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at BIGINT NOT NULL,
      updated_by INT UNSIGNED NULL,
      PRIMARY KEY (id),
      KEY idx_owner (owner_id),
      KEY idx_folder (folder_id),
      CONSTRAINT fk_${P}docs_owner FOREIGN KEY (owner_id) REFERENCES ${T.users} (id) ON DELETE CASCADE,
      CONSTRAINT fk_${P}docs_folder FOREIGN KEY (folder_id) REFERENCES ${T.folders} (id) ON DELETE SET NULL,
      CONSTRAINT fk_${P}docs_updby FOREIGN KEY (updated_by) REFERENCES ${T.users} (id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS ${T.sheets} (
      doc_id INT UNSIGNED NOT NULL,
      id VARCHAR(64) NOT NULL,
      rev BIGINT NOT NULL,
      deleted TINYINT(1) NOT NULL DEFAULT 0,
      data LONGTEXT NOT NULL,
      PRIMARY KEY (doc_id, id),
      KEY idx_rev (doc_id, rev),
      CONSTRAINT fk_${P}sheets_doc FOREIGN KEY (doc_id) REFERENCES ${T.docs} (id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS ${T.docShares} (
      doc_id INT UNSIGNED NOT NULL,
      user_id INT UNSIGNED NOT NULL,
      role ENUM('view','edit') NOT NULL DEFAULT 'edit',
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (doc_id, user_id),
      KEY idx_user (user_id),
      CONSTRAINT fk_${P}dshares_doc FOREIGN KEY (doc_id) REFERENCES ${T.docs} (id) ON DELETE CASCADE,
      CONSTRAINT fk_${P}dshares_user FOREIGN KEY (user_id) REFERENCES ${T.users} (id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS ${T.folderShares} (
      folder_id INT UNSIGNED NOT NULL,
      user_id INT UNSIGNED NOT NULL,
      role ENUM('view','edit') NOT NULL DEFAULT 'edit',
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (folder_id, user_id),
      KEY idx_user (user_id),
      CONSTRAINT fk_${P}fshares_folder FOREIGN KEY (folder_id) REFERENCES ${T.folders} (id) ON DELETE CASCADE,
      CONSTRAINT fk_${P}fshares_user FOREIGN KEY (user_id) REFERENCES ${T.users} (id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  ]],
  // Move each user's v1 workspace into one diagram of the new model.
  [5, async exec => {
    const users = await exec(`SELECT DISTINCT user_id FROM ${T.diagrams}`);
    for (const { user_id } of users) {
      const rows = await exec(`SELECT id, data, updated_at FROM ${T.diagrams} WHERE user_id = ?`, [user_id]);
      let name = "Os meus diagramas";
      const root = rows.find(r => r.id === "root");
      try { if (root) name = String(JSON.parse(root.data).name || "").trim().slice(0, 120) || name; } catch (_) {}
      const updated = Math.max(0, ...rows.map(r => Number(r.updated_at) || 0)) || Date.now();
      const r = await exec(`INSERT INTO ${T.docs} (owner_id, name, rev, updated_at, updated_by) VALUES (?, ?, 1, ?, ?)`,
        [user_id, name, updated, user_id]);
      for (const row of rows) {
        await exec(`INSERT INTO ${T.sheets} (doc_id, id, rev, data) VALUES (?, ?, 1, ?)`, [r.insertId, row.id, row.data]);
      }
    }
  }],
  // Files attached to boxes. The bytes are on disk (FILES_DIR); this lists them per diagram, so that
  // only people with access to the diagram can download them.
  [6, `CREATE TABLE IF NOT EXISTS ${T.files} (
      doc_id INT UNSIGNED NOT NULL,
      id VARCHAR(32) NOT NULL,
      name VARCHAR(255) NOT NULL,
      mime VARCHAR(120) NOT NULL,
      size BIGINT UNSIGNED NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      created_by INT UNSIGNED NULL,
      PRIMARY KEY (doc_id, id),
      KEY idx_created (created_at),
      CONSTRAINT fk_${P}files_doc FOREIGN KEY (doc_id) REFERENCES ${T.docs} (id) ON DELETE CASCADE,
      CONSTRAINT fk_${P}files_user FOREIGN KEY (created_by) REFERENCES ${T.users} (id) ON DELETE SET NULL
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
    if (typeof sql === "function") {
      // data migrations run in a transaction together with their bookkeeping row
      await tx(async exec => {
        await sql(exec);
        await exec(`INSERT INTO ${T.migrations} (version) VALUES (?)`, [v]);
      });
    } else {
      for (const stmt of [].concat(sql)) await q(stmt);
      await q(`INSERT INTO ${T.migrations} (version) VALUES (?)`, [v]);
    }
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
