# Ensayo del reclamo en vivo · 9-oct-2026, madrugada

Primer reclamo hecho de punta a punta **desde Claude**: Claude firmó el reclamo con `open_claim` del MCP y el árbitro
lo abrió en la red con `resolve:open -- --claim`. Hasta hoy, ese camino solo tenía tests; el reclamo real del 8-oct se
firmó desde la terminal ([evidencia/T124-reembolso-real.md](../evidencia/T124-reembolso-real.md)). Todo con el código
de `main` y AgentResolve tal como está: el árbitro abre la disputa a mano.

Compra: `ord_mv0bfvfcf83e182ff5`, Imán de cobre Atacama, 490 CLP, 0,5157895 USDC, pagada por Claude el 8-oct a las
22:58 (Chile) desde el rail del MCP `CB4WVTJ4…FRQ6L`; recibo `713447e8…958a`.

## 0. Garantía de la tienda (con OK del usuario)

```
AgentResolve · fondear la garantía de un comercio · testnet
  comercio       GAPCCUMMA4VY55DUH5KBQUQDBWVD52YEJ72XKDECTVYD7B4GKSZ25YVZ
  monto          2.0000000 USDC
  desde          GAK6E5E7L63ZYFZZZFXDTYVG6MVAKILSHI5FITGH5U4ORACEZQ4GFP2K (reserva de cuentas patrocinadas)
  tx             https://stellar.expert/explorer/testnet/tx/89657842700224c47bfe7746ac851b0cd63f8bd3de5ab4a270f351e56f94873f
  garantía       3.4315789 USDC (bloqueado 0.0000000 USDC)
```

## 1. Claude firma el reclamo (claude.ai, conector AgentPey)

El usuario escribió: "Con AgentPey, abre un reclamo de reembolso por mi orden ord_mv0bfvfcf83e182ff5 en agentcommerce.
Motivo: no me llegó; la tienda me avisó que no tiene stock. Pide el monto completo." Claude llamó `open_claim` y
devolvió el `claim_jws`, firmado por el agente del MCP (`GC7ALMLY…23LB`), dueño del rail que pagó. Descripción que
escribió Claude en el reclamo: "El pedido no fue entregado. La tienda informó al comprador que no tiene stock del
producto (Imán de cobre Atacama, 1 unidad; 0 unidades despachadas). Se solicita el reembolso completo del monto
pagado: 490 CLP."

## 2. El árbitro abre la disputa (`resolve:open -- --claim`)

```
[comprador] reclamo ya firmado
  recibo         713447e843396dfed591b7b1554d9cc9c821ba5718d928b6411bde7ff5e9958a
  reclamo        ffb2fafe-f2c5-4ce3-8a59-085c0f272a85 (not_delivered)
  pide           0.5157895 USDC
  firmante       did:stellar:testnet:GC7ALMLYKBIHSYTM6HQRO2GISZOEUHVNKMA25VOWDAI7M26RBKEW23LB

[árbitro] verifica y abre la disputa en el contrato
  ✅ recibo       firma del comercio, anclado en receipt-registry, pago confirmado en Horizon
  ✅ firmante     controla al pagador CB4WVTJ4LVB6GUWSTJE4FQ2MH364Q2HW3FHXGSZF4KJ55SGEBIFGRQ6L
  ✅ plazo        hasta 2026-10-19T01:57:59.962Z
  tx             https://stellar.expert/explorer/testnet/tx/ca1817d50eee3620ea75294a7b0fccd81853f5ce1ad495e22562e82b641c3dc5
  disputa        Open, 0.5157895 USDC bloqueados en la garantía de GAPCCUMMA4VY55DUH5KBQUQDBWVD52YEJ72XKDECTVYD7B4GKSZ25YVZ
  garantía       3.4315789 USDC (bloqueado 0.5157895 USDC)
```

`/api/live` mostró la disputa enseguida: `{'status': 'open', 'amount_usdc': '0.5157895', ...}`, `disputes_open` 1.

## 3. La tienda responde (`agentpey.com/resolve/responder`, Freighter, cuenta de cobro)

```
AgentResolve · verificar la respuesta de un comercio · testnet
  ✅ firma        SEP-53 de GD2MCESI2DMMOU4F2SI6ZHDZDDCN5LA7PMKUVZSKTKVGU5RLTCNIK5GN, la cuenta de cobro del recibo
  ✅ disputa      responde al reclamo c2e7c6efc873bb68… que está en la red (Open)
  posición       accept_full
  descargos      Confirmo que no tengo stock del imán y que el pedido no se despachó. Acepto devolver el monto completo
  hash           72785cec5436b0a35cade71688b408e60c1aef6465c56e5e5321bce9dca6b114
```

Tropiezo del ensayo: el primer archivo que se pasó era la respuesta del 8-oct (`agentresolve-response-b48e47ee732d.json`).
Los archivos se llaman por el hash del reclamo; el atajo `reclamo_decidir` toma siempre el más reciente de Descargas.

## 4. El árbitro de IA decide (`resolve:decide`)

```
  ✅ respuesta    accept_full, firmada por GD2MCESI2DMMOU4F2SI6ZHDZDDCN5LA7PMKUVZSKTKVGU5RLTCNIK5GN (cuenta de cobro del recibo)
  árbitro        claude-opus-5-5 (esfuerzo high)
  veredicto n.º  1
  resultado      refund_full
  reembolso      0.5157895 USDC de 0.5157895 USDC en disputa

Razonamiento
  El reclamo es específico y coincide con el recibo verificado: un Imán de cobre Atacama, 1 unidad, pagado con 0.5157895 USDC (equivalente a los 490 CLP que menciona el comprador). Según el reclamo, la tienda informó que no tenía stock y no despachó nada. El reclamo se presentó dentro del plazo de reembolso.

  El comercio respondió con su firma y confirmó que no tiene stock del imán, que el pedido no se despachó y que acepta devolver el monto completo. No puedo verificar la entrega por mi cuenta, pero ambas partes coinciden en los hechos. La falta de stock es responsabilidad del comercio, así que corresponde el reembolso total del monto disputado.

  Una persona revisará esta decisión antes de que se mueva el dinero. Con esta decisión el caso queda cerrado de forma definitiva.

Hash del veredicto
  sha256         1f78a2b0a330c18d81a6aa759ea6a8263dd87058df5fa0bca6b849e10863f751
```

## 5. Una persona confirma (`E-18`) y el contrato paga (`resolve:execute`)

El usuario escribió el hash del veredicto en el chat.

```
AgentResolve · ejecutar el veredicto confirmado · testnet
  veredicto      refund_full, 1f78a2b0a330c18d81a6aa759ea6a8263dd87058df5fa0bca6b849e10863f751
  reembolso      0.5157895 USDC a CB4WVTJ4LVB6GUWSTJE4FQ2MH364Q2HW3FHXGSZF4KJ55SGEBIFGRQ6L
  tx             https://stellar.expert/explorer/testnet/tx/887db95740c5d7343a1b02f871eec946161f11e3374673e9ff3156e8cf5a18f6
  disputa        Resolved, reembolsado 0.5157895 USDC
```

`resolve:verify`: estado `Resolved`, ✅ respuesta archivada, ✅ hash del veredicto en la red, garantía 2,9157894
USDC sin nada bloqueado. `/api/live`: `disputes_resolved` 3, `refunded_usdc` 2.0842106.
