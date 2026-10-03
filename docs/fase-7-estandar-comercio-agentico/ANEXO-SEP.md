# Anexo técnico · Agentic Commerce on Stellar

> Material para el borrador de SEP "Agentic Commerce on Stellar" (`P-14`),
> que se escribe en el chat de estrategia. AgentPey es la implementación de
> referencia. Este anexo **no es el SEP**: es la descripción exacta de lo que
> la implementación hace hoy, con cada formato tomado del código y cada id
> tomado de `deployments/`.
>
> Fecha: 2026-10-01 · Red: Stellar testnet · UCP `2026-04-08` (`E-2`) ·
> x402 versión 2 · AP2 `v0.2` · Tareas T125 y T123 (sección 4.5). Un test
> (`scripts/fase7-anexo.test.ts`) falla si deja de coincidir con el código o
> con `deployments/`: los ejemplos JSON de 2.1, 2.3 y 4.5 contra sus esquemas,
> los campos del recibo, cada función y archivo citados, los códigos de
> rechazo y de error, y cada contrato en su fila.
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
| 2 | El principal fondea un **`policy_rail`**: una cuenta-contrato con límites por compra y por día, de la que solo él puede retirar. Que esos límites coincidan con los del Mandato es una convención de despliegue (`E-5`): nada en la red los ata | Principal | Saldo y límites en el contrato |
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
| Nota | `agentcommerce` es una tienda de prueba propia: el `principal` del rail y la cuenta que cobra son la misma wallet, así que la plata vuelve a su dueño |

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
sobre el contrato del activo. Hoy van con credenciales de dirección v1 porque
la versión actual del facilitator no lee v2 (`policy-rail-payer.ts`): es una
limitación de esa versión, no parte del formato. Es lo mismo que en x402 viaja en el header `PAYMENT-SIGNATURE`,
con la versión escrita al estilo UCP y sin `resource`, que en UCP no existe.

### 2.4 Lo que comprueba el comprador antes de firmar

En este orden (`executeUcpPayment`, `apps/agent/src/payment/ucp.ts`):

1. El perfil declara el handler con `spec` y `schema` en `agentpey.com`, y el
   `endpoint` REST del servicio está en el mismo origen que la tienda.
2. La sesión está `ready_for_complete` y `binding.checkout_id` es la sesión que abrió.
3. `payTo`, `asset` y `network` de los requisitos son iguales a `pay_to`,
   `asset.contract` y `network` del perfil. La respuesta del checkout la
   escribe el comercio; el perfil es lo que publicó.
4. `toPaymentTerms` (`apps/agent/src/payment/x402.ts`): `scheme` `exact` y red
   `stellar:testnet`, el activo según el registro de comercios, y la cuenta
   fijada del comercio **cuando el directorio fija una** (los comercios de
   Vitrinee la tienen, `C-141`).
5. `policyRail.authorise` contra la intención, el alcance de la credencial y
   el Mandato (sección 4.3, paso 3). Recibe un Mandato **ya verificado**: su
   firma y su estado en el registro se comprueban antes, al arrancar el agente
   y al crear la intención, no justo antes de pagar.

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
| `success: false` sin transacción emitida, en la respuesta o en una excepción que la trae | Vuelve a `ready_for_complete`; error `payment_failed` |
| Excepción sin respuesta legible, timeout, o `success: false` con transacción emitida | Queda `complete_in_progress`, mensaje `payment_pending`; **nunca se vuelve a liquidar** |

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
| `orderId` | id del pedido de Vitrinee (`ord_…`), no el de la plataforma |
| `platformOrderId` | id en la plataforma, o `null` si la plataforma rechazó el pedido después del pago (`VT-10`) |
| `platform` | texto libre; hoy `shopify`, `jumpseller` o `mock` |
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

1. **Firma y contenido:** el cuerpo cumple el esquema, el DID del `kid` es
   `merchantDid`, y la firma Ed25519 verifica contra la llave del DID. Además el
   recibo no se contradice (`receiptIncoherence`,
   `packages/vitrinee-core/src/receipt.ts`, desde T132): `amountUSDC` es el
   mismo monto que `amountUSDCAtomic`, cada `unitPriceUSDC` es el mismo que su
   `unitPriceUSDCAtomic`, y `asset` es el contrato de USDC que el verificador
   tiene fijo. Sin red. `signReceipt` se niega a firmar un recibo que no lo
   cumple (`ReceiptInvalid`).
