#!/usr/bin/env node
// Sincroniza la tabla `ancla` del CRM con src/data/zoneAnchors.json del sitio.
//
// Uso:   node scripts/sync-anclas.mjs ruta/a/zoneAnchors.json
//
// Escribe anclas.sql con un INSERT ... ON CONFLICT(id) DO UPDATE por ancla, así que se puede
// volver a correr cada vez que el JSON crezca (hoteles nuevos, etc.): agrega lo nuevo y
// actualiza lo existente. NUNCA borra ni reasigna ids (el sitio tampoco debe hacerlo).
// Después se aplica con wrangler (el script imprime los comandos).

import { readFileSync, writeFileSync } from 'node:fs';

const ruta = process.argv[2];
if (!ruta) {
  console.error('Uso: node scripts/sync-anclas.mjs ruta/a/zoneAnchors.json');
  process.exit(1);
}

let anclas;
try {
  anclas = JSON.parse(readFileSync(ruta, 'utf-8')).anchors;
} catch (e) {
  console.error(`No pude leer ${ruta}: ${e.message}`);
  process.exit(1);
}
if (!Array.isArray(anclas) || !anclas.length) {
  console.error('El JSON no tiene un arreglo "anchors".');
  process.exit(1);
}

const errores = [];
const ids = new Set();
const codigos = new Set();
for (const a of anclas) {
  if (!Number.isInteger(a.id) || a.id < 0 || a.id > 1023) errores.push(`id inválido (0–1023): ${JSON.stringify(a.id)} (${a.code})`);
  if (ids.has(a.id)) errores.push(`id repetido: ${a.id}`);
  if (codigos.has(a.code)) errores.push(`code repetido: ${a.code}`);
  ids.add(a.id);
  codigos.add(a.code);
  if (!a.code || !a.zone || !a.label?.es || !a.label?.en) errores.push(`ancla ${a.id}: faltan code, zone o label.es/label.en`);
}
if (errores.length) {
  console.error('El JSON tiene problemas, no se generó nada:\n - ' + errores.join('\n - '));
  process.exit(1);
}

const esc = (s) => String(s).replace(/'/g, "''");
const num = (n) => (Number.isFinite(n) ? n : 'NULL');

const lineas = anclas
  .sort((a, b) => a.id - b.id)
  .map(
    (a) =>
      `INSERT INTO ancla (id, codigo, nombre, nombre_en, tipo, zona_id, lat, lng) VALUES ` +
      `(${a.id}, '${esc(a.code)}', '${esc(a.label.es)}', '${esc(a.label.en)}', '${a.kind === 'venue' ? 'venue' : 'zona'}', ` +
      `(SELECT id FROM zona WHERE nombre = '${esc(a.zone)}'), ${num(a.lat)}, ${num(a.lng)}) ` +
      `ON CONFLICT(id) DO UPDATE SET codigo = excluded.codigo, nombre = excluded.nombre, nombre_en = excluded.nombre_en, ` +
      `tipo = excluded.tipo, zona_id = excluded.zona_id, lat = excluded.lat, lng = excluded.lng;`,
  );

writeFileSync('anclas.sql', lineas.join('\n') + '\n', 'utf-8');

const huecos = [];
for (let i = 0; i <= Math.max(...ids); i++) if (!ids.has(i)) huecos.push(i);
console.log(`\n${anclas.length} anclas (${anclas.filter((a) => a.kind === 'venue').length} lugares). Se creó anclas.sql.`);
if (huecos.length) console.log(`Ojo: faltan los ids ${huecos.join(', ')} (¿se borraron? nunca se deben reutilizar).`);
console.log('\nAplícalo con:');
console.log('  Local:       npx wrangler d1 execute crm-db --local  --file=anclas.sql');
console.log('  Producción:  npx wrangler d1 execute crm-db --remote --file=anclas.sql');
console.log('\nY comprueba que ninguna quedó sin zona de precios (debe salir vacío):');
console.log('  npx wrangler d1 execute crm-db --remote --command "SELECT id, codigo FROM ancla WHERE zona_id IS NULL"\n');