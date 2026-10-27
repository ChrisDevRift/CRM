# CRM — Luxury Transfers Riviera — Documento de planeación técnica

Este documento existe para que un chat nuevo (enfocado 100% en construir el CRM) tenga
el contexto necesario sin tener que releer el código de `LuxuryPage` ni los workers.
No contiene código — es la especificación de datos y la arquitectura de integración.

---

## 1. Contexto: qué existe hoy

Tres sistemas independientes, sin una base de datos real detrás de ninguno:

| Sistema | Qué hace | Dónde vive |
|---|---|---|
| **LuxuryPage** (Astro) | Sitio público: landings SEO, calculadora de precios (`#quote`), formulario personalizado (`#custom`) | Repo `LuxuryPage`, Cloudflare Pages |
| **Worker de precios** | Regresa la matriz completa de tarifas por zona + polígonos GPS | `precios.luxurytransfersriviera.com.mx` |
| **Worker de pagos** | Cobra (Stripe/PayPal), valida cupones, calcula precio final, reenvía datos de la reserva | `WORKER_PAGOS_URL` (Cloudflare Worker) |
| **"CRM" actual** | Un Google Apps Script (`doPost`) que escribe una fila en Sheets y manda 2 correos (interno + cliente) | Google Apps Script, fuera de cualquier repo |

El CRM nuevo reemplaza esa última fila de la tabla — Sheets + Apps Script no son una base
de datos real, no tienen historial de estados, no permiten buscar un cliente por su
historial, y (lección reciente) nadie se entera si algo se rompe silenciosamente ahí.

### Flujo de datos hoy (sin CRM)

```
Cliente llena #quote o #custom
        │
        ▼
payment.js → iniciarEnvio(data)
        │
        ├─ Si es venta pagada: primero pasa por Stripe/PayPal
        │  vía WORKER_PAGOS_URL/process-payment (con priceToken firmado)
        │
        ▼
POST WORKER_PAGOS_URL/send-to-sheet  (mismo endpoint para venta Y cotización)
        │
        ▼
Google Apps Script (doPost) → Sheets + 2 correos (interno + cliente)
```

**El CRM debe insertarse en el mismo punto donde hoy está Apps Script** — `/send-to-sheet`
es el único lugar donde converge TODO (cotizaciones y ventas, con o sin voucher).

---

## 2. Diccionario de datos canónico

Estos son los nombres de campo que **ya existen** en producción (frontend + worker de
pagos). El CRM debe reusarlos tal cual, no traducirlos ni renombrarlos — evita una capa
de mapeo innecesaria y evita tener que tocar el frontend para que el CRM funcione.

### 2.1 Payload de reserva/cotización (lo que llega a `/send-to-sheet`)

| Campo | Tipo | Presente en | Notas |
|---|---|---|---|
| `esVenta` | boolean | siempre | `true` = venta confirmada y pagada. `false` = solo cotización (formulario Custom). **Es el campo que distingue todo el flujo.** |
| `codigo` | string | siempre | Referencia única, formato `LTR-XXXX`. Úsalo como identificador de negocio, no como PK técnico. |
| `nombre` | string | siempre | |
| `email` | string | siempre | |
| `telefono` | string | siempre | Número de WhatsApp/contacto |
| `pasajeros` | string/number | siempre | |
| `tipoViaje` | string | siempre | `"ONE WAY"` / `"ROUND TRIP"` / `"SENCILLO"` / `"REDONDO"` / `"Custom Service"` — valores no 100% normalizados hoy, el CRM debería normalizar esto a un enum limpio |
| `origen` | string | siempre | Texto libre (dirección) |
| `destino` | string | siempre | Texto libre (dirección) |
| `zona` | string | solo ventas con ruta fija | Una de las 21 zonas exactas (ver §2.3) — **no siempre presente**, las cotizaciones personalizadas no tienen zona fija |
| `zonaDestino` | string | solo ventas con ruta fija | Igual que `zona` |
| `fecha` | string (date) | siempre | |
| `hora` | string (time) | siempre | |
| `fechaRegreso` | string (date) | solo redondo | |
| `horaRegreso` | string (time) | solo redondo | |
| `notas` | string | siempre | |
| `itinerario` | string | solo custom | Detalle libre de itinerario para servicios personalizados |
| `vehiculo` | string | siempre | Ej. `"Luxury VIP"`, `"Custom Service"` |
| `precio` | string | siempre | String ya formateado, ej. `"$281 USD"` — **no es numérico**, el CRM debería parsear a `monto` + `moneda` por separado |
| `precioTotal` | string | solo ventas | Precio + extras, mismo problema de formato que `precio` |
| `tipo` | string | ventas | `"SENCILLO"` u otro — parcialmente redundante con `tipoViaje`, confirmar con el frontend antes de asumir cuál es la fuente de verdad |
| `pago` | string | ventas | Método + sufijo traducido concatenado (ej. `"Stripe (Paid Online)"`) — el CRM debería separar `metodoPago` (enum) de cualquier texto de UI |
| `extraStop` / `extraStopR` | — | ventas con parada extra | Parada de 20 min, ida/vuelta |
| `totalExtras` | string | ventas | |
| `cupon` | string | si aplica | Código de cupón usado, ya en mayúsculas |
| `idioma` | string | siempre | `"en"` / `"es"` |
| `pdfBase64` | string (base64) | **solo si `esVenta === true`** | El voucher, generado 100% en el navegador (jsPDF). Base64 puro, **sin** el prefijo `data:application/pdf;base64,`. Nombre de archivo convencional: `Voucher-<codigo>.pdf` |

