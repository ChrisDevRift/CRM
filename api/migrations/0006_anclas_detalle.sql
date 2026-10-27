-- Detalle de las anclas (lugares del sitio). Se llena con scripts/sync-anclas.mjs a partir de
-- src/data/zoneAnchors.json del sitio. `zona_id` enlaza con la zona de precios, así que una
-- reserva con código de landing (LTR-XXXXXX-OODD) puede llenar zona_origen_id y zona_destino_id.

ALTER TABLE ancla ADD COLUMN codigo     TEXT;
ALTER TABLE ancla ADD COLUMN zona_id    INTEGER REFERENCES zona(id);
ALTER TABLE ancla ADD COLUMN tipo       TEXT NOT NULL DEFAULT 'zona' CHECK (tipo IN ('zona','venue'));
ALTER TABLE ancla ADD COLUMN nombre_en  TEXT;
ALTER TABLE ancla ADD COLUMN lat        REAL;
ALTER TABLE ancla ADD COLUMN lng        REAL;