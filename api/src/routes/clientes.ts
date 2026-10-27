import { Hono } from 'hono';
import type { Bindings } from '../types';
import { requireAuth, type UsuarioSesion } from '../lib/auth';

export const clientesRoutes = new Hono<{
  Bindings: Bindings;
  Variables: { usuario: UsuarioSesion };
}>();

// ── GET /clientes?q=&limit=&offset= ──────────────────────────────────────
// Lista con totales. "total_usd" suma solo reservas vendidas, no canceladas, en USD
// (mezclar monedas daría un número sin sentido).
clientesRoutes.get('/', requireAuth(), async (c) => {
  const q = (c.req.query('q') ?? '').trim();
  const limit = Math.min(parseInt(c.req.query('limit') ?? '50') || 50, 200);
  const offset = Math.max(parseInt(c.req.query('offset') ?? '0') || 0, 0);

  const params: unknown[] = [];
  let where = '';
  if (q) {
    where = 'WHERE (c.nombre LIKE ? OR c.email LIKE ? OR c.telefono LIKE ?)';
    const like = `%${q}%`;
    params.push(like, like, like);
  }

  const { results } = await c.env.DB.prepare(
    `SELECT c.id, c.nombre, c.email, c.telefono, c.idioma_preferido, c.fecha_alta,
            COUNT(r.id) AS reservas,
            COALESCE(SUM(CASE WHEN r.es_venta = 1 AND r.estado != 'cancelada' AND r.moneda = 'USD'
                              THEN r.monto ELSE 0 END), 0) AS total_usd,
            MAX(r.fecha_servicio) AS ultimo_servicio
     FROM cliente c
     LEFT JOIN reserva r ON r.cliente_id = c.id
     ${where}
     GROUP BY c.id
     ORDER BY ultimo_servicio IS NULL, ultimo_servicio DESC, c.id DESC
     LIMIT ? OFFSET ?`,
  )
    .bind(...params, limit, offset)
    .all();

  return c.json({ clientes: results });
});

// ── GET /clientes/:id ────────────────────────────────────────────────────
clientesRoutes.get('/:id', requireAuth(), async (c) => {
  const id = parseInt(c.req.param('id'));
  if (!Number.isFinite(id)) return c.json({ error: 'id inválido' }, 400);

  const cliente = await c.env.DB.prepare('SELECT * FROM cliente WHERE id = ?').bind(id).first();
  if (!cliente) return c.json({ error: 'No encontrado' }, 404);

  const { results: reservas } = await c.env.DB.prepare(
    `SELECT id, codigo, estado, es_venta, tipo_viaje, origen, destino,
            fecha_servicio, hora_servicio, monto, moneda
     FROM reserva WHERE cliente_id = ?
     ORDER BY fecha_servicio DESC, id DESC LIMIT 200`,
  )
    .bind(id)
    .all<{ es_venta: number; estado: string; moneda: string; monto: number; fecha_servicio: string }>();

  const resumen = {
    reservas: reservas.length,
    total_usd: reservas
      .filter((r) => r.es_venta === 1 && r.estado !== 'cancelada' && r.moneda === 'USD')
      .reduce((s, r) => s + r.monto, 0),
    ultimo_servicio: reservas.length ? reservas[0].fecha_servicio : null,
  };

  return c.json({ cliente, resumen, reservas });
});

// ── PATCH /clientes/:id ──────────────────────────────────────────────────
clientesRoutes.patch('/:id', requireAuth(), async (c) => {
  const id = parseInt(c.req.param('id'));
  if (!Number.isFinite(id)) return c.json({ error: 'id inválido' }, 400);

  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body || typeof body !== 'object') return c.json({ error: 'JSON inválido' }, 400);

  const sets: string[] = [];
  const params: unknown[] = [];
  const vacio = (v: unknown) => v === null || v === undefined || String(v).trim() === '';

  for (const [campo, valor] of Object.entries(body)) {
    const s = vacio(valor) ? '' : String(valor).trim();
    switch (campo) {
      case 'nombre':
        if (s.length < 2 || s.length > 100) return c.json({ error: 'nombre: entre 2 y 100 caracteres' }, 400);
        sets.push('nombre = ?'); params.push(s);
        break;
      case 'email': {
        const correo = s.toLowerCase();
        if (correo && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(correo)) return c.json({ error: 'email: formato inválido' }, 400);
        sets.push('email = ?'); params.push(correo || null);
        break;
      }
      case 'telefono':
        if (s.length > 50) return c.json({ error: 'telefono: máximo 50 caracteres' }, 400);
        sets.push('telefono = ?'); params.push(s || null);
        break;
      case 'idioma_preferido':
        if (s !== 'es' && s !== 'en') return c.json({ error: 'idioma_preferido: es o en' }, 400);
        sets.push('idioma_preferido = ?'); params.push(s);
        break;
      case 'notas_internas':
        if (s.length > 2000) return c.json({ error: 'notas_internas: máximo 2000 caracteres' }, 400);
        sets.push('notas_internas = ?'); params.push(s || null);
        break;
      default:
        return c.json({ error: `Campo no editable: ${campo}` }, 400);
    }
  }
  if (!sets.length) return c.json({ status: 'ok', cambios: 0 });

  try {
    const res = await c.env.DB.prepare(`UPDATE cliente SET ${sets.join(', ')} WHERE id = ?`)
      .bind(...params, id)
      .run();
    if (res.meta.changes === 0) return c.json({ error: 'No encontrado' }, 404);
  } catch (e) {
    if (String(e).includes('UNIQUE')) return c.json({ error: 'Ese correo ya pertenece a otro cliente' }, 409);
    throw e;
  }
  return c.json({ status: 'ok', cambios: sets.length });
});