### 2.2 Vehículos (tipos, usados en pricing y en el payload)

| key interno | Label | Capacidad |
|---|---|---|
| `sedan` | Classic Sedan | 1-3 pax |
| `van` | Comfort Van | 1-7 pax |
| `luxVip` | Luxury VIP | 1-5 pax |
| `sprinter` | Group Van | 1-13 pax |
| `familyVan` | Family Van | 1-10 pax |

### 2.3 Zonas válidas (`zona` / `zonaDestino`, y `originZone`/`destinationZone` en el
Content Collection de landings — mismo vocabulario en los dos sistemas)

```
AEROPUERTO CANCUN          AEROPUERTO TULUM
CENTRO DE CANCUN           ZONA HOTELERA DE CANCUN
PLAYA MUJERES               COSTA MUJERES
PUERTO JUAREZ               PUERTO MORELOS
PLAYA PARAISO                PLAYA DEL CARMEN
PUERTO AVENTURAS             AKUMAL
CENTRO DE TULUM              ZONA HOTELERA DE TULUM
FELIPE CARRILLO PUERTO       HOLBOX
MAHAHUAL                     BACALAR
CHETUMAL                     VALLADOLID
MERIDA
```

⚠️ Ya nos costó un bug de confusión de zonas — **nunca adivines el nombre por lógica**
("Tulum" puede ser `CENTRO DE TULUM` o `ZONA HOTELERA DE TULUM`, con precios distintos).
Si el CRM permite crear reservas manuales, reusa el worker de precios para resolver la
zona, no una lista aparte.

### 2.4 Cupones

- Hoy viven en una variable de entorno del worker (`VALID_COUPONS`), un JSON plano
  `{ "CODIGO": porcentaje }`.
- Se validan **dos veces, por separado**: una vez para mostrar el precio en pantalla
  (`/validate-coupon`), y otra vez de forma independiente al momento de cobrar
  (`/calculate-price`, que genera un `priceToken` firmado con `PRICE_SECRET` — el monto
  cobrado sale de ese token, no de lo que mande el navegador). **Esto es una propiedad
  de seguridad real, no un detalle cosmético — si el CRM va a administrar cupones, tiene
  que preservar este patrón** (servidor revalida, nunca confía en el descuento que
  reporta el cliente).
- Rango válido: porcentaje entre 0 (exclusivo) y 100 (inclusivo).

### 2.5 Pagos (Stripe / PayPal)

- `session_id` — nombre exacto del query param que lee `thank-you.js` al volver de
  Stripe. El worker sustituye el placeholder literal `{CHECKOUT_SESSION_ID}` en el
  `successUrl` por el ID real de sesión (comportamiento nativo de Stripe; en modo prueba
  hay que replicarlo a mano — ya se corrigió un bug de esto).
- PayPal usa su propio flujo de order/capture, distinto al de Stripe — no asumas que
  comparten estructura de ID.
- El worker rechaza cualquier `STRIPE_SECRET_KEY` que empiece con `sk_live_` salvo que
  se confirme explícitamente — un patrón de seguridad que vale la pena preservar si el
  CRM también va a tocar credenciales de pago.

---

## 3. Modelo de datos propuesto para el CRM

Nombrado en español, consistente con el resto del proyecto. Esto es una propuesta de
punto de partida — el chat de CRM puede ajustarlo, pero que parta de aquí en vez de
inventar nombres nuevos.

### `Cliente`
`id`, `nombre`, `email`, `telefono`, `idioma_preferido`, `notas_internas`, `fecha_alta`

