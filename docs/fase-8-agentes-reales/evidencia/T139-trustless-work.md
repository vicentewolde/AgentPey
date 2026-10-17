# T139 · Trustless Work como escrow por compra · prueba técnica

> Prueba técnica, sin código, sin nada en la red. Fuentes leídas el **2026-10-17**: la documentación de Trustless
> Work (V1 y V2), su repositorio de contratos y su indexador en GitHub, la auditoría pública y el handbook del SCF. Lo
> que dice **[código]** es lectura propia del código fuente, no de la documentación; lo que no tiene una fuente
> primaria dice **sin confirmar**. Spec: [T139](../SPEC.md). Planteada como evaluación para **después** de la Fase 9:
> no cambia el `purchase-escrow`, el árbitro, `E-17` ni `E-18` (`P-19`). El usuario les escribió por Discord el
> 16-oct; al 17-oct no respondieron.

## 1. En una frase

**Trustless Work no sirve como escrow de las compras de AgentPey tal como pagan hoy: el `policy_rail` del agente no
puede fondear su escrow con la llamada que Trustless Work exige, ni abrir una disputa en él, y su contrato no tiene
plazos.** La Fase 9 ya resolvió esto con un contrato propio, el `purchase-escrow`, hecho para compras de agentes. Lo
que sí encaja con Trustless Work es otro caso: pagos por hitos entre empresas. Recomendación: no construir; si se
retoma, como un caso de hitos aparte, no en el checkout.

## 2. Qué es Trustless Work (fuentes)

- **Escrow como servicio sobre Stellar.** Cada escrow es **su propio contrato de Soroban**, desplegado por una fábrica
  desde un código aprobado; la API devuelve su dirección antes de desplegarlo ([deploy V2]).
- **Dos versiones:** V1, la de producción, en mainnet y testnet (`api.trustlesswork.com`, `dev.api…`); y V2, una
  "Core API" en beta, **solo en testnet** y "not yet externally audited" ([arquitectura V2]).
- **Roles por dirección:** Approver, Service Provider, Release Signer, Dispute Resolver, Platform, Receiver; en V2
  hasta 5 direcciones por rol, y el admin distinto de todos ([roles]).
- **Dos tipos:** un solo pago al final, o pagos por hitos ([tipos]).
- **Cualquier activo emitido en Stellar**, normalmente USDC; cada participante necesita la trustline ([trustlines]).
- **Comisión de 0,3 %** del protocolo, más una comisión opcional de la plataforma; las dos se cobran también al
  resolver una disputa. **[código]** `TRUSTLESS_WORK_FEE_BPS = 30`.
- **La API nunca firma:** devuelve transacciones sin firmar, pide una API key y en V1 limita a 50 pedidos por minuto.
  SDK de JS (`@trustless-work/escrow-js`, beta) y de React. El backend de la API no es público ([API V2]).
- **Auditoría:** Runtime Verification revisó sus contratos entre agosto y septiembre de 2025 (19 hallazgos críticos o
  altos, 4 medios, 29 bajos); el informe no dice qué versión ni si se corrigieron. V2 no está auditada ([auditoría]).

## 3. El escrow de hoy: el `purchase-escrow` de la Fase 9

- **Un contrato por tienda**, con muchas compras adentro. El agente paga por x402 con una **transferencia simple** al
  contrato; después el operador de la tienda la asigna con `hold(orden, pagador, monto, tx, hash del recibo)` (`X-14`,
  `X-20`).
- **Plazos en el contrato:** la tienda despacha y corre la ventana de liberación; si hay reclamo, la tienda tiene
  `response_window` para responder y el árbitro `resolve_window` para decidir. Si nadie decide, `expire` le devuelve
  todo al pagador (`X-7`). En `agentcommerce`: 10, 15 y 60 minutos.
- **El pagador abre el reclamo con su propia firma**, aunque sea un `policy_rail`: `open` acepta la firma Ed25519 del
  dueño del rail sobre un mensaje corto (`X-16`, `X-18`).
- **El árbitro devuelve un monto** (`resolve(orden, verdict_hash, refund)`), sin comisión.
- **El recibo** nombra el escrow (`receipt.escrow.contract`, T159), y el agente comprueba en la red que la compra
  retenida sea la de su pago y su recibo (`X-24`, T161).

## 4. ¿El `payTo` de x402 puede ser un escrow de Trustless Work?

**Técnicamente sí; en la práctica, con tres problemas.**

1. **El fondeo oficial es una llamada propia, `fund_escrow`, que el rail no puede autorizar.** **[código]**
   `fund_escrow(signer, expected_escrow, amount)` pide `signer.require_auth()` y mueve los fondos con
   `token.transfer`. El `policy_rail` solo autoriza **una** llamada, `transfer` de su propio activo
   (`contracts/policy-rail/src/lib.rs`, `__check_auth`): una invocación de `fund_escrow` le llega como otra forma y la
   rechaza con `UnexpectedInvocation`. Es el mismo bloqueo que T145 encontró con Cards402.
