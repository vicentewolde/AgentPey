# Anexo técnico · Agentic Commerce on Stellar

> Material para el borrador de SEP "Agentic Commerce on Stellar" (`P-14`),
> que se escribe en el chat de estrategia. AgentPey es la implementación de
> referencia. Este anexo **no es el SEP**: es la descripción exacta de lo que
> la implementación hace hoy, con cada formato tomado del código y cada id
> tomado de `deployments/`.
>
> Fecha: 2026-10-01 · Red: Stellar testnet · UCP `2026-04-08` (`E-2`) ·
> x402 versión 2 · Tarea T125. Un test (`scripts/fase7-anexo.test.ts`) falla si
> un id, un nombre o un código de este archivo deja de coincidir con el código o
> con `deployments/`.
>
> Los nombres de campos, los JSON y los mensajes van tal cual están en el
> código, en inglés; la prosa, en español (regla 4 de `CLAUDE.md`). La spec
> pública del handler, ya en inglés, está en
> <https://agentpey.com/ucp/handlers/stellar-x402/spec>.

## 1. El recorrido completo

Tres documentos firmados y tres contratos, en este orden:

| # | Paso | Quién | Dónde queda la prueba |
|---|---|---|---|
| 1 | El principal (dueño de la plata) firma un **Mandato**: qué agente, en qué comercios, qué activos, cuánto por compra y por día, hasta cuándo | Wallet del principal | Hash anclado en `agent-registry` |
| 2 | El principal fondea un **`policy_rail`**: una cuenta-contrato con los mismos límites, de la que solo él puede retirar | Principal | Saldo y límites en el contrato |
| 3 | El agente descubre la tienda: `GET /.well-known/ucp` y `POST /ucp/v1/catalog/search` | Agente | — |
| 4 | El agente firma una **intención de compra** para un producto y una cantidad | Agente | JWS de la intención |
| 5 | El agente abre la sesión: `POST /ucp/v1/checkout-sessions`. La tienda responde los **requisitos de pago x402** dentro de la configuración del handler | Tienda | Sesión en la base de la tienda |
| 6 | Antes de firmar el pago, el agente comprueba: destinatario, activo y red contra el perfil de la tienda; cuenta fijada del comercio; Mandato | Agente | — |
| 7 | El agente firma la autorización Soroban de un `transfer` del `policy_rail` al comercio, por el monto exacto | Llave dueña del rail | Entrada de autorización firmada |
| 8 | `POST /ucp/v1/checkout-sessions/{id}/complete` con esa autorización como credencial | Agente | — |
| 9 | La tienda liquida con un facilitator x402; en la red, `__check_auth` del rail vuelve a aplicar los límites | Facilitator y red | Transacción en Stellar |
| 10 | La tienda crea el pedido en su plataforma (Shopify, Jumpseller) y firma un **recibo** | Tienda | JWS del recibo |
| 11 | La tienda ancla el hash del recibo en `receipt-registry` | Tienda | Registro en el contrato |
| 12 | Cualquiera verifica el recibo: firma, anclaje y pago, sin confiar en la tienda | Cualquiera | — |

Caso real del 2026-10-01 (T122, [evidencia](evidencia/T122.md)): un imán de
1.490 CLP en la tienda Shopify `agentcommerce`, pagado con 1,5684211 USDC.

| | |
|---|---|
| Pago | `06ff47cf38a4c1f8f22a9d4095c3cfb34b5d6ffd9c5914cb248fa299e2210ea6` |
| Recibo (hash anclado) | `fe3c5730884a59a72760217ae192757b7bb376bb1467f1e2d2ea7a6047c0f076` |
| Anclaje | `60a26da5a9ad5e2fd80e8853804f0b6df8211f7085f078344343961f610a3f9a`, ledger 4967422 |
| Pagador | `policy_rail` UCP `CA6P4KKV77Q5J4AH6L4V7S42QNF6DLKUAM4SCOQO4GMLB7V7STC5VIYP` |