2. **Anclaje:** `get(sha256(jws))` existe en `receipt-registry`, con
   `merchant` igual a la cuenta del DID, `amount` igual a `amountUSDCAtomic` y
   `order_ref` igual a `orderId`.
3. **Pago:** en Horizon (`packages/vitrinee-anchor/src/settlement.ts`),
   `settlementTxHash` existe, fue exitosa, y movió exactamente
   `amountUSDCAtomic` del pagador a `merchantAccount`, en el USDC que el
   verificador tiene fijo, que por el check 1 es el mismo `asset` del recibo.

Lo que estos checks no miran: que una misma transacción respalde un solo
recibo (brecha 10). La tienda de Vitrinee lo garantiza al emitir
(`fulfilPaidPurchase`: un pago, un pedido, un recibo, también con dos
solicitudes simultáneas), pero quien verifica un recibo suelto no puede
comprobarlo.

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
asíncrono: `anchor.status` pasa de `pending` a `anchored` (o a `failed` si se
agotan los reintentos), y se ve leyendo la orden (`GET /ucp/v1/orders/{id}`).

**La disputa en la orden (T127, `E-23`, `E-24`).** Si el recibo tiene un reclamo
en AgentResolve (sección 4.6), la orden lo muestra de dos formas, leídas del
contrato `agent-resolve` en cada consulta: un ajuste nativo de UCP, que cualquier
cliente entiende, y el campo `receipt.dispute`, con lo necesario para comprobarlo
contra la red (`get(receipt)` del contrato). Solo lo que el contrato guarda: el
razonamiento del veredicto no se publica.

```json
"adjustments": [
  { "id": "dispute_12075d85a757b963", "type": "dispute", "status": "completed",
    "occurred_at": "2026-10-01T21:19:47.000Z",
    "description": "Refund claim resolved in AgentResolve: rejected, nothing refunded." }
],
"receipt": {
  "…": "…",
  "dispute": {
    "contract": "CCYMGX56FJ65EVXUY2M4BTVBCCOBXBTAMGSCWN5X4TQLQTCCEAHDCD3F",
    "status": "resolved",
    "claim_hash": "12075d85a757b96394b63a52e19dc18842b335eb4f6a3d321b408202d9f7d37f",
    "asset": "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
    "amount_atomic": "15684211",
    "opened_at": "2026-10-01T20:58:02.000Z",
    "verdict_hash": "ff3ef9b02f6f6791db924fe97a6c2707c50a2d792deb9550a8214f2228d83df3",
    "refund_atomic": "0",
    "resolved_at": "2026-10-01T21:19:47.000Z"
  }
}
```