2. **Una transferencia simple llega, pero las dos versiones no la tratan igual.** V1 la acepta como "Direct Deposit",
   aunque puede no disparar la indexación ([fondeo V1]). V2 dice no tratarla como equivalente ([fondeo V2]).
   **[código]** En V2 la liberación y la disputa miran el saldo real, así que el dinero se puede pagar; pero el
   bloqueo que congela roles y monto al fondear mira un contador que solo sube `fund_escrow`. **Un escrow V2 fondeado
   por transferencia sigue editable:** su admin podría cambiar roles o el monto con el pago adentro.
3. **Un contrato por compra.** El `payTo` tiene que existir al cotizar, así que cada checkout desplegaría un escrow,
   se pague o no, con su costo en XLM y una llamada a la API de Trustless Work en el camino del pago. Hoy hay un
   contrato por tienda y el checkout no llama a nadie.

## 5. ¿Qué cambia en el recibo?

- **`receipt.escrow.contract`** pasaría a ser el escrow de esa compra, uno distinto por recibo.
- **El hash del recibo cabe en el escrow**, en `engagementId` (hasta 100 caracteres) o en la evidencia de un hito
  (hasta 500). **[código]** Pero ningún campo ata el pago: no guarda el pagador ni la transacción, y `engagementId`
  lo escribe quien despliega. Hoy `hold` guarda pagador, monto, transacción y hash del recibo, y el agente los compara
  (`X-24`). Con Trustless Work esa comprobación habría que rehacerla leyendo los depósitos del indexador.
- **El estado se puede leer en la red** con `get_escrow` (montos, hitos, `dispute{is_disputed, reason, resolved}`,
  `released`), y la API lo expone como "the authoritative read" ([get-escrow]). `receipt.escrow` de T161 se podría
  armar con eso, pero **sin fechas**: no hay plazos que mostrar (§6).

## 6. ¿El árbitro de AgentResolve puede ser el Dispute Resolver?

**Sí, y puede repartir montos; pero quién abre el reclamo y los plazos no encajan.**

- **Resolver:** la cuenta del árbitro (`E-16`, una `G…`) puede ser el Dispute Resolver. `resolve_dispute` recibe un
  reparto `{dirección: monto}` que debe sumar el saldo del escrow ([resolve V2]): sirve para un reembolso parcial.
  Antes se descuentan las comisiones, así que un reembolso "completo" deja al pagador 0,3 % abajo, más la comisión de
  la plataforma si la hay. `E-18` no cambia: el script del árbitro arma la transacción y una persona confirma.
- **Quién abre la disputa:** en V2, Approvers, Service Providers, Platform, Release Signers o el Receiver; el
  Resolver no ([disputa V2]). El pagador tendría que ser Approver, y **el `policy_rail` no puede firmar esa llamada**
  (§4.1). Quedaría abierta por AgentPey como Platform, con el reclamo firmado fuera de la red: se pierde lo que dio
  `X-16`, que el pagador abre su propio reclamo en la red.
- **Plazos:** **[código]** ninguno en el contrato (busqué fechas, ledgers y vencimientos en V1 y en las dos ramas de
  V2). No hay ventana de liberación, ni plazo para la tienda, ni algo como `expire`; la documentación deja los plazos
  a la aplicación. **La garantía principal de la Fase 9, que el comprador recupera todo si nadie decide a tiempo,
  quedaría en un servidor de AgentPey y no en la red.**
- **El razonamiento del veredicto** queda fuera de la red, igual que hoy (`E-24`): Trustless Work no tiene campo para
  él.

## 7. ¿Qué pediría una postulación al Integration Track del SCF?

- **Qué es:** un tramo del Build Award para aplicaciones que integran piezas que ya existen en Stellar
  ([integration track]). **Trustless Work está en la lista oficial**, como escrow sin escribir contratos, con una
  integración estimada en menos de dos semanas ([integration list]).
- **Qué pide:** integrar al menos una pieza de la lista, explicar por qué importa y **la tracción actual**; gastar la
  mayor parte en la integración; y comprometer una métrica en la red (volumen acumulado, por ejemplo). El último 40 %
  se paga solo al cumplir esa métrica.
- **Montos sugeridos:** 25 a 50 mil USD (pequeño), 50 a 100 mil (mediano), 100 a 150 mil (grande); tope del Build
  Award, 150 mil en XLM. Tramos: 10 % al aceptar, 20 % con el MVP, 30 % en testnet, 40 % con la métrica.
- **Para AgentPey hoy:** el tramo está pensado para equipos con tracción; sin ella, el handbook deriva a los
  Instawards, que es el camino en curso (Fase 9). La métrica en la red pide volumen real, o sea mainnet, que está fuera
  de alcance (`CLAUDE.md`). **Una postulación ahora sería débil**; después de la Fase 9, con un caso de hitos real y
  tracción, sería otra conversación.

## 8. Opciones

