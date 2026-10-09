# Auditoría del facilitator x402

Solo lectura, 2026-10-09. Rama `chore/partner-readiness`, sin cambios de código. Las referencias son `archivo:línea` del repo en esa fecha.

**Recomendación: cambio chico (< 1 día)**, con una condición: que el facilitator externo hable el mismo protocolo x402 v2 que el actual y soporte pagadores de contrato `C…` (el `policy_rail`). Si no, pasa a 1-2 días. Detalle en §4. Todavía no se probó contra StellarSight: **no hay ninguna referencia a StellarSight en el repo**, así que la compatibilidad se deduce del contrato genérico de x402, no de su documentación.

## 1. Dónde se configura el facilitator

Es **global por proceso**: ni por tienda ni por request.

- `packages/vitrinee-gateway/src/config.ts:39-41`: `FACILITATOR_URL` (default `OPENZEPPELIN_FACILITATOR_TESTNET`), `FACILITATOR_API_KEY` (opcional), `FACILITATOR_TIMEOUT_MS` (60 s).
- Valor por defecto: `packages/vitrinee-core/src/manifest.ts:13` = `https://channels.openzeppelin.com/x402/testnet`.
- El cliente se crea una vez en `packages/vitrinee-gateway/src/x402.ts:19-32` (`HTTPFacilitatorClient`); la llave va como `Authorization: Bearer`.
- En el modo multi-comercio, `packages/vitrinee-gateway/src/platform/storefronts.ts:31` lo define como entorno de la plataforma, sin valores por comercio.
- En producción: `render.yaml:233` (`VITRINEE_FACILITATOR_URL`) y `render.yaml:242` (`VITRINEE_FACILITATOR_API_KEY`, secreto). Mapeo de nombres en `apps/gateway/src/hosts.ts:165-166`.
- Se anuncia en el manifiesto (`packages/vitrinee-gateway/src/manifest.ts:62`) y en el perfil UCP (`src/ucp/profile.ts:45`), y queda registrado en `deployments/vitrinee-testnet.json`.
- Aparte: SignalDesk y `examples/reference-merchant` corren un facilitator **en el mismo proceso** (`apps/signaldesk/src/merchant.ts:25,366-368`), sin URL.

## 2. Esquema, red y activo

- Esquema **`exact`**: `packages/vitrinee-gateway/src/checkout.ts:314`, `src/ucp/checkout.ts:244-252`, fijado por el manifiesto (`packages/vitrinee-core/src/manifest.ts:80`) y registrado con `ExactStellarScheme` de `@x402/stellar` (`x402.ts:13,44`).
- Red **`stellar:testnet`** (`manifest.ts:12`).
- Activo: **USDC de Circle en testnet**, 7 decimales (`manifest.ts:16-21`). Emisor `GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5`, SAC `CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA`. El mismo SAC es el `asset` de `policy-rail` y `agent-resolve` en `deployments/testnet.json`.

## 3. Quién llama a `/verify` y `/settle`, y de quién es el facilitator

- Los llama **el servidor de la tienda** (el gateway de Vitrinee), no el agente ni el backend de AgentPey. El agente solo firma el pago con `@x402/stellar` y se lo manda a la tienda (`apps/agent/src/payment/x402.ts`, `packages/ucp-stellar/src/payers.ts`). `apps/gateway` es solo un proxy inverso.
- Checkout x402 REST: middleware que verifica y liquida **antes** del handler (`packages/vitrinee-gateway/src/app.ts:284`; hook `onAfterSettle` en `x402.ts:45-58`).
- Checkout UCP: `deps.x402.settlePayment` en `src/ucp/checkout.ts:596-600`. `/supported` se consulta al inicializar (`app.ts:233-238`); si no ofrece `stellar:testnet`, falla con "the facilitator offers no way to pay" (`ucp/checkout.ts:252`).
- El facilitator es **de un tercero**: OpenZeppelin, "Built on Stellar" Channels (`channels.openzeppelin.com/x402/testnet`, con API key). **No es código nuestro.**

## 4. Qué haría falta para liquidar con un facilitator externo (StellarSight)

El cliente ya es el estándar `HTTPFacilitatorClient` de `@x402/core` (2.26.0). Si StellarSight es compatible a nivel de protocolo, es **configuración**:

| Cambio | Dónde |
|---|---|
| `VITRINEE_FACILITATOR_URL` y, si aplica, `VITRINEE_FACILITATOR_API_KEY` | `render.yaml:233,242` |
| Ejemplo de entorno | `.env.vitrinee.example:39-42` |
| `facilitator.url` registrado | `deployments/vitrinee-testnet.json` |
| Si la autenticación no es `Bearer` | `x402.ts:24-30` (`createAuthHeaders`) |
| Tests que fijan la URL de OpenZeppelin | `scripts/vitrinee/lib/deployment.test.ts`, `manifest.test.ts`, tests de contrato UCP |

