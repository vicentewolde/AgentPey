# Día 1 · mié 23 de septiembre de 2026 (trabajo iniciado el 22) · "El agente paga"

Salida cruda de los comandos clave. Sin secretos: solo llaves públicas, ids
de transacción y respuestas de APIs que no devuelven credenciales.

## Repo y remoto

```
$ gh repo view vicentewolde/Vitrinee
Vitrinee · PUBLIC · created 2026-09-22T13:05:48Z · license Apache License 2.0 · default main
$ git push origin main            → 82de7d8..b096b86 (main rebased sobre el "Initial commit" de GitHub)
$ git push -f origin v0.1 day-0-skeleton
```

## Credenciales verificadas en vivo (valores nunca impresos)

```
$ node probe-env.mjs .env.local
  FACILITATOR_API_KEY            <set, 36 chars>
  JUMPSELLER_AUTHTOKEN           <set, 32 chars>
  JUMPSELLER_LOGIN               <set, 32 chars>

=== facilitator /supported (Authorization: Bearer …) ===
  HTTP 200
  {"kinds":[{"extra":{"areFeesSponsored":true},"network":"stellar:testnet","scheme":"exact","x402Version":2}],
   "signers":{"stellar:testnet":["GCNJB6V5YIODDSSCWXZ2VOKMRPRVZ2V723RRQS6STXE6NWTGVOJY35CN"]}}

=== jumpseller (Basic auth login:authtoken) ===
  store/info HTTP 200
  {"store":{"name":"Vitrinee","code":"vitrinee","currency":"CLP","country":"CL","timezone":"America/Santiago",
   "url":"https://vitrinee.jumpseller.com","subscription_plan":"pro","subscription_status":"trial","checkout_version":"v2"}}
  products HTTP 200 · count: 5   (los cinco productos demo que Jumpseller crea por defecto, 100 CLP, stock ilimitado)
  shipping_methods HTTP 200      (918997 "Correo Ordinario" type free · 918998 "Bluexpress")
```

Conclusión: el plan trial **sí** expone la API completa con `login` + `authtoken`.

## `pnpm bootstrap`

```
Vitrinee bootstrap · Stellar testnet
  horizon   https://horizon-testnet.stellar.org
  usdc      USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5

  merchant payTo
    account    GC5ZY7UJ7CKD7O7YURRSDIDVYEETYP2JXPKUL5E6GIWHUPAH5DCIVCII  (generated)
    xlm        funded via friendbot · 10000.0000000 XLM
    trustline  opened · tx 2988c085081b08572ec00d0cec41e656477ea7b1a75833b96bdce874ebfa5045

  merchant signing
    account    GCT7ODWJ7PF3JVWYOFJYUENQBHG6B267LIY4HWZU3BVI66W2TMURCXTW  (generated)
    xlm        funded via friendbot · 10000.0000000 XLM

  agent (buyer)
    account    GAGRRWU5CEYAMHUMVO6DZBXAV7YTQTO2QE7R2KO3TUEN6QR7GRVXQPOM  (generated)
    xlm        funded via friendbot · 10000.0000000 XLM
    trustline  opened · tx e6c09bbc5bdf23491247903203e5def671b666b71ca6c2359ef2c5a0b8def3bb

  wrote .env.local (mode 600) · 3 new secrets, none printed

  Next: fund the agent with testnet USDC (Circle's faucet is a web form):
    address  GAGRRWU5CEYAMHUMVO6DZBXAV7YTQTO2QE7R2KO3TUEN6QR7GRVXQPOM
    faucet   https://faucet.circle.com  → Stellar testnet → USDC
```

## Tests sin red (facilitator simulado)

```
packages/gateway test:  ✓ src/app.test.ts (6 tests)
packages/gateway test:  ✓ src/checkout.test.ts (5 tests)
   refuses bad input, unknown products and missing stock before asking for money
   answers 402 with the exact USDC amount for the quantity, upfront flow, and a Spanish quote
   settles before the handler, then creates the platform order and records the sale
   never fails the request once money moved: a platform error is recorded as paid_unfulfilled
   does not create an order when the facilitator refuses the payment
apps/agent test:        ✓ src/matcher.test.ts (9 tests)
scripts:                ✓ env-file (4) · roles (4)
```

Observación registrada: con `paymentFlow: "upfront"` el SDK **no** llama a
`verify` del facilitator; la validez la establece `settle` (comentario en
`@x402/core`: "upfront / escrow, payment validity is established by settle").

## Gateway real + agente en dry run (facilitator OpenZeppelin, sin USDC aún)

