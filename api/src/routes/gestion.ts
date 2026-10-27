import { Hono } from "hono";
import type { Bindings } from "../types";
import { requireAuth, type UsuarioSesion } from "../lib/auth";
import { generarCodigoManual } from "../lib/codigo";

type Env = { Bindings: Bindings; Variables: { usuario: UsuarioSesion } };

export const ESTADOS = [
  "cotizacion_pendiente",
  "cotizacion_respondida",
  "confirmada",
  "completada",
  "cancelada",
];

// ── Validadores: cada uno devuelve el valor ya limpio o un error ───────────
type R = { ok: true; v: string | number | null } | { ok: false; error: string };
const ok = (v: string | number | null): R => ({ ok: true, v });
const err = (error: string): R => ({ ok: false, error });
const vacio = (v: unknown) =>
  v === null || v === undefined || String(v).trim() === "";

const texto =
  (max: number, requerido = false) =>
  (v: unknown): R => {
    if (vacio(v)) return requerido ? err("es obligatorio") : ok(null);
    const s = String(v).trim();
    return s.length > max ? err(`máximo ${max} caracteres`) : ok(s);
  };
const enumerado =
  (vals: string[], nulo = false) =>
  (v: unknown): R => {
    if (vacio(v) && nulo) return ok(null);
    return vals.includes(String(v))
      ? ok(String(v))
      : err(`valores válidos: ${vals.join(", ")}`);
  };
const fecha =
  (requerido: boolean) =>
  (v: unknown): R => {
    if (vacio(v)) return requerido ? err("es obligatoria") : ok(null);
    return /^\d{4}-\d{2}-\d{2}$/.test(String(v))
      ? ok(String(v))
      : err("formato AAAA-MM-DD");
  };
const hora =
  (requerido: boolean) =>
  (v: unknown): R => {
    if (vacio(v)) return requerido ? err("es obligatoria") : ok(null);
    return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(v))
      ? ok(String(v))
      : err("formato HH:MM");
  };
const entero =
  (min: number, max: number, nulo: boolean) =>
  (v: unknown): R => {
    if (vacio(v)) return nulo ? ok(null) : err("es obligatorio");
    const n = Number(v);
    return Number.isInteger(n) && n >= min && n <= max
      ? ok(n)
      : err(`entero entre ${min} y ${max}`);
  };
const numero =
  (min: number, max: number) =>
  (v: unknown): R => {
    const n = Number(v);
    return !vacio(v) && Number.isFinite(n) && n >= min && n <= max
      ? ok(n)
      : err(`número entre ${min} y ${max}`);
  };

// Campos que se pueden editar / capturar en una reserva (lista blanca: los nombres
// de columna que llegan al UPDATE salen SOLO de aquí).
const CAMPOS: Record<string, (v: unknown) => R> = {
  estado: enumerado(ESTADOS),
  tipo_viaje: enumerado(["one_way", "round_trip", "custom"]),
  vehiculo_id: texto(30, true),
  origen: texto(300, true),
  destino: texto(300, true),
  zona_origen_id: entero(1, 100000, true),
  zona_destino_id: entero(1, 100000, true),
  fecha_servicio: fecha(true),
  hora_servicio: hora(true),
  fecha_regreso: fecha(false),
  hora_regreso: hora(false),
  vuelo: texto(50),
  vuelo_regreso: texto(50),
  pasajeros: entero(1, 100, false),
  notas: texto(2000),
  monto: numero(0, 1_000_000),
  moneda: enumerado(["USD", "MXN", "CAD"]),
  metodo_pago: enumerado(
    ["stripe", "paypal", "efectivo", "transferencia"],
    true,
  ),
  estado_pago: enumerado([
    "no_aplica",
    "pendiente",
    "pagado",
    "fallido",
    "reembolsado",
  ]),
  cupon_codigo: texto(50),
  duracion_min: entero(1, 1440, true),
};

const tieneCampo = (campo: string) =>
  Object.prototype.hasOwnProperty.call(CAMPOS, campo);

// ════════════════════════════════════════════════════════════════════════
//  Catálogos para los formularios del panel (zonas, vehículos, estados)
// ════════════════════════════════════════════════════════════════════════
export const catalogosRoutes = new Hono<Env>();