Abierta, el ajuste está en `pending`. Con reembolso, lleva un `total` negativo en
la moneda de la orden, la proporción del total que representa lo devuelto
(`VT-38`); el monto exacto en USDC es `refund_atomic`.

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
  "credentialStatus": { "type": "AgentPassRegistry2026", "registry": "<agent-registry>" }
}
```

Un Mandato también puede llegar firmado por la wallet del principal con
SEP-53 en vez de como JWS (`verifyWalletSignedMandateOnChain`,
`packages/mandate/src/anchor.ts`). El estado en la red se comprueba igual.

`payTo` y `products` son opcionales: si faltan, no se comprueban (y la
respuesta lo dice); si están, un arreglo vacío no permite nada.

### 4.2 Anclaje y revocación

`agent-registry.anchor(issuer, cred_hash, subject, expires_at)`, con
`cred_hash = sha256(jws)`, `subject` el agente y `expires_at` el `validUntil`.
El principal revoca con `revoke(issuer, cred_hash)`, desde fuera del agente:
ningún prompt lo deshace. Lo que la revocación detiene es la verificación del
Mandato en el agente; no detiene por sí sola al `policy_rail` (sección 4.4).

### 4.3 Verificación, en orden

1. **Fuera de línea** (`verifyMandate`, `packages/mandate/src/sign.ts`): la firma
   contra la llave del `issuer`, y después la ventana `validFrom`–`validUntil`.
2. **En la red** (`verifyMandateOnChain`, `packages/mandate/src/anchor.ts`): que el
   registro nombrado sea el que el verificador confía (`RegistryMismatch`), que
   el hash esté `Active` (`MandateRevoked`, `MandateUnknown`, `MandateExpired`),
   y que el principal siga registrado y activo.
3. **Antes de pagar** (`authorise`, `apps/agent/src/policy/policy-rail.ts`), en este orden:
   1. `reconcileTerms` (`apps/agent/src/policy/terms.ts`): lo que pide el
      comercio contra la intención. Mismo comercio, mismo activo, monto exacto
      y destinatario permitido por el Mandato. Rechazos: `TermsVenueMismatch`,
      `TermsAssetMismatch`, `TermsAmountMismatch`, `TermsPayeeNotAllowed`.
   2. `checkScope` (`apps/agent/src/scope/scope.ts`): la intención contra el
      alcance de la credencial. Rechazos: `ScopeActionNotAllowed`,
      `ScopeVenueNotAllowed`, `ScopeAssetNotAllowed`, `ScopeCurrencyMismatch`,
      `ScopeAmountExceeded`.
   3. `checkMandate` (`apps/agent/src/mandate/check-mandate.ts`, pura): la
      intención contra el Mandato. Agente, principal, acción, comercio,
      producto, activo, moneda, ventana y monto por compra. Rechazos:
      `MandateAgentMismatch`, `MandatePrincipalMismatch`,
      `MandateActionNotAllowed`, `MandateVenueNotAllowed`,
      `MandateProductNotAllowed`, `MandateAssetNotAllowed`,
      `MandateCurrencyMismatch`, `MandateWindowMismatch`,
      `MandateAmountExceeded`.
   4. El total del día, con el registro de gasto, contra los dos límites
      diarios: `ScopeDailyLimitExceeded`, `MandateDailyLimitExceeded`.
4. **En la red** (`__check_auth` del `policy_rail`,
   `contracts/policy-rail/src/lib.rs`): la firma del `owner`, la vigencia del
   rail (`valid_until`), una sola invocación `transfer` del activo del rail
   **desde** el propio rail, monto positivo, `per_tx` y `per_day`. Si algo
   falla, la simulación falla y no se envía nada.

Los pasos 1 a 3 corren en el agente. El 4 corre en la red y no depende de que
el agente sea honesto, **pero solo para lo que comprueba** (sección 4.4).
Evidencia en T122: `Error(Contract, #7)`.

### 4.4 Lo que la red no comprueba

`__check_auth` no consulta `agent-registry` y no restringe a quién va el
`transfer`. En consecuencia:

- **Revocar el Mandato no corta el rail.** Un agente honesto deja de pagar
  porque su verificación lo rechaza; pero quien tenga la llave `owner` puede
  seguir firmando transferencias hasta `per_tx` y `per_day`, hasta que el rail
  venza (`valid_until`).
- **El destinatario no está fijado en la red.** Con la llave `owner` se puede
  pagar a cualquier cuenta, dentro de los mismos límites. El destinatario lo
  comprueban el agente (chequeos 3 y 4 de la sección 2.4, y `TermsPayeeNotAllowed`) y el
  comercio, no el contrato.
- **Cómo se corta del todo:** el `principal` llama `set_owner` (cambia la llave
  que puede gastar) o `withdraw` (saca los fondos). Las dos exigen su firma.

Es la brecha 11 para el SEP.

### 4.5 El Mandato como mandatos AP2 v0.2 (T123)

AP2 `v0.2` (repo `google-agentic-commerce/AP2`, commit `e1ea56d`, 2026-04-28)
tiene dos tipos de mandato, el de checkout y el de pago, cada uno **abierto**
(límites más la llave del agente en `cnf`) o **cerrado** (firmado por el agente
al comprar). El Mandato de AgentPey corresponde a los dos abiertos, en el modo
"sin humano presente" de AP2. AgentPey los emite como SD-JWT y los firma como
"Trusted Agent Provider", porque la wallet del principal firma SEP-53 y no puede
producir un JWS (`E-8`). Se emite un par por compra (`E-11`): AP2 exige que el
mandato abierto de checkout nombre los productos y que el de pago apunte a él.

`exportMandateAsAp2` (`apps/agent/src/ap2/export.ts`) emite el par solo después
de cuatro pasos (`E-13`): la credencial del agente y el Mandato se verifican en
la red (firma, ventana, anclados y no revocados); la intención de compra se
verifica contra la llave del agente y tiene que nombrar esa credencial, ese
agente y ese principal; y `checkScope` y `checkMandate`, sin cambios, tienen que
permitirla. Revocar la credencial corta también la exportación. La firma y el formato están en
`issueOpenMandatePair` (`packages/ap2/src/issue.ts`); la verificación, en
`verifyOpenMandatePair` (`packages/ap2/src/verify.ts`), con los esquemas
`openCheckoutMandateSchema` y `openPaymentMandateSchema`
(`packages/ap2/src/schemas.ts`).

**Formato.** SD-JWT sin Key Binding, `typ: "dc+sd-jwt"`, `alg` `EdDSA` (la llave
del emisor es un `did:stellar`) o `ES256` (`E-9`). La raíz firmada lleva `iss`,
`iat`, el claim `com.agentpey.mandate` y `delegate_payload` con un solo
elemento divulgable: el mandato. Dentro, el producto, el comercio, el
beneficiario y el instrumento también son divulgables.

**Correspondencia.**

| Mandato de AgentPey | Mandato AP2 abierto |
|---|---|
| `credentialSubject.id` (el agente) | `cnf.jwk`, la llave Ed25519 de su `did:stellar` |
| `perTx` y `perDay` de la credencial y del Mandato | `payment.amount_range.max`: el menor de los cuatro, en centavos, redondeado hacia abajo (`E-12`) |
| `grant.limits.currency` | `payment.amount_range.currency` (`"USDC"`: no es ISO 4217, brecha 13) |
| el acumulado de `perDay` | no se exporta como restricción: lo aplica el `policy_rail` (`E-10`, brecha 12) |
| la venue de la intención | `checkout.allowed_merchants` y `payment.allowed_payees` |
| el activo de la intención | `payment.allowed_payment_instruments`, `type: "stellar_x402"` |
| producto y cantidad de la intención | `checkout.line_items` |
| `validUntil` y el vencimiento de la intención | `exp`: el primero entre la intención, la credencial, el Mandato y una hora (`E-10`) |
| `credentialStatus` y el hash del Mandato | `com.agentpey.mandate`: `mandate_id`, `hash`, `registry` |

#### Mandato abierto de checkout (el elemento de `delegate_payload`)

```json
{
  "vct": "mandate.checkout.open.1",
  "constraints": [
    {
      "type": "checkout.line_items",
      "items": [{ "id": "line_1", "acceptable_items": [{ "id": "67624104591666", "title": "Imán de cobre Atacama" }], "quantity": 1 }]
    },
    {
      "type": "checkout.allowed_merchants",
      "allowed": [{ "id": "vitrinee-agentcommerce:GD2MCESI2DMMOU4F2SI6ZHDZDDCN5LA7PMKUVZSKTKVGU5RLTCNIK5GN", "name": "agentcommerce.vitrinee.agentpey.com", "website": "https://agentcommerce.vitrinee.agentpey.com" }]
    }
  ],
  "cnf": { "jwk": { "kty": "OKP", "crv": "Ed25519", "x": "FeJ0n1-3nBc5yW454qbzKgUhcjo6VEzH7TjogETMOGI" } },
  "iat": 1790884672,
  "exp": 1790885571
}
```

#### Mandato abierto de pago

```json
{
  "vct": "mandate.payment.open.1",
  "constraints": [
    { "type": "payment.reference", "conditional_transaction_id": "NUCG8d_BCMni-Lw8nsNh4mI5iHcRcQX95UnNQHkGz14" },
    { "type": "payment.amount_range", "currency": "USDC", "max": 300 },
    {
      "type": "payment.allowed_payees",
      "allowed": [{ "id": "vitrinee-agentcommerce:GD2MCESI2DMMOU4F2SI6ZHDZDDCN5LA7PMKUVZSKTKVGU5RLTCNIK5GN", "name": "agentcommerce.vitrinee.agentpey.com", "website": "https://agentcommerce.vitrinee.agentpey.com" }]
    },
    {
      "type": "payment.allowed_payment_instruments",
      "allowed": [{ "id": "USDC:CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA", "type": "stellar_x402", "description": "USDC on Stellar, paid with x402 (exact)" }]
    },
    { "type": "payment.execution_date", "not_after": "2026-10-01T20:12:51.392Z" }
  ],
  "cnf": { "jwk": { "kty": "OKP", "crv": "Ed25519", "x": "FeJ0n1-3nBc5yW454qbzKgUhcjo6VEzH7TjogETMOGI" } },
  "iat": 1790884672,
  "exp": 1790885571
}
```

Son los del export real de T123 ([evidencia](evidencia/T123.md)), sobre el
Mandato `e5eae6ce…` anclado en `agent-registry`: 3,00 USDC por compra son
`300` centavos, y el par vence con la intención (15 minutos). `conditional_transaction_id`
es el `sd_hash` del token de checkout: `base64url(sha256(token))`, con los
disclosures incluidos, igual que lo calcula la librería oficial de AP2.

**Verificación, en orden.** Firma con la llave del emisor que elige quien
verifica (el `alg` tiene que ser el de esa llave) → disclosures (uno que no
corresponda a ningún digest firmado rechaza el token) → raíz → un solo mandato
→ su `vct` → tipos de restricción → esquema (cada lista de permitidos con al
menos un elemento revelado, como pide AP2) → ventana (`iat`, `exp`, bordes
inclusivos). Para el par, además, `payment.reference` tiene que ser el
`sd_hash` del de checkout, y los dos tienen que coincidir en emisor, `cnf`,
ventana y Mandato de origen.
Códigos: `Ap2MandateInvalid`, `Ap2SignatureInvalid`, `Ap2DisclosureMismatch`,
`Ap2MandateExpired`, `Ap2MandateNotYetValid`, `Ap2ReferenceMismatch`,
`Ap2ConstraintUnsupported`.

**Interoperabilidad.** La librería oficial de AP2 en Python (commit `e1ea56d`)
verifica los dos mandatos del export real en Ed25519 y los del mismo export
firmado con llaves P-256 de un solo uso (`scripts/ap2-crosscheck/verify.py`).
Lo que no se hace: negociar `dev.ucp.shopping.ap2_mandate` en el checkout UCP,
ni mandatos cerrados (`E-8`, brecha 14).

### 4.6 Disputas: AgentResolve (T124)

Quien pagó un recibo de Vitrinee puede pedir su dinero de vuelta. El reembolso
sale de una **garantía del comercio** en USDC, guardada en el contrato
`agent-resolve` (`E-14`); el flujo de pago (x402, `policy_rail`, recibo) no
cambia.

**Recorrido.**

1. **Reclamo.** El pagador firma un `AgentResolveClaim`
   (`agentResolveClaimSchema`, `packages/resolve/src/claim.ts`), un JWS con
   `typ: "agentresolve-claim+jwt"` que lleva el recibo entero, el motivo
   (`not_delivered`, `not_as_described`, `damaged`, `unauthorized`, `other`), la
   descripción, hasta cinco evidencias y el monto pedido. Si el pagador es un
   contrato (un `policy_rail`), firma la llave que devuelve su `owner()`.
2. **Apertura.** El árbitro (`E-16`) verifica los tres checks del recibo, la
   firma del reclamo, la ventana de reembolso y el monto (`checkClaim`), y llama
   `open` en el contrato. El contrato lee `receipt-registry` por su cuenta: el
   comercio y el tope salen del recibo anclado, nunca de quien llama. El monto
   queda bloqueado en la garantía de ese comercio.
3. **Respuesta del comercio (T126).** El dueño del comercio responde en
   `agentpey.com/resolve/responder` con el reclamo que le envía el árbitro: una
   posición (`accept_full`, `accept_partial` con monto, `contest`), sus
   descargos y hasta cinco evidencias (`agentResolveResponseSchema`,
   `packages/resolve/src/response.ts`). Firma con su wallet (SEP-53) un mensaje
   legible que lleva el `sha256` del JSON canónico de la respuesta
   (`responseChallengeMessage`), desde la cuenta de cobro que el comercio puso
   en el recibo (`merchantAccount`, `E-20`). `verifyMerchantResponse` exige esa
   cuenta y que la respuesta apunte al `claim_hash` de la disputa en la red. La
   respuesta viaja como archivo (`E-21`). Sin respuesta, no se decide antes de
   48 h desde `opened_at` (`E-22`).
4. **Veredicto.** Claude Opus 5.5 (`E-17`) lee los hechos del recibo, el
   reclamo y la respuesta, los dos últimos como datos no confiables entre
   `<claim_data>` y `<response_data>`, y
   propone `refund_full`, `refund_partial` o `rejected` con su razonamiento
   (`createClaudeArbiter`, `packages/resolve/src/arbiter.ts`). El código lo
   acota al monto en disputa (`decideDispute`, `packages/resolve/src/decide.ts`)
   y calcula `verdict_hash` = `sha256` del JSON canónico del veredicto. Cada
   veredicto queda archivado; solo el último se puede ejecutar. El veredicto
   lleva `responseHash` (o `null` si el comercio no respondió), así que el hash
   anclado cubre también la respuesta, sin tocar el contrato.
5. **Confirmación y pago.** Una persona confirma pasando ese hash exacto
   (`E-18`); recién entonces el script del árbitro llama `resolve`, que guarda
   el hash del veredicto junto al recibo y paga el reembolso desde la garantía
   al pagador. La confirmación es un paso del procedimiento, no una regla de la
   red (brecha 18). El veredicto es final: un recibo admite una sola disputa.

**Lo que la red garantiza**, decida lo que decida el árbitro o su modelo
(`contracts/agent-resolve/src/lib.rs`):

| Regla | Error |
|---|---|
| El recibo tiene que estar anclado en `receipt-registry` | `ReceiptNotAnchored` = 1 |
| La disputa se abre dentro de la ventana, contada desde el anclaje | `ClaimWindowClosed` = 2 |
| El monto en disputa no supera el recibo anclado | `AmountExceedsReceipt` = 4 |
| Una sola disputa por recibo, abierta o resuelta | `AlreadyDisputed` = 5 |
| Solo se bloquea la garantía del comercio del recibo, y si alcanza | `InsufficientGuarantee` = 6 |
| No se resuelve dos veces | `AlreadyResolved` = 8 |
| El reembolso no supera lo bloqueado | `RefundExceedsClaim` = 9 |
| El comercio no retira lo bloqueado por disputas abiertas | `InsufficientFree` = 10 |
| `open` y `resolve` exigen la firma del árbitro | autorización de Soroban |

Errores del lado de AgentPey: `ResolveClaimInvalid`, `ResolveReceiptInvalid`,
`ResolveClaimantNotPayer`, `ResolveClaimWindowClosed`, `ResolveAmountExceeded`,
`ResolveVerdictInvalid`, `ResolveConfirmationMismatch`, y para la respuesta
del comercio `ResolveResponseInvalid`, `ResolveRespondentNotMerchant`,
`ResolveResponseMismatch`, `ResolveResponsePending`.

## 5. Contratos desplegados (testnet)

| Contrato | Id | Wasm (sha256) | Para qué |
|---|---|---|---|
| `agent-registry` | `CARC2SIQ3GTL34LVHSTGFRKDNNBYUXCSMGAUGKWGMT6Z2SDY6FXPP2DT` | `b2ff9231f27555c1cfd94e6d480529a5cf316736c969410aad3c57a8953cf151` | Credenciales y Mandatos: anclaje, estado, revocación |
| `policy_rail` compartido | `CBWRKZ3SL4EAXOS5XAV6CXVRRTBNPPFFC5TKSLW3FTXFTQZNBAZY6Z5U` | `8690d1f5ce18e6ef6209a400918d095450c01d7a8621ac795f404e11ea7e3175` | Pagos del piloto: 0.0020000 por compra, 0.0100000 por día |
| `policy_rail` UCP | `CA6P4KKV77Q5J4AH6L4V7S42QNF6DLKUAM4SCOQO4GMLB7V7STC5VIYP` | `8690d1f5ce18e6ef6209a400918d095450c01d7a8621ac795f404e11ea7e3175` | Compras UCP: 3.0000000 por compra, 5.0000000 por día (`E-5`) |
| `receipt-registry` | `CADILO6QYG3CT2PXEWIKOYLUACPXEP4P645L5HF6WVI2K7BSVN23ZTM5` | `e0a871502c4bdf5a396483664f32b5006083648b7ac9546c9ce2a7ed105ac13f` | Hash de cada recibo |
| `agent-resolve` | `CCYMGX56FJ65EVXUY2M4BTVBCCOBXBTAMGSCWN5X4TQLQTCCEAHDCD3F` | `fbefa298e9f5554cc2cf8930c938680d493324a6cb5bd552340597626ca210b9` | Garantías de comercios y disputas sobre recibos (T124); árbitro `GAEB2EG3CSMEHLCYKHPPOMBRVISQOTBRS7T4K2D2EMNOA2AMUSJ32VV6`, ventana de 864000 s |
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
construir, más trece que aparecieron después:

1. **No hay handlers de stablecoins ni de pagos en cadena** en UCP. Este es de
   los primeros.
2. **Moneda de precio distinta del activo de liquidación.** UCP asume una
   moneda ISO 4217; aquí la tasa viaja en el `config` del handler (`E-3`).
3. **El binding es lógico, no criptográfico.** La autorización Soroban firma
   destinatario, activo, monto, nonce y vencimiento, pero no el id de la
   sesión: dos sesiones del mismo comercio por el mismo monto son
   intercambiables, aunque cada credencial se liquida una sola vez. Lo que
   protege es que el comercio liquida los requisitos **guardados** de la
   sesión y el facilitator verifica la transacción contra ellos; el `accepted`
   de la credencial es solo lo que la plataforma declara (`E-7`). Un SEP podría
   fijar cómo atar la firma a la sesión.
4. **No hay lugar para recibos verificables en la orden.** De ahí la extensión
   `com.agentpey.shopping.receipt`.
5. **Algoritmos de AP2.** AP2 `v0.2` exige ECDSA para el checkout que firma el
   comercio (`specification.md`, líneas 155–157) y su sección de seguridad lo
   contradice (permite Ed25519 con entropía en el checkout); el issue AP2 #268,
   abierto, propone quedarse con lo segundo. Los mandatos abiertos de AgentPey
   van en Ed25519 y la librería oficial los verifica; pero la misma librería
   solo sigue un `cnf` P-256 cuando el agente cierra el mandato. Un SEP debería
   pedir Ed25519 en los dos lugares, para que una sola llave Stellar alcance
   (T123, `E-9`).
6. **Las disputas** son un `adjustment` de texto libre en la orden de UCP, sin
   proceso. AgentResolve (sección 4.6) las resuelve fuera de UCP, con una
   garantía del comercio en un contrato, y desde T127 la orden muestra el estado
   como ajuste más `receipt.dispute` (sección 3.4). Pero UCP no tiene un formato
   para el proceso: quién abre, en qué plazo, cómo se prueba, y el ajuste solo
   puede expresar el reembolso en la moneda de la orden. Un SEP debería fijarlo.
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
10. **Una transacción, un recibo: la red no lo impide.** Desde T132 el
    verificador sí exige que el recibo no se contradiga (los dos montos dicen lo
    mismo y `asset` es el USDC confiado), y la tienda no emite dos recibos sobre
    un pago. Pero `receipt-registry` guarda el recibo por su hash y no guarda el
    hash de la transacción: un comercio que firmara y anclara dos recibos
    distintos sobre el mismo pago pasaría los tres checks con los dos. Lo
    cerraría que el registro guarde el hash de la transacción y rechace un
    segundo anclaje sobre ella, lo que pide un contrato nuevo. Un SEP debería
    exigir la coherencia con DEBE, y la unicidad en el registro.
11. **La revocación no llega a la cuenta pagadora** (sección 4.4). Un SEP
    podría pedir que la cuenta pagadora consulte el estado del Mandato, o que
    fije el destinatario, a costa de una lectura más por pago.
12. **AP2 no tiene un tope diario.** `payment.budget` es un total, y una
    restricción propia haría fallar a cualquier verificador AP2. `perDay` no se
    exporta (sección 4.5, `E-10`).
13. **Montos en un activo sin código ISO 4217.** `payment.amount_range` pide
    ISO 4217 y "minor (cents) unit"; USDC en Stellar tiene 7 decimales y
    ningún código. El riesgo es concreto: escrito en unidades de Stellar, 3,00
    USDC (`30000000`) se lee como 300.000 en centavos. El export usa `"USDC"` y
    centavos redondeados hacia abajo (`E-12`), así que nunca permite más de lo
    autorizado, a costa de perder precisión bajo el centavo. Un SEP debería
    fijar la unidad de los activos de Stellar.
14. **AP2 en el checkout UCP, y mandatos cerrados.** Negociar la extensión deja
    la sesión "security locked" y exige la firma del comercio en cada
    respuesta; en UCP `2026-08-25` la extensión se renombró
    (`dev.ucp.common.payment.ap2_mandate`). Tampoco hay revocación en AP2: un
    mandato abierto vale hasta su `exp`. Y "un par por compra" (`E-11`) no se
    hace cumplir: la misma intención se puede exportar otra vez hasta que vence,
    cada par con el mismo tope y la misma ventana. T123 exporta y verifica
    fuera de línea (`E-8`).
15. **La respuesta del comercio no vive en la red.** Desde T126 el comercio
    responde firmado (sección 4.6) y el veredicto ancla el hash de la respuesta,
    pero el plazo de 48 h (`E-22`) lo aplica el script del árbitro, no el
    contrato, y el árbitro sigue sin poder verificar la entrega. Un SEP debería
    fijar en la red el plazo y el formato de la respuesta.
16. **El comercio puede vaciar su garantía antes del reclamo** (`E-19`): solo lo
    bloqueado por una disputa abierta está protegido. Un retiro con aviso previo
    lo cerraría.
17. **El veredicto de un modelo no es determinista.** Pedirlo otra vez puede dar
    otro resultado. AgentResolve archiva cada veredicto y solo ejecuta el último
    confirmado por una persona; un SEP debería fijar cuántos intentos valen y
    cómo se publican.
18. **El árbitro es el único punto de confianza.** El contrato no puede saber
    quién pagó (`receipt-registry` no guarda el pagador), así que el destinatario
    del reembolso lo pone el árbitro en `open`; la confirmación humana (`E-18`)
    vive en su script, y la red no la exige; y una disputa abierta no vence: si
    el árbitro desaparece, el monto queda bloqueado. Con la llave del árbitro
    filtrada se podrían vaciar las garantías, recibo por recibo, dentro de la
    ventana. Un SEP debería anclar el pagador junto al recibo, exigir en la red
    una segunda firma para `resolve` y dar a las disputas un vencimiento.
19. **Sin anclaje no hay disputa.** Un comercio que no ancla un recibo, o lo
    ancla con otro monto (y `verifyReceipt` lo invalida), queda fuera de
    AgentResolve.
20. **El ida y vuelta con el comercio es a mano, y las dos partes pueden
    intentar manipular al árbitro.** El árbitro le envía el reclamo y el
    comercio le devuelve un archivo (`E-21`): no hay bandeja ni aviso, y una
    respuesta que no llega a tiempo deja la decisión con una sola parte. La
    respuesta es texto no confiable igual que el reclamo: un comercio puede
    intentar empujar el reembolso hacia abajo, y ningún tope del código ni del
    contrato lo impide; la defensa es la confirmación humana (`E-18`). Un SEP
    debería definir el canal y cómo se notifica a cada parte.

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

```bash
pnpm run ap2:export -- --store https://agentcommerce.vitrinee.agentpey.com --product 67624104591666 --ephemeral-p256
```

```bash
python scripts/ap2-crosscheck/verify.py .vitrinee/ap2
```

`ucp:buy` mueve USDC de testnet y crea un pedido real; necesita `.env.local`
con el rail UCP (sección 5). `ap2:export` ancla una credencial y un Mandato
(solo comisión). Los otros no mueven plata. El chequeo en Python necesita un
entorno virtual con `scripts/ap2-crosscheck/requirements.txt`.
