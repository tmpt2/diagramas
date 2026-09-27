-- =====================================================================
-- Camadas — preparar a MariaDB (correr uma vez, como root/administrador)
--   mariadb -u root -p < sql/01-criar-base.sql
-- As tabelas são criadas automaticamente pela aplicação no primeiro arranque.
-- =====================================================================

CREATE DATABASE IF NOT EXISTS camadas
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- O contentor Docker liga-se a partir da rede do Docker (normalmente 172.16.0.0/12).
-- Ajuste o host ('172.%') se a MariaDB estiver noutro servidor: use o IP do servidor Docker.
CREATE USER IF NOT EXISTS 'camadas'@'172.%' IDENTIFIED BY 'mude-esta-password';
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX, REFERENCES
  ON camadas.* TO 'camadas'@'172.%';

FLUSH PRIVILEGES;