catalogosRoutes.get("/", requireAuth(), async (c) => {
  const [zonas, vehiculos] = await Promise.all([
    c.env.DB.prepare("SELECT id, nombre FROM zona ORDER BY nombre").all(),
    c.env.DB.prepare(
      "SELECT id, label, capacidad FROM vehiculo ORDER BY label",
    ).all(),
  ]);
  return c.json({
    zonas: zonas.results,
    vehiculos: vehiculos.results,
    estados: ESTADOS,
  });
});

// ════════════════════════════════════════════════════════════════════════
//  Crear, editar, historial y precio sugerido — se monta en /reservas
// ════════════════════════════════════════════════════════════════════════
export const gestionRoutes = new Hono<Env>();

// ── POST /reservas/manual ────────────────────────────────────────────────
gestionRoutes.post("/manual", requireAuth(), async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body || typeof body !== "object")
    return c.json({ error: "JSON inválido" }, 400);

  // Cliente
  const nombre = String(body.nombre ?? "").trim();
  const email = String(body.email ?? "")
    .trim()
    .toLowerCase();
  const telefono =
    String(body.telefono ?? "")
      .trim()
      .slice(0, 50) || null;
  if (nombre.length < 2 || nombre.length > 100)
    return c.json({ error: "nombre: entre 2 y 100 caracteres" }, 400);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email))
    return c.json({ error: "email: formato inválido" }, 400);

  // Datos de la reserva
  const d: Record<string, string | number | null> = {};
  for (const campo of Object.keys(CAMPOS)) {
    if (body[campo] === undefined) continue;
    const r = CAMPOS[campo](body[campo]);
    if (!r.ok) return c.json({ error: `${campo}: ${r.error}` }, 400);
    d[campo] = r.v;
  }
  for (const req of [
    "tipo_viaje",
    "vehiculo_id",
    "origen",
    "destino",
    "fecha_servicio",
    "hora_servicio",
    "pasajeros",
  ]) {
    if (d[req] === undefined || d[req] === null)
      return c.json({ error: `${req}: es obligatorio` }, 400);
  }
  if (d.tipo_viaje === "round_trip" && (!d.fecha_regreso || !d.hora_regreso)) {
    return c.json(
      { error: "Un viaje redondo necesita fecha y hora de regreso" },
      400,
    );
  }

  const esVenta = body.es_venta === true || body.es_venta === "true";
  const estado =
    (d.estado as string) ?? (esVenta ? "confirmada" : "cotizacion_pendiente");
  const estadoPago =
    (d.estado_pago as string) ?? (esVenta ? "pendiente" : "no_aplica");
  const idioma = body.idioma === "en" ? "en" : "es";
  const usuarioId = c.get("usuario").id;

  // Se comprueba que el vehículo y las zonas existan antes de tocar nada, para no dejar
  // un cliente creado si la reserva después no se puede guardar.
  const veh = await c.env.DB.prepare(
    "SELECT 1 AS ok FROM vehiculo WHERE id = ?",
  )
    .bind(d.vehiculo_id)
    .first();
  if (!veh) return c.json({ error: "vehiculo_id: no existe" }, 400);
  for (const campoZona of ["zona_origen_id", "zona_destino_id"] as const) {
    if (d[campoZona] == null) continue;
    const z = await c.env.DB.prepare("SELECT 1 AS ok FROM zona WHERE id = ?")
      .bind(d[campoZona])
      .first();
    if (!z) return c.json({ error: `${campoZona}: no existe` }, 400);
  }

  // Cliente: si el email ya existe se reutiliza sin pisar su nombre ni su teléfono.
  const cliente = email
    ? await c.env.DB.prepare(
        `INSERT INTO cliente (nombre, email, telefono, idioma_preferido) VALUES (?, ?, ?, ?)
         ON CONFLICT(email) DO UPDATE SET telefono = COALESCE(cliente.telefono, excluded.telefono)
         RETURNING id`,
      )
        .bind(nombre, email, telefono, idioma)
        .first<{ id: number }>()
    : await c.env.DB.prepare(
        "INSERT INTO cliente (nombre, email, telefono, idioma_preferido) VALUES (?, NULL, ?, ?) RETURNING id",
      )
        .bind(nombre, telefono, idioma)
        .first<{ id: number }>();
  if (!cliente)
    return c.json({ error: "No se pudo registrar el cliente" }, 500);

  // Reserva: se reintenta con otro código si por casualidad ya existe.
  for (let intento = 0; intento < 5; intento++) {
    const codigo = generarCodigoManual();
    try {
      const fila = await c.env.DB.prepare(
        `INSERT INTO reserva (
           codigo, cliente_id, es_venta, estado, tipo_viaje, vehiculo_id, origen, destino,
           zona_origen_id, zona_destino_id, fecha_servicio, hora_servicio, fecha_regreso, hora_regreso,
           vuelo, vuelo_regreso, pasajeros, notas, monto, moneda, cupon_codigo, metodo_pago,
           estado_pago, idioma, duracion_min, fuente
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'manual')
         RETURNING id`,
      )
        .bind(
          codigo,
          cliente.id,
          esVenta ? 1 : 0,
          estado,
          d.tipo_viaje,
          d.vehiculo_id,
          d.origen,
          d.destino,
          d.zona_origen_id ?? null,
          d.zona_destino_id ?? null,
          d.fecha_servicio,
          d.hora_servicio,
          d.fecha_regreso ?? null,
          d.hora_regreso ?? null,
          d.vuelo ?? null,
          d.vuelo_regreso ?? null,
          d.pasajeros,
          d.notas ?? null,
          d.monto ?? 0,
          d.moneda ?? "USD",
          d.cupon_codigo ?? null,
          d.metodo_pago ?? null,
          estadoPago,
          idioma,
          d.duracion_min ?? null,
        )
        .first<{ id: number }>();

      await c.env.DB.prepare(
        "INSERT INTO reserva_evento (reserva_id, usuario_id, tipo, detalle) VALUES (?, ?, 'creada', ?)",
      )
        .bind(fila!.id, usuarioId, JSON.stringify({ fuente: "manual", codigo }))
        .run();

      return c.json({ status: "ok", id: fila!.id, codigo }, 201);
    } catch (e) {
      const msg = String(e);
      if (msg.includes("UNIQUE")) continue; // código repetido: probar otro
      if (msg.includes("FOREIGN KEY"))
        return c.json({ error: "Vehículo o zona inexistente" }, 400);
      throw e;
    }
  }
  return c.json(
    { error: "No se pudo generar un código único, intenta de nuevo" },
    500,
  );
});

