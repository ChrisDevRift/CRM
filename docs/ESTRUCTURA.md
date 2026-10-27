# Luxury CRM — estructura, decisiones y pendientes

Documento para **retomar el proyecto en otro chat**. Lo ideal es adjuntar este archivo y el `README.md`, decir
qué fase sigue y pegar solo los archivos que se vayan a tocar.

Estado: **Fases 1–8 terminadas** (API, auth, reservas, panel, crear/editar, rediseño, clientes, límite de login,
importador, anclas). La API y el panel están en línea y reciben reservas de prueba del worker de pagos.

---

## 1. Mapa de archivos

```
Luxury-CRM/
├── README.md                      cómo correrlo, desplegarlo y operarlo
├── docs/ESTRUCTURA.md             este archivo
├── package.json                   workspaces: api, panel
├── .gitignore                     node_modules, .wrangler, .astro, dist, .dev.vars, .env, crear-usuario.sql
│
├── api/                           Worker de Cloudflare (Hono) + D1
│   ├── wrangler.toml              config de PRODUCCIÓN: binding D1 "DB", vars, ruta crm-api.<dominio>
│   ├── package.json               scripts: dev, deploy, db:migrate:local|remote, create-admin, (sync-anclas, import-sheet)
│   ├── tsconfig.json
│   ├── .dev.vars                  (local, no se sube) token y overrides locales de COOKIE_DOMAIN / CORS_ORIGIN
│   ├── migrations/
│   │   ├── 0001_init.sql          zona(21), vehiculo(6), cliente, cupon, reserva, log_notificacion, usuario
│   │   ├── 0002_sesiones.sql      sesion
│   │   ├── 0003_reserva_vuelos.sql   reserva.vuelo, reserva.vuelo_regreso
│   │   ├── 0004_*.sql             ancla(id,nombre), reserva.ancla_origen_id/ancla_destino_id, reserva.fuente,
│   │   │                          reserva.duracion_min, reserva_evento (historial)
│   │   ├── 0005_login_throttle.sql   intento_login
│   │   └── 0006_anclas_detalle.sql   ancla.codigo/zona_id/tipo/nombre_en/lat/lng
│   ├── scripts/
│   │   ├── create-admin.mjs       crea usuario o cambia su contraseña (pide la contraseña por teclado) → crear-usuario.sql
│   │   ├── sync-anclas.mjs        zoneAnchors.json del sitio → anclas.sql (upsert por id)
│   │   └── import-sheet.mjs       TSV/CSV exportado del Google Sheet → POST /reservas (idempotente)
│   └── src/
│       ├── index.ts               app Hono: CORS con credenciales, GET / y /health, monta las rutas
│       ├── types.ts               tipo Bindings (DB, ENVIRONMENT, COOKIE_DOMAIN, CORS_ORIGIN, CRM_API_TOKEN, PAYMENTS_WORKER_URL)
│       ├── lib/
│       │   ├── crypto.ts          PBKDF2-SHA256 (100,000 iteraciones: tope de Workers) y tokens de sesión
│       │   ├── auth.ts            crear/cerrar sesión (cookie crm_session) y middleware requireAuth (renovación deslizante)
│       │   ├── service-auth.ts    middleware requireServiceToken (Authorization: Bearer CRM_API_TOKEN)
│       │   ├── throttle.ts        límite de intentos de login (5 por correo / 30 por IP → 15 min)
│       │   ├── codigo.ts          decodifica LTR-XXXXXX-OODD (ids de anclas) y genera códigos LTR-M… de reservas manuales
│       │   └── normalizacion.ts   payload "crudo" del worker → vocabulario del CRM (tipo de viaje, vehículo, pago,
│       │                          monto, fecha, hora 24 h, teléfono, tipo personalizado, registro→UTC)
│       └── routes/
│           ├── auth.ts            POST /auth/login | /auth/logout, GET /auth/me
│           ├── reservas.ts        POST /reservas (token de servicio, upsert por código), GET /reservas, GET /reservas/:id
│           ├── gestion.ts         POST /reservas/manual, POST /reservas/sugerir-precio, GET /reservas/:id/eventos,
│           │                      PATCH /reservas/:id (lista blanca + historial), GET /catalogos
│           └── clientes.ts        GET /clientes, GET /clientes/:id, PATCH /clientes/:id
│
└── panel/                         Astro SSR (adapter Cloudflare) → Pages. Todo el dato se pide desde el navegador.
    ├── astro.config.mjs           output: 'server'
    ├── .env.example               PUBLIC_API_URL
    └── src/
        ├── layouts/
        │   ├── Layout.astro       HTML base, tokens de diseño claro/oscuro, script anti-parpadeo del tema
        │   └── AppLayout.astro    shell: menú arriba o lateral (elegible), tema, sesión, estado de error con "Reintentar"
        ├── lib/
        │   ├── api.ts             API_URL (de PUBLIC_API_URL)
        │   ├── labels.ts          etiquetas legibles de enums + formatearMonto
        │   └── reservaForm.ts     lógica pura del formulario (diff de cambios, normalización)
        ├── components/
        │   └── ReservaForm.astro  formulario compartido crear/editar reserva (+ "Sugerir precio")
        └── pages/
            ├── index.astro        inicio (placeholder)
            ├── login.astro        login (maneja 401 / 429 / errores de servidor)
            ├── reservas/
            │   ├── index.astro    lista con filtros (estado, fechas, texto) y "Nueva reserva"
            │   ├── nueva.astro    crear a mano
            │   ├── [id].astro     detalle, cambio rápido de estado/notas, historial, enlace a la ficha del cliente
            │   └── [id]/editar.astro   editar todos los campos
            └── clientes/
                ├── index.astro    lista con búsqueda, nº de reservas, total USD, último servicio
                └── [id].astro     ficha: resumen, edición de datos, reservas del cliente
```

