-- CRM Luxury Transfers Riviera — esquema inicial (Cloudflare D1 / SQLite)
-- Borrador para revisión — ver notas al final antes de aplicar

PRAGMA foreign_keys = ON;

-- ── Lookup: zonas válidas (§2.3 del plan técnico) ──────────────────────────
-- Tabla de referencia en vez de texto libre: evita que una reserva manual
-- o un bug de mapeo introduzca un nombre de zona inventado.
CREATE TABLE zona (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre  TEXT NOT NULL UNIQUE
);

INSERT INTO zona (nombre) VALUES
  ('AEROPUERTO CANCUN'), ('AEROPUERTO TULUM'),
  ('CENTRO DE CANCUN'), ('ZONA HOTELERA DE CANCUN'),
  ('PLAYA MUJERES'), ('COSTA MUJERES'),
  ('PUERTO JUAREZ'), ('PUERTO MORELOS'),
  ('PLAYA PARAISO'), ('PLAYA DEL CARMEN'),
  ('PUERTO AVENTURAS'), ('AKUMAL'),
  ('CENTRO DE TULUM'), ('ZONA HOTELERA DE TULUM'),
  ('FELIPE CARRILLO PUERTO'), ('HOLBOX'),
  ('MAHAHUAL'), ('BACALAR'),
  ('CHETUMAL'), ('VALLADOLID'),
  ('MERIDA');

-- ── Lookup: tipos de vehículo (§2.2) ────────────────────────────────────────
CREATE TABLE vehiculo (
  id         TEXT PRIMARY KEY,   -- key interno, mismo vocabulario que pricing
  label      TEXT NOT NULL,
  capacidad  TEXT NOT NULL
);

INSERT INTO vehiculo (id, label, capacidad) VALUES
  ('sedan',     'Classic Sedan',  '1-3 pax'),
  ('van',       'Comfort Van',    '1-7 pax'),
  ('luxVip',    'Luxury VIP',     '1-5 pax'),
  ('sprinter',  'Group Van',      '1-13 pax'),
  ('familyVan', 'Family Van',     '1-10 pax'),
  ('custom',    'Custom Service', 'variable');