// ── POST /reservas/sugerir-precio ────────────────────────────────────────
// Pregunta al worker de pagos (la única fuente de las tarifas) y devuelve el precio.
gestionRoutes.post("/sugerir-precio", requireAuth(), async (c) => {
  const b = await c.req
    .json<{
      zona_origen_id?: number;
      zona_destino_id?: number;
      vehiculo_id?: string;
      tipo_viaje?: string;
      paradas_ida?: number;
      paradas_regreso?: number;
      moneda?: string;
      cupon?: string;
    }>()
    .catch(() => null);
  if (!b) return c.json({ error: "JSON inválido" }, 400);

  const base = (c.env.PAYMENTS_WORKER_URL || "").replace(/\/+$/, "");
  if (!base)
    return c.json({ error: "PAYMENTS_WORKER_URL no está configurada" }, 503);

  const { results: zonas } = await c.env.DB.prepare(
    "SELECT id, nombre FROM zona WHERE id IN (?, ?)",
  )
    .bind(b.zona_origen_id ?? 0, b.zona_destino_id ?? 0)
    .all<{ id: number; nombre: string }>();
  const zOrigen = zonas.find((z) => z.id === b.zona_origen_id);
  const zDestino = zonas.find((z) => z.id === b.zona_destino_id);
  const veh = await c.env.DB.prepare("SELECT label FROM vehiculo WHERE id = ?")
    .bind(b.vehiculo_id ?? "")
    .first<{ label: string }>();

  if (!zOrigen || !zDestino)
    return c.json({ error: "Elige zona de origen y de destino" }, 400);
  if (!veh || b.vehiculo_id === "custom")
    return c.json(
      { error: "Elige un vehículo con tarifa (no personalizado)" },
      400,
    );

  try {
    const res = await fetch(`${base}/calculate-price`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        zonaOrigen: zOrigen.nombre,
        zonaDestino: zDestino.nombre,
        vehiculo: veh.label.toUpperCase(),
        tipo: b.tipo_viaje === "round_trip" ? "REDONDO" : "SENCILLO",
        currency: b.moneda ?? "USD",
        cupon: b.cupon ?? "",
        stops: b.paradas_ida ?? 0,
        stopsR: b.paradas_regreso ?? 0,
      }),
      signal: AbortSignal.timeout(8000),
    });
    const data = (await res.json().catch(() => ({}))) as {
      amount?: number;
      amountUSD?: number;
      currency?: string;
      error?: string;
    };
    if (!res.ok || typeof data.amount !== "number") {
      return c.json(
        {
          error: `El worker de precios respondió: ${data.error ?? res.status}`,
        },
        502,
      );
    }
    return c.json({
      monto: data.amount,
      moneda: data.currency,
      monto_usd: data.amountUSD,
    });
  } catch {
    return c.json({ error: "No se pudo consultar el worker de precios" }, 502);
  }
});