## 2. El payment handler `com.agentpey.stellar_x402`

| | |
|---|---|
| Nombre | `com.agentpey.stellar_x402` |
| Versión | `2026-09-30` |
| Id en el perfil | `stellar_x402` |
| Tipo de instrumento | `stellar_x402` |
| Tipo de credencial | `x402_payment_payload` |
| Spec | <https://agentpey.com/ucp/handlers/stellar-x402/spec> |
| Esquema | <https://agentpey.com/ucp/handlers/stellar-x402/schema.json> ([fuente](../../apps/web/public/ucp/handlers/stellar-x402/schema.json)) |
| Constantes | `packages/vitrinee-core/src/ucp.ts` |

UCP exige que el origen de `spec` y `schema` sea el dominio del nombre
(`com.agentpey.*` → `agentpey.com`). El comprador rechaza un perfil que no lo
cumpla o que omita alguno de los dos (`originMatchesNamespace`, en
`apps/agent/src/payment/ucp.ts`).

### 2.1 Declaración en el perfil del comercio (`business_config`)

Zod: `stellarX402BusinessConfigSchema` (`packages/vitrinee-core/src/ucp.ts`).
Esquema: `#/$defs/business_config`.

```json
{
  "id": "stellar_x402",
  "version": "2026-09-30",
  "spec": "https://agentpey.com/ucp/handlers/stellar-x402/spec",
  "schema": "https://agentpey.com/ucp/handlers/stellar-x402/schema.json",
  "available_instruments": [{ "type": "stellar_x402" }],
  "config": {
    "x402_version": 2,
    "scheme": "exact",
    "network": "stellar:testnet",
    "asset": { "code": "USDC", "contract": "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA", "decimals": 7 },
    "pay_to": "G…",
    "facilitator": "https://channels.openzeppelin.com/x402/testnet"
  }
}
```

### 2.2 Configuración resuelta en la respuesta del checkout (`response_config`)

Cuando la sesión está `ready_for_complete`, el handler trae los requisitos de
**esa** compra. Esquema: `#/$defs/response_config`. Código:
`handlerFor` en `packages/vitrinee-gateway/src/ucp/checkout.ts`.

```json
{
  "x402_version": 2, "scheme": "exact", "network": "stellar:testnet",
  "asset": { "code": "USDC", "contract": "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA", "decimals": 7 },
  "pay_to": "G…",
  "facilitator": "https://channels.openzeppelin.com/x402/testnet",
  "payment_requirements": {
    "scheme": "exact", "network": "stellar:testnet",
    "asset": "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
    "amount": "15684211",
    "payTo": "G…",
    "maxTimeoutSeconds": 300,
    "extra": { "paymentFlow": "upfront", "areFeesSponsored": true }
  },
  "fx": { "base": "USD", "quote": "CLP", "rate": "950", "as_of": "2026-10-01T13:20:00.000Z" },
  "binding": { "checkout_id": "cs_…" }
}
```

- `payment_requirements` es un `PaymentRequirements` de x402 v2, sin cambios.
  `amount` va en unidades atómicas del activo (7 decimales).
- La sesión va en la moneda de la tienda (`currency`, ISO 4217, montos en su
  unidad menor); el monto en USDC solo vive aquí (`E-3`). `fx` dice con qué
  tasa se pasó de uno a otro.
- Antes de que la sesión esté lista, el handler trae solo la configuración del
  comercio: no hay nada que firmar.

### 2.3 Instrumento y credencial en `complete`

Zod: `stellarX402CredentialSchema` (`packages/vitrinee-gateway/src/ucp/checkout.ts`).
Esquema: `#/$defs/instrument` y `#/$defs/credential`.

