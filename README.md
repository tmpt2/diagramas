# Camadas — instalação com Docker e MariaDB externa

Editor de diagramas de fluxo em até 4 níveis. Cada utilizador tem a sua conta e os seus diagramas.
A aplicação corre num contentor Docker e liga-se à **MariaDB que já tem** (no próprio servidor ou noutro).

```
Navegador ──HTTPS──> nginx / Caddy ──> contentor "camadas" (porta 3000) ──> a sua MariaDB (3306)
```

## Conteúdo do pacote

| Ficheiro | Para quê |
|---|---|
| `Dockerfile`, `docker-compose.yml` | Construir e arrancar o contentor |
| `.env.example` | Modelo de configuração (ligação à MariaDB, administrador, registo) |
| `sql/01-criar-base.sql` | Cria a base de dados e o utilizador na MariaDB |
| `Caddyfile` | HTTPS automático (opcional) |
| `nginx-exemplo.conf` | Exemplo para quem já usa nginx |
| `src/` | Servidor (Node.js). Só depende do driver `mysql2` |
| `public/` | A aplicação web |

Requisitos: Docker 20+ com Docker Compose, MariaDB 10.3+ (ou MySQL 8), 256 MB de RAM livres.

---

## Unraid

A imagem é construída automaticamente pelo GitHub Actions a cada push para `main` e publicada em
`ghcr.io/tmpt2/diagramas:latest` (amd64 e arm64). No Unraid não é preciso construir nada.

1. **Base de dados.** Se ainda não tem, instale o contentor **MariaDB** pelas Community Apps. Depois,
   no terminal do Unraid, entre na MariaDB e crie a base e o utilizador:
   ```bash
   docker exec -it mariadb mariadb -u root -p
   ```
   ```sql
   CREATE DATABASE IF NOT EXISTS camadas CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
   CREATE USER IF NOT EXISTS 'camadas'@'%' IDENTIFIED BY 'uma-password-forte';
   GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX, REFERENCES ON camadas.* TO 'camadas'@'%';
   FLUSH PRIVILEGES;
   ```
2. **Template.** Copie o template para a pen do Unraid (terminal do Unraid):
   ```bash
   wget -O /boot/config/plugins/dockerMan/templates-user/my-camadas.xml \
     https://raw.githubusercontent.com/tmpt2/diagramas/main/unraid/camadas.xml
   ```
3. **Adicionar.** Separador **Docker** → **Add Container** → em *Template* escolha **camadas**.
   Preencha `DB_HOST` (o IP do Unraid, ex. `192.168.1.10`), `DB_PASSWORD`, `ADMIN_EMAIL` e
   `ADMIN_PASSWORD` → **Apply**. Antes, crie a pasta dos ficheiros anexados com o dono certo (o
   contentor corre como o utilizador 1000):
   ```bash
   mkdir -p /mnt/user/appdata/camadas/files && chown -R 1000:1000 /mnt/user/appdata/camadas/files
   ```
4. Abra `http://IP-do-unraid:3000` (ou clique no ícone → **WebUI**).

Sem template: em **Add Container** ponha *Repository* `ghcr.io/tmpt2/diagramas:latest`, mapeie a porta
3000, mapeie a pasta `/data/files` do contentor para `/mnt/user/appdata/camadas/files` e crie as
variáveis `DB_HOST`, `DB_PASSWORD`, `ADMIN_EMAIL`, `ADMIN_PASSWORD` à mão.

Para HTTPS a partir da internet use o Nginx Proxy Manager / SWAG que já tenha no Unraid, apontando para
`IP-do-unraid:3000`. **Atualizar:** separador Docker → *Check for Updates* → *Apply update*.

---

## 1. Preparar a MariaDB

Edite a password em `sql/01-criar-base.sql` e corra-o como administrador da MariaDB:

```bash
mariadb -u root -p < sql/01-criar-base.sql
```

Isto cria a base `camadas` (utf8mb4) e o utilizador `camadas`. As tabelas são criadas pela aplicação
no primeiro arranque (com o prefixo `camadas_`, por isso também pode usar uma base de dados que já exista).

### Onde está a sua MariaDB?

**A) No mesmo servidor, instalada fora do Docker** (caso mais comum)

1. No `.env` use `DB_HOST=host.docker.internal`.
2. A MariaDB tem de aceitar ligações vindas da rede do Docker. Em `/etc/mysql/mariadb.conf.d/50-server.cnf`
   (ou `/etc/my.cnf`) troque `bind-address = 127.0.0.1` por:
   ```ini
   bind-address = 0.0.0.0
   ```
   e reinicie: `sudo systemctl restart mariadb`.
3. Garanta que a porta 3306 **não** fica aberta para a internet (só para a rede do Docker), por exemplo com ufw:
   ```bash
   sudo ufw allow from 172.16.0.0/12 to any port 3306 proto tcp
   sudo ufw deny 3306/tcp
   ```
   O utilizador criado pelo script só entra a partir de `172.%` (rede do Docker).

**B) Noutro servidor**

