# Parche del worker — guardar reservas en el CRM

Cinco cambios en `worker.js` (el código único de pruebas/producción). Todos son **aditivos**: no se borra ni se cambia ninguna línea existente. Sin `CRM_API_URL` el worker se comporta exactamente igual que hoy.

**Variables nuevas** (Cloudflare → Worker → Settings → Variables y secretos):

| Variable | Tipo | Valor |
|---|---|---|
| `CRM_API_URL` | Texto | URL del API del CRM, ej. `https://crm-api.TU-SUBDOMINIO.workers.dev` |
| `CRM_API_TOKEN` | Secreto | El mismo token que pusiste en el CRM con `wrangler secret put CRM_API_TOKEN` |

---

## Cambio 1 — Constantes

Busca esta línea:

```js
const PAID_TTL      = 60 * 60 * 24 * 3;    // 3 días
```

y pega **justo debajo**:

```js
// ── CRM (Worker + D1) ──────────────────────────────────────────────
const CRM_TIMEOUT_MS         = 8000;           // por intento
const CRM_MAX_ATTEMPTS       = 10;             // ≈ 50 min de reintentos con el cron
const CRM_RETRY_MIN_GAP_MS   = 4 * 60 * 1000;  // el cron corre cada 5 min
const CRM_CRON_MAX_PER_TICK  = 5;
```

## Cambio 2 — Navegador (`handleSendToSheet`)

Busca:

```js
  // 2) Procesar en segundo plano (misma respuesta de siempre)
  ctx.waitUntil(procesarReserva(env, body, { source: 'browser' }));
```

y agrega **debajo** de la línea de `procesarReserva` (antes del `return _json(...)`):

```js
  // 3) Guardar también en el CRM (independiente de Apps Script)
  ctx.waitUntil(crmSync(env, body, { source: 'browser' }));
```

## Cambio 3 — Webhook de Stripe (`handleStripeWebhook`)

Busca:

```js
    _log('stripe_webhook_completed', { codigo: refId });
```

y agrega **debajo**:

```js
    // Respaldo hacia el CRM (el upsert por código evita duplicados con lo del navegador)
    ctx.waitUntil(crmSync(env, datosVenta, { source: 'stripe-webhook', refId }));
```

## Cambio 4 — Cron (`cronTick`)

Busca:

```js
  // 2) Conciliación de pagos PayPal (pagó pero no hay reserva registrada)
```

y agrega **justo arriba** de esa línea:

```js
  // 1b) Reintentos hacia el CRM
  await crmCronRetry(env, kv, now);

```

## Cambio 5 — Funciones del CRM

Pega este bloque completo **justo arriba** del comentario de sección que dice `CRON (cada 5 min): reintenta pendientes y concilia pagos de PayPal` (es decir, antes de `async function cronTick`):

```js
// ════════════════════════════════════════════════════════════════════
//  CRM — guarda cada reserva/cotización en la base de datos del CRM
//
//  Independiente de Apps Script: si el CRM falla no se afectan Sheet ni
//  correos, y viceversa. Si falla, queda en KV (crm:<V|C>:<código>) y el
//  cron reintenta. El CRM hace upsert por código, así que reenviar es seguro.
//  Variables: CRM_API_URL (sin "/" final) y CRM_API_TOKEN. Sin CRM_API_URL
//  todo esto se apaga solo.
// ════════════════════════════════════════════════════════════════════
async function _crmPost(env, body) {
  const t0 = Date.now();
  try {
    const res = await fetch(`${String(env.CRM_API_URL).replace(/\/+$/, '')}/reservas`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${env.CRM_API_TOKEN || ''}` },
      body: JSON.stringify(_noPdf(body)),          // sin PDF ni _token
      signal: AbortSignal.timeout(_envInt(env.CRM_TIMEOUT_MS, CRM_TIMEOUT_MS)),
    });
    const ms = Date.now() - t0;
    if (res.ok) return { ok: true, status: res.status, ms };
    const txt = (await res.text()).slice(0, 200);
    // 400 = el CRM rechazó los datos: reintentar igual no sirve.
    // 401/403 = token mal puesto: sí se reintenta, por si se corrige a tiempo.
    const retryable = res.status >= 500 || [401, 403, 408, 429].includes(res.status);
    return { ok: false, status: res.status, retryable, error: `HTTP ${res.status} — ${txt}`, ms };
  } catch (e) {
    const timedOut = !!e && (e.name === 'TimeoutError' || e.name === 'AbortError');
    return { ok: false, retryable: true, error: timedOut ? 'timeout' : `error de red: ${String(e).slice(0, 150)}`, ms: Date.now() - t0 };
  }
}

