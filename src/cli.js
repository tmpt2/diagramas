"use strict";
// Utilitários de linha de comandos:
//   node src/cli.js create-admin <email> <password> [nome]
//   node src/cli.js reset-password <email> <nova-password>
//   node src/cli.js list-users
const db = require("./db");
const auth = require("./auth");
const { q, T } = db;

async function main() {
  const [cmd, a, b, c] = process.argv.slice(2);
  await db.waitForDb(console.log, 3);
  await db.migrate(console.log);
  if (cmd === "create-admin") {
    const email = String(a || "").trim().toLowerCase();
    if (!auth.validEmail(email)) throw new Error("Uso: create-admin <email> <password> [nome]");
    const pp = auth.passwordProblem(b); if (pp) throw new Error(pp);
    const ex = (await q(`SELECT id FROM ${T.users} WHERE email = ?`, [email]))[0];
    if (ex) {
      await q(`UPDATE ${T.users} SET is_admin = 1, password_hash = ? WHERE id = ?`, [await auth.hashPassword(b), ex.id]);
      console.log(`Utilizador ${email} já existia: agora é administrador e a password foi alterada.`);
    } else {
      await auth.createUser({ email, name: c || "Administrador", password: b, isAdmin: true });
      console.log(`Administrador ${email} criado.`);
    }
  } else if (cmd === "reset-password") {
    const email = String(a || "").trim().toLowerCase();
    const pp = auth.passwordProblem(b); if (pp) throw new Error(pp);
    const ex = (await q(`SELECT id FROM ${T.users} WHERE email = ?`, [email]))[0];
    if (!ex) throw new Error(`Não existe o utilizador ${email}`);
    await q(`UPDATE ${T.users} SET password_hash = ? WHERE id = ?`, [await auth.hashPassword(b), ex.id]);
    await auth.destroyUserSessions(ex.id);
    console.log(`Password de ${email} alterada.`);
  } else if (cmd === "list-users") {
    const rows = await q(`SELECT id, email, name, is_admin, created_at FROM ${T.users} ORDER BY id`);
    rows.forEach(r => console.log(`${r.id}\t${r.is_admin ? "admin" : "     "}\t${r.email}\t${r.name}`));
  } else {
    console.log("Comandos: create-admin <email> <password> [nome] | reset-password <email> <password> | list-users");
  }
}
main().then(() => db.pool.end()).catch(e => { console.error("Erro:", e.message); db.pool.end(); process.exit(1); });
