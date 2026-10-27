// Lógica pura del formulario de reservas (sin DOM), para crear y editar.

export type Valores = Record<string, string>;

// Campos del formulario que viajan a la API con el mismo nombre.
export const CAMPOS_RESERVA = [
  'tipo_viaje', 'vehiculo_id', 'origen', 'destino', 'zona_origen_id', 'zona_destino_id',
  'fecha_servicio', 'hora_servicio', 'fecha_regreso', 'hora_regreso', 'vuelo', 'vuelo_regreso',
  'pasajeros', 'duracion_min', 'monto', 'moneda', 'metodo_pago', 'estado_pago',
  'cupon_codigo', 'estado', 'notas',
] as const;

const NUMERICOS = new Set(['zona_origen_id', 'zona_destino_id', 'pasajeros', 'duracion_min', 'monto']);
const SOLO_REDONDO = ['fecha_regreso', 'hora_regreso', 'vuelo_regreso'];

/** En un viaje que no es redondo, los campos de regreso se ignoran. */
export function normalizar(v: Valores): Valores {
  const n = { ...v };
  if (n.tipo_viaje !== 'round_trip') for (const c of SOLO_REDONDO) n[c] = '';
  return n;
}

function convertir(campo: string, valor: string): string | number {
  const t = valor.trim();
  return NUMERICOS.has(campo) && t !== '' ? Number(t) : t;
}

/** Edición: solo lo que cambió respecto a lo que se cargó (un vacío significa "borrar"). */
export function cambios(inicial: Valores, actual: Valores): Record<string, string | number> {
  const a = normalizar(actual);
  const i = normalizar(inicial);
  const out: Record<string, string | number> = {};
  for (const c of CAMPOS_RESERVA) {
    if ((a[c] ?? '').trim() !== (i[c] ?? '').trim()) out[c] = convertir(c, a[c] ?? '');
  }
  return out;
}

/** Creación: todo lo que se llenó; los vacíos no se mandan. */
export function datosNuevos(actual: Valores): Record<string, string | number> {
  const a = normalizar(actual);
  const out: Record<string, string | number> = {};
  for (const c of CAMPOS_RESERVA) {
    if ((a[c] ?? '').trim() !== '') out[c] = convertir(c, a[c]);
  }
  return out;
}