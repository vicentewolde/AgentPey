# Chequeo del día 1 · el facilitator x402 y un `payTo` contrato

Fecha: 2026-10-14, con OK del usuario. Script local (no versionado), con `@x402/core` y `@x402/stellar` 2.26, los mismos de `packages/vitrinee-gateway`. Pagador: la cuenta `AGENT_SECRET_KEY` de `.env.local` (`GAK6E5E7…FP2K`). Destino: `policyRailUcp` (`CBDRI5B72VWNZGRVUXNMUNOSYWXGB7RZLK5ITRVOVSGOS4VXPCRMD3YA`), cuyo `principal` es la wallet del usuario. Facilitator: OpenZeppelin Channels testnet, con la llave de la tienda. Resultado: `X-14`.

## Saldo USDC del contrato antes

```
rail USDC atomic: 301631577
```

## Requisitos, `verify` y `settle`

```json
{
  "step": "requirements",
  "payer": "GAK6E5E7L63ZYFZZZFXDTYVG6MVAKILSHI5FITGH5U4ORACEZQ4GFP2K",
  "accepts": [
    {
      "scheme": "exact",
      "network": "stellar:testnet",
      "amount": "100000",
      "asset": "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
      "payTo": "CBDRI5B72VWNZGRVUXNMUNOSYWXGB7RZLK5ITRVOVSGOS4VXPCRMD3YA",
      "maxTimeoutSeconds": 120,
      "extra": {
        "paymentFlow": "upfront",
        "areFeesSponsored": true
      }
    }
  ]
}
{
  "step": "verify",
  "verify": {
    "isValid": true,
    "payer": "GAK6E5E7L63ZYFZZZFXDTYVG6MVAKILSHI5FITGH5U4ORACEZQ4GFP2K"
  }
}
{
  "step": "settle",
  "settle": {
    "success": true,
    "payer": "GAK6E5E7L63ZYFZZZFXDTYVG6MVAKILSHI5FITGH5U4ORACEZQ4GFP2K",
    "transaction": "84611558ffea12348a87aa23f9428749efcbba74e30f0d3bae04d61841cb077f",
    "network": "stellar:testnet"
  }
}
```

## Saldo USDC del contrato después (+100000 unidades = 0,01 USDC)

```
rail USDC atomic: 301731577
```

## Efectos en Horizon

[Transacción en Stellar Expert](https://stellar.expert/explorer/testnet/tx/84611558ffea12348a87aa23f9428749efcbba74e30f0d3bae04d61841cb077f) · ledger 5194404 · 2026-10-14T16:33:27Z · enviada por `GASPBKBE…GYOU` (el facilitator), comisión 148482 stroops pagada por él.

```
{"type":"account_debited","account":"GAK6E5E7L63ZYFZZZFXDTYVG6MVAKILSHI5FITGH5U4ORACEZQ4GFP2K","amount":"0.0100000","asset":"USDC"}
{"type":"contract_credited","account":"GASPBKBEJM3IVZ3WEQLFUHKCYMW52XCLLNSBDW4TSPIWKMDPBRPJGYOU","contract":"CBDRI5B72VWNZGRVUXNMUNOSYWXGB7RZLK5ITRVOVSGOS4VXPCRMD3YA","amount":"0.0100000","asset":"USDC"}
```
