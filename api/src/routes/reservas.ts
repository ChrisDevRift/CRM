import { Hono } from "hono";
import type { Bindings } from "../types";
import { requireAuth, type UsuarioSesion } from "../lib/auth";
import { requireServiceToken } from "../lib/service-auth";
import { decodificarCodigo } from "../lib/codigo";
import {
  normalizarTipoViaje,
  normalizarVehiculo,
  cantidadVehiculos,
  normalizarMetodoPago,
  parsearMonto,
  normalizarFecha,
  normalizarHora,
  limpiarTelefono,
  textoTipoPersonalizado,
  registroAUtc,
} from "../lib/normalizacion";

export const reservasRoutes = new Hono<{
  Bindings: Bindings;
  Variables: { usuario: UsuarioSesion };
}>();

// ════════════════════════════════════════════════════════════════════════
//  POST /reservas — la llama worker.js / worker-test.js (token de servicio,
//  no sesión de usuario). Mismo payload que hoy le llega a Apps Script.
// ════════════════════════════════════════════════════════════════════════
reservasRoutes.post("/", requireServiceToken(), async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body) return c.json({ error: "JSON inválido" }, 400);

  const codigo = String(body.codigo ?? "").trim();
  const email = String(body.email ?? "")
    .trim()
    .toLowerCase();
  const nombre = String(body.nombre ?? "").trim();

  if (!codigo) return c.json({ error: "Falta codigo" }, 400);
  if (!nombre) return c.json({ error: "Falta nombre" }, 400);
  // El email es opcional: el worker registra ventas aunque venga vacío o mal
  // escrito (para no perder una reserva pagada).

  // find-or-create de cliente por email (política de dedup del MVP).
  // Si el cliente ya existía solo se completa el teléfono si llega uno; el nombre no se pisa.
  const telefono = limpiarTelefono(body.telefono);
  let clienteId: number | null = null;

  if (email) {
    const fila = await c.env.DB.prepare(
      `INSERT INTO cliente (nombre, email, telefono, idioma_preferido)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(email) DO UPDATE SET telefono = COALESCE(excluded.telefono, cliente.telefono)
       RETURNING id`,
    )
      .bind(nombre, email, telefono, body.idioma === "en" ? "en" : "es")
      .first<{ id: number }>();
    clienteId = fila?.id ?? null;
  } else {
    // Sin email no hay con qué deduplicar. Si esta reserva ya existía (el worker
    // puede reenviarla), se reutiliza su cliente en vez de crear uno huérfano nuevo.
    const previa = await c.env.DB.prepare(
      "SELECT cliente_id FROM reserva WHERE codigo = ?",
    )
      .bind(codigo)
      .first<{ cliente_id: number }>();
    if (previa) {
      clienteId = previa.cliente_id;
    } else {
      const fila = await c.env.DB.prepare(
        "INSERT INTO cliente (nombre, email, telefono, idioma_preferido) VALUES (?, NULL, ?, ?) RETURNING id",
      )
        .bind(nombre, telefono, body.idioma === "en" ? "en" : "es")
        .first<{ id: number }>();
      clienteId = fila?.id ?? null;
    }
  }

  if (clienteId === null)
    return c.json({ error: "No se pudo registrar el cliente" }, 500);

  const esVenta = body.esVenta === true || body.esVenta === "true";
  const tipoViaje = normalizarTipoViaje(body.tipoViaje);
  const vehiculoId = normalizarVehiculo(body.vehiculo);
  const metodoPago = normalizarMetodoPago(body.pago);
  const monto = parsearMonto(body.precioTotal) || parsearMonto(body.precio);

  // extraStop/extraStopR no tienen columna propia — se anotan en `notas`
  // para no perder el dato. Si más adelante hace falta reportar sobre esto
  // específicamente, ahí se justifica agregarles columnas.
  const notaExtras = [
    Number(body.extraStop) > 0
      ? `${body.extraStop} parada(s) extra (ida)`
      : null,
    Number(body.extraStopR) > 0
      ? `${body.extraStopR} parada(s) extra (regreso)`
      : null,
  ]
    .filter(Boolean)
    .join(" · ");
  // Si el worker tuvo que vaciar un email mal escrito, se conserva el original en notas.
  const notaEmail = body.emailOriginal
    ? `Email original (inválido): ${body.emailOriginal}`
    : "";
  // Con varios vehículos el sitio manda "34 × CLASSIC SEDAN": el tipo se normaliza arriba
  // y el texto completo queda en las notas para no perder la cantidad.
  const notaVehiculos =
    cantidadVehiculos(body.vehiculo) > 1 ? `Vehículos: ${body.vehiculo}` : "";
  // En cotizaciones a la medida el "tipo de viaje" es el tipo de evento (Boda, Grupo grande…).
  const tipoPersonalizado = textoTipoPersonalizado(body.tipoViaje);
  const notaTipo = tipoPersonalizado
    ? `Tipo de servicio: ${tipoPersonalizado}`
    : "";
  const notas =
    [body.notas, notaExtras, notaEmail, notaVehiculos, notaTipo]
      .filter(Boolean)
      .join(" — ") || null;

  // `estado`, `fuente` y `registradoEn` son opcionales y solo los manda el importador del Sheet.
  const ESTADOS = [
    "cotizacion_pendiente",
    "cotizacion_respondida",
    "confirmada",
    "completada",
    "cancelada",
  ];
  const FUENTES = ["web", "manual", "importada", "chatbot"];
  const estado = ESTADOS.includes(String(body.estado))
    ? String(body.estado)
    : esVenta
      ? "confirmada"
      : "cotizacion_pendiente";
  const estadoPago = esVenta ? "pagado" : "no_aplica";
  const fuente = FUENTES.includes(String(body.fuente))
    ? String(body.fuente)
    : codigo.toUpperCase().startsWith("CHAT-")
      ? "chatbot"
      : "web";
  const registradoEn = registroAUtc(body.registradoEn);

  // Upsert por código. El worker puede mandar la misma reserva varias veces
  // (navegador, webhook de Stripe, reintentos del cron), así que reenviar nunca
  // debe deshacer trabajo del staff:
  //  - una cotización que pasa a venta se actualiza (estado, monto, pago);
  //  - si el staff ya la movió a completada/cancelada, el estado NO retrocede;
  //  - una venta nunca se degrada a cotización;
  //  - origen, destino, notas, etc. no se pisan (el staff pudo editarlos).
  await c.env.DB.prepare(
    `INSERT INTO reserva (
       codigo, cliente_id, es_venta, estado, tipo_viaje, vehiculo_id,
       origen, destino, fecha_servicio, hora_servicio, fecha_regreso, hora_regreso,
       vuelo, vuelo_regreso, pasajeros, notas, monto, moneda, cupon_codigo,
       metodo_pago, estado_pago, referencia_pago_externa, idioma, fuente, created_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,COALESCE(?, datetime('now')))
     ON CONFLICT(codigo) DO UPDATE SET
       es_venta = MAX(reserva.es_venta, excluded.es_venta),
       estado = CASE
         WHEN reserva.estado IN ('cotizacion_pendiente','cotizacion_respondida')
         THEN excluded.estado ELSE reserva.estado END,
       monto = CASE
         WHEN excluded.es_venta = 1 OR reserva.es_venta = 0
         THEN excluded.monto ELSE reserva.monto END,
       metodo_pago = COALESCE(excluded.metodo_pago, reserva.metodo_pago),
       estado_pago = CASE
         WHEN excluded.estado_pago = 'pagado' THEN 'pagado' ELSE reserva.estado_pago END,
       referencia_pago_externa = COALESCE(excluded.referencia_pago_externa, reserva.referencia_pago_externa),
       updated_at = datetime('now')`,
  )
    .bind(
      codigo,
      clienteId,
      esVenta ? 1 : 0,
      estado,
      tipoViaje,
      vehiculoId,
      String(body.origen ?? ""),
      String(body.destino ?? ""),
      normalizarFecha(body.fecha),
      normalizarHora(body.hora),
      body.fechaRegreso ? normalizarFecha(body.fechaRegreso) : null,
      body.horaRegreso ? normalizarHora(body.horaRegreso) : null,
      body.vuelo || null,
      body.vueloRegreso || null,
      parseInt(String(body.pasajeros)) || 1,
      notas,
      monto,
      "USD",
      body.cupon || null,
      metodoPago,
      estadoPago,
      body.referenciaPagoExterna || null,
      body.idioma === "en" ? "en" : "es",
      fuente,
      registradoEn,
    )
    .run();

  // Si el código trae landing (LTR-XXXXXX-OODD), se guardan los ids de origen y destino y,
  // con la tabla `ancla`, también las zonas de precio (zona_origen_id / zona_destino_id).
  const ancla = decodificarCodigo(codigo);
  if (ancla) {
    await c.env.DB.prepare(
      `UPDATE reserva SET
         ancla_origen_id  = COALESCE(ancla_origen_id, ?1),
         ancla_destino_id = COALESCE(ancla_destino_id, ?2),
         zona_origen_id   = COALESCE(zona_origen_id, (SELECT zona_id FROM ancla WHERE id = ?1)),
         zona_destino_id  = COALESCE(zona_destino_id, (SELECT zona_id FROM ancla WHERE id = ?2))
       WHERE codigo = ?3`,
    )
      .bind(ancla.origenId, ancla.destinoId, codigo)
      .run();
  }

  return c.json({ status: "ok", codigo });
});

