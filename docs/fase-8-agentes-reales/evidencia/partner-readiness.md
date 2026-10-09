# Preparación para socios: evidencia (2026-10-09)

Lo que se comprobó después de mergear la auditoría del facilitator, el arreglo de `/api/live` (`P-18`) y el README nuevo
(PR #76 y #77). Solo lectura: no se cambió código ni configuración.

## 1. `/api/live` en vivo coincide con el README

Lectura de `https://agentpey.com/api/live` a las 2026-10-09 15:32 UTC, tres veces seguidas:

```json
{"purchases":26,"usdc":"52.7157903","disputes_open":0,"disputes_resolved":3,"refunded_usdc":"2.0842106"}
```

con 7 registros en `incomplete` y `/en-vivo` con el elemento `id="incomplete"` de la nota. La respuesta lleva
`cache-control: public, max-age=5` y `cf-cache-status: DYNAMIC` (`apps/web/src/server.ts`, ruta `/api/live`): no hay
caché largo que explique una lectura vieja. El README en `main` (`ecc09ae`) dice lo mismo.

Antes del arreglo (lectura del 2026-10-09 03:33 UTC):

```json
{"purchases":33,"usdc":"57.9283168","disputes_open":0,"disputes_resolved":2,"refunded_usdc":"1.5684211"}
```

La primera lectura con 26 compras fue justo después del merge del PR #76 (mergeado a las 14:03 UTC). No hay acceso a
Render por CLI ni API desde esta sesión, así que no se pudo ver el historial de deploys ni si `autoDeploy` está activo.

## 2. Las tres disputas, y de dónde sale cada cifra

| Orden | Estado | Reembolso (USDC) | Resuelta |
|---|---|---|---|
| `ord_mv0bfvfcf83e182ff5` | resuelta | 0,5157895 | 2026-10-09 08:04 UTC |
| `ord_muq1gqhycf4961492c` | resuelta | 1,5684211 | 2026-10-08 19:49 UTC |
| `ord_mupk7srw006dfebad8` | resuelta, reclamo rechazado | 0 | 2026-10-01 21:19 UTC |

1,5684211 + 0,5157895 = 2,0842106. La tercera (la del imán, la orden del ejemplo del README):

- Se abrió el 2026-10-09 04:35 UTC: [tx](https://stellar.expert/explorer/testnet/tx/ca1817d50eee3620ea75294a7b0fccd81853f5ce1ad495e22562e82b641c3dc5).
- Se resolvió con reembolso total a las 08:04 UTC: [tx](https://stellar.expert/explorer/testnet/tx/887db95740c5d7343a1b02f871eec946161f11e3374673e9ff3156e8cf5a18f6).
- `pnpm run resolve:verify -- --receipt 713447e843396dfed591b7b1554d9cc9c821ba5718d928b6411bde7ff5e9958a`:
  estado `Resolved`, en disputa 0,5157895 USDC, reembolso 0,5157895 USDC, veredicto de la red igual al archivado
  (`1f78a2b0a330c18d…`), garantía 2,9157894 USDC con 0 bloqueado.

## 3. Acceso al MCP

Sigue siendo solo la wallet dueña del rail:

- `apps/mcp/src/runtime.ts:60`: el MCP no arranca si `MCP_ALLOWED_WALLET` no es el principal del rail
  (`ConfigError`; prueba en `evidencia/T128.md`).
- La apertura a cualquier wallet no está en `SPEC.md`, `ESTADO.md`, las `DECISIONES` de la fase, el traspaso, ninguna
  rama ni los PR abiertos.
- Lo que dicen la landing (`landing.html`), `/tiendas` (`tiendas.html`) y los dos README coincide con el código: nada
  sugiere que un tercero conecte su propio Claude.
- Abrirlo implicaría decidir un rail por usuario o un rail compartido con topes por sesión: custodia y flujo de
  fondos (`P-10`), decisión del usuario.
