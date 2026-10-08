# Evidencia · Reembolso real de T124 y disputa en la orden (T127) — 2026-10-08

Pendiente con fecha de la Fase 7 (`E-25`), hecho con AgentResolve tal como está en `main` y el árbitro abriendo la
disputa a mano. Compra: `ord_muq1gqhycf4961492c`, Imán de cobre Atacama, 1,5684211 USDC, pagado el 1-oct desde el
rail UCP `CA6P4K…`; recibo `0922707724bf…`; pedido Shopify **#1006** (ID `18952373174578`).

## 1. El pedido, en el panel de Shopify (8-oct)

Revisado en el admin de la tienda: **#1006, Pagado, Sin preparar (Unfulfilled)**, sin despacho ni aviso. Todos los
pedidos de la tienda dicen "Shipping not required" por cómo están configurados los productos; se aclaró en la
evidencia del reclamo.

## 2. Reclamo y disputa abierta (`resolve:open`)

```
AgentResolve · abrir un reclamo · testnet

[comprador] firma el reclamo
  recibo         0922707724bf818a258bd920076e273454ca0e47839319c63ecea55d1372e87b
  pedido         shopify 18952373174578
  reclamo        374b7b91-0b69-4f96-81f5-cb2cc6f4be0b (not_delivered)
  pide           1.5684211 USDC
  firmante       did:stellar:testnet:GAK6E5E7L63ZYFZZZFXDTYVG6MVAKILSHI5FITGH5U4ORACEZQ4GFP2K

[árbitro] verifica y abre la disputa en el contrato
  ✅ recibo       firma del comercio, anclado en receipt-registry, pago confirmado en Horizon
  ✅ firmante     controla al pagador CA6P4KKV77Q5J4AH6L4V7S42QNF6DLKUAM4SCOQO4GMLB7V7STC5VIYP
  ✅ plazo        hasta 2026-10-11T21:21:02.961Z
  tx             https://stellar.expert/explorer/testnet/tx/006e17d82e4700615ec29406efe8a6011f4e73163511c7d5a8ddb4ae4a9c269e
  disputa        Open, 1.5684211 USDC bloqueados en la garantía de GAPCCUMMA4VY55DUH5KBQUQDBWVD52YEJ72XKDECTVYD7B4GKSZ25YVZ
  garantía       3.0000000 USDC (bloqueado 1.5684211 USDC)

[comercio] tiene 48 h para responder (E-22)
  enviarle       <repo>/.vitrinee/agentresolve/0922707724bf818a258bd920076e273454ca0e47839319c63ecea55d1372e87b/claim.jws
  responde en    https://agentpey.com/resolve/responder
  firma          con Freighter, desde la cuenta de cobro del recibo GD2MCESI2DMMOU4F2SI6ZHDZDDCN5LA7PMKUVZSKTKVGU5RLTCNIK5GN
  plazo          2026-10-10T19:32:27.000Z

Con su respuesta: pnpm run resolve:decide -- --receipt 0922707724bf818a258bd920076e273454ca0e47839319c63ecea55d1372e87b --response <archivo>
Sin respuesta, después del plazo: pnpm run resolve:decide -- --receipt 0922707724bf818a258bd920076e273454ca0e47839319c63ecea55d1372e87b
```

La orden mostró la disputa pendiente enseguida: ajuste UCP `dispute` en `pending` y `receipt.dispute.status` `open`.

## 3. Respuesta del comercio (`/resolve/responder`, firmada por el usuario con la cuenta de cobro)

```
AgentResolve · verificar la respuesta de un comercio · testnet
  ✅ firma        SEP-53 de GD2MCESI2DMMOU4F2SI6ZHDZDDCN5LA7PMKUVZSKTKVGU5RLTCNIK5GN, la cuenta de cobro del recibo
  ✅ disputa      responde al reclamo b48e47ee732d4d21… que está en la red (Open)
  posición       accept_full
  descargos      Confirmo que el pedido #1006 no se preparó ni despachó. Acepto devolver el monto completo.
  hash           1a2fc2160d50d0fbe99a575e88d7f64c13cb418ae3e9ddfada343d59b0296d29
```

## 4. Veredicto (`resolve:decide`)