// ════════════════════════════════════════════════════════════════════════
//  GET /reservas — lista para el panel, con filtros básicos
// ════════════════════════════════════════════════════════════════════════
reservasRoutes.get("/", requireAuth(), async (c) => {
  const { estado, desde, hasta, q } = c.req.query();
  const limit = Math.min(parseInt(c.req.query("limit") ?? "50") || 50, 200);
  const offset = Math.max(parseInt(c.req.query("offset") ?? "0") || 0, 0);

  const condiciones: string[] = [];
  const params: unknown[] = [];

  if (estado) {
    condiciones.push("r.estado = ?");
    params.push(estado);
  }
  if (desde) {
    condiciones.push("r.fecha_servicio >= ?");
    params.push(desde);
  }
  if (hasta) {
    condiciones.push("r.fecha_servicio <= ?");
    params.push(hasta);
  }
  if (q) {
    condiciones.push("(r.codigo LIKE ? OR c.nombre LIKE ? OR c.email LIKE ?)");
    const like = `%${q}%`;
    params.push(like, like, like);
  }

  const where = condiciones.length ? `WHERE ${condiciones.join(" AND ")}` : "";

  const { results } = await c.env.DB.prepare(
    `SELECT r.id, r.codigo, r.estado, r.es_venta, r.tipo_viaje, r.vehiculo_id,
            r.origen, r.destino, r.fecha_servicio, r.hora_servicio,
            r.monto, r.moneda, r.estado_pago, r.created_at,
            c.nombre AS cliente_nombre, c.email AS cliente_email
     FROM reserva r
     JOIN cliente c ON c.id = r.cliente_id
     ${where}
     ORDER BY r.fecha_servicio DESC, r.id DESC
     LIMIT ? OFFSET ?`,
  )
    .bind(...params, limit, offset)
    .all();

  return c.json({ reservas: results });
});

