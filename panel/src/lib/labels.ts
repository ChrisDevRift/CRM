// panel/src/lib/labels.ts
export const ESTADO_LABELS: Record<string, string> = {
  cotizacion_pendiente: 'Cotización pendiente',
  cotizacion_respondida: 'Cotización respondida',
  confirmada: 'Confirmada',
  completada: 'Completada',
  cancelada: 'Cancelada',
};

export const TIPO_VIAJE_LABELS: Record<string, string> = {
  one_way: 'Sencillo',
  round_trip: 'Redondo',
  custom: 'Personalizado',
};

// Mismas claves que la tabla `vehiculo` en D1 (api/migrations/0001_init.sql).
export const VEHICULO_LABELS: Record<string, string> = {
  sedan: 'Classic Sedan',
  van: 'Comfort Van',
  luxVip: 'Luxury VIP',
  sprinter: 'Group Van',
  familyVan: 'Family Van',
  custom: 'Servicio personalizado',
};

export const ESTADO_PAGO_LABELS: Record<string, string> = {
  no_aplica: 'No aplica',
  pendiente: 'Pendiente',
  pagado: 'Pagado',
  fallido: 'Fallido',
  reembolsado: 'Reembolsado',
};

export function formatearMonto(n: number, moneda: string): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: moneda || 'USD' }).format(n);
}

export const FUENTE_LABELS: Record<string, string> = {
  web: 'Sitio web',
  manual: 'Creada a mano',
  importada: 'Importada',
  chatbot: 'Chatbot',
};

// Nombres legibles de los campos, para mostrar el historial de cambios.
export const CAMPO_LABELS: Record<string, string> = {
  estado: 'Estado',
  tipo_viaje: 'Tipo de viaje',
  vehiculo_id: 'Vehículo',
  origen: 'Origen',
  destino: 'Destino',
  zona_origen_id: 'Zona de origen',
  zona_destino_id: 'Zona de destino',
  fecha_servicio: 'Fecha',
  hora_servicio: 'Hora',
  fecha_regreso: 'Fecha de regreso',
  hora_regreso: 'Hora de regreso',
  vuelo: 'Vuelo',
  vuelo_regreso: 'Vuelo de regreso',
  pasajeros: 'Pasajeros',
  notas: 'Notas',
  monto: 'Monto',
  moneda: 'Moneda',
  metodo_pago: 'Método de pago',
  estado_pago: 'Estado del pago',
  cupon_codigo: 'Cupón',
  duracion_min: 'Duración (min)',
};