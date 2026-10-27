export type Bindings = {
  DB: D1Database;
  ENVIRONMENT: string;
  /**
   * Dominio para la cookie de sesión, ej. ".luxurytransfersriviera.com.mx"
   * — así la cookie sirve tanto para el panel (crm.) como para el API
   * (crm-api.) sin problemas de cross-site. En local/dev déjalo vacío para
   * que la cookie sea host-only (funciona con localhost).
   */
  COOKIE_DOMAIN: string;
  /**
   * Origen(es) del panel permitidos para CORS con credenciales, separados
   * por coma. En dev: "http://localhost:4321". En producción, el dominio
   * real del panel una vez que exista (Fase 4/5).
   */
  CORS_ORIGIN: string;
  /**
   * Token de servicio — lo usa worker.js/worker-test.js para autenticar
   * POST /reservas (no es una sesión de usuario). Se define con
   * `wrangler secret put CRM_API_TOKEN`, nunca en wrangler.toml en texto plano.
   */
  CRM_API_TOKEN: string;
  /** URL del worker de pagos (sin "/" final). El CRM le pide los precios sugeridos. */
  PAYMENTS_WORKER_URL: string;
};
