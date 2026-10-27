-- Límite de intentos de inicio de sesión, por correo y por IP.
CREATE TABLE intento_login (
  clave            TEXT PRIMARY KEY,   -- 'email:correo@x.com' o 'ip:1.2.3.4'
  fallos           INTEGER NOT NULL DEFAULT 0,
  desde            TEXT NOT NULL,      -- inicio de la ventana de conteo (ISO, UTC)
  bloqueado_hasta  TEXT                -- NULL = sin bloqueo
);