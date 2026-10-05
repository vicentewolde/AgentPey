# Evidencia · T135 · MPP charge desde un `policy_rail` (prueba técnica)

**Veredicto:** el SDK oficial de MPP para Stellar (`@stellar/mpp` 0.7.1) **no acepta** un pago MPP charge desde un
`policy_rail`. La red acepta la transferencia firmada por el rail (simulada en modo estricto, el `__check_auth` del
rail la autoriza), pero el servidor oficial rechazó los cuatro intentos, en dos modos (pull y patrocinado), por el tipo
de pagador y antes de enviar nada a la red: el saldo del rail no cambió. El servidor sin patrocinio sí cobró un pago
de control hecho con una llave clásica; el patrocinado no tiene control (§1). Por `R-4`, AgentPey no construye el pago por MPP: en el video se
dice **"evaluamos MPP"**, no "soportamos MPP".

## 1. Qué se probó y con qué

- `@stellar/mpp` 0.7.1 (`stellar/stellar-mpp-sdk`), `mppx` 0.6.31, `@stellar/stellar-sdk` 15.1.0 (el que pide
  `@stellar/mpp` como peer; AgentPey usa la 17) y `viem` 2.57.1, en un paquete aislado,
  [`scripts/mpp-probe/`](../../../scripts/mpp-probe/), fuera del workspace de pnpm.
- Un servidor MPP charge del SDK oficial (`Mppx.create` con `stellar.charge`), sin puerto: se le pasan objetos
  `Request` y devuelve `Response`. Cobra 0,01 USDC (`CBIELTK6…DAMA`) a la cuenta de cobro de `agentcommerce`
  (`GD2MCESI…K5GN`). Uno sin patrocinio y otro patrocinado (`feePayer`). El pagador de comisiones del patrocinado es
  una cuenta aleatoria **sin fondos**: no puede enviar nada a la red, así que ningún intento patrocinado puede mover
  plata, y tampoco hay un control patrocinado. Los intentos c y d valen por el motivo registrado, que el SDK da antes
  de usar la red, no por comparación con un control.
- El rail UCP `CBDRI5B7…D3YA` (`R-19`) y su dueño, la llave del agente `GAK6E5…FP2K`. La autorización del rail se
  firma como la firma `authorizeAsPolicyRailOwner` (`apps/agent/src/payment/policy-rail-payer.ts`): el dueño firma el
  payload de la entrada y se devuelve la estructura `{ public_key, signature }` que decodifica `__check_auth`.
- El script nunca envía nada a la red por su cuenta. El único camino es el del servidor del SDK: si aceptara a o b
  (sin patrocinio), enviaría la transferencia del rail firmada por el dueño, hasta 0,01 USDC y dentro de los topes del
  rail; el veredicto exige además que el saldo del rail se lea igual antes y después.
- Modo push: **no se probó** (decisión del usuario). Ahí el cliente envía la transacción a la red antes de que el
  servidor la verifique: desde el rail, la plata se movería y el cobro se rechazaría igual (la verificación de
  `signedHash` compara el `from` de la transferencia en la red con la cuenta `G…` declarada).

```
pnpm --dir scripts/mpp-probe install
pnpm --dir scripts/mpp-probe run probe
```

## 2. Lo que dice el código del SDK

- **Cliente** (`dist/charge/client/Charge.js`): `charge()` recibe un `Keypair` y arma `transfer(from = keypair.publicKey(), …)`.
  No hay forma de declarar un pagador contrato.
- **Servidor** (`dist/charge/server/Charge.js`, `publicKeyFromDID`): el pagador es `did:pkh:stellar:{red}:{llave}` y la
  llave se valida con `Keypair.fromPublicKey`, que rechaza una dirección `C…`. Pasa en los tres tipos de credencial
  (`transaction`, `signedHash`, `hash`).
- **Servidor, después:** el `from` de la transferencia tiene que ser esa misma llave (`Transfer "from" does not match
  credential source`).