// ════════════════════════════════════════════════════════════════════════
//  GET /reservas/:id — detalle completo
// ════════════════════════════════════════════════════════════════════════
reservasRoutes.get("/:id", requireAuth(), async (c) => {
  const id = parseInt(c.req.param("id"));
  if (!Number.isFinite(id)) return c.json({ error: "id inválido" }, 400);

  const reserva = await c.env.DB.prepare(
    `SELECT r.*, c.nombre AS cliente_nombre, c.email AS cliente_email, c.telefono AS cliente_telefono,
            ao.nombre AS ancla_origen_nombre, ad.nombre AS ancla_destino_nombre
     FROM reserva r
     JOIN cliente c ON c.id = r.cliente_id
     LEFT JOIN ancla ao ON ao.id = r.ancla_origen_id
     LEFT JOIN ancla ad ON ad.id = r.ancla_destino_id
     WHERE r.id = ?`,
  )
    .bind(id)
    .first();

  if (!reserva) return c.json({ error: "No encontrada" }, 404);
  return c.json({ reserva });
});

// ════════════════════════════════════════════════════════════════════════
//  PATCH /reservas/:id — cambiar estado o notas desde el panel
//  (MVP: solo estos dos campos; el resto se agrega si hace falta editar más)
// ════════════════════════════════════════════════════════════════════════
const ESTADOS_VALIDOS = [
  "cotizacion_pendiente",
  "cotizacion_respondida",
  "confirmada",
  "completada",
  "cancelada",
];