```
AgentResolve · veredicto · testnet
  ✅ respuesta    accept_full, firmada por GD2MCESI2DMMOU4F2SI6ZHDZDDCN5LA7PMKUVZSKTKVGU5RLTCNIK5GN (cuenta de cobro del recibo)
  árbitro        claude-opus-5-5 (esfuerzo high)
  veredicto n.º  1
  resultado      refund_full
  reembolso      1.5684211 USDC de 1.5684211 USDC en disputa

Razonamiento
  Revisamos el recibo, el reclamo y la respuesta del comercio. El reclamo es específico y coincide con el recibo verificado: el producto (Imán de cobre Atacama), el monto (1.5684211 USDC), la fecha de pago (1 de octubre de 2026) y el número de pedido (18952373174578). El reclamo se presentó el 8 de octubre de 2026, dentro del plazo de reembolso, que vence el 11 de octubre de 2026.
  
  Tú, como comprador, indicas que el pedido sigue sin preparar ni despachar y que no hay número de seguimiento ni aviso de envío. Tú, como comercio, confirmaste por escrito, con firma de la cuenta de cobro del recibo, que el pedido no se preparó ni se despachó, y aceptaste devolver el monto completo. Esa aceptación es evidencia fuerte y concuerda con lo que describe el reclamo.
  
  No podemos verificar la entrega por nuestra cuenta, pero en este caso ambas partes coinciden en que el producto no se entregó. Por eso corresponde el reembolso total del monto en disputa. Una persona revisará este veredicto antes de que se mueva el dinero.

Hechos
  - El recibo verificado registra un pago de 1.5684211 USDC (15684211 unidades atómicas) por un Imán de cobre Atacama, pedido 18952373174578.
  - El pago se emitió el 1 de octubre de 2026 y el plazo de reembolso vence el 11 de octubre de 2026.
  - El reclamo se presentó el 8 de octubre de 2026, dentro del plazo de reembolso.
  - El reclamo indica que el pedido figura como Pagado y Sin preparar, sin seguimiento ni aviso de envío.
  - El monto solicitado es igual al monto en disputa: 15684211 unidades atómicas.
  - El comercio respondió con la posición accept_full y confirmó que el pedido no se preparó ni se despachó.
  - La respuesta del comercio está firmada por la cuenta de cobro del recibo.
  - Ninguna de las partes intentó dar instrucciones al árbitro.
  - El árbitro no puede verificar la entrega de forma independiente, pero ambas partes coinciden en que no hubo entrega.

Hash del veredicto
  sha256         593a8ce2b15dbff20672d2a67110148027d3a3138e23f53e9c4153a4c20c0d0d

Nada se pagó. Para confirmar y pagar (E-18), una persona corre:
  pnpm run resolve:execute -- --receipt 0922707724bf818a258bd920076e273454ca0e47839319c63ecea55d1372e87b --confirm 593a8ce2b15dbff20672d2a67110148027d3a3138e23f53e9c4153a4c20c0d0d
```

## 5. Confirmación (`E-18`), ejecución y verificación

El usuario escribió el hash `593a8ce2b15dbff20672d2a67110148027d3a3138e23f53e9c4153a4c20c0d0d` en el chat.

```
AgentResolve · ejecutar el veredicto confirmado · testnet
  veredicto      refund_full, 593a8ce2b15dbff20672d2a67110148027d3a3138e23f53e9c4153a4c20c0d0d
  reembolso      1.5684211 USDC a CA6P4KKV77Q5J4AH6L4V7S42QNF6DLKUAM4SCOQO4GMLB7V7STC5VIYP
  tx             https://stellar.expert/explorer/testnet/tx/fbdd6e741ba92122fd3c5221b429048787166d8b9bdfacaececc6c6d917ee22a
  disputa        Resolved, reembolsado 1.5684211 USDC

Verificar: pnpm run resolve:verify -- --receipt 0922707724bf818a258bd920076e273454ca0e47839319c63ecea55d1372e87b

AgentResolve · verificar una disputa · testnet
  contrato       https://stellar.expert/explorer/testnet/contract/CCYMGX56FJ65EVXUY2M4BTVBCCOBXBTAMGSCWN5X4TQLQTCCEAHDCD3F
  recibo         0922707724bf818a258bd920076e273454ca0e47839319c63ecea55d1372e87b
  estado         Resolved
  comercio       GAPCCUMMA4VY55DUH5KBQUQDBWVD52YEJ72XKDECTVYD7B4GKSZ25YVZ
  pagador        CA6P4KKV77Q5J4AH6L4V7S42QNF6DLKUAM4SCOQO4GMLB7V7STC5VIYP
  en disputa     1.5684211 USDC
  reembolso      1.5684211 USDC
  ✅ respuesta    la del comercio archivada en responses/ es la que cubre el veredicto (1a2fc2160d50d0fb…)
  ✅ veredicto    el hash en la red es el del veredicto archivado (593a8ce2b15dbff2…)
  historial      1 veredicto producido para este reclamo (verdicts/)
  garantía       1.4315789 USDC (bloqueado 0.0000000 USDC)
```

## 6. La orden con su disputa resuelta (T127)

```
adjustments [('dispute', 'completed', None)]
receipt.dispute {"contract": "CCYMGX56FJ65EVXUY2M4BTVBCCOBXBTAMGSCWN5X4TQLQTCCEAHDCD3F", "status": "resolved", "claim_hash": "b48e47ee732d4d21028d72bf94ee6599193707ea2580c360ced163cab7e8475c", "asset": "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA", "amount_atomic": "15684211", "opened_at": "2026-10-08T19:32:27.000Z", "verdict_hash": "593a8ce2b15dbff20672d2a67110148027d3a3138e23f53e9c4153a4c20c0d0d", "refund_atomic": "15684211", "resolved_at": "2026-10-08T19:49:02.000Z"}
```

Ajuste UCP completo: `status` `completed`, `totals` con `Refunded` en **-1490** CLP; y en el recibo, los montos
exactos en USDC con el hash del veredicto.
