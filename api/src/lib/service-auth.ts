import type { MiddlewareHandler } from 'hono';
import type { Bindings } from '../types';

function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = new TextEncoder().encode(a);
  const bb = new TextEncoder().encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

/**
 * Autenticación para llamadas servicio-a-servicio — el worker de pagos hoy,
 * el bot de Telegram más adelante. No usa cookies de sesión: un token fijo
 * compartido vía `Authorization: Bearer <CRM_API_TOKEN>`.
 */
export function requireServiceToken(): MiddlewareHandler<{ Bindings: Bindings }> {
  return async (c, next) => {
    const auth = c.req.header('authorization') || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!token || !c.env.CRM_API_TOKEN || !timingSafeEqualStr(token, c.env.CRM_API_TOKEN)) {
      return c.json({ error: 'No autorizado' }, 401);
    }
    await next();
  };
}
