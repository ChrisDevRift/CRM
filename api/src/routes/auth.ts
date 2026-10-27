import { Hono } from 'hono';
import type { Bindings } from '../types';
import { verifyPassword } from '../lib/crypto';
import { crearSesion, cerrarSesion, requireAuth, type UsuarioSesion } from '../lib/auth';
import {
  segundosDeEspera, registrarFallo, limpiarFallos, MAX_FALLOS_EMAIL, MAX_FALLOS_IP,
} from '../lib/throttle';

export const authRoutes = new Hono<{
  Bindings: Bindings;
  Variables: { usuario: UsuarioSesion };
}>();

authRoutes.post('/login', async (c) => {
  const body = await c.req.json<{ email?: string; password?: string }>().catch(() => null);
  if (!body?.email || !body?.password) {
    return c.json({ error: 'Falta email o password' }, 400);
  }

  const correo = body.email.toLowerCase().trim().slice(0, 200);
  const ip = c.req.header('cf-connecting-ip') ?? 'desconocida';
  const claveCorreo = `email:${correo}`;
  const claveIp = `ip:${ip}`;

  // Primero el límite de intentos: es barato y evita gastar CPU verificando contraseñas.
  const espera = await segundosDeEspera(c.env.DB, [claveCorreo, claveIp]);
  if (espera > 0) {
    c.header('Retry-After', String(espera));
    return c.json(
      { error: `Demasiados intentos. Intenta de nuevo en ${Math.ceil(espera / 60)} min.`, retry_after: espera },
      429,
    );
  }

  const usuario = await c.env.DB.prepare(
    'SELECT id, nombre, email, password_hash, rol, activo FROM usuario WHERE email = ?',
  )
    .bind(correo)
    .first<{
      id: number;
      nombre: string;
      email: string;
      password_hash: string;
      rol: 'admin' | 'agente';
      activo: number;
    }>();

  // Mismo mensaje tanto si el usuario no existe como si la contraseña es
  // incorrecta — no le damos pistas a quien intenta adivinar credenciales.
  const rechazar = async () => {
    await registrarFallo(c.env.DB, claveCorreo, MAX_FALLOS_EMAIL);
    await registrarFallo(c.env.DB, claveIp, MAX_FALLOS_IP);
    return c.json({ error: 'Credenciales inválidas' }, 401);
  };

  if (!usuario || !usuario.activo) return rechazar();
  if (!(await verifyPassword(body.password, usuario.password_hash))) return rechazar();

  await limpiarFallos(c.env.DB, claveCorreo);
  await crearSesion(c, usuario.id);

  return c.json({
    usuario: { id: usuario.id, nombre: usuario.nombre, email: usuario.email, rol: usuario.rol },
  });
});

authRoutes.post('/logout', async (c) => {
  await cerrarSesion(c);
  return c.json({ status: 'ok' });
});

// Para que el panel confirme al cargar si sigue habiendo sesión activa.
authRoutes.get('/me', requireAuth(), async (c) => {
  return c.json({ usuario: c.get('usuario') });
});