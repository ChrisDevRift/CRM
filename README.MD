# Luxury CRM

CRM interno de **Luxury Transfers Riviera** para administrar reservas y cotizaciones de traslados
(Cancún / Riviera Maya). Reemplaza poco a poco el flujo basado en Google Sheets + Apps Script.

> Para el mapa de archivos, el modelo de datos, las decisiones y lo pendiente, ver
> [`docs/ESTRUCTURA.md`](docs/ESTRUCTURA.md). Ese es el documento para retomar el proyecto en otro chat.

## Qué hace hoy

- **Recibe reservas y cotizaciones** del worker de pagos del sitio (`POST /reservas`) y las guarda en D1.
- **Panel web** (staff): lista y filtra reservas, detalle, crear a mano, editar, cambiar estado, historial de
  cambios, y precio sugerido consultando al worker de precios.
- **Clientes**: lista con búsqueda y totales, ficha con historial de reservas y edición.
- **Sesiones propias** con usuarios y contraseñas, límite de intentos de login y modo claro/oscuro.
- **Importador del Google Sheet** para cargar el histórico, y **sincronización de anclas** (lugares del sitio)
  para saber de qué landing viene cada reserva.

Todavía **no** hace: cupones, correos, comentarios de clientes, inventario (ver "Pendiente" en `docs/ESTRUCTURA.md`).

## Arquitectura

```
 Sitio (Astro, Cloudflare Pages)
        │  reserva / cotización
        ▼
 Worker de pagos  ───────────────►  Apps Script → Google Sheet + correos   (sigue funcionando en paralelo)
 (se edita desde el dashboard)
        │  service binding CRM_SERVICE  (POST /reservas, token de servicio)
        ▼
 ┌──────────────────────────┐        ┌───────────────────────────┐
 │ crm-api  (Worker, Hono)  │◄──────►│ Panel (Astro SSR, Pages)  │
 │ crm-api.<dominio>        │ cookie │ crm.<dominio>             │
 └───────────┬──────────────┘ sesión └───────────────────────────┘
             │
        Cloudflare D1  (crm-db)
```

