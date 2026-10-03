# Evidencia · Criterios de aceptación de la Fase 7

Fecha: 2026-10-02. Rama `cc/ordenar-casa`. Los tres primeros criterios de la
sección 6 del spec, con la evidencia de su tarea y una corrida nueva, de solo
lectura, hecha hoy. El cuarto (anexo entregado al chat de estrategia) es del
usuario.

## 1. Un cliente UCP lee el perfil de una tienda real y lista sus productos

En T121, con `bazar-cordillera` (Jumpseller): [evidencia/T121.md](T121.md).
Hoy, con `agentcommerce` (Shopify), la tienda de las compras de T122 y T124:

```
$ pnpm run vitrinee:ucp:list -- https://agentcommerce.vitrinee.agentpey.com
✓ UCP profile 2026-04-08 at https://agentcommerce.vitrinee.agentpey.com
✓ every spec and schema URL is on its namespace's domain
✓ REST endpoint https://agentcommerce.vitrinee.agentpey.com/ucp/v1
✓ pays with com.agentpey.stellar_x402: USDC on stellar:testnet, to GD2MCESI2DMMOU4F2SI6ZHDZDDCN5LA7PMKUVZSKTKVGU5RLTCNIK5GN

5 product(s):
  67624104591666                    1490 CLP  Imán de cobre Atacama
  67624245068082                    1990 CLP  Taza de greda Chiloé
  67624387576114                    2490 CLP  Marcapáginas de cuero Valdivia
  67624503640370                    2850 CLP  Llavero de madera Torres del Paine
  67661927612722                    1990 CLP  Set posavasos de cuero
```

## 2. Una compra UCP pagada en USDC testnet desde un `policy_rail`, con pedido real y recibo verificable

T122: tx `06ff47cf…`, pedido Shopify `18946533884210` visto por el usuario,
recibo con los tres checks ([evidencia/T122.md](T122.md) §2 y §3). La segunda
compra UCP (T124, pedido Shopify `18952373174578`), verificada hoy:

```
$ pnpm run vitrinee:verify -- .vitrinee/last-ucp-receipt.jws
  pedido       ord_muq1gqhycf4961492c · 1 × Imán de cobre Atacama · 1.5684211 USDC
  hash         0922707724bf818a258bd920076e273454ca0e47839319c63ecea55d1372e87b
  ✅ firma      Ed25519 de GAPCCUMMA4VY55DUH5KBQUQDBWVD52YEJ72XKDECTVYD7B4GKSZ25YVZ (did:stellar del merchant)
  ✅ anclaje    receipt-registry CADILO6QYG3CT2PXEWIKOYLUACPXEP4P645L5HF6WVI2K7BSVN23ZTM5 · ledger 4973216
  ✅ pago       tx de settlement confirmada en Stellar · ledger 4973214
  ✅ RECIBO VÁLIDO
```

## 3. La red rechaza un pago que excede `per_tx`

T122: dos imanes (3,14 USDC sobre un `per_tx` de 3,00) firmados directo contra
el `policy_rail`: `Error(Contract, #7)` = `PerTxExceeded`, desde `__check_auth`,
en simulación, sin enviar nada ([evidencia/T122.md](T122.md) §4). No se repite
hoy: el script arma una compra nueva.

## 4. El anexo técnico está entregado al chat de estrategia

Confirmado por el usuario el 2026-10-03, en el traspaso de la Fase 8: con
`ANEXO-SEP.md` se escribió, en el chat de estrategia, el borrador del SEP
"Agentic Commerce on Stellar" (documento del usuario en claude.ai, en inglés y
castellano). El borrador no está en el repo: exportarlo a
`docs/fase-8-agentes-reales/SEP-borrador.md` es un pendiente del usuario.

## Cierre de la fase (2026-10-03, rama `cc/fase7-cierre`)

Los criterios 1 y 2 se repitieron hoy, solo lectura, con el código de `main`
(`9049267`). El 3 no se repite: su script arma una compra nueva.

```
$ pnpm run vitrinee:ucp:list -- https://agentcommerce.vitrinee.agentpey.com
✓ UCP profile 2026-04-08 at https://agentcommerce.vitrinee.agentpey.com
✓ every spec and schema URL is on its namespace's domain
✓ REST endpoint https://agentcommerce.vitrinee.agentpey.com/ucp/v1
✓ pays with com.agentpey.stellar_x402: USDC on stellar:testnet, to GD2MCESI2DMMOU4F2SI6ZHDZDDCN5LA7PMKUVZSKTKVGU5RLTCNIK5GN

5 product(s):
  67624104591666                    1490 CLP  Imán de cobre Atacama
  67624245068082                    1990 CLP  Taza de greda Chiloé
  67624387576114                    2490 CLP  Marcapáginas de cuero Valdivia
  67624503640370                    2850 CLP  Llavero de madera Torres del Paine
  67661927612722                    1990 CLP  Set posavasos de cuero
```

```
$ pnpm run vitrinee:verify -- .vitrinee/last-ucp-receipt.jws
  recibo       .vitrinee/last-ucp-receipt.jws
  verificador  local: firma, Soroban RPC y Horizon, sin pasar por el gateway
  pedido       ord_muq1gqhycf4961492c · 1 × Imán de cobre Atacama · 1.5684211 USDC
  hash         0922707724bf818a258bd920076e273454ca0e47839319c63ecea55d1372e87b
  ✅ firma      Ed25519 de GAPCCUMMA4VY55DUH5KBQUQDBWVD52YEJ72XKDECTVYD7B4GKSZ25YVZ (did:stellar del merchant)
  ✅ anclaje    receipt-registry CADILO6QYG3CT2PXEWIKOYLUACPXEP4P645L5HF6WVI2K7BSVN23ZTM5 · ledger 4973216
  ✅ pago       tx de settlement confirmada en Stellar · ledger 4973214
  ✅ RECIBO VÁLIDO
```
