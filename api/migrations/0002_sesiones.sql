-- Tabla de sesiones — faltaba en el esquema inicial (la §3 original solo
-- contemplaba `usuario`, no dónde vivían las sesiones activas).
--
-- `id` guarda el HASH (SHA-256, hex) del token de sesión, nunca el token en
-- texto plano — el token real solo existe en la cookie del navegador.

CREATE TABLE sesion (
  id          TEXT PRIMARY KEY,
  usuario_id  INTEGER NOT NULL REFERENCES usuario(id),
  expires_at  TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  user_agent  TEXT
);

CREATE INDEX idx_sesion_usuario ON sesion(usuario_id);
CREATE INDEX idx_sesion_expires ON sesion(expires_at);