- **API**: Cloudflare Worker con [Hono](https://hono.dev). Base de datos Cloudflare D1 (SQLite).
- **Panel**: Astro en modo servidor (`@astrojs/cloudflare`), desplegado en Cloudflare Pages. Los datos se piden
  desde el navegador a la API con la cookie de sesión.
- **Dominios**: `crm.` (panel) y `crm-api.` (API) deben colgar del **mismo dominio** (cookie compartida con
  `Domain=.tudominio`). Con `*.pages.dev` y `*.workers.dev` el login entre sitios distintos no funciona.

## Requisitos

- Node.js 18 o superior y npm.
- Una cuenta de Cloudflare con el dominio dentro.
- `wrangler` 3.x ya viene como dependencia (se usa con `npx wrangler`). **No lo actualices a 4** sin antes
  revisar `@astrojs/cloudflare` del panel: hoy exige wrangler 3 y chocan.

## Desarrollo local

Dos terminales, desde la raíz del repo (`npm install` una sola vez):

```powershell
# 1) API  → http://localhost:8787
cd api
npm run db:migrate:local                 # aplica las migraciones a la D1 local (.wrangler/state)
npm run create-admin -- "Tu Nombre" tucorreo@ejemplo.com admin     # pide la contraseña por teclado
npx wrangler d1 execute crm-db --local --file=crear-usuario.sql
Remove-Item crear-usuario.sql
npm run dev

# 2) Panel → http://localhost:4321   (abrir SIEMPRE con "localhost", no con 127.0.0.1)
cd panel
copy .env.example .env                   # PUBLIC_API_URL=http://localhost:8787
npm run dev
```

Archivos locales que **no** se suben a git:

| Archivo | Para qué |
|---|---|
| `api/.dev.vars` | `CRM_API_TOKEN=...` y valores locales que pisan a `wrangler.toml`: `COOKIE_DOMAIN=` (vacío) y `CORS_ORIGIN=http://localhost:4321` |
| `panel/.env` | `PUBLIC_API_URL=http://localhost:8787` |

La base local es **independiente** de la remota: lo que guarda el worker de pagos en línea no aparece en tu API local.

## Despliegue (producción)

Orden: base de datos → API → panel.

```powershell
cd api
npm run db:migrate:remote
npx wrangler secret put CRM_API_TOKEN          # una sola vez; el mismo valor va en el worker de pagos
npx wrangler deploy

cd ..\panel
$env:PUBLIC_API_URL = "https://crm-api.TU-DOMINIO"     # se incrusta al compilar
npm run build
npx wrangler pages deploy dist --project-name crm-panel
Remove-Item Env:PUBLIC_API_URL                          # ¡quitarla después! pisa al .env local
```

`api/wrangler.toml` guarda los valores de **producción** (`COOKIE_DOMAIN`, `CORS_ORIGIN`, `PAYMENTS_WORKER_URL`,
la ruta del dominio `crm-api.`). Variables y secretos:

| Dónde | Nombre | Qué es |
|---|---|---|
| API (secreto) | `CRM_API_TOKEN` | token con el que el worker de pagos y el importador llaman a `POST /reservas` |
| API (var) | `COOKIE_DOMAIN` | `.tudominio` en producción; vacío en local |
| API (var) | `CORS_ORIGIN` | origen(es) del panel permitidos, separados por coma |
| API (var) | `PAYMENTS_WORKER_URL` | URL del worker de pagos (para "Sugerir precio") |
| Panel (build) | `PUBLIC_API_URL` | URL de la API |
| Worker de pagos | `CRM_API_URL`, `CRM_API_TOKEN`, binding `CRM_SERVICE` → `crm-api` | ver `docs/ESTRUCTURA.md` |

## Operación

**Crear usuario o cambiar su contraseña** (si el correo existe, se actualiza):
```powershell
cd api
npm run create-admin -- "Nombre Apellido" correo@ejemplo.com admin     # o "agente"
npx wrangler d1 execute crm-db --remote --file=crear-usuario.sql
Remove-Item crear-usuario.sql
```

**Importar el histórico del Google Sheet**:
1. En cada pestaña del Sheet: Archivo → Descargar → *Valores separados por tabulaciones (.tsv)*.
2. Simulación y luego importación real (se puede repetir sin duplicar, actualiza por código):
```powershell
cd api
node scripts/import-sheet.mjs ..\hoja.tsv --dry-run
$env:CRM_API_URL = "https://crm-api.TU-DOMINIO"; $env:CRM_API_TOKEN = "EL-TOKEN"
node scripts/import-sheet.mjs ..\hoja.tsv
```

**Sincronizar las anclas** cada vez que crezca `src/data/zoneAnchors.json` del sitio:
```powershell
cd api
node scripts/sync-anclas.mjs RUTA\AL\zoneAnchors.json
npx wrangler d1 execute crm-db --remote --file=anclas.sql
Remove-Item anclas.sql
```

**Nueva migración**: crear `api/migrations/000N_nombre.sql`, probar con `npm run db:migrate:local`, y luego
`npm run db:migrate:remote`. Nunca editar una migración que ya se aplicó en remoto.

## Problemas conocidos (ya resueltos, por si reaparecen)

- **Login "rebota" a `/login`**: la cookie no se guardó. Revisa que `PUBLIC_API_URL` use `localhost` (no `127.0.0.1`),
  que `COOKIE_DOMAIN` esté vacío en local, y que en producción panel y API cuelguen del mismo dominio.
- **500 en `/auth/login` en producción, pero no en local**: Cloudflare limita PBKDF2 a 100,000 iteraciones;
  `api/src/lib/crypto.ts` y `api/scripts/create-admin.mjs` deben usar el mismo valor (100,000).
- **`error code: 1042` del worker de pagos al CRM**: un Worker no puede llamar a otro por URL pública dentro de la
  misma zona. Se resuelve con el service binding `CRM_SERVICE`.
- **Contraseña con `$` en PowerShell**: dentro de comillas dobles se interpreta como variable. Por eso
  `create-admin` pide la contraseña por teclado.