**Fuera del repo** (se mantienen a mano):
- **Worker de pagos** (y su copia de pruebas): código editado en el editor del dashboard de Cloudflare, sin `wrangler.toml`.
- **Apps Script / Google Sheet**: siguen guardando reservas y mandando los correos mientras no exista la Fase de correos.
- **Sitio** (repo LuxuryPage): `src/data/zoneAnchors.json` es la fuente de las anclas.

---

## 2. Modelo de datos (D1)

| Tabla | Qué guarda |
|---|---|
| `zona` | 21 zonas de precio (nombres EXACTOS del worker de precios). Catálogo fijo. |
| `vehiculo` | `sedan, van, luxVip, sprinter, familyVan, custom`. Catálogo fijo. |
| `cliente` | nombre, **email opcional y único** (dedupe por email), teléfono, idioma_preferido (es/en), notas_internas. |
| `reserva` | cotización **y** venta en una sola tabla (`es_venta`). Ver campos clave abajo. |
| `reserva_evento` | historial: quién (`usuario_id`, NULL = sistema), qué cambió (JSON antes/después), cuándo. |
| `ancla` | lugares del sitio: `id` (el que va dentro del código), `codigo`, `nombre` (es), `nombre_en`, `tipo` (zona/venue), `zona_id`→`zona`, `lat`, `lng`. |
| `usuario` / `sesion` | staff (rol `admin`/`agente`), sesiones con el HASH del token. |
| `intento_login` | contadores del límite de intentos por correo e IP. |
| `cupon`, `log_notificacion` | creadas pero **sin uso todavía** (fases de cupones y de correos). |

Campos clave de `reserva`: `codigo` (único), `estado` (`cotizacion_pendiente | cotizacion_respondida | confirmada |
completada | cancelada`), `tipo_viaje` (`one_way | round_trip | custom`), `vehiculo_id`, `fecha_servicio` (`AAAA-MM-DD`),
`hora_servicio` (`HH:MM` 24 h), `monto` + `moneda`, `metodo_pago`, `estado_pago`, `fuente` (`web | manual | importada | chatbot`),
`ancla_origen_id/ancla_destino_id` (decodificados del código), `zona_origen_id/zona_destino_id`, `duracion_min`, `created_at` (UTC).

### Código de reserva
- `LTR-XXXXXX` → reserva directa (sin landing). `LTR-XXXXXX-OODD` → con landing: `OO` = id de la ancla de origen y `DD` = id de la
  de destino, cada uno en 2 símbolos de base 32 con el alfabeto `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`
  (`id = pos(s1)*32 + pos(s2)`). Verificado contra códigos reales del sitio (`AGA2` = Akumal→Zona Arqueológica Xelhá).