1. No `.env` ponha `DB_HOST=<IP ou nome do servidor MariaDB>`.
2. No script SQL troque `'camadas'@'172.%'` por `'camadas'@'<IP deste servidor Docker>'`.
3. Nesse servidor, `bind-address` tem de aceitar ligações externas e a firewall deve permitir a porta 3306 só a partir deste servidor.
4. Se a ligação passar por rede pública, ative TLS: `DB_SSL=true` (e `DB_SSL_CA=` se o certificado for próprio).

**C) Noutro contentor Docker**

Ponha `DB_HOST=<nome do contentor/serviço MariaDB>` e ligue o `app` à mesma rede, acrescentando ao
`docker-compose.yml`:

```yaml
services:
  app:
    networks: [default, mariadb_net]
networks:
  mariadb_net:
    external: true
    name: <nome-da-rede-da-mariadb>   # ver com: docker network ls
```

---

## 2. Configurar

```bash
cp .env.example .env
nano .env
```

O mínimo a preencher:

| Variável | Exemplo | Nota |
|---|---|---|
| `DB_HOST` | `host.docker.internal` | ver secção 1 |
| `DB_PORT` | `3306` | |
| `DB_NAME` | `camadas` | |
| `DB_USER` | `camadas` | |
| `DB_PASSWORD` | `…` | a mesma do script SQL |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | `admin@empresa.pt` | primeiro administrador, criado no arranque |
| `ALLOW_REGISTRATION` | `false` | `true` deixa qualquer pessoa criar conta |

Outras opções: `DB_TABLE_PREFIX`, `DB_SSL`, `DB_SSL_CA`, `DB_PASSWORD_FILE`, `DB_CONNECTION_LIMIT`,
`SESSION_DAYS`, `EXAMPLE_FOR_NEW_USERS`, `HOST_PORT`, `BIND_ADDRESS`, `APP_NAME`, `COOKIE_SECURE`.
Estão todas explicadas no `.env.example`.

Proteja o ficheiro: `chmod 600 .env`

---

## 3. Arrancar

```bash
docker compose up -d --build
docker compose logs -f app
```

Deve ver:

```
A ligar a MariaDB em host.docker.internal:3306/camadas como camadas
Migração 1 aplicada … Migração 3 aplicada
Administrador criado: admin@empresa.pt
Camadas a correr na porta 3000 (registo fechado)
```

Teste no servidor: `curl http://127.0.0.1:3000/healthz` → `{"ok":true}`

---

## 4. Publicar com HTTPS

Por omissão a aplicação só escuta em `127.0.0.1:3000`, para ficar atrás de um proxy com HTTPS.
Escolha uma opção:

**Opção 1 — Já tem nginx:** use `nginx-exemplo.conf` (troque o domínio) e obtenha o certificado com
`sudo certbot --nginx -d diagramas.seudominio.pt`.

**Opção 2 — Caddy incluído (HTTPS automático):** aponte o domínio (registo DNS A) para o servidor,
defina `DOMAIN=` no `.env`, garanta que as portas 80 e 443 estão livres e abertas, e arranque com:

```bash
docker compose --profile https up -d --build
```

**Opção 3 — Rede interna, sem HTTPS:** `BIND_ADDRESS=0.0.0.0` e `COOKIE_SECURE=false` no `.env`,
e aceda por `http://IP-do-servidor:3000`. Use só numa rede de confiança.

---

## 5. Primeiro acesso

1. Abra o endereço e entre com `ADMIN_EMAIL` / `ADMIN_PASSWORD`.
2. Menu da conta (canto superior direito) → **Perfil e password** → mude a password.
3. Depois pode apagar `ADMIN_PASSWORD` do `.env`.
4. **Gerir utilizadores** (só administradores): criar contas, repor passwords, dar ou tirar o papel de
   administrador, apagar contas (apaga também os projetos e diagramas dessa conta).

---

## Diagramas, projetos e partilha

- **Vários diagramas.** Depois de entrar vê a lista dos seus diagramas. **Novo diagrama** cria um vazio;
  o nome muda-se no painel da direita (com nada selecionado) ou no menu **⋯** do cartão.
- **Projetos.** Organize os diagramas em projetos (pastas): **Novo projeto** na barra lateral e, no cartão
  de um diagrama, **⋯ → Mover para projeto**. Apagar um projeto não apaga os diagramas: passam para
  *Sem projeto*.
- **Partilhar.** No cartão (**⋯ → Partilhar**), dentro do diagrama (botão **Partilhar** no topo) ou num
  projeto (**Partilhar** partilha todos os diagramas do projeto, incluindo os que forem criados depois).
  Escreve-se o email de um utilizador já registado e escolhe-se **Pode editar** ou **Só pode ver**.
  O que foi partilhado consigo aparece em **Partilhados comigo**.
- **Editar em conjunto.** Com o mesmo diagrama aberto, cada pessoa vê as alterações das outras em cerca
  de 4 segundos, e os avatares no topo mostram quem mais está a ver. Se duas pessoas mexerem ao mesmo
  tempo, as alterações são juntadas caixa a caixa. Só quando as duas mudam o mesmo campo da mesma caixa
  fica a última alteração.
