// Límite de intentos fallidos de login. Se cuenta por correo y por IP en la tabla
// `intento_login`. Tras MAX fallos dentro de la ventana, esa clave queda bloqueada
// 15 minutos. Se consulta ANTES de verificar la contraseña (que es lo caro).

const VENTANA_MS = 15 * 60 * 1000;
export const MAX_FALLOS_EMAIL = 5;
export const MAX_FALLOS_IP = 30;

/** Segundos que faltan para que se levante el bloqueo más largo entre las claves (0 = libre). */
export async function segundosDeEspera(db: D1Database, claves: string[]): Promise<number> {
  const { results } = await db
    .prepare(
      `SELECT bloqueado_hasta FROM intento_login
       WHERE clave IN (${claves.map(() => '?').join(',')}) AND bloqueado_hasta IS NOT NULL`,
    )
    .bind(...claves)
    .all<{ bloqueado_hasta: string }>();

  const ahora = Date.now();
  let resta = 0;
  for (const r of results) resta = Math.max(resta, new Date(r.bloqueado_hasta).getTime() - ahora);
  return resta > 0 ? Math.ceil(resta / 1000) : 0;
}

export async function registrarFallo(db: D1Database, clave: string, maximo: number): Promise<void> {
  const ahora = Date.now();
  const fila = await db
    .prepare('SELECT fallos, desde FROM intento_login WHERE clave = ?')
    .bind(clave)
    .first<{ fallos: number; desde: string }>();

  const vigente = !!fila && new Date(fila.desde).getTime() > ahora - VENTANA_MS;
  const fallos = vigente ? fila!.fallos + 1 : 1;
  const desde = vigente ? fila!.desde : new Date(ahora).toISOString();
  const bloqueadoHasta = fallos >= maximo ? new Date(ahora + VENTANA_MS).toISOString() : null;

  await db
    .prepare(
      `INSERT INTO intento_login (clave, fallos, desde, bloqueado_hasta) VALUES (?, ?, ?, ?)
       ON CONFLICT(clave) DO UPDATE SET fallos = excluded.fallos, desde = excluded.desde,
                                        bloqueado_hasta = excluded.bloqueado_hasta`,
    )
    .bind(clave, fallos, desde, bloqueadoHasta)
    .run();

  // Limpieza: lo que lleva más de un día sin actividad ya no sirve.
  await db
    .prepare('DELETE FROM intento_login WHERE desde < ?')
    .bind(new Date(ahora - 24 * 60 * 60 * 1000).toISOString())
    .run();
}

export async function limpiarFallos(db: D1Database, clave: string): Promise<void> {
  await db.prepare('DELETE FROM intento_login WHERE clave = ?').bind(clave).run();
}