| Opción | Qué es | A favor | En contra | Horas |
|---|---|---|---|---|
| **A · No integrar** (recomendada) | El `purchase-escrow` sigue siendo el escrow de las compras | Plazos y `expire` en la red, el pagador abre su reclamo, un contrato por tienda, sin comisión, auditable en el repo | Mantener un contrato propio sin auditoría externa | 0 |
| B · Trustless Work en el checkout | Un escrow de Trustless Work por compra, pagado por transferencia | Contratos auditados (V1), un servicio conocido en el ecosistema, encaja con el Integration Track | El rail no puede fondear ni abrir disputas (§4, §6); plazos en un servidor; un despliegue por checkout; 0,3 % por compra y por reembolso; V2 editable tras una transferencia | ~35 |
| C · Trustless Work para pagos por hitos | Otro producto: un equipo paga a un proveedor por hitos (por ejemplo, la tesorería de T145) | Es su caso de diseño; no toca el checkout ni el `purchase-escrow` | Área de producto nueva; pide un cliente real y una decisión de alcance | ~16 para una demo en testnet |

Horas de la opción B: escrow por checkout con la API (6), `payTo` y recibo (6), disputa abierta por la plataforma y
reparto del árbitro en `scripts/resolve.ts` (8), plazos y liberación en un servicio (6), comprobación del pago contra
el indexador (5), tests y documentos (4).

## 9. Recomendación

1. **No integrar Trustless Work en las compras (opción A).** Su modelo da a cada rol una firma sobre el escrow, y el
   `policy_rail`, que es lo que hace segura la compra del agente (`R-1`), solo firma transferencias. Y la protección
   del comprador de la Fase 9 vive en los plazos del contrato, que Trustless Work no tiene.
2. **Si se retoma, como opción C**, en una fase propia y con un caso de hitos real.
3. **Para el SEP:** Trustless Work es un buen ejemplo de por qué el estándar debería definir la interfaz del
   reclamo y del veredicto (quién abre, cómo se firma, plazos) y no el contrato que guarda el dinero.

## 10. Sin confirmar

- Si la API de Trustless Work acepta una dirección `C…` en un rol (el contrato sí; la documentación dice "wallets").
- La dirección de la fábrica y de los contratos en mainnet.
- Qué versión cubrió la auditoría y si se corrigieron sus hallazgos.
- Si una transferencia simple a un escrow V1 queda indexada siempre como depósito.
- La respuesta de Trustless Work por Discord (pendiente al 17-oct).

## 11. Criterios del spec

- [x] `T139-trustless-work.md` con las respuestas citadas, opciones, recomendación y horas (este documento)
- [x] el usuario decidió si se construye: **opción C** (17-oct, `R-39`): no en el checkout; candidato para pagos por hitos entre empresas, en una fase propia

## 12. Fuentes (leídas el 2026-10-17)

| Tema | Fuente |
|---|---|
| Visión general, roles, tipos | https://docs.trustlesswork.com/trustless-work/introduction/technology-overview |
| [arquitectura V2] | https://docs.trustlesswork.com/trustless-work/v2-en/introduction/technology-overview/architecture-and-design-strategy.md |
| [roles] | https://docs.trustlesswork.com/trustless-work/v2-en/introduction/technology-overview/roles-in-trustless-work.md |
| [tipos] | https://docs.trustlesswork.com/trustless-work/introduction/technology-overview/escrow-types.md |
| [trustlines] | https://docs.trustlesswork.com/trustless-work/introduction/stellar-and-soroban-the-backbone-of-trustless-work/trustlines.md |
| [deploy V2] | https://docs.trustlesswork.com/trustless-work/v2-en/api-rest/deploy/initialize-escrow.md |
| [fondeo V1] | https://docs.trustlesswork.com/trustless-work/introduction/technology-overview/escrow-lifecycle/funding-phase.md |
| [fondeo V2] | https://docs.trustlesswork.com/trustless-work/v2-en/introduction/technology-overview/escrow-lifecycle/funding-phase.md |
| [disputa V2] | https://docs.trustlesswork.com/trustless-work/v2-en/introduction/technology-overview/escrow-lifecycle/dispute-resolution.md |
| [resolve V2] | https://docs.trustlesswork.com/trustless-work/v2-en/api-rest/deploy/resolving-disputes.md |
| [get-escrow] | https://docs.trustlesswork.com/trustless-work/v2-en/api-rest/escrow-information/get-escrow.md |
| [API V2] | https://docs.trustlesswork.com/trustless-work/v2-en/api-rest/introduction.md |
| Contratos (código) | https://github.com/Trustless-Work/trustlesswork-smart-contract-stellar (ramas `single-release-main`, `single-release-develop-v2`, `multi-release-develop-v2`) |
| Indexador (código) | https://github.com/Trustless-Work/trustlesswork-indexer-go |
| [auditoría] | https://runtimeverification.com/public-report/trustless-work |
| [integration track] | https://stellar.gitbook.io/scf-handbook/scf-awards/build-award/integration-track |
| [integration list] | https://stellar.gitbook.io/scf-handbook/scf-awards/build-award/integration-track/integration-list.md |
| El escrow de hoy | `contracts/purchase-escrow/src/lib.rs`, `contracts/policy-rail/src/lib.rs`, `X-7`, `X-14`, `X-16`, `X-20`, `X-24` en [Fase 9](../../fase-9-compra-protegida/DECISIONES.md) |
