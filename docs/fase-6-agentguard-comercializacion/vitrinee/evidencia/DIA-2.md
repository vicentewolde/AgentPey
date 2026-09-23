# Día 2 · "Recibo y anclaje" (adelantado al mar 22 de septiembre de 2026)

Salida cruda de los comandos clave. Sin secretos: solo llaves públicas, ids
de contrato, hashes de transacción y de recibo.

## Contrato `receipt-registry` · `cargo test`

```
running 11 tests
test test::an_unknown_hash_reads_none ... ok
test test::anchoring_without_authorization_fails - should panic ... ok
test test::reports_its_schema_version ... ok
test test::zero_and_negative_amounts_are_refused ... ok
test test::records_are_kept_alive_well_beyond_the_hackathon ... ok
test test::anchoring_stores_the_record_with_ledger_and_time ... ok
test test::empty_and_oversized_order_refs_are_refused ... ok
test test::anchoring_requires_the_merchants_own_authorization ... ok
test test::anchoring_publishes_receipt_anchored ... ok
test test::the_same_hash_cannot_be_anchored_twice_even_by_another_merchant ... ok
test test::counts_are_per_merchant ... ok

test result: ok. 11 passed; 0 failed
```

```
$ stellar contract build
    Wasm Size: 4007 bytes optimized (original size was 4517 bytes)
    Exported Functions: 4 found
      • anchor
      • count
      • get
      • schema_version
✅ Build Complete
```

## `pnpm deploy:registry` (primer deploy)

```
Vitrinee · receipt-registry · Stellar testnet
  rpc        https://soroban-testnet.stellar.org
  deployer   GCT7ODWJ7PF3JVWYOFJYUENQBHG6B267LIY4HWZU3BVI66W2TMURCXTW  (MERCHANT_SIGNING_ACCOUNT)
  wasm       4007 bytes · sha256 e0a871502c4bdf5a396483664f32b5006083648b7ac9546c9ce2a7ed105ac13f
  protocol   28
  upload     tx ca422da28faf02fe3454eeeb0476258bef8e7b695bf7bb70198655e8fb0db092
  deploy     tx 5ff704ce9b24108fc4ecf584941475ead92db372e760348188443a817f714252
  contract   CADILO6QYG3CT2PXEWIKOYLUACPXEP4P645L5HF6WVI2K7BSVN23ZTM5
  verified   get(unknown) = null · count(deployer) = 0 · live wasm matches
  wrote      deployments/testnet.json · .env.local RECEIPT_REGISTRY_ID
  explorer   https://stellar.expert/explorer/testnet/contract/CADILO6QYG3CT2PXEWIKOYLUACPXEP4P645L5HF6WVI2K7BSVN23ZTM5
```

Segunda corrida (idempotencia):

```
  contract   CADILO6QYG3CT2PXEWIKOYLUACPXEP4P645L5HF6WVI2K7BSVN23ZTM5  (recorded, live, same wasm — nothing to do)
```

## Tests sin red

```
packages/core test:       Tests  31 passed (31)    ← +8: JWS EdDSA, receipts, tamper
packages/adapters test:   Tests  6 passed (6)
packages/anchor test:     Tests  10 passed (10)    ← nuevo: scval, settlement, verifyReceipt
packages/gateway test:    Tests  19 passed (19)    ← +8: recibo, anclaje con reintento, verify verde/rojo,
                                                     idempotencia, una tx = una orden, reserva de stock
apps/agent test:          Tests  8 passed (8)
scripts:                  Tests  10 passed (10)
```

## `pnpm test:integration` — ciclo completo contra testnet

```
  instrucción  "compra el pack de stickers y envíalo a Ñuñoa"
  elegido      Pack de stickers Cordillera × 1 ("pack" en el nombre, "sticker" en el nombre)
  precio       990 CLP c/u → 1.0421053 USDC en total
← 402 Pago requerido
  cobro        1.0421053 USDC (10421053 stroops) → GC5Z…VCII · fees patrocinados por el facilitator
→ firmando auth entry con GAGR…QPOM
← 200 pagado y ordenado
  pedido       ord_mucs9vepd720401266 · mock mock-0001 · paid
  pago         https://stellar.expert/explorer/testnet/tx/d0c25a4f2e5ea73204e3a63ac9c5aa47932ff652d86e68d1b9b3e2b36b777754
  recibo       JWS firmado · sha256 ab9fd2d13c08239e14042031776c67deaa4922ccd2e10ff392a3694f29c3ac12
[gateway] receipt anchored { txHash: '2220dfb4c9065dcd62de721d642a48952128510b6a5301d6d382504f1da7b681', ledger: 4812916, attempt: 1 }
  anclaje      ledger 4812916
  ✅ firma      Ed25519 de GCT7ODWJ7PF3JVWYOFJYUENQBHG6B267LIY4HWZU3BVI66W2TMURCXTW (did:stellar del merchant)
  ✅ anclaje    receipt-registry CADILO6QYG3CT2PXEWIKOYLUACPXEP4P645L5HF6WVI2K7BSVN23ZTM5 · ledger 4812916
  ✅ pago       tx de settlement confirmada en Stellar · ledger 4812915
  ✅ RECIBO VÁLIDO
  tiempo       14.6 s (pago 9.6 s)
timings (ms from start) { manifest: 5, challenge: 14, signed: 2435, paid: 9606, anchored: 13629, verified: 14558 }

 ✓ answers a real 402 from the real facilitator (dry run, needs no USDC)  1115ms
 ✓ buys for real: USDC moves, the receipt is anchored on Soroban and verifies; an edited copy does not  16127ms
```

