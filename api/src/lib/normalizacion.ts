// Normaliza los valores "crudos" que manda el worker de pagos (los mismos
// que hoy le llegan a Apps Script) al vocabulario limpio que usa el CRM.
// Esta es la única capa que necesita conocer el formato del payload viejo —
// si ese formato cambia algún día, el cambio se limita a este archivo.

/** ONE WAY/SENCILLO → one_way · ROUND TRIP/REDONDO → round_trip · resto → custom */
export function normalizarTipoViaje(
  raw: unknown,
): "one_way" | "round_trip" | "custom" {
  const v = String(raw ?? "")
    .trim()
    .toUpperCase();
  if (v === "ONE WAY" || v === "SENCILLO") return "one_way";
  if (v === "ROUND TRIP" || v === "REDONDO") return "round_trip";
  return "custom";
}

// Mismo mapeo que ya usa /calculate-price en worker.js — se mantiene igual
// a propósito para no introducir una segunda fuente de verdad.
const VEH_MAP: Record<string, string> = {
  "CLASSIC SEDAN": "sedan",
  "COMFORT VAN": "van",
  "LUXURY VIP": "luxVip",
  "GROUP VAN": "sprinter",
  "FAMILY VAN": "familyVan",
};

/** "34 × CLASSIC SEDAN" (varios vehículos) → cantidad 34 y texto "CLASSIC SEDAN". */
function separarCantidad(raw: unknown): { cantidad: number; texto: string } {
  const m = /^\s*(\d+)\s*[×xX]\s*(.+)$/.exec(String(raw ?? ""));
  return m
    ? { cantidad: Number(m[1]), texto: m[2] }
    : { cantidad: 1, texto: String(raw ?? "") };
}

/** Devuelve un id válido de la tabla `vehiculo`; si no matchea, 'custom'. */
export function normalizarVehiculo(raw: unknown): string {
  return VEH_MAP[separarCantidad(raw).texto.trim().toUpperCase()] || "custom";
}

/** Cuántos vehículos pidió la reserva (1 si el texto no trae "N × ..."). */
export function cantidadVehiculos(raw: unknown): number {
  return separarCantidad(raw).cantidad;
}
/** El texto libre de "pago" (ej. "Stripe Checkout ✅ Paid Online") → enum. */
export function normalizarMetodoPago(
  raw: unknown,
): "stripe" | "paypal" | "efectivo" | "transferencia" | null {
  const v = String(raw ?? "").toLowerCase();
  if (v.includes("stripe")) return "stripe";
  if (v.includes("paypal")) return "paypal";
  if (v.includes("efectivo") || v.includes("cash")) return "efectivo";
  if (v.includes("transferencia")) return "transferencia";
  return null;
}

/** "$281 USD", "281", 281 → 281. Nunca truena, peor caso devuelve 0. */
export function parsearMonto(raw: unknown): number {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  const match = String(raw ?? "").match(/[\d.]+/);
  return match ? parseFloat(match[0]) : 0;
}
/** "2026-10-24", "24/10/2026" o "4/10/2026" → "2026-10-24". Si no se entiende, devuelve el texto tal cual. */
export function normalizarFecha(raw: unknown): string {
  const t = String(raw ?? "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(t);
  return m ? `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}` : t;
}

/** "2:02 PM", "12:00 AM", "14:02" o "9:5" → "HH:MM" en 24 h. Si no se entiende, devuelve el texto tal cual. */
export function normalizarHora(raw: unknown): string {
  const t = String(raw ?? "").trim();
  const m = /^(\d{1,2}):(\d{1,2})(?::\d{2})?\s*([AaPp])?\.?[Mm]?\.?$/.exec(t);
  if (!m) return t;
  let h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  const sufijo = (m[3] ?? "").toUpperCase();
  if (sufijo === "P" && h < 12) h += 12;
  if (sufijo === "A" && h === 12) h = 0;
  if (h > 23 || min > 59) return t;
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

/** Quita basura como "undefined undefined" (el chatbot lo manda si falta el teléfono). */
export function limpiarTelefono(raw: unknown): string | null {
  const t = String(raw ?? "").trim();
  if (!t || /undefined|null|^[+\s]*$/i.test(t)) return null;
  return t;
}

/** Para cotizaciones a la medida el sitio manda el tipo de evento en lugar de ONE WAY/ROUND TRIP
 *  (ej. "Wedding / Event", "Traslado Grupo Grande"): se conserva ese texto para las notas. */
export function textoTipoPersonalizado(raw: unknown): string | null {
  const t = String(raw ?? "").trim();
  if (!t || normalizarTipoViaje(t) !== "custom" || /^custom service$/i.test(t))
    return null;
  return t;
}

/** Fecha y hora de registro de la hoja ("29/09/2026 15:41", hora de Cancún = UTC-5 fijo) → "YYYY-MM-DD HH:MM:SS" en UTC. */
export function registroAUtc(raw: unknown): string | null {
  const t = String(raw ?? "").trim();
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})[ T](\d{1,2}):(\d{2})/.exec(t);
  let ms: number;
  if (m) ms = Date.UTC(+m[3], +m[2] - 1, +m[1], +m[4] + 5, +m[5]);
  else if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(t))
    ms = Date.parse(
      t.replace(" ", "T") + (/[zZ]|[+-]\d{2}:?\d{2}$/.test(t) ? "" : "Z"),
    );
  else return null;
  return Number.isFinite(ms)
    ? new Date(ms).toISOString().slice(0, 19).replace("T", " ")
    : null;
}