async function crmSync(env, body, opts = {}) {
  if (!env.CRM_API_URL) return 'disabled';
  const kv   = env.FAILED_BOOKINGS_KV;
  const tipo = _tipo(body);
  const id   = _code(body) || opts.refId || 'NOCODE';
  const key  = _k('crm', tipo, id);
  const prev = opts.pending || null;
  const attempts = (prev ? prev.attempts || 0 : 0) + 1;

  try {
    const r = await _crmPost(env, body);
    _log('crm_attempt', { codigo: id, tipo, source: opts.source, attempt: attempts, ok: r.ok, status: r.status, ms: r.ms, error: r.error });

    if (r.ok) {
      if (prev) {
        await _kvDelete(kv, key);
        if (prev.alerted) await _telegram(env, `🔁 CRM: ${_titulo(body)} ${id} ya quedó guardada en el CRM (intento ${attempts}).`);
      }
      return 'ok';
    }

    const authError = r.status === 401 || r.status === 403;
    if (authError) {
      await _alertOnce(env, 'alert:crm_auth', 3600,
        `🚨 El CRM rechazó el token del Worker (HTTP ${r.status}). Revisa que CRM_API_TOKEN sea igual en el Worker y en el CRM. ` +
        `Sheet y correos siguen funcionando; las reservas se reintentan solas hacia el CRM.`);
    }

    // Sin remedio (400) o se agotaron los intentos → queda en crmfailed:* para conciliar a mano
    if (!r.retryable || attempts >= CRM_MAX_ATTEMPTS) {
      await _kvPut(kv, `crmfailed:${Date.now()}:${id}`,
        { v: 2, at: Date.now(), tipo, source: opts.source, attempts, lastError: r.error, body: _noPdf(body) }, FAILED_TTL);
      if (prev) await _kvDelete(kv, key);
      await _telegram(env,
        `🚨 CRM: ${_titulo(body)} ${id} NO se pudo guardar en el CRM (${r.error}).\n` +
        `Sheet y correos no se afectan. Quedó en crmfailed:* para registrarla en el CRM a mano.`);
      return 'failed_final';
    }

    const guardada = await _kvPut(kv, key, {
      v: 2, at: prev ? prev.at : Date.now(), source: opts.source, tipo, attempts,
      lastError: r.error, lastTryAt: Date.now(), alerted: true, body: _noPdf(body),
    }, PENDING_TTL);
    if (!authError && !(prev && prev.alerted)) {
      await _telegram(env,
        `⚠️ CRM: ${_titulo(body)} ${id} no se guardó en el CRM (${r.error}).\n` +
        (guardada ? `Se reintenta sola cada ~5 min. Sheet y correos no se afectan.`
                  : `⚠️ Tampoco se pudo guardar en KV: regístrala en el CRM a mano.`));
    }
    return 'failed_retrying';

  } catch (e) {
    _log('crm_sync_exception', { codigo: id, tipo, error: String((e && e.stack) || e) });
    return 'exception';
  }
}

// Llamada desde cronTick: reintenta las que quedaron pendientes hacia el CRM
async function crmCronRetry(env, kv, now) {
  if (!env.CRM_API_URL) return;
  let n = 0;
  for (const name of await _listKeys(kv, 'crm:', 100)) {      // no coincide con "crmfailed:"
    if (n >= CRM_CRON_MAX_PER_TICK) break;
    const pend = await _kvGetJSON(kv, name);
    if (!pend || !pend.body) { await _kvDelete(kv, name); continue; }
    if (pend.lastTryAt && now - pend.lastTryAt < CRM_RETRY_MIN_GAP_MS) continue;
    n++;
    await crmSync(env, pend.body, { source: 'cron', pending: pend, refId: name.split(':').slice(2).join(':') });
  }
}
```

---

## Dónde ver qué pasó

- Telegram avisa si el CRM no recibe una reserva (`⚠️ CRM: ...`), si se recupera (`🔁 CRM: ...`) o si se rindió (`🚨 CRM: ...`).
- En KV (`FAILED_BOOKINGS_KV`): `crm:V:<código>` = pendiente de reintento · `crmfailed:<ts>:<código>` = no se pudo guardar tras reintentar (hay que conciliarla con el Sheet).