- **Ficheiros nas caixas.** Com uma caixa selecionada, **Adicionar ficheiros…** no painel da direita
  anexa ficheiros do computador; também se podem arrastar do computador para cima da caixa. Quem pode ver
  o diagrama pode abrir e descarregar os ficheiros; quem pode editar pode juntar e retirar. Cada ficheiro
  tem no máximo `MAX_FILE_MB` (25 MB por omissão). Os ficheiros ficam no volume Docker `camadas_files`
  (pasta `/data/files` do contentor, uma subpasta por diagrama); a MariaDB só guarda a lista (tabela
  `camadas_files`). Um ficheiro retirado de todas as caixas é apagado ao fim de 7 dias (até lá,
  **Anular** repõe-no); apagar um diagrama apaga os seus ficheiros.
  A exportação em JSON não inclui os ficheiros, só a lista de nomes.
- Só o dono pode partilhar, mover ou apagar. Quem recebeu uma partilha pode sair dela no menu **⋯**.
- **Exportar** (dentro do diagrama ou no menu **⋯**) guarda um diagrama num ficheiro JSON. **Importar**
  cria sempre um diagrama novo a partir de um ficheiro, incluindo os exportados da versão que usava no Claude.

Ao atualizar de uma versão anterior, os diagramas de cada utilizador passam automaticamente para um
diagrama com o nome do mapa principal. A tabela antiga (`camadas_diagrams`) fica intacta como cópia de
segurança e pode ser apagada mais tarde.

---

## Comandos úteis

```bash
# Criar um administrador (ou repor a password de um existente e torná-lo admin)
docker compose exec app node src/cli.js create-admin ana@empresa.pt 'NovaPass123' 'Ana Silva'

# Repor a password de um utilizador
docker compose exec app node src/cli.js reset-password ana@empresa.pt 'OutraPass123'

# Listar utilizadores
docker compose exec app node src/cli.js list-users

# Reiniciar / parar
docker compose restart app
docker compose down
```

## Cópias de segurança

Os diagramas estão na MariaDB e os ficheiros anexados às caixas no volume Docker `camadas_files`.
Copie os dois. Exemplo de cópia diária (cron):

```bash
mysqldump -u root -p --single-transaction camadas \
  camadas_users camadas_sessions camadas_folders camadas_docs camadas_sheets \
  camadas_doc_shares camadas_folder_shares camadas_files camadas_schema_migrations \
  | gzip > /backups/camadas-$(date +%F).sql.gz

# ficheiros anexados (o nome do volume leva o nome da pasta do projeto: veja "docker volume ls")
docker run --rm -v diagramas_camadas_files:/data:ro -v /backups:/backups alpine \
  tar czf /backups/camadas-ficheiros-$(date +%F).tar.gz -C /data .
```

No Unraid, os ficheiros estão em `/mnt/user/appdata/camadas/files` (incluídos na cópia do appdata).

## Atualizar para uma versão nova

```bash
# substitua os ficheiros do projeto (mantenha o seu .env) e depois:
docker compose up -d --build
```

As alterações à estrutura das tabelas, quando existirem, são aplicadas automaticamente no arranque.

## Resolução de problemas

| Mensagem nos registos | Causa provável |
|---|---|
| `ECONNREFUSED` | A MariaDB só escuta em 127.0.0.1 (`bind-address`), ou a firewall bloqueia a 3306 |
| `ER_ACCESS_DENIED_ERROR` | Password errada, ou o utilizador não pode entrar a partir do IP do contentor (veja `'camadas'@'172.%'`) |
| `ER_BAD_DB_ERROR` | A base de dados `DB_NAME` não existe: corra o script SQL |
| `ENOTFOUND` | `DB_HOST` com nome errado. `host.docker.internal` precisa do `extra_hosts` do compose |
| Entra mas volta ao ecrã de entrada | Está em HTTP com `COOKIE_SECURE=true`. Use HTTPS ou `COOKIE_SECURE=false` |
| `AVISO: sem permissão para escrever em FILES_DIR` | A pasta montada em `/data/files` não pertence ao utilizador 1000: `chown -R 1000:1000 <pasta>` |
| Erro `413` ao enviar um ficheiro grande | `client_max_body_size` do nginx (ou o limite do proxy) menor que `MAX_FILE_MB` |
| `AVISO: não existe nenhum administrador` | Defina `ADMIN_EMAIL`/`ADMIN_PASSWORD` ou use `cli.js create-admin` |

Para ver o IP de onde o contentor chega à MariaDB: `docker network inspect bridge | grep Gateway`.

## Segurança (resumo)

- Passwords guardadas com scrypt (sal aleatório). Sessões num cookie `HttpOnly` + `SameSite=Lax`,
  guardadas na base de dados só como hash.
- Limite de tentativas de entrada (10 em 15 minutos por IP e email).
- Os pedidos que alteram dados exigem um cabeçalho próprio da aplicação (proteção contra CSRF).
- Content-Security-Policy restrita. O contentor corre sem privilégios de root.
- O utilizador da MariaDB só tem permissões na base `camadas`.
