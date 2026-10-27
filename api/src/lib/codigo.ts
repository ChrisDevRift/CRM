// Código de reserva del sitio:  LTR-XXXXXX            (sin landing)
//                               LTR-XXXXXX-OODD       (con landing)
// OO y DD son los ids de origen y destino (anclas), cada uno en 2 símbolos de base 32,
// con el mismo alfabeto que usa generarCodigo() en el sitio. No es cifrado: es una
// búsqueda en la tabla `ancla`.

export const ALFABETO = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 32 símbolos, sin I, O, 0, 1

const S = '[ABCDEFGHJKLMNPQRSTUVWXYZ2-9]';
const RE_LANDING = new RegExp(`^LTR-${S}{6}-(${S}{2})(${S}{2})$`);

const decodificar = (par: string) => ALFABETO.indexOf(par[0]) * 32 + ALFABETO.indexOf(par[1]);

/** Devuelve los ids de origen y destino, o null si el código no trae landing. */
export function decodificarCodigo(codigo: string): { origenId: number; destinoId: number } | null {
  const m = RE_LANDING.exec(String(codigo).trim().toUpperCase());
  if (!m) return null;
  return { origenId: decodificar(m[1]), destinoId: decodificar(m[2]) };
}

/** id (0–1023) → 2 símbolos. Lo usa el CRM solo en pruebas; el sitio tiene su propia copia. */
export function codificarId(id: number): string {
  return ALFABETO[Math.floor(id / 32)] + ALFABETO[id % 32];
}

/** Código para reservas creadas a mano: LTR-M + 5 símbolos (10 caracteres, como los del sitio sin landing). */
export function generarCodigoManual(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(5));
  return 'LTR-M' + [...bytes].map((b) => ALFABETO[b % 32]).join('');
}