*Relación: un cliente puede tener muchas `Reserva`. Se identifica por email/teléfono —
definir política de deduplicación (mismo email = mismo cliente) en el chat de CRM.*

### `Reserva` (unifica cotización y venta — mismo patrón `es_venta` que ya existe)
`id`, `codigo`, `cliente_id` (FK), `es_venta` (bool), `estado` (enum — propuesto:
`cotizacion_pendiente` → `cotizacion_respondida` → `confirmada` → `completada` /
`cancelada`), `tipo_viaje`, `vehiculo`, `origen`, `destino`, `zona_origen`,
`zona_destino`, `fecha_servicio`, `hora_servicio`, `fecha_regreso`, `hora_regreso`,
`pasajeros`, `notas`, `itinerario`, `monto` (numérico, separado de moneda — no el string
`precio` tal cual), `moneda`, `cupon_codigo`, `descuento_pct`, `metodo_pago` (enum
limpio, no el string concatenado `pago`), `estado_pago`, `referencia_pago_externa`
(session_id de Stripe / order id de PayPal), `voucher_pdf` (blob o referencia a
storage), `idioma`, `created_at`, `updated_at`

### `Cupon` (reemplaza la variable de entorno `VALID_COUPONS`)
`id`, `codigo`, `descuento_pct`, `activo`, `fecha_inicio`, `fecha_fin`,
`usos_maximos`, `usos_actuales`

*Si el CRM administra esto, el worker de pagos necesita leer de aquí en vez de su env
var — es una decisión de arquitectura real, ver §5.*

### `LogNotificacion` — tu idea del voucher, llevada un paso más allá
`id`, `reserva_id` (FK), `tipo` (`confirmacion_interna` / `confirmacion_cliente` /
`cotizacion`), `destinatario`, `incluyo_voucher` (bool), `fecha_envio`, `estado`
(`enviado`/`fallido`), `proveedor_error` (texto, si falló)

*Esto es exactamente lo que nos hubiera ahorrado la sesión de debugging del Apps
Script equivocado — un registro de "qué se mandó, a quién, con qué adjunto" hace que un
correo sin voucher sea evidente al instante, en vez de descubrirse por casualidad
revisando una bandeja de entrada.*

### `Usuario` (staff del CRM)
`id`, `nombre`, `email`, `rol` (`admin` / `agente`), credenciales (definir estrategia de
auth en el chat de CRM — no se decide aquí)

---

## 4. Sobre guardar el voucher (tu pregunta)

Sí, vale la pena — y no solo por conveniencia. Hoy el voucher **no existe en ningún
lado después de enviarse** — se genera en el navegador del cliente en el momento del
pago y se manda por correo; si ese correo se pierde, se va a spam, o (como ya vimos)
el script de destino no lo adjunta, no hay forma de recuperarlo sin que el cliente
vuelva a pasar por el flujo de pago. Guardarlo en `Reserva.voucher_pdf` permite:
- Reenviarlo manualmente desde el CRM sin pedirle al cliente que pague de nuevo.
- Auditar si el envío original sí lo llevó adjunto (vía `LogNotificacion`).
- Generarlo de nuevo del lado del servidor si el original nunca se generó bien.

---

## 5. Decisiones de arquitectura que quedan abiertas (a resolver en el chat de CRM, no aquí)

- **¿El worker de pagos se modifica para escribir directo a la base de datos del CRM**
  (reemplazando `/send-to-sheet` → Apps Script), **o el CRM corre en paralelo con Sheets**
  por un tiempo de transición? Afecta cuánto hay que tocar del worker existente.
- **Base de datos**: dado que todo ya vive en Cloudflare (Pages + Workers), Cloudflare D1
  es un candidato natural por cercanía de infraestructura — pero no es la única opción
  razonable, vale la pena evaluarlo con criterios propios del chat de CRM.
- **¿Quién administra los cupones?** Si pasa a vivir en el CRM (`Cupon`), el worker de
  pagos necesita consultar esa fuente en vez de su variable de entorno — cambia el
  patrón de "worker autónomo" a "worker que depende del CRM para esto en particular".
  Alternativa: el CRM sigue escribiendo la variable de entorno del worker en cada
  cambio (más simple, pero menos "tiempo real").
- **Autenticación de staff**: no se definió aquí a propósito — depende de cuántas
  personas, si necesitan roles distintos, y si ya usan algún proveedor de auth en otro
  lado del negocio.
- **Deduplicación de clientes**: incluida en §3, es una función real de un CRM y merece
  discutirse aparte (¿un cliente que reserva 3 veces con el mismo email es UN cliente
  con 3 reservas, o hay riesgo de que use emails distintos?).

## 5.1 Decisiones de arquitectura — resueltas