```json
{
  "payment": {
    "instruments": [{
      "id": "instr_1",
      "handler_id": "stellar_x402",
      "type": "stellar_x402",
      "selected": true,
      "credential": {
        "type": "x402_payment_payload",
        "x402_version": 2,
        "accepted": { "…": "los payment_requirements de la sesión, tal cual" },
        "payload": { "transaction": "<XDR en base64>" }
      }
    }]
  }
}
```

`payload.transaction` es la transacción que contiene la entrada de
autorización Soroban firmada para `transfer(from = pagador, to = payTo, amount)`
sobre el contrato del activo, con credenciales de dirección v1 (el facilitator
no lee v2). Es lo mismo que en x402 viaja en el header `PAYMENT-SIGNATURE`,
con la versión escrita al estilo UCP y sin `resource`, que en UCP no existe.

### 2.4 Lo que comprueba el comprador antes de firmar

En este orden (`executeUcpPayment`, `apps/agent/src/payment/ucp.ts`):

1. El perfil declara el handler con `spec` y `schema` en `agentpey.com`.
2. `binding.checkout_id` es la sesión que abrió.
3. `payTo`, `asset` y `network` de los requisitos son iguales a `pay_to`,
   `asset.contract` y `network` del perfil. La respuesta del checkout la
   escribe el comercio; el perfil es lo que publicó.
4. `toPaymentTerms`: la cuenta fijada del comercio en el directorio de la
   plataforma (`C-141`) y el activo del registro de comercios.
5. `policyRail.authorise`: el Mandato y la intención (sección 4).

Solo entonces firma, con un tope de gasto igual al monto autorizado (`C-139`).

### 2.5 Lo que hace el comercio en `complete`

`complete` en `packages/vitrinee-gateway/src/ucp/checkout.ts` (`E-6`):

1. Vuelve a cotizar. Si el total cambió, no cobra y devuelve los requisitos nuevos.
2. Exige que `accepted` sea igual a los requisitos guardados en la sesión
   (`scheme`, `network`, `asset`, `amount`, `payTo`, `maxTimeoutSeconds`).
3. Reserva el stock, deja la sesión en `complete_in_progress` y liquida los
   requisitos **guardados** con el facilitator (`settlePayment` de `@x402/core`).
4. Con el pago confirmado, guarda la liquidación en la sesión y recién después
   crea el pedido y firma el recibo.

| Resultado del facilitator | Qué pasa con la sesión |
|---|---|
| `success: true` | Liquidación guardada; pedido; `completed` |
| `success: false` sin transacción emitida | Vuelve a `ready_for_complete`; error `payment_failed` |
| Excepción, timeout, o `success: false` con transacción emitida | Queda `complete_in_progress`, mensaje `payment_pending`; **nunca se vuelve a liquidar** |

## 3. El recibo firmado y anclado

### 3.1 Formato

JWS compacto, `alg: EdDSA` (Ed25519 de Stellar), firmado con la llave de firma
del comercio, que no es su cuenta de cobro (`VT-8`). Código: `signReceipt` y
`receiptClaimsSchema` en `packages/vitrinee-core/src/receipt.ts`; cabecera en
`signJws` (`packages/vitrinee-core/src/jws.ts`).

Cabecera:

```json
{ "alg": "EdDSA", "typ": "JWT", "kid": "did:stellar:testnet:G…#key-1" }
```

Cuerpo (`typ` fijo `vitrinee-receipt/0.1`, objeto estricto):

| Campo | Tipo |
|---|---|
| `typ` | `"vitrinee-receipt/0.1"` |
| `orderId` | id del pedido en la tienda |
| `platformOrderId` | id en la plataforma, o `null` si la plataforma rechazó el pedido después del pago (`VT-10`) |
| `platform` | `shopify`, `jumpseller`, `mock` |
| `merchantDid` | `did:stellar:testnet:G…` de la llave de firma |
| `merchantAccount` | `G…`, la cuenta que cobra |
| `payerAccount` | `G…` o `C…` (un `policy_rail` paga como contrato) |
| `network` | `"stellar:testnet"` |
| `asset` | contrato SEP-41 del activo |
| `amountUSDC`, `amountUSDCAtomic` | decimal y unidades atómicas |
| `settlementTxHash` | hash de la transacción de pago, hex en minúsculas |
| `items[]` | `productId`, `sku`, `name`, `quantity`, `unitPriceUSDC`, `unitPriceUSDCAtomic` |
| `issuedAt`, `refundWindowEndsAt` | ISO 8601 |