- `CHAT-XXXXXX` → reservas del chatbot (`fuente = chatbot`). `LTR-M?????` → creadas a mano en el panel.
- Los ids de `zoneAnchors.json` **nunca se reasignan ni se reutilizan**.

---

## 3. Endpoints de la API

| Método y ruta | Auth | Qué hace |
|---|---|---|
| `GET /`, `GET /health` | pública | estado del Worker y de D1 |
| `POST /auth/login` | pública | correo+contraseña → cookie `crm_session` (429 si hay demasiados intentos) |
| `POST /auth/logout`, `GET /auth/me` | sesión | cierra sesión / usuario actual |
| `POST /reservas` | **token de servicio** | recibe del worker de pagos o del importador; **upsert por código** |
| `GET /reservas` | sesión | lista (`estado`, `desde`, `hasta`, `q`, `limit`, `offset`) |
| `GET /reservas/:id` | sesión | detalle + nombres de anclas |
| `PATCH /reservas/:id` | sesión | edita campos de la lista blanca y deja historial |
| `POST /reservas/manual` | sesión | crea una reserva a mano (código `LTR-M…`) |
| `POST /reservas/sugerir-precio` | sesión | pregunta el precio al worker de pagos (`/calculate-price`) |
| `GET /reservas/:id/eventos` | sesión | historial de la reserva |
| `GET /catalogos` | sesión | zonas, vehículos y estados para los formularios |
| `GET/PATCH /clientes[/:id]` | sesión | lista con totales / ficha / edición |

**Reglas del upsert de `POST /reservas`** (el worker reenvía la misma reserva por varios caminos):
una cotización que pasa a venta se actualiza; el estado **no retrocede** si el staff ya la movió; una venta nunca se degrada a
cotización; origen, destino y notas no se pisan; al cliente solo se le completa el teléfono (el nombre no se pisa).
Campos opcionales que solo manda el importador: `estado`, `fuente`, `registradoEn`.

**Contrato del payload** (lo que manda el worker de pagos; ver `normalizacion.ts`): `esVenta, codigo, nombre, telefono, email,
pasajeros, tipoViaje, origen, destino, fecha, hora, fechaRegreso, horaRegreso, vuelo, vehiculo, precio, precioTotal, totalExtras,
extraStop, extraStopR, pago, cupon, notas, idioma, emailOriginal`. El sitio manda la hora como `2:02 PM` o `12:00` y el
vehículo como `34 × CLASSIC SEDAN` cuando son varios; el CRM lo normaliza.

---

## 4. Integración con el worker de pagos

- El worker llama al CRM con `crmSync(env, body, …)` desde `/send-to-sheet` y desde el webhook de Stripe. Es **independiente
  de Apps Script**: si el CRM falla, Sheet y correos no se afectan.
- Si falla, queda en KV (`crm:<V|C>:<código>`) y el cron del worker reintenta (hasta 10 veces); si se agota o el CRM rechaza
  los datos (400), pasa a `crmfailed:*` y avisa por Telegram.
- Configuración en el dashboard del worker: variables `CRM_API_URL` y `CRM_API_TOKEN` (secreto) y el **service binding
  `CRM_SERVICE` → `crm-api`** (evita el `error code: 1042`). `_crmPost` usa el binding si existe y si no, la URL pública.
- El CRM llama al worker de pagos solo para `POST /reservas/sugerir-precio` (`PAYMENTS_WORKER_URL`); `crm-api` lleva la
  bandera `global_fetch_strictly_public`.

---

## 5. Decisiones de diseño (no rediseñar sin motivo)

- **Auth propia** con sesiones en D1 (no JWT): cookie `crm_session` HttpOnly, Secure, SameSite=Lax, `Domain=.dominio`, 7 días con
  renovación deslizante. Hash PBKDF2 **100,000** iteraciones (tope de Cloudflare en producción). Roles `admin/agente` existen
  pero **hoy ningún endpoint los distingue**.
- **Panel y API en subdominios hermanos** del mismo dominio; el navegador llama a la API con `credentials: 'include'`. CORS permite
  solo `CORS_ORIGIN`.