- **Servidor patrocinado** (`dist/shared/verify-auth.js`, línea 34): "Only stellar-account (ed25519) authorizers are
  supported … Source-account and contract (custom `__check_auth`) authorizers cannot be verified off-chain and are
  rejected." Esta tercera barrera hoy no se alcanza: las dos primeras rechazan antes. El mismo camino ya simula la
  transacción en modo `enforce` antes de enviarla (`dist/charge/server/Charge.js`, línea 391).
- **Lo que haría falta** está en el texto del issue ([T135-issue-mpp.md](T135-issue-mpp.md)). La firma del rail ya
  tiene la forma `Vec<{public_key, signature}>` que el SDK verifica para una cuenta: la diferencia es el tipo de
  dirección y que el contrato aplica sus propias reglas (`__check_auth`), que solo la red puede evaluar.

## 3. La corrida final (2026-10-05)

Con el script corregido tras `/revisar` (§5), sin el control (`--skip-control`), porque el control ya había pagado en
la primera corrida (§4). El paso 0 simula en modo `enforce` la transferencia firmada por el rail: la red ejecuta su
`__check_auth` y la acepta, así que la firma es buena y los rechazos de a–d son por el pagador. El servidor responde a
todo rechazo con el mismo "Payment verification failed."; el motivo es el error interno del SDK, que el script
captura, y cada intento cuenta como rechazado solo si es el motivo esperado (`esperado … → sí`).

