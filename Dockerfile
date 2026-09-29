# Camadas — editor de diagramas por níveis
FROM node:20-alpine

ENV NODE_ENV=production
WORKDIR /app

# Dependências (só o driver MariaDB/MySQL)
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

# Código da aplicação
COPY src ./src
COPY public ./public

# Ficheiros anexados às caixas: montar aqui um volume (ver docker-compose.yml).
# A pasta pertence ao utilizador node, e um volume novo herda essas permissões.
ENV FILES_DIR=/data/files
RUN mkdir -p /data/files && chown node:node /data/files

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/healthz >/dev/null || exit 1

CMD ["node", "src/server.js"]
