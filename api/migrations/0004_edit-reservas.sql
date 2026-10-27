-- Fase 7: crear/editar reservas, historial de cambios y página de origen.

-- Anclas: id corto → nombre. Es la copia en el CRM de la tabla de zoneAnchors.json
-- del sitio; el sitio codifica estos ids dentro del código de reserva (LTR-XXXXXX-OODD).
-- Empieza vacía: se llena con los ids reales del sitio.
CREATE TABLE ancla (
  id      INTEGER PRIMARY KEY,
  nombre  TEXT NOT NULL
);

-- Sin FK a propósito: si llega un código con un id que aún no está en `ancla`,
-- la reserva se guarda igual y el id queda a la espera de su nombre.
ALTER TABLE reserva ADD COLUMN ancla_origen_id  INTEGER;
ALTER TABLE reserva ADD COLUMN ancla_destino_id INTEGER;

-- De dónde vino la reserva.
ALTER TABLE reserva ADD COLUMN fuente TEXT NOT NULL DEFAULT 'web'
  CHECK (fuente IN ('web','manual','importada','chatbot'));

-- Duración estimada del servicio en minutos (se usará para saber cuándo pedir el comentario).
ALTER TABLE reserva ADD COLUMN duracion_min INTEGER;

-- Historial: quién cambió qué y cuándo. usuario_id NULL = el sistema.
CREATE TABLE reserva_evento (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  reserva_id  INTEGER NOT NULL REFERENCES reserva(id),
  usuario_id  INTEGER REFERENCES usuario(id),
  tipo        TEXT NOT NULL CHECK (tipo IN ('creada','editada','estado')),
  detalle     TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_reserva_evento_reserva ON reserva_evento(reserva_id, id);