// ── GET /reservas/:id/eventos ────────────────────────────────────────────
gestionRoutes.get("/:id/eventos", requireAuth(), async (c) => {
  const id = parseInt(c.req.param("id"));
  if (!Number.isFinite(id)) return c.json({ error: "id inválido" }, 400);

  const { results } = await c.env.DB.prepare(
    `SELECT e.id, e.tipo, e.detalle, e.created_at, u.nombre AS usuario
     FROM reserva_evento e LEFT JOIN usuario u ON u.id = e.usuario_id
     WHERE e.reserva_id = ? ORDER BY e.id DESC LIMIT 100`,
  )
    .bind(id)
    .all<{
      id: number;
      tipo: string;
      detalle: string | null;
      created_at: string;
      usuario: string | null;
    }>();

  return c.json({
    eventos: results.map((e) => {
      let detalle: unknown = null;
      try {
        detalle = e.detalle ? JSON.parse(e.detalle) : null;
      } catch {
        /* queda null */
      }
      return { ...e, detalle };
    }),
  });
});

// ── PATCH /reservas/:id ─────────────────────────────────────────────────
// Edita cualquier campo de la lista blanca y deja constancia en el historial.
gestionRoutes.patch("/:id", requireAuth(), async (c) => {
  const id = parseInt(c.req.param("id"));
  if (!Number.isFinite(id)) return c.json({ error: "id inválido" }, 400);

  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body || typeof body !== "object")
    return c.json({ error: "JSON inválido" }, 400);

  const actual = await c.env.DB.prepare("SELECT * FROM reserva WHERE id = ?")
    .bind(id)
    .first<Record<string, unknown>>();
  if (!actual) return c.json({ error: "No encontrada" }, 404);

  const cambios: Record<string, { antes: unknown; despues: unknown }> = {};
  const sets: string[] = [];
  const params: unknown[] = [];

  for (const [campo, valor] of Object.entries(body)) {
    if (!tieneCampo(campo))
      return c.json({ error: `Campo no editable: ${campo}` }, 400);
    const r = CAMPOS[campo](valor);
    if (!r.ok) return c.json({ error: `${campo}: ${r.error}` }, 400);
    if (r.v === (actual[campo] ?? null)) continue; // no cambió
    cambios[campo] = { antes: actual[campo] ?? null, despues: r.v };
    sets.push(`${campo} = ?`);
    params.push(r.v);
  }

  if (!sets.length) return c.json({ status: "ok", cambios: 0 });

  // Confirmar o completar una reserva la vuelve venta.
  const nuevoEstado = cambios.estado?.despues;
  if (
    (nuevoEstado === "confirmada" || nuevoEstado === "completada") &&
    actual.es_venta !== 1
  ) {
    sets.push("es_venta = 1");
  }
  sets.push("updated_at = datetime('now')");

  const soloEstado = Object.keys(cambios).length === 1 && cambios.estado;
  try {
    await c.env.DB.batch([
      c.env.DB.prepare(
        `UPDATE reserva SET ${sets.join(", ")} WHERE id = ?`,
      ).bind(...params, id),
      c.env.DB.prepare(
        "INSERT INTO reserva_evento (reserva_id, usuario_id, tipo, detalle) VALUES (?, ?, ?, ?)",
      ).bind(
        id,
        c.get("usuario").id,
        soloEstado ? "estado" : "editada",
        JSON.stringify(cambios),
      ),
    ]);
  } catch (e) {
    if (String(e).includes("FOREIGN KEY"))
      return c.json({ error: "Vehículo o zona inexistente" }, 400);
    throw e;
  }
  return c.json({ status: "ok", cambios: Object.keys(cambios).length });
});