```
$ pnpm --dir scripts/mpp-probe run probe -- --skip-control
AgentPey · T135 · MPP charge desde un policy_rail · Stellar testnet
  SDK         @stellar/mpp 0.7.1, mppx 0.6.31, @stellar/stellar-sdk 15.1.0
  cobra       0.01 USDC (CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA) a GD2MCESI2DMMOU4F2SI6ZHDZDDCN5LA7PMKUVZSKTKVGU5RLTCNIK5GN
  rail        CBDRI5B72VWNZGRVUXNMUNOSYWXGB7RZLK5ITRVOVSGOS4VXPCRMD3YA
  dueño       GAK6E5E7L63ZYFZZZFXDTYVG6MVAKILSHI5FITGH5U4ORACEZQ4GFP2K
  saldos      rail 2.7684210 · dueño 591.4240000 · cobro 140.7363162

0. la firma del rail, simulada en modo enforce (no se envía)
  resultado   éxito: __check_auth del rail acepta esta transferencia exacta, firmada así

a. pull, el rail como pagador
  source      did:pkh:stellar:testnet:CBDRI5B72VWNZGRVUXNMUNOSYWXGB7RZLK5ITRVOVSGOS4VXPCRMD3YA
  status      402
  answer      {"type":"https://paymentauth.org/problems/verification-failed","title":"Verification Failed","status":402,"detail":"Payment verification failed.","challengeId":"U0Kix2E9zgcZ11c3wL4V84h3WjX-00vkeAMR2QhnjFg"}
  motivo      PaymentVerificationError: [stellar:charge] Credential source contains an invalid Stellar public key. {"source":"did:pkh:stellar:testnet:CBDRI5B72VWNZGRVUXNMUNOSYWXGB7RZLK5ITRVOVSGOS4VXPCRMD3YA"}
  esperado    Credential source contains an invalid Stellar public key → sí

b. pull, el dueño del rail declarado como pagador
  source      did:pkh:stellar:testnet:GAK6E5E7L63ZYFZZZFXDTYVG6MVAKILSHI5FITGH5U4ORACEZQ4GFP2K
  status      402
  answer      {"type":"https://paymentauth.org/problems/verification-failed","title":"Verification Failed","status":402,"detail":"Payment verification failed.","challengeId":"aDw8rNzrOpIvMpVhBIn_VSfHZB9af7ZXlcadrn1lDUg"}
  motivo      PaymentVerificationError: [stellar:charge] Transfer "from" does not match credential source. {"expected":"GAK6E5E7L63ZYFZZZFXDTYVG6MVAKILSHI5FITGH5U4ORACEZQ4GFP2K","actual":"CBDRI5B72VWNZGRVUXNMUNOSYWXGB7RZLK5ITRVOVSGOS4VXPCRMD3YA"}
  esperado    Transfer "from" does not match credential source → sí

c. patrocinado, el rail autoriza (dueño como source)
  source      did:pkh:stellar:testnet:GAK6E5E7L63ZYFZZZFXDTYVG6MVAKILSHI5FITGH5U4ORACEZQ4GFP2K
  status      402
  answer      {"type":"https://paymentauth.org/problems/verification-failed","title":"Verification Failed","status":402,"detail":"Payment verification failed.","challengeId":"kLBed6NgEngprhRHEQhciYpdqqdAEAwEs4iLWIOKIT8"}
  motivo      PaymentVerificationError: [stellar:charge] Transfer "from" does not match credential source. {"expected":"GAK6E5E7L63ZYFZZZFXDTYVG6MVAKILSHI5FITGH5U4ORACEZQ4GFP2K","actual":"CBDRI5B72VWNZGRVUXNMUNOSYWXGB7RZLK5ITRVOVSGOS4VXPCRMD3YA"}
  esperado    Transfer "from" does not match credential source → sí

d. patrocinado, el rail como pagador
  source      did:pkh:stellar:testnet:CBDRI5B72VWNZGRVUXNMUNOSYWXGB7RZLK5ITRVOVSGOS4VXPCRMD3YA
  status      402
  answer      {"type":"https://paymentauth.org/problems/verification-failed","title":"Verification Failed","status":402,"detail":"Payment verification failed.","challengeId":"YRfB7J7PSLmN2mJ44oWy4iW-o-EIDFLJjlkF-JGr6iQ"}
  motivo      PaymentVerificationError: [stellar:charge] Credential source contains an invalid Stellar public key. {"source":"did:pkh:stellar:testnet:CBDRI5B72VWNZGRVUXNMUNOSYWXGB7RZLK5ITRVOVSGOS4VXPCRMD3YA"}
  esperado    Credential source contains an invalid Stellar public key → sí

e. control: no corre en esta corrida (--skip-control); pagó en la corrida del 2026-10-05, tx 9e9836644e434df99a5b359a94a145bbe36cd1a3219ecebd6f32a6fb8efd9be9

  saldos      rail 2.7684210 · dueño 591.4240000 · cobro 140.7363162
  rail        sin cambios

VEREDICTO: el rail autoriza la transferencia (0), pero el SDK oficial rechaza el pago MPP charge desde él, por el pagador, en los cuatro intentos (a–d), y el rail no se movió.
  El control con una llave clásica no corrió aquí: ver la tx 9e9836644e434df99a5b359a94a145bbe36cd1a3219ecebd6f32a6fb8efd9be9.
```

## 4. El control: una llave clásica sí paga

De la primera corrida (2026-10-05 19:28 UTC), con el cliente oficial del SDK, la llave clásica del agente y el
servidor sin patrocinio. **No es
una forma de pagar de AgentPey** (`R-4`): muestra que el servidor cobra, y que el rechazo de a–d es por el pagador.

```
e. control: el cliente oficial del SDK con una llave clásica (no es una forma de pagar de AgentPey, R-4)
  status      200
  answer      {"paid":true}
  recibo      {"method":"stellar","reference":"9e9836644e434df99a5b359a94a145bbe36cd1a3219ecebd6f32a6fb8efd9be9","status":"success","timestamp":"2026-10-05T19:28:38.387Z"}
  saldos      rail 2.7684210 · dueño 591.4340000 · cobro 140.7263162   (antes)
  saldos      rail 2.7684210 · dueño 591.4240000 · cobro 140.7363162   (después)
```

En Horizon: transacción `9e9836644e434df99a5b359a94a145bbe36cd1a3219ecebd6f32a6fb8efd9be9`, exitosa, ledger
`5040986`, desde `GAK6E5…FP2K`. El dueño pagó 0,01 USDC; el rail, nada.