El mismo test verifica además, sin pasar por el gateway, con `verifyReceipt`
directo contra Soroban RPC y Horizon; lee el registro (`merchant`,
`amount = 10421053`, `order_ref = orderId`), comprueba que `count` subió en 1,
y que la copia con el monto editado da los tres checks en rojo.

## Los comandos del video, contra el gateway real (`node packages/gateway/dist/main.js`)

```
$ pnpm demo:buy -- "compra el pack de stickers y envíalo a Ñuñoa"

Vitrinee · agente de compra (cliente x402 estándar)
  tienda       Bazar Cordillera · did:stellar:testnet:GCT7ODWJ7PF3JVWYOFJYUENQBHG6B267LIY4HWZU3BVI66W2TMURCXTW
  catálogo     6 productos en CLP · tasa demo 950 CLP/USD
  red          stellar:testnet · facilitator https://channels.openzeppelin.com/x402/testnet
  instrucción  "compra el pack de stickers y envíalo a Ñuñoa"
  elegido      Pack de stickers Cordillera × 1 ("pack" en el nombre, "sticker" en el nombre)
  precio       990 CLP c/u → 1.0421053 USDC en total
  envío        Ñuñoa, CL
→ POST /checkout/stickers-cordillera
← 402 Pago requerido
  cobro        1.0421053 USDC (10421053 stroops) → GC5Z…VCII · fees patrocinados por el facilitator
→ firmando auth entry con GAGR…QPOM
→ POST /checkout/stickers-cordillera + PAYMENT-SIGNATURE
← 200 pagado y ordenado
  pedido       ord_mucsaosd3bb23af3d9 · mock mock-0001 · paid
  pago         https://stellar.expert/explorer/testnet/tx/b05c17f4e4ab78cdfd0256719617a7c01b931d7334d9d7df8d44112d0b2fbc9b
  recibo       JWS firmado · sha256 dd8ab0c9d52240e5f8be10544abd45e8eaf3a3aad3fcec8fac6bfe3d1d7f88b8
  anclaje      ledger 4812924 · https://stellar.expert/explorer/testnet/tx/7b0233248769cfecc60ec532ed6292d9082f3e6090ce0866f0b46cd3284c7676
→ GET /receipts/dd8ab0c9d52240e5f8be10544abd45e8eaf3a3aad3fcec8fac6bfe3d1d7f88b8/verify
  ✅ firma      Ed25519 de GCT7ODWJ7PF3JVWYOFJYUENQBHG6B267LIY4HWZU3BVI66W2TMURCXTW (did:stellar del merchant)
  ✅ anclaje    receipt-registry CADILO6QYG3CT2PXEWIKOYLUACPXEP4P645L5HF6WVI2K7BSVN23ZTM5 · ledger 4812924
  ✅ pago       tx de settlement confirmada en Stellar · ledger 4812922
  ✅ RECIBO VÁLIDO
  tiempo       22.1 s (pago 15.2 s)
  guardado     .vitrinee/last-receipt.jws (para pnpm demo:verify)

$ pnpm demo:verify
  verificador  local: firma, Soroban RPC y Horizon, sin pasar por el gateway
  pedido       ord_mucsaosd3bb23af3d9 · 1 × Pack de stickers Cordillera · 1.0421053 USDC
  ✅ firma · ✅ anclaje · ✅ pago · ✅ RECIBO VÁLIDO

$ pnpm demo:verify -- --tamper
  manipulado   amountUSDC 1.0421053 → 0.1042105, misma firma (sin volver a firmar)
  hash         6a190e2476ad210f86037413ed1f72544d4b36b57e7cd4b7069a1eaf4b2e4d10
  ❌ firma      signature does not match the content
  ❌ anclaje    this exact receipt is not anchored in the registry
  ❌ pago       the payer was not debited the receipt's USDC amount in that transaction
  ❌ RECIBO INVÁLIDO

$ curl -X POST -H "idempotency-key: <la clave de la compra anterior>" …/checkout/stickers-cordillera
replay status 200        ← misma orden, sin 402 ni segundo cobro
```

Tiempo de punta a punta: 14,6 s y 22,1 s en dos corridas. La diferencia está
casi entera en el settle del facilitator (7,2 s y 12,8 s entre firma y
respuesta); el anclaje agrega ~4–5 s y la verificación ~1 s.
