#!/usr/bin/env node
// Crea un usuario del CRM, o le cambia la contraseña si el correo ya existe.
//
// Uso:   node scripts/create-admin.mjs "Nombre Apellido" correo@empresa.com [admin|agente]
//
// La contraseña se pide por teclado (no se ve al escribir), así la consola de Windows/
// PowerShell no puede alterarla: con la contraseña como argumento, un "$" dentro de
// comillas dobles se interpreta como variable y el hash queda de otra contraseña.
// Para automatizar: CRM_PASSWORD="..." node scripts/create-admin.mjs "Nombre" correo rol
//
// El script solo CALCULA el hash y escribe crear-usuario.sql; no toca D1 directamente.

import { webcrypto as crypto } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const PBKDF2_ITERATIONS = 100_000; // debe coincidir con src/lib/crypto.ts

const toBase64 = (bytes) => Buffer.from(bytes).toString('base64');

async function derivar(password, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, key, 256);
  return new Uint8Array(bits);
}

async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derivar(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2_sha256$${PBKDF2_ITERATIONS}$${toBase64(salt)}$${toBase64(hash)}`;
}

// Pide una línea; en una terminal real no muestra lo que escribes.
function pedir(pregunta) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
    if (process.stdin.isTTY) {
      rl._writeToOutput = (s) => {
        if (s.startsWith(pregunta)) process.stdout.write(s);
        else if (s.includes('\n') || s.includes('\r')) process.stdout.write('\n');
      };
    }
    rl.question(pregunta, (r) => { rl.close(); resolve(r); });
  });
}

const [nombre, email, rol = 'admin'] = process.argv.slice(2);

if (!nombre || !email || !['admin', 'agente'].includes(rol)) {
  console.error('Uso: node scripts/create-admin.mjs "Nombre Apellido" correo@empresa.com [admin|agente]');
  console.error('(la contraseña se pide después; ya no va como argumento)');
  process.exit(1);
}

let password = process.env.CRM_PASSWORD;
if (!password) {
  password = await pedir('Contraseña: ');
  if (process.stdin.isTTY) {
    const otra = await pedir('Repite la contraseña: ');
    if (otra !== password) { console.error('\nNo coinciden. No se creó nada.'); process.exit(1); }
  }
}
if (password.length < 10) { console.error('\nUsa al menos 10 caracteres. No se creó nada.'); process.exit(1); }

const hash = await hashPassword(password);
const correo = email.toLowerCase().trim();
const esc = (s) => s.replace(/'/g, "''");

const sql =
  `INSERT INTO usuario (nombre, email, password_hash, rol) VALUES ` +
  `('${esc(nombre)}', '${esc(correo)}', '${hash}', '${rol}') ` +
  `ON CONFLICT(email) DO UPDATE SET nombre = excluded.nombre, password_hash = excluded.password_hash, ` +
  `rol = excluded.rol, activo = 1;`;

const archivo = 'crear-usuario.sql';
writeFileSync(archivo, sql + '\n', 'utf-8');

console.log(`\nListo: ${correo} (${rol}), contraseña de ${[...password].length} caracteres. Se creó ${archivo}. Aplícalo con:\n`);
console.log(`  Local (pruebas):  npx wrangler d1 execute crm-db --local --file=${archivo}`);
console.log(`  Producción:       npx wrangler d1 execute crm-db --remote --file=${archivo}\n`);
console.log(`Después borra ${archivo} (contiene el hash de la contraseña).\n`);