**Estimación:** 2-4 h si es compatible (cambiar configuración, correr 402 → pago → orden con un pagador `G…` y con el `policy_rail`, redesplegar). 1-2 días si hay que adaptar la autenticación, la forma de `/verify` o `/settle`, o el soporte de cuentas de contrato. Un facilitator **por tienda** (hoy no existe el gancho) sumaría ~1 día (`config.ts`, `x402.ts`, `platform/storefronts.ts`, manifiesto y perfil).

**Riesgos**
1. **Comisiones patrocinadas.** El facilitator actual reconstruye y patrocina el sobre sin cuenta fuente (`packages/ucp-stellar/src/payers.ts:220`); el tope de comisión es 50 000 stroops (`contracts/policy-rail/src/lib.rs:9,48`). El externo debe aceptar lo mismo, la forma `transfer` sola y las credenciales de dirección heredadas (`payers.ts:230`).
2. **Pagadores de contrato `C…`.** El `policy_rail` firma con `__check_auth`; un facilitator que solo maneje cuentas `G…` rompería ese flujo. Probarlo explícitamente.
3. **`/supported`** debe publicar `{x402Version: 2, scheme: "exact", network: "stellar:testnet"}` (y `extra.areFeesSponsored`); si no, no hay requisitos de pago (`ucp/checkout.ts:252`).
4. **`/settle`** debe devolver `success`, `transaction` (64 hex en minúscula), `payer` y `network`; `""` en `transaction` significa "no se emitió nada" (`ucp/checkout.ts:596-612`, `vitrinee-core/src/receipt.ts:27`).
5. **Versiones.** El gateway fija `@x402/*` 2.26.0 (`vitrinee-gateway/package.json:28-30`); `packages/ucp-stellar` usa `~2.24.0`.
6. **Confianza y disponibilidad.** Un tercero recibe el pago firmado. Ya se le quita la query string para que no le llegue el envío (`x402.ts:62-91`). Solo testnet.

## 5. ¿Dependen el anclaje de recibos o AgentResolve del formato de respuesta del facilitator?

**De forma débil**: solo del `transaction` y el `payer` de `/settle`, que son campos del `SettleResponse` estándar de x402 (`x402.ts:45-57`, `ucp/checkout.ts:596-612`). `payment_tx` **no** es un campo del facilitator: es el nombre en el recibo de SignalDesk (`apps/signaldesk/src/merchant.ts:291,320`), en la bóveda y en el feed en vivo (`apps/web/src/live-activity.ts`).

- El recibo guarda `settlementTxHash` y `payerAccount` (`packages/vitrinee-gateway/src/checkout.ts:365-369`). Si el facilitator no devuelve `payer`, se deduce del XDR de la transacción (`src/payer.ts`).
- El anclaje y la verificación (`packages/vitrinee-anchor/src/settlement.ts:27-70`) **no hablan con el facilitator**: leen la transacción en Horizon y exigen un `transfer` SEP-41 exitoso del pagador al comercio por el monto del recibo. Un facilitator distinto sirve si emite esa misma forma de transacción.
- AgentResolve (`packages/resolve/src/arbiter.ts:98`, `claim.ts:135-136`) usa del recibo firmado `payerAccount`, `amountUSDCAtomic` y `settlementTxHash`, y los comprueba en Horizon. No usa ningún campo del facilitator.

## 6. Tipos de cuenta

| Cuenta | Tipo | Referencia |
|---|---|---|
| Pagador `policy_rail` | **Contrato `C…`** (cuenta personalizada, `__check_auth` con una firma Ed25519) | `contracts/policy-rail/src/lib.rs:319`; `packages/ucp-stellar/src/payers.ts:188-260` exige `^C[A-Z2-7]{55}$` |
| Dueño y principal del rail | `owner` es una clave Ed25519 cruda (no una dirección); `principal` es una cuenta `G…` | `lib.rs:112-125`; `deployments/testnet.json` |
| Firma de las resoluciones de AgentResolve (el árbitro) | **Cuenta clásica `G…`**: `GAEB2EG3CSMEHLCYKHPPOMBRVISQOTBRS7T4K2D2EMNOA2AMUSJ32VV6` | `contracts/agent-resolve/src/lib.rs:90-95,246-248,294-296`; `deployments/testnet.json:53` |

Consecuencias para los socios:

- **Fermah** (solo acepta mandatos de cuentas `G…`): el pagador del `policy_rail` es `C…`, así que **no** puede ser el titular de un mandato de Fermah. Sí podría serlo la cuenta `G…` del principal o del árbitro.
- **Trustless Work** (el rol de resolutor de disputas es una dirección): el árbitro de AgentResolve es una `G…`, compatible. Pero el árbitro se fija en el constructor y **no se puede reasignar**: el contrato no tiene `set_arbiter` ni `upgrade`. Cambiar de resolutor exige un contrato nuevo y re-apuntar `AGENT_RESOLVE_CONTRACT_ID`.
- En AgentResolve, el reclamante de un pagador `C…` se resuelve al `owner()` del rail (`scripts/resolve.ts:148-155`, `claim.ts:136`).