**Hash anclado:** `sha256` del JWS compacto (UTF-8), hex en minúsculas
(`receiptHash`).

### 3.2 Anclaje

`receipt-registry.anchor(hash: BytesN<32>, merchant: Address, amount: i128, order_ref: Bytes)`
(`contracts/receipt-registry/src/lib.rs`). Exige la firma de `merchant` (la
llave de firma del comercio), rechaza `amount <= 0` y `order_ref` vacío o de
más de 64 bytes, y no acepta anclar dos veces el mismo hash
(`AlreadyAnchored`, #1). Lectura: `get(hash)` y `count(merchant)`.

### 3.3 Los tres checks

`verifyReceipt` en `packages/vitrinee-anchor/src/verify.ts`:

1. **Firma:** el cuerpo cumple el esquema, el DID del `kid` es `merchantDid`, y
   la firma Ed25519 verifica contra la llave del DID. Sin red.
2. **Anclaje:** `get(sha256(jws))` existe en `receipt-registry`, con
   `merchant` igual a la cuenta del DID, `amount` igual a `amountUSDCAtomic` y
   `order_ref` igual a `orderId`.
3. **Pago:** en Horizon, `settlementTxHash` existe, fue exitosa, y movió
   exactamente `amountUSDC` del pagador a `merchantAccount`.

### 3.4 En UCP: la extensión `com.agentpey.shopping.receipt`

Extiende `dev.ucp.shopping.checkout` y `dev.ucp.shopping.order`. Esquema:
<https://agentpey.com/ucp/extensions/receipt/schema.json>
([fuente](../../apps/web/public/ucp/extensions/receipt/schema.json)).

```json
"receipt": {
  "format": "jws",
  "jws": "eyJ…",
  "hash": "fe3c5730884a59a72760217ae192757b7bb376bb1467f1e2d2ea7a6047c0f076",
  "network": "stellar:testnet",
  "settlement_tx_hash": "06ff47cf38a4c1f8f22a9d4095c3cfb34b5d6ffd9c5914cb248fa299e2210ea6",
  "anchor": { "status": "anchored", "registry": "CADILO6QYG3CT2PXEWIKOYLUACPXEP4P645L5HF6WVI2K7BSVN23ZTM5", "tx_hash": "60a26da5…", "ledger": 4967422 },
  "verify_url": "https://agentcommerce.vitrinee.agentpey.com/receipts/fe3c…/verify"
}
```

`order.permalink_url` apunta a la página pública del recibo. El anclaje es
asíncrono: `anchor.status` pasa de `pending` a `anchored`, y se ve leyendo la
orden (`GET /ucp/v1/orders/{id}`).

## 4. Cómo se verifica un Mandato

### 4.1 Formato

Un Verifiable Credential 2.0 firmado como JWS. Esquema:
`agentPayMandateSchema` (`packages/mandate/src/mandate.ts`). Cabecera
`typ: "mandate+jwt"`, `alg: EdDSA`, firmado por el principal, que es el
`issuer`.

```json
{
  "@context": ["https://www.w3.org/ns/credentials/v2"],
  "type": ["VerifiableCredential", "AgentPayMandate"],
  "mandateId": "<uuid>",
  "issuer": "did:stellar:testnet:G… (el principal)",
  "validFrom": "…", "validUntil": "…",
  "credentialSubject": {
    "id": "did:stellar:testnet:G… (el agente)",
    "grant": {
      "actions": ["catalog:read", "intent:create"],
      "venues": ["<slug>:<cuenta>"],
      "assets": ["USDC:CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA"],
      "limits": { "perTx": "3.00", "perDay": "5.00", "currency": "USDC" },
      "payTo": ["G…"],
      "products": ["…"]
    }
  },
  "credentialStatus": { "type": "…", "registry": "<agent-registry>" }
}
```

`payTo` y `products` son opcionales: si faltan, no se comprueban (y la
respuesta lo dice); si están, un arreglo vacío no permite nada.

### 4.2 Anclaje y revocación

`agent-registry.anchor(issuer, cred_hash, subject, expires_at)`, con
`cred_hash = sha256(jws)`, `subject` el agente y `expires_at` el `validUntil`.
El principal revoca con `revoke(issuer, cred_hash)`, desde fuera del agente:
ningún prompt lo deshace.

### 4.3 Verificación, en orden

1. **Fuera de línea** (`verifyMandate`, `packages/mandate/src/sign.ts`): la firma
   contra la llave del `issuer`, y después la ventana `validFrom`–`validUntil`.
2. **En la red** (`verifyMandateOnChain`, `packages/mandate/src/anchor.ts`): que el
   registro nombrado sea el que el verificador confía (`RegistryMismatch`), que
   el hash esté `Active` (`MandateRevoked`, `MandateUnknown`, `MandateExpired`),
   y que el principal siga registrado y activo.
3. **Contra la compra** (`checkMandate`, `apps/agent/src/mandate/check-mandate.ts`,
   pura): agente, principal, acción, comercio, producto, activo, moneda,
   ventana y monto por compra. Rechazos: `MandateAgentMismatch`,
   `MandatePrincipalMismatch`, `MandateVenueNotAllowed`,
   `MandateProductNotAllowed`, `MandateAssetNotAllowed`,
   `MandateWindowMismatch`, `MandateAmountExceeded`.
4. **Contra lo que pide el comercio** (`reconcileTerms`,
   `apps/agent/src/policy/terms.ts`): mismo comercio, mismo activo, monto
   exacto y destinatario permitido. Rechazos: `TermsVenueMismatch`,
   `TermsAssetMismatch`, `TermsAmountMismatch`, `TermsPayeeNotAllowed`. El
   total del día lo lleva el registro de gasto del rail local.
5. **En la red, otra vez** (`__check_auth` del `policy_rail`): la firma del
   `owner`, la vigencia del rail, una sola invocación `transfer` del activo
   desde el propio rail, `per_tx` y `per_day`. Si algo falla, la simulación
   falla y no se envía nada.

Los pasos 1 a 4 corren en el agente; el 5, en la red, y no depende de que el
agente sea honesto (evidencia en T122: `Error(Contract, #7)`).

## 5. Contratos desplegados (testnet)

| Contrato | Id | Wasm (sha256) | Para qué |
|---|---|---|---|
| `agent-registry` | `CARC2SIQ3GTL34LVHSTGFRKDNNBYUXCSMGAUGKWGMT6Z2SDY6FXPP2DT` | `b2ff9231f27555c1cfd94e6d480529a5cf316736c969410aad3c57a8953cf151` | Credenciales y Mandatos: anclaje, estado, revocación |
| `policy_rail` compartido | `CBWRKZ3SL4EAXOS5XAV6CXVRRTBNPPFFC5TKSLW3FTXFTQZNBAZY6Z5U` | `8690d1f5ce18e6ef6209a400918d095450c01d7a8621ac795f404e11ea7e3175` | Pagos del piloto: 0.0020000 por compra, 0.0100000 por día |
| `policy_rail` UCP | `CA6P4KKV77Q5J4AH6L4V7S42QNF6DLKUAM4SCOQO4GMLB7V7STC5VIYP` | `8690d1f5ce18e6ef6209a400918d095450c01d7a8621ac795f404e11ea7e3175` | Compras UCP: 3.0000000 por compra, 5.0000000 por día (`E-5`) |
| `receipt-registry` | `CADILO6QYG3CT2PXEWIKOYLUACPXEP4P645L5HF6WVI2K7BSVN23ZTM5` | `e0a871502c4bdf5a396483664f32b5006083648b7ac9546c9ce2a7ed105ac13f` | Hash de cada recibo |
| USDC (SAC) | `CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA` | — | Emisor `GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5`, 7 decimales |

Facilitator x402: Built on Stellar (OpenZeppelin Channels),
`https://channels.openzeppelin.com/x402/testnet`.

Errores del `policy_rail` (`contracts/policy-rail/src/lib.rs`):
`NotInitialized` = 1, `UnknownSigner` = 2, `AlreadyExpired` = 3,
`InvalidLimit` = 4, `Expired` = 5, `UnexpectedInvocation` = 6,
`PerTxExceeded` = 7, `PerDayExceeded` = 8, `InvalidWithdrawAmount` = 9.
Solo el `principal` puede `withdraw` y `set_owner`.

Fuente de los ids: `deployments/testnet.json` y
`deployments/vitrinee-testnet.json`.

## 6. Lo que UCP no resuelve y un SEP debería fijar

Las seis de T120 (sección 8 de
[T120-handler-stellar-ucp.md](T120-handler-stellar-ucp.md)), confirmadas al
construir, más tres que aparecieron después:

1. **No hay handlers de stablecoins ni de pagos en cadena** en UCP. Este es de
   los primeros.
2. **Moneda de precio distinta del activo de liquidación.** UCP asume una
   moneda ISO 4217; aquí la tasa viaja en el `config` del handler (`E-3`).
3. **El binding es lógico, no criptográfico.** La autorización Soroban firma
   destinatario, activo, monto, nonce y vencimiento, pero no el id de la
   sesión. El comercio compensa exigiendo requisitos idénticos a los de la
   sesión (`E-7`). Un SEP podría fijar cómo atarlo.
4. **No hay lugar para recibos verificables en la orden.** De ahí la extensión
   `com.agentpey.shopping.receipt`.
5. **AP2 en UCP exige ECDSA** (ES256/384/512) y mandatos SD-JWT; el Mandato y
   los recibos de AgentPey usan Ed25519, la curva de Stellar. Exportar exige un
   segundo par de llaves o que AP2 acepte EdDSA (T123).
6. **Las disputas** son un `adjustment` de texto libre en la orden, sin proceso (T124).
7. **Resultado dudoso de la liquidación.** Ni UCP ni x402 dicen qué hacer
   cuando el facilitator no responde o da por fallida una transacción ya
   emitida. AgentPey retiene la compra y concilia a mano (`E-6`). Un SEP
   debería fijar cómo se consulta y se cierra.
8. **Idempotencia del pedido en la plataforma.** Shopify no tiene clave de
   idempotencia al crear un pedido (`VT-35`): una caída entre crear el pedido
   y guardarlo puede duplicarlo.
9. **Un error en los esquemas oficiales de UCP `2026-04-08`:** el esquema del
   perfil referencia `../schemas/ucp.json` desde
   `https://ucp.dev/schemas/discovery/profile.json`, que no resuelve
   ([evidencia de T121](evidencia/T121.md)).

## 7. Reproducir

```bash
pnpm run vitrinee:ucp:list -- https://agentcommerce.vitrinee.agentpey.com
```

```bash
pnpm run ucp:buy -- --store https://agentcommerce.vitrinee.agentpey.com --product 67624104591666
```

```bash
pnpm run vitrinee:verify -- .vitrinee/last-ucp-receipt.jws
```

```bash
pnpm run ucp:probe-per-tx -- --store https://agentcommerce.vitrinee.agentpey.com --product 67624104591666 --quantity 2
```

`ucp:buy` mueve USDC de testnet y crea un pedido real; necesita `.env.local`
con el rail UCP (sección 5). Los otros tres no mueven plata.