Esto cierra los puntos que quedaron abiertos en la §5. Decidido antes de escribir
código, para no rediseñar sobre la marcha.

### Stack

| Pieza | Decisión | Por qué |
|---|---|---|
| **Base de datos** | Cloudflare D1 (SQLite) | Cercanía de infraestructura — mismo `wrangler`, bindings directos desde Workers, sin credenciales externas que manejar |
| **Storage de vouchers** | Cloudflare R2 | Los PDFs no van como blob en D1; R2 es para esto, gratis hasta 10GB/mes |
| **API del CRM** | Worker nuevo (Hono), separado del worker de pagos | El worker de pagos sigue enfocado solo en cobrar — no se acopla al CRM |
| **Panel staff (frontend)** | Astro en modo SSR (adapter Cloudflare), repo nuevo | Reutiliza el conocimiento y el patrón de deploy ya establecido con LuxuryPage; islands para las partes interactivas (tabla de reservas, filtros, edición de estado) |
| **Auth de staff** | Propio — usuarios/contraseñas en D1, hasheadas, roles `admin`/`agente`, opción de restringir por dominio de correo de la empresa | Más control que Cloudflare Access; necesario para poder crear/limitar usuarios manualmente |
| **Correos transaccionales** (cuando el CRM tome esta responsabilidad) | Resend | SDK nativo para Workers, soporta adjuntos (voucher PDF), tier gratuito de 3,000/mes, API tipo `fetch` — sin la fricción de SMTP vía Gmail/Workspace desde el edge |
| **Repo** | Nuevo, separado de `LuxuryPage` | El CRM es una herramienta interna distinta al sitio público; menos blast radius por cambio |

### Integración con el worker de pagos

Cambio mínimo: el `POST` que hoy va a `/send-to-sheet` (Apps Script) cambia de destino
al nuevo endpoint del CRM (`crm-api.../reservas`). El worker de pagos no cambia su
lógica ni el payload — sigue mandando el mismo JSON que arma hoy (§2.1). La
normalización (`esVenta`→`es_venta`, parseo de `precio` a `monto`+`moneda`, etc.) vive
del lado del CRM API, no en el worker de pagos.

**Transición**: durante las primeras 1-2 semanas, el worker manda a **ambos** destinos
(CRM y Sheets) — una llamada `fetch` extra, sin rediseño — como red de seguridad
mientras se valida que el CRM captura todo correctamente. Después se retira la llamada
a Sheets.

### Correos — por qué no es un detalle menor

Apps Script hoy hace dos cosas, no una: guarda la fila **y** manda los 2 correos
(interno + cliente, con voucher adjunto). Quitar Sheets sin resolver esto corta el
canal de notificación completo, no solo el respaldo de datos.

- **Durante la transición** (doble envío activo): Apps Script sigue mandando los
  correos como hoy. El CRM solo guarda datos en paralelo — no toca email todavía. Cero
  riesgo de correos duplicados o perdidos mientras se valida el CRM.
- **En el corte final** (se retira Sheets): el CRM toma el envío de correos vía Resend,
  y cada envío se registra en `LogNotificacion` (ya estaba en el modelo de §3) — con
  esto un correo sin voucher, o un envío fallido, es evidente al instante en vez de
  descubrirse por casualidad.

### Telegram (auxiliar, fuera de alcance del MVP)

Está en el radar un bot de Telegram para consultar/administrar reservas cuando no se
pueda acceder al panel — de forma auxiliar, el CRM siempre tiene prioridad. No requiere
diseño especial ahora: como el CRM ya expone una API propia (el Worker de la sección
anterior), el bot de Telegram se vuelve simplemente *otro cliente* que llama a esa
misma API. Lo único a tener en cuenta desde ya: la API no debe asumir que solo el panel
web la consume — auth por token de servicio como alternativa a las cookies de sesión,
para no tener que rediseñar la capa de auth cuando llegue ese chat.

---

## 6. Alcance sugerido (MVP vs. después)

**MVP (lo mínimo para reemplazar Sheets+Apps Script de forma útil):**
Cliente, Reserva (con `es_venta`, `estado`, voucher guardado), vista de lista/búsqueda,
creación manual de reserva por staff (reusando el worker de precios para la zona/tarifa).

**Después:**
Cupon administrado desde el CRM, LogNotificacion completo, reportes/dashboard
(ingresos, rutas más pedidas — hay sinergia directa con `zona`/`zonaDestino`, que ya es
el mismo vocabulario que usan las landing pages de SEO), roles de usuario, asignación de
chofer/vehículo si el negocio lo pide más adelante.
