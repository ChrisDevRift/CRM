#!/usr/bin/env node
// Importa al CRM las reservas y cotizaciones del Google Sheet.
//
// 1) En el Sheet, en cada pestaña: Archivo → Descargar → "Valores separados por tabulaciones (.tsv)".
//    Sirve cualquier pestaña de ventas o de cotizaciones, o varias pegadas en un mismo archivo
//    (cada vez que aparece una fila de encabezados, empieza una tabla nueva).
// 2) node scripts/import-sheet.mjs archivo.tsv --dry-run                     (solo muestra lo que haría)
//    node scripts/import-sheet.mjs archivo.tsv --api https://crm-api.… --token TU_TOKEN
//    (o con las variables CRM_API_URL y CRM_API_TOKEN, para no dejar el token en el historial)
//
// Cada fila se manda a POST /reservas, el mismo camino que usa el worker de pagos, así que pasa
// por las mismas normalizaciones. Se puede correr varias veces: el CRM actualiza por código y no
// duplica. Las reservas importadas quedan con fuente = "importada".

import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const archivo = args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--api' && args[args.indexOf(a) - 1] !== '--token');
const valor = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
const dry = args.includes('--dry-run');
const api = (valor('--api') ?? process.env.CRM_API_URL ?? '').replace(/\/+$/, '');
const token = valor('--token') ?? process.env.CRM_API_TOKEN ?? '';

if (!archivo || (!dry && (!api || !token))) {
  console.error('Uso: node scripts/import-sheet.mjs archivo.tsv [--dry-run] [--api URL --token TOKEN]');
  process.exit(1);
}

// ── Lector de CSV/TSV (comillas, saltos de línea dentro de una celda, BOM) ──
function leerTabla(texto) {
  texto = texto.replace(/^\uFEFF/, '');
  const primera = texto.split(/\r?\n/, 1)[0];
  const sep = primera.includes('\t') ? '\t' : primera.includes(';') && !primera.includes(',') ? ';' : ',';
  const filas = [];
  let fila = [], celda = '', comillas = false;
  for (let i = 0; i < texto.length; i++) {
    const ch = texto[i];
    if (comillas) {
      if (ch === '"' && texto[i + 1] === '"') { celda += '"'; i++; }
      else if (ch === '"') comillas = false;
      else celda += ch;
    } else if (ch === '"' && celda === '') comillas = true;
    else if (ch === sep) { fila.push(celda); celda = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && texto[i + 1] === '\n') i++;
      fila.push(celda); celda = '';
      if (fila.some((c) => c.trim() !== '')) filas.push(fila);
      fila = [];
    } else celda += ch;
  }
  fila.push(celda);
  if (fila.some((c) => c.trim() !== '')) filas.push(fila);
  return filas;
}

const norm = (s) => String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();

// Encabezado de la hoja → campo del payload.
const COLUMNAS = {
  'estado': 'estadoHoja', 'fecha de registro': 'registradoEn', 'codigo': 'codigo',
  'fecha de servicio': 'fecha', 'hora de servicio': 'hora', 'fecha regreso': 'fechaRegreso', 'hora regreso': 'horaRegreso',
  'idioma': 'idioma', 'nombre': 'nombre', 'telefono': 'telefono', 'email': 'email',
  'tipo': 'tipoViaje', 'tipo de viaje': 'tipoViaje', 'vehiculo': 'vehiculo', 'tipo de servicio': 'vehiculo',
  'pasajeros': 'pasajeros', 'origen': 'origen', 'destino': 'destino', 'vuelo': 'vuelo', 'extras': 'extras',
  'precio final': 'precioTotal', 'precio': 'precio', 'metodo de pago': 'pago', 'cupon': 'cupon', 'notas': 'notas',
};

function estadoDeHoja(texto) {
  const t = norm(texto).toUpperCase();
  if (/CANCEL/.test(t)) return 'cancelada';
  if (/COMPLET|FINALIZ|TERMIN|REALIZ/.test(t)) return 'completada';
  if (/RESPOND/.test(t)) return 'cotizacion_respondida';
  if (/CONFIRM/.test(t)) return 'confirmada';
  return null; // NUEVA, COTIZACIÓN…: lo decide el CRM según sea venta o cotización
}
const CONOCIDOS = /NUEVA|COTIZACION|CANCEL|COMPLET|FINALIZ|TERMIN|REALIZ|RESPOND|CONFIRM/;