- **Token de servicio** para llamadas máquina a máquina (worker de pagos, importador, futuro bot de Telegram).
- **Tema claro/oscuro y posición del menú** se guardan en `localStorage` del navegador (`crm-theme`, `crm-nav`).
- **Una sola tabla `reserva`** para cotización y venta.
- **Entorno único por ahora**: una D1, se vaciará antes de producción real. Un entorno de staging separado se arma después del lanzamiento.
- **Zona horaria**: Cancún es UTC−5 fijo (sin horario de verano). `created_at` y demás marcas están en UTC; se muestran en `America/Cancun`.
- **Todo el texto que escribe el cliente se pinta con `textContent`** (nunca `innerHTML`): el nombre viene del formulario público.
- **Entrega del trabajo**: por fases, con el código pegable en el chat (cambios puntuales con su ubicación), probado antes de entregarlo.

---

## 6. Limitaciones conocidas

- **Dedupe de clientes solo por email**: la misma persona con dos correos son dos clientes; un mismo correo usado con nombres
  distintos queda con el primer nombre. No hay fusionar ni borrar clientes.
- **Varios vehículos**: `34 × CLASSIC SEDAN` se guarda como el tipo de vehículo y la cantidad queda en `notas`. Una mezcla
  (`2 × A + 1 × B`) cae en `custom` con el texto en `notas`. El modelo correcto es una tabla `reserva_vehiculo`.
- **Moneda**: la ingesta asume `USD` aunque el cliente pague en MXN/CAD.
- **Total por cliente** suma solo reservas vendidas, no canceladas, en USD.
- Cotizaciones sin fecha (chatbot) se guardan con fecha vacía: hay que completarla al editar.
- Pasajeros `?` se guardan como 1.
- Las horas/fechas que ya estaban en D1 con formato `2:02 PM` (reservas de prueba anteriores a la normalización) no se corrigen solas.
- Wrangler está en 3.x; el aviso de "desactualizado" es cosmético (subir a 4 choca con el adaptador de Astro).

---

## 7. Pendiente / siguientes fases

1. **Cupones** (siguiente). Decisión tomada: los administra el CRM en lugar de la variable `VALID_COUPONS` del worker. Cada cupón con
   dos listas: en qué páginas **aparece** y en cuáles se **acepta** (la clave de página sale de las anclas / landings). El worker
   consultaría al CRM con respaldo a la variable si el CRM no responde. Existe la tabla `cupon` sin uso. Requiere diseño previo.
2. **Correos (Resend) y comentarios verificados.** Al cortar Sheets/Apps Script, el CRM debe mandar los correos de confirmación
   (hoy los manda Apps Script) y registrarlos en `log_notificacion`. Comentarios: se pide **automáticamente al terminar el servicio**
   = duración estimada del trayecto + 1 h de margen (en redondo, desde el regreso), hora de Cancún; enlace único por reserva; solo
   quien tuvo una reserva completada puede comentar; aprobación en el CRM; salida en el formato del pool de reseñas del sitio
   (`zones[]`, `tags[]`, bilingüe). La duración se estima con `lat/lng` de las anclas (columna `reserva.duracion_min`, editable).
   **Excluir `fuente = 'importada'`** del envío automático para no escribirle a clientes de reservas históricas.
3. **Inventario** (comestibles para el plan Luxury, aún no disponible en el sitio): `producto`, `movimiento_inventario`,
   `reserva_item`; `reserva.monto` sigue siendo el total.
4. **Importar el Sheet real** con `import-sheet.mjs` (ya probado con datos de prueba) y vaciar la base de pruebas antes.
5. Fusionar/borrar clientes duplicados; filtros por zona, fuente y landing en la lista de reservas; paginación.
6. Aplicar roles (`admin` vs `agente`) en los endpoints; alta de usuarios desde el panel.
7. Bot de Telegram como cliente auxiliar de la misma API (con token de servicio); el CRM siempre tiene prioridad.
8. Modelo `reserva_vehiculo` para varios vehículos; moneda por reserva.
9. Staging separado después del lanzamiento; cuando el worker de producción se copie, agregar el binding `CRM_SERVICE`.

---

## 8. Cómo retomar en otro chat

1. Adjuntar `README.md` y este archivo.
2. Decir qué fase sigue (por ejemplo "Cupones") y que se trabaja **arquitectura primero, luego código pegable por fases**.
3. Pegar solo los archivos que se vayan a modificar (o pedirlos por ruta de este mapa).
4. Datos de ejemplo útiles: filas del Sheet, `zoneAnchors.json` y el código actual del worker de pagos.