```
$ node packages/gateway/dist/main.js
{"message":"vitrinee gateway listening","port":4021,"adapter":"mock","merchant":"GC5ZY7UJ7CKD7O7YURRSDIDVYEETYP2JXPKUL5E6GIWHUPAH5DCIVCII",
 "facilitator":"https://channels.openzeppelin.com/x402/testnet","facilitatorKey":"set","manifest":"/.well-known/agent-storefront.json"}

$ pnpm demo:buy -- "compra el hoodie talla M y envíalo a Ñuñoa" --dry-run

Vitrinee · agente de compra (cliente x402 estándar)
  tienda       Bazar Cordillera · did:stellar:testnet:GC5ZY7UJ7CKD7O7YURRSDIDVYEETYP2JXPKUL5E6GIWHUPAH5DCIVCII
  catálogo     5 productos en CLP · tasa demo 950 CLP/USD
  red          stellar:testnet · facilitator https://channels.openzeppelin.com/x402/testnet
  instrucción  "compra el hoodie talla M y envíalo a Ñuñoa"
  elegido      Hoodie Cordillera talla M × 1 ("hoodie" en el nombre, "m" en el nombre, talla M)
  precio       34.990 CLP c/u → 36.8315789 USDC en total
  envío        Ñuñoa, CL
→ POST /checkout/hoodie-cordillera-m
← 402 Pago requerido
  cobro        36.8315789 USDC (368315789 stroops) → GC5Z…VCII · fees patrocinados por el facilitator
  (dry run: no se firma ni se paga)
```

Sin USDC en la cuenta del agente, el mismo comando sin `--dry-run` termina en:

```
→ firmando auth entry con GAGR…QPOM
✗ PaymentError: saldo USDC insuficiente en GAGRRWU5CEYAMHUMVO6DZBXAV7YTQTO2QE7R2KO3TUEN6QR7GRVXQPOM. Fondéala en https://faucet.circle.com
```

(Ese error viene de la simulación Soroban que hace `@x402/stellar` antes de
firmar: el agente descubre que no puede pagar sin molestar al facilitator.)

## Compra real · `pnpm test:integration` (22 de septiembre, 11:20 Chile)

```
apps/agent test:integration: ✓ compra real contra Stellar testnet > answers a real 402 from the real facilitator (dry run, needs no USDC)  1084ms
apps/agent test:integration: ✓ compra real contra Stellar testnet > buys one product for real: USDC moves, the order exists, the tx is on Horizon  24716ms

  instrucción  "cómprame un café de grano y envíalo a Ñuñoa"
  elegido      Café de grano Ñuñoa 250 g × 1 ("cafe" en el nombre, "grano" en el nombre)
  precio       8.990 CLP c/u → 9.4631579 USDC en total
  envío        Ñuñoa, CL
→ POST /checkout/cafe-nunoa-250
← 402 Pago requerido
  cobro        9.4631579 USDC (94631579 stroops) → GC5Z…VCII · fees patrocinados por el facilitator
→ firmando auth entry con GAGR…QPOM
→ POST /checkout/cafe-nunoa-250 + PAYMENT-SIGNATURE
[gateway] checkout completed { orderId: 'ord_mucrhcq85d377d2f30', status: 'paid', platformOrderId: 'mock-0001',
  txHash: 'ef86ca2fb6b3fbbe32e89b23c7159a4b13dc02e251bb83a7e75e0ac68f86080f', amountUSDC: '9.4631579' }
← 200 pagado y ordenado
  pedido       ord_mucrhcq85d377d2f30 · mock mock-0001 · paid
  tx           https://stellar.expert/explorer/testnet/tx/ef86ca2fb6b3fbbe32e89b23c7159a4b13dc02e251bb83a7e75e0ac68f86080f
  tiempo       24.1 s
```

### Confirmación en Horizon

```
$ curl https://horizon-testnet.stellar.org/transactions/ef86ca2f…86080f
  successful True | ledger 4812648 | created_at 2026-09-22T14:20:27Z
  source      GDIPM2BCVZDM33O2ZMGKOFMXI4S6I4ORG6MXR4OSMYCIO5URYQNUULZ5   (relayer del facilitator)
  fee_account GA6THKUY2XJZOBRFMEQMMEADSCQLCZ2QMQWAWMMDXBTE7SARKAXVH7TL   (fee bump: fees patrocinados)
  fee 23099 stroops · 1 operación (invokeHostFunction → transfer USDC)

$ …/transactions/ef86ca2f…86080f/effects
  account_debited  GAGRRWU5CEYAMHUMVO6DZBXAV7YTQTO2QE7R2KO3TUEN6QR7GRVXQPOM  9.4631579 USDC   (agente)
  account_credited GC5ZY7UJ7CKD7O7YURRSDIDVYEETYP2JXPKUL5E6GIWHUPAH5DCIVCII  9.4631579 USDC   (merchant payTo)

saldos después:
  agente    10.5368421 USDC · 9999.9999900 XLM   (el XLM no se movió: el agente no pagó fees)
  merchant  29.4631579 USDC · 9999.9999900 XLM
```

Lo que prueba: el dinero fue directo del agente al merchant en una sola
transacción sometida por el facilitator; Vitrinee no tocó fondos ni llaves de
pago. La tienda creó el pedido `mock-0001` solo después de ese settle.
