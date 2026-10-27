import type { Context, MiddlewareHandler } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { Bindings } from '../types';
import { generateSessionToken, hashSessionToken } from './crypto';

const COOKIE_NAME = 'crm_session';
const SESSION_DURATION_SEC = 7 * 24 * 60 * 60; // 7 días
const RENEW_THRESHOLD_SEC = 24 * 60 * 60; // renueva si queda menos de 1 día

export type UsuarioSesion = {
  id: number;
  nombre: string;
  email: string;
  rol: 'admin' | 'agente';
};

type Env = { Bindings: Bindings; Variables: { usuario: UsuarioSesion } };

function cookieOpts<E extends { Bindings: Bindings }>(c: Context<E>, maxAge: number) {
  return {
    httpOnly: true as const,
    secure: true as const,
    sameSite: 'Lax' as const,
    // vacío en local/dev = cookie host-only, funciona con localhost
    domain: c.env.COOKIE_DOMAIN || undefined,
    path: '/',
    maxAge,
  };
}

/** Crea una sesión nueva en D1 y pone la cookie en la respuesta. */
export async function crearSesion<E extends { Bindings: Bindings }>(
  c: Context<E>,
  usuarioId: number,
) {
  const token = generateSessionToken();
  const tokenHash = await hashSessionToken(token);
  const expiresAt = new Date(Date.now() + SESSION_DURATION_SEC * 1000).toISOString();

  await c.env.DB.prepare(
    'INSERT INTO sesion (id, usuario_id, expires_at, user_agent) VALUES (?, ?, ?, ?)',
  )
    .bind(tokenHash, usuarioId, expiresAt, c.req.header('user-agent') ?? null)
    .run();

  setCookie(c, COOKIE_NAME, token, cookieOpts(c, SESSION_DURATION_SEC));
}

/** Borra la sesión actual de D1 y limpia la cookie. */
export async function cerrarSesion<E extends { Bindings: Bindings }>(c: Context<E>) {
  const token = getCookie(c, COOKIE_NAME);
  if (token) {
    const tokenHash = await hashSessionToken(token);
    await c.env.DB.prepare('DELETE FROM sesion WHERE id = ?').bind(tokenHash).run();
  }
  deleteCookie(c, COOKIE_NAME, { domain: c.env.COOKIE_DOMAIN || undefined, path: '/' });
}

/**
 * Exige sesión válida. Cuelga el usuario en el contexto (c.get('usuario'))
 * para que las rutas protegidas lo usen directo, y renueva la sesión si
 * queda poco tiempo (renovación deslizante de 7 días).
 *
 * Nota para la Fase 3: /reservas lo llama el worker de pagos, no un usuario
 * con sesión — ahí se agrega, sin tocar esta lógica, soporte para
 * Authorization: Bearer <token de servicio> como mecanismo alterno.
 */
export function requireAuth(): MiddlewareHandler<Env> {
  return async (c, next) => {
    const token = getCookie(c, COOKIE_NAME);
    if (!token) return c.json({ error: 'No autenticado' }, 401);

    const tokenHash = await hashSessionToken(token);
    const sesion = await c.env.DB.prepare(
      `SELECT s.usuario_id, s.expires_at, u.nombre, u.email, u.rol
       FROM sesion s JOIN usuario u ON u.id = s.usuario_id
       WHERE s.id = ? AND u.activo = 1`,
    )
      .bind(tokenHash)
      .first<{
        usuario_id: number;
        expires_at: string;
        nombre: string;
        email: string;
        rol: 'admin' | 'agente';
      }>();

    if (!sesion) return c.json({ error: 'Sesión inválida' }, 401);

    const expiresAtMs = new Date(sesion.expires_at).getTime();
    if (expiresAtMs < Date.now()) {
      await c.env.DB.prepare('DELETE FROM sesion WHERE id = ?').bind(tokenHash).run();
      return c.json({ error: 'Sesión expirada' }, 401);
    }

    if (expiresAtMs - Date.now() < RENEW_THRESHOLD_SEC * 1000) {
      const nuevaExpiracion = new Date(Date.now() + SESSION_DURATION_SEC * 1000).toISOString();
      c.executionCtx.waitUntil(
        c.env.DB.prepare('UPDATE sesion SET expires_at = ? WHERE id = ?')
          .bind(nuevaExpiracion, tokenHash)
          .run(),
      );
      setCookie(c, COOKIE_NAME, token, cookieOpts(c, SESSION_DURATION_SEC));
    }

    c.set('usuario', {
      id: sesion.usuario_id,
      nombre: sesion.nombre,
      email: sesion.email,
      rol: sesion.rol,
    });
    await next();
  };
}