-- ── Cliente ─────────────────────────────────────────────────────────────────
CREATE TABLE cliente (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre            TEXT NOT NULL,
  -- Opcional a propósito: el worker de pagos registra ventas aunque el email venga
  -- vacío/mal escrito (para no perder una reserva pagada). UNIQUE permite varios NULL;
  -- política de dedup MVP: mismo email = mismo cliente.
  email             TEXT UNIQUE,
  telefono          TEXT,
  idioma_preferido  TEXT NOT NULL DEFAULT 'es' CHECK (idioma_preferido IN ('es','en')),
  notas_internas    TEXT,
  fecha_alta        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_cliente_telefono ON cliente(telefono);

-- ── Cupon (tabla creada desde ya; FK opcional — ver nota al final) ─────────
CREATE TABLE cupon (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  codigo         TEXT NOT NULL UNIQUE,
  descuento_pct  REAL NOT NULL CHECK (descuento_pct > 0 AND descuento_pct <= 100),
  activo         INTEGER NOT NULL DEFAULT 1 CHECK (activo IN (0,1)),
  fecha_inicio   TEXT,
  fecha_fin      TEXT,
  usos_maximos   INTEGER,
  usos_actuales  INTEGER NOT NULL DEFAULT 0
);

-- ── Reserva (unifica cotización y venta) ───────────────────────────────────
CREATE TABLE reserva (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  codigo                  TEXT NOT NULL UNIQUE,  -- LTR-XXXX, identificador de negocio
  cliente_id              INTEGER NOT NULL REFERENCES cliente(id),
  es_venta                INTEGER NOT NULL CHECK (es_venta IN (0,1)),
  estado                  TEXT NOT NULL DEFAULT 'cotizacion_pendiente'
                            CHECK (estado IN (
                              'cotizacion_pendiente','cotizacion_respondida',
                              'confirmada','completada','cancelada'
                            )),
  tipo_viaje              TEXT NOT NULL CHECK (tipo_viaje IN ('one_way','round_trip','custom')),
  vehiculo_id             TEXT NOT NULL REFERENCES vehiculo(id),
  origen                  TEXT NOT NULL,
  destino                 TEXT NOT NULL,
  zona_origen_id          INTEGER REFERENCES zona(id),   -- NULL en cotizaciones custom
  zona_destino_id         INTEGER REFERENCES zona(id),
  fecha_servicio          TEXT NOT NULL,  -- ISO date
  hora_servicio           TEXT NOT NULL,  -- HH:MM
  fecha_regreso           TEXT,           -- solo round_trip
  hora_regreso            TEXT,
  pasajeros               INTEGER NOT NULL,
  notas                   TEXT,
  itinerario              TEXT,           -- solo custom
  monto                   REAL NOT NULL DEFAULT 0,
  moneda                  TEXT NOT NULL DEFAULT 'USD',
  cupon_codigo            TEXT,           -- sin FK por ahora, ver nota al final
  descuento_pct           REAL,
  metodo_pago             TEXT CHECK (metodo_pago IS NULL OR metodo_pago IN
                            ('stripe','paypal','efectivo','transferencia')),
  estado_pago             TEXT NOT NULL DEFAULT 'no_aplica'
                            CHECK (estado_pago IN ('no_aplica','pendiente','pagado','fallido','reembolsado')),
  referencia_pago_externa TEXT,           -- session_id Stripe / order id PayPal
  voucher_pdf_key         TEXT,           -- key/path en R2, no el blob
  idioma                  TEXT NOT NULL DEFAULT 'es' CHECK (idioma IN ('es','en')),
  created_at              TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at              TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_reserva_cliente       ON reserva(cliente_id);
CREATE INDEX idx_reserva_estado        ON reserva(estado);
CREATE INDEX idx_reserva_fecha_servicio ON reserva(fecha_servicio);
CREATE INDEX idx_reserva_zona_origen   ON reserva(zona_origen_id);
CREATE INDEX idx_reserva_zona_destino  ON reserva(zona_destino_id);

-- ── LogNotificacion ─────────────────────────────────────────────────────────
CREATE TABLE log_notificacion (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  reserva_id       INTEGER NOT NULL REFERENCES reserva(id),
  tipo             TEXT NOT NULL CHECK (tipo IN
                     ('confirmacion_interna','confirmacion_cliente','cotizacion')),
  destinatario     TEXT NOT NULL,
  incluyo_voucher  INTEGER NOT NULL DEFAULT 0 CHECK (incluyo_voucher IN (0,1)),
  fecha_envio      TEXT NOT NULL DEFAULT (datetime('now')),
  estado           TEXT NOT NULL CHECK (estado IN ('enviado','fallido')),
  proveedor_error  TEXT
);

CREATE INDEX idx_log_notificacion_reserva ON log_notificacion(reserva_id);

-- ── Usuario (staff del CRM) ─────────────────────────────────────────────────
CREATE TABLE usuario (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre         TEXT NOT NULL,
  email          TEXT NOT NULL UNIQUE,
  password_hash  TEXT NOT NULL,
  rol            TEXT NOT NULL CHECK (rol IN ('admin','agente')),
  activo         INTEGER NOT NULL DEFAULT 1 CHECK (activo IN (0,1)),
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ═══════════════════════════════════════════════════════════════════════════
-- NOTAS — decisiones tomadas al escribir este borrador, pendientes de tu ok:
--
-- 1. cupon_codigo en `reserva` NO tiene FK a `cupon.codigo`. Razón: según el
--    alcance MVP (§6), la administración de cupones sigue viviendo en la env
--    var del worker por ahora — la tabla `cupon` existe pero no se usa activamente
--    todavía. Forzar la FK bloquearía inserts de reservas con cupones que el CRM
--    no conoce aún. Se puede agregar la FK cuando el worker de pagos empiece a
--    leer cupones desde aquí.
--
-- 2. tipo_viaje se normaliza a un enum limpio de 3 valores (one_way/round_trip/
--    custom), colapsando los 5 valores no normalizados que llegan hoy del
--    frontend (ONE WAY, ROUND TRIP, SENCILLO, REDONDO, Custom Service). Esa
--    normalización pasa a vivir en el CRM API al recibir el payload, no aquí.
--    Asumo SENCILLO→one_way y REDONDO→round_trip (duplicados ES/EN del mismo
--    dato) — confirmar que es correcto.
--
-- 3. moneda tiene DEFAULT 'USD' sin CHECK — asumí que todo el negocio cotiza
--    en USD hoy. Si en algún momento hay reservas en MXN u otra moneda, avisa
--    para agregar el CHECK con el enum correcto antes de que haya datos reales.
-- ═══════════════════════════════════════════════════════════════════════════