En esa misma primera corrida los intentos a–d no valen: el script armaba mal la cabecera (agregaba `Payment ` a un
valor que ya lo traía) y el servidor los rechazó como "Malformed Credential", sin leer el pagador. Por eso el
veredicto del script exige que cada rechazo traiga el motivo esperado del SDK (corregido en `/revisar`: en la primera
versión bastaba con que no fuera "malformed").

**Una pista falsa, descartada.** Una corrida intermedia falló leyendo XDR (`unknown SorobanCredentialsType member for
value 2`), y por un momento pareció que la red devolvía un tipo de credencial nuevo para un autorizador contrato.
Un diagnóstico aparte, leyendo la respuesta cruda de `simulateTransaction` cuatro veces, mostró el tipo de siempre
(`1`, address), y `stellar-sdk` 15 prepara la transacción sin problema. No es un hallazgo y no va al anexo.

## 5. `/revisar` (2026-10-05)

Sin bloqueantes. Dos importantes y siete sugerencias, todos corregidos a pedido del usuario, sin mover plata:

| # | Hallazgo | Corrección |
|---|---|---|
| 1 | El veredicto podía dar un falso "rechazado": cualquier 402 que no fuera "malformed" contaba (un timeout, un desafío vencido o un "ambiguous" después de enviar), una excepción también, y "el rail no se movió" se imprimía sin comparar saldos | Cada intento exige su motivo esperado del SDK; una excepción no cuenta; el saldo del rail tiene que leerse y ser igual antes y después |
| 2 | El servidor patrocinado nunca demostró que cobra: su pagador de comisiones no tiene fondos | Dicho en §1, en la brecha 21 y en el issue: c y d valen por el motivo registrado |
| 3 | La firma del rail no se ponía a prueba (los rechazos llegan antes) | Paso 0: la transferencia firmada, simulada en modo `enforce`; el `__check_auth` del rail la acepta |
| 4 | "No mueve nada" depende del SDK | README y cabecera lo dicen así: si aceptara a o b, hasta 0,01 USDC saldría del rail |
| 5 | La propuesta del issue podía ser más precisa | Cita las líneas del SDK: el camino patrocinado ya simula en `enforce`; sin patrocinio basta aceptar `C…` |
| 6 | Con `--skip-control` el veredicto decía que el control cobró | Remite a la tx de la corrida anterior |
| 7 | Brecha 21: "cuatro modos" | "cuatro intentos, en dos modos; push no se probó" |
| 8 | Bordes: saldo con `as bigint`, un cast de más, `.env.local` ausente con un error genérico | `z.bigint()`, sin cast, `ProbeError("ConfigError")`; el README explica por qué no `AgentPassError` |
| 9 | El comentario de `railTransaction` quedó desubicado y desactualizado | Corregido |

## 6. La pregunta del SEP: ¿segunda credencial del mismo medio de pago, o medio de pago aparte?

**Medio de pago aparte** (`R-20`). MPP trae su propio desafío (`WWW-Authenticate: Payment`), su propia credencial
(`Authorization: Payment`, con un `did:pkh` como pagador), su propio recibo (`Payment-Receipt`) y su propia
verificación. Ponerlo como segunda credencial de `com.agentpey.stellar_x402` haría que un mismo id de handler
signifique dos protocolos con dos reglas de verificación, y un comercio que declara el handler no sabría cuál acepta
el otro lado. Un handler aparte (por ejemplo `com.agentpey.stellar_mpp_charge`) se declara, se negocia y se rechaza
por separado.

## 7. La frase para el video

> "Evaluamos MPP charge en testnet: el SDK oficial solo acepta pagos desde una llave clásica, y nuestro agente paga
> desde una cuenta-contrato con topes que aplica la red. Por eso no lo usamos todavía: propusimos el cambio al SDK."

Evidencia: §3 (la red acepta la firma del rail, los cuatro rechazos, el rail sin moverse) y §4 (el control que sí
cobra). "Propusimos el cambio" vale
solo cuando el issue esté publicado, con el OK del usuario; hasta entonces, "lo documentamos para el SEP".