const filas = leerTabla(readFileSync(archivo, 'utf-8'));
const payloads = [];
const omitidas = [];
const estadosRaros = new Map();
let tabla = null;

for (const fila of filas) {
  if (norm(fila[0]) === 'estado') {
    const mapa = {};
    fila.forEach((h, i) => { const campo = COLUMNAS[norm(h)]; if (campo) mapa[campo] = i; });
    tabla = { mapa, esVentas: 'pago' in mapa || 'precioTotal' in mapa };
    continue;
  }
  if (!tabla) continue;
  const v = (campo) => (tabla.mapa[campo] === undefined ? '' : String(fila[tabla.mapa[campo]] ?? '').trim());

  const codigo = v('codigo');
  const nombre = v('nombre');
  if (!codigo || !nombre) { omitidas.push(fila.slice(0, 4).join(' | ')); continue; }

  const estadoTxt = v('estadoHoja');
  if (estadoTxt && !CONOCIDOS.test(norm(estadoTxt).toUpperCase())) estadosRaros.set(estadoTxt, (estadosRaros.get(estadoTxt) ?? 0) + 1);

  const extras = v('extras');
  payloads.push({
    esVenta: tabla.esVentas,
    codigo, nombre,
    telefono: v('telefono'), email: v('email'),
    pasajeros: v('pasajeros'), tipoViaje: v('tipoViaje'), vehiculo: v('vehiculo'),
    origen: v('origen'), destino: v('destino'),
    fecha: v('fecha'), hora: v('hora'), fechaRegreso: v('fechaRegreso'), horaRegreso: v('horaRegreso'),
    vuelo: v('vuelo'),
    precio: v('precio') || v('precioTotal'), precioTotal: v('precioTotal'),
    pago: v('pago'), cupon: v('cupon'),
    notas: [v('notas'), extras ? `Extras: ${extras}` : ''].filter(Boolean).join(' — '),
    idioma: v('idioma').toLowerCase() === 'en' ? 'en' : 'es',
    registradoEn: v('registradoEn'),
    estado: estadoDeHoja(estadoTxt) ?? undefined,
    fuente: 'importada',
  });
}

console.log(`\n${payloads.length} filas para importar (${payloads.filter((p) => p.esVenta).length} ventas, ${payloads.filter((p) => !p.esVenta).length} cotizaciones).`);
if (omitidas.length) console.log(`Se omitieron ${omitidas.length} filas sin código o sin nombre:\n  ${omitidas.join('\n  ')}`);
if (estadosRaros.size) console.log(`Estados de la hoja que no reconozco (se importan con el estado por defecto): ${[...estadosRaros].map(([e, n]) => `"${e}" ×${n}`).join(', ')}`);

if (dry) {
  console.log('\n── Simulación (no se mandó nada) ──');
  for (const p of payloads) console.log(`${p.esVenta ? 'VENTA' : 'COTIZ'} ${p.codigo.padEnd(18)} ${p.fecha || '—'} ${p.hora || ''} | ${p.nombre} | ${p.vehiculo || p.tipoViaje} | ${p.precioTotal || p.precio} | estado:${p.estado ?? 'por defecto'}`);
  process.exit(0);
}

let ok = 0;
const fallidas = [];
for (const p of payloads) {
  try {
    const res = await fetch(`${api}/reservas`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(p),
    });
    if (res.ok) ok++;
    else fallidas.push(`${p.codigo}: HTTP ${res.status} ${(await res.text()).slice(0, 120)}`);
  } catch (e) {
    fallidas.push(`${p.codigo}: ${e.message}`);
  }
}
console.log(`\nImportadas: ${ok} de ${payloads.length}.`);
if (fallidas.length) console.log(`Fallaron ${fallidas.length}:\n  ${fallidas.join('\n  ')}`);
process.exit(fallidas.length ? 1 : 0);