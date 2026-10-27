-- Faltaban en el esquema inicial: el número de vuelo (ida y regreso) es
-- dato operativo real — el chofer lo necesita para monitorear llegadas.
-- Viene en el payload que manda el worker de pagos (`vuelo`, `vueloRegreso`).

ALTER TABLE reserva ADD COLUMN vuelo TEXT;
ALTER TABLE reserva ADD COLUMN vuelo_regreso TEXT;
