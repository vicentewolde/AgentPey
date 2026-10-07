# T145 · Equipos SCF pagando IA y servicios con Stellar · prueba técnica

> Prueba técnica, sin código de producto y sin dinero real. Fuentes externas
> leídas el **2026-10-07**; lo que no tiene una fuente primaria dice **sin
> confirmar**. Esto no es asesoría legal: la sección 6 lista lo que tiene que
> revisar un abogado. Spec: [T145](../SPEC.md).

## 1. En una frase

**El cobro por uso funciona hoy en testnet con lo que ya existe; las
suscripciones no tienen todavía un emisor de tarjetas fondeado desde Stellar
que se pueda recomendar.** Cards402 prohíbe los cobros recurrentes en su
contrato, y ASGCard no publica términos, KYC ni banco emisor. Se recomienda
construir T146 (cobro por uso, en testnet, reutilizando un rail ya desplegado)
y dejar las suscripciones como diseño.

## 2. La pregunta

Un equipo financiado por el Stellar Community Fund (SCF) recibe su premio en
una cuenta de Stellar y quiere que sus agentes paguen herramientas de IA y
servicios desde ahí, con topes que el agente no pueda saltarse. Dos caminos:

- **A · Cobro por uso:** servicios que cobran por pedido con x402 o MPP,
  pagados directo desde un `policy_rail` del equipo.
- **B · Suscripciones:** ChatGPT, Claude, GitHub, Vercel, Figma, que solo
  aceptan tarjeta, pagadas con una tarjeta virtual fondeada con USDC.

## 3. Lo que ya existe en el repo

| Pieza | Qué aplica | Dónde |
|---|---|---|
| `policy_rail` (contrato) | Un solo `owner` (la llave del agente), un `principal` (la wallet que fondea), un solo asset, `per_tx`, `per_day` por día UTC y `valid_until`. El `principal` puede rotar o cortar al agente (`set_owner`) y retirar fondos (`withdraw`). **No revisa el destino** ni tiene tope mensual; los topes se fijan al desplegar | `contracts/policy-rail/src/lib.rs` (`Config` 114-129, `__check_auth` 323) |
| Rails desplegados en testnet | `policyRail` (0,002/0,01), `policyRailUcp` (5/10), `policyRailMcp` (3/5), todos en el USDC de testnet `CBIELTK6…DAMA` | `deployments/testnet.json` |
| Mandato | `scope` con `venues`, `assets`, `limits` (`perTx`, `perDay`) y, en el grant, `payTo` (payees permitidos) y `products`. **No tiene categorías.** Lo aplica `checkMandate` fuera de la red | `packages/core/src/credential.ts:40-51`, `packages/mandate/src/mandate.ts:74-77`, `apps/agent/src/mandate/check-mandate.ts:83` |
| Pago x402 desde un rail | `PolicyRailStellarScheme` sobre `policyRailPayer` de `@agentpey/ucp-stellar` (T136). Lo usan el MCP, las tiendas de la plataforma y `pnpm demo:pay-real --payer=policy-rail`. El `execute_payment` del agente de línea de comandos paga desde su cuenta clásica, con la autorización fuera de la red | `apps/agent/src/payment/x402.ts:340-344`, `apps/mcp/src/runtime.ts:127`, `apps/agent/src/tools/agent-tools.ts:579` |
| Servicio x402 que cobra por uso | SignalDesk: `signaldesk:ai-credits-1000` a 0,10 USDC y un informe de mercado a 0,25, con recibo firmado, en el mismo USDC de testnet | `apps/signaldesk/README.md` |
| Registro | MandateVault: cadena de hashes con `granted`, `refused`, `anchored` (liga el `paymentTx`) y `released`. `packages/activity` lee el uso por día y los rechazos. **No hay resumen por mes** | `packages/vault/src/vault.ts`, `packages/activity/src/index.ts:84,121` |
| MPP | No paga desde un `policy_rail`: el SDK oficial solo acepta un pagador `G…` | `R-20`, [stellar-mpp-sdk#90](https://github.com/stellar/stellar-mpp-sdk/issues/90) |

## 4. Camino A · Cobro por uso

**Cómo queda.** El premio llega a una cuenta del equipo (el `principal`). El
equipo fondea un `policy_rail` con USDC; el agente firma como `owner` y paga
servicios x402. El Mandato dice a qué servicios (`venues`, `payTo`) y cuánto;
el rail lo vuelve a aplicar en la red para `per_tx` y `per_day`. Cada pago deja
el recibo del servicio y una entrada `anchored` en el Vault.

**Qué servicios hay hoy** ([x402 en Stellar](https://developers.stellar.org/docs/build/agentic-payments/x402), [facilitador "Built on Stellar"](https://developers.stellar.org/docs/build/agentic-payments/x402/built-on-stellar), [MPP en Stellar](https://developers.stellar.org/docs/build/agentic-payments/mpp), [MPP Router](https://www.mpprouter.dev/integration.md)):

| Servicio | Red | ¿Paga un `policy_rail`? |
|---|---|---|
| SignalDesk y el bazaar (propios y del embajador) | testnet | Sí: es el camino de T128, T136 y la plataforma |
| Facilitador x402 de OpenZeppelin (`channels.openzeppelin.com/x402/testnet`) | testnet y mainnet | El cliente firma entradas de autorización de Soroban; que acepte un pagador contrato está **sin confirmar** (se puede probar en testnet) |
| MPP charge (`@stellar/mpp`) | testnet y mainnet | No (`R-20`) |
| MPP Router: unos 88 servicios, entre ellos `openai_chat`, `anthropic_messages`, `openrouter_chat`, `gemini_generate`, fal.ai, Exa y Firecrawl | **solo mainnet** | Acepta MPP o x402 v2; con un pagador contrato, **sin confirmar**. Es un intermediario: cobra USDC en Stellar y paga al proveedor desde su propio fondo en otra red |
| Un proveedor de IA que cobre directo en Stellar testnet | | **No encontré ninguno** |

**Lo que falta para un equipo real** (ninguna se construye en esta fase):

1. **El destino no se aplica en la red.** El rail aplica montos, no a quién se
   paga; el `payTo` del Mandato se aplica fuera de la red. Un agente con la
   llave del rail puede pagarle a cualquiera dentro del tope diario. Para
   cerrarlo hace falta un contrato con lista de destinos: es un cambio de
   contrato y pide permiso del usuario.
2. **Sin tope mensual** y topes fijos desde el despliegue. Un presupuesto mensual
   hoy es `per_day` × días, o un rail nuevo cada mes.
3. **Un solo agente por rail y un solo `owner`.** Un equipo con varios agentes
   necesita un rail por agente (cada uno con su tope), que es además lo que hace
   la plataforma: un rail por inquilino (`C-61`, `C-137`).
4. **El premio llega en XLM.** El rail maneja un solo asset (USDC); el
   `principal` tiene que convertir antes, fuera del rail (sección 5).
5. **Sin resumen por período.** Es lo que pide T146.

## 5. Camino B · Suscripciones con tarjeta virtual

| | Cards402 | ASGCard |
|---|---|---|
| Fuente | [docs](https://cards402.com/docs), [términos](https://cards402.com/terms), [contrato del titular](https://cards402.com/legal/cardholder-agreement) | [docs](https://asgcard.dev/docs), [GitHub](https://github.com/ASGCompute/asgcard-public) |
| Tarjeta | Visa prepagada ("Reward Card") emitida por **Pathward, N.A.**; Cards402 es program manager | Mastercard virtual en USD; el código integra a 4payments; **banco emisor no publicado** |
| Red | Stellar mainnet | x402 en `stellar:pubnet`, o Stripe MPP |
| Fondeo | USDC o XLM, llamando `pay_usdc(from, amount, order_id)` en un contrato de Soroban con `from.require_auth()` | x402 contra el USDC de mainnet, a una tesorería `G…` |
| ¿Desde un `policy_rail`? | En teoría sí (`from` es una `Address`); **sin confirmar** que el contrato desplegado sea el del repo y que el reembolso vuelva a un `C…` | Se autentica con una firma Ed25519 de una wallet `G…`; los `C…` no aparecen |
| Suscripciones | **No.** El contrato del titular: "Recurring payments: Not permitted" | **Sin confirmar** |
| KYC y titular | El alta pide solo un correo; KYC y titular **sin confirmar** | **No publicados**; `/terms` y `/legal` dan 404 |
| Costo y límites | $0 de Cards402; Pathward cobra $2,50 al mes desde el sexto mes y $2 + 2 % por transacción extranjera; saldo máximo $10.000, $5.000 por día; el saldo no se reembolsa | $10 por tarjeta, 3,5 % por carga, de $5 a $5.000 |

Otras opciones, de pasada: Rain es infraestructura B2B para emitir programas de
tarjetas y anunció soporte de Stellar ([rain.xyz](https://www.rain.xyz/blog/rain-expands-support-to-solana-tron-and-stellar-enabling-more-partners-to-launch-stablecoin-powered-card-programs)),
no un producto para un equipo; MPP Router dice dar acceso a tarjetas de regalo
de Bitrefill.

**El vínculo con el Mandato se corta en la tarjeta.** Lo único que pasa en la
red es la carga de la tarjeta: el Mandato y el rail pueden topar cuánto se
carga, pero lo que la tarjeta compra después ocurre en la red de Visa o
Mastercard, sin recibo verificable ni Mandato. El control por servicio queda en
manos del emisor (Cards402 ofrece topes por llave y aprobación por categoría de
comercio).

**Conclusión del camino B:** hoy no se puede recomendar. Cards402 sirve, a lo
más, para compras de una vez; ASGCard no publica lo mínimo para que un equipo
le confíe su tesorería. Las suscripciones se siguen pagando con la tarjeta
normal del equipo.

## 6. Quién es quién, y lo que pide revisión legal

**Cómo paga SCF** ([Build Award](https://stellar.gitbook.io/scf-handbook/scf-awards/build-award)):
en **XLM**, por tramos contra entregables, con plazo de 90 días entre entregas.
Antes de pagar, la SDF hace verificación de identidad a **cada integrante** del
equipo. El equipo custodia sus llaves.

| Rol | Camino A | Camino B |
|---|---|---|
| Titular de los fondos | El equipo: es el `principal` y puede retirar todo con `withdraw` | El titular de la tarjeta (sin confirmar en los dos emisores) |
| KYC | La SDF, al pagar el premio. Un servicio x402 no pide identidad | La SDF y, según el emisor, Pathward o 4payments (sin confirmar) |
| Firma del agente | La llave `owner` del rail. En la plataforma hospedada y en el MCP, **esa llave la tiene AgentPey** (`packages/tenancy/src/derive-keys.ts`, `MCP_AGENT_SECRET_KEY`); en una instalación propia, el equipo | Igual para la carga; el gasto lo controla el emisor |
| Qué hace AgentPey | La capa de control: Mandato, rail, recibo, Vault | Solo podría topar la carga |

**Para un abogado.** Normas chilenas leídas el 2026-10-07:
[Ley Fintec 21.521](https://www.bcn.cl/leychile/navegar?idNorma=1187323) (art. 2,
art. 3 n°3, 5 y 8) y su [NCG 502](https://www.cmfchile.cl/portal/principal/613/articles-79589_doc_pdf.pdf);
[Ley 20.950](https://www.bcn.cl/leychile/navegar?idNorma=1096097), que desde la
21.521 incluye representaciones en registros distribuidos respaldadas en dinero,
con el [capítulo III.J.1.3 del Banco Central](https://coleccion.bcentral.cl/documents/33528/115568/CapIIIJ13.pdf);
[Ley 19.913](https://www.bcn.cl/leychile/navegar?idNorma=219119) (sujetos
obligados ante la UAF, art. 3). En EE. UU. la entidad regulada es el banco
emisor; Cards402 se declara software y no un *money services business*.

1. **Si AgentPey presta "custodia".** La ley la define como mantener "a nombre
   propio por cuenta de terceros". Los fondos están en un contrato que el
   equipo puede vaciar cuando quiera, lo que apunta a que no; pero en la
   versión hospedada AgentPey tiene la llave que gasta hasta el tope diario.
   Hay que confirmar si eso cuenta, y si cambiaría al patrocinar comisiones o
   mover fondos de terceros.
2. **Si la conversión de XLM a USDC** que hace el equipo, o un servicio que lo
   haga por él, entra en "intermediación" o en un sistema alternativo de
   transacción.
3. **Si un emisor extranjero de tarjetas** (Cards402, ASGCard) necesita
   registro en Chile para ofrecer su producto a chilenos, y si su uso por una
   empresa viola sus términos (Cards402 es una tarjeta de recompensa, de
   consumo).
4. **Contabilidad e impuestos (SII):** cómo se registra cobrar el premio en
   XLM, convertirlo y pagar gastos en el extranjero. No encontré una fuente
   clara.
5. **Los términos de cada servicio pagado** por un agente (uso automatizado,
   cuentas compartidas).

## 7. Recomendación

1. **Construir T146 tal como está en el spec**, después del video: el
   `policy_rail` de la plataforma (`policyRailUcp`, 5/10 USDC) paga
   `signaldesk:ai-credits-1000` en testnet, con recibo, y un script nuevo arma
   el resumen de gastos del mes desde el Vault y `packages/activity`. **Sin
   desplegar nada nuevo** y sin tocar contratos. Estimación: 6 h (la del
   spec); el resumen mensual es lo único nuevo, unas 3 h.
2. **No construir el camino B.** Se anota como diseño en el anexo del SEP: una
   tarjeta se carga desde el rail, pero el Mandato no llega a lo que la tarjeta
   compra.
3. **Lo que se puede decir en el video:** "un equipo puede dar a sus agentes un
   presupuesto en la red para servicios que cobran por uso; para
   suscripciones, todavía no hay un emisor que podamos recomendar". No decir
   "pagamos ChatGPT desde Stellar".
4. **Abierto, para cuando haga falta:** probar en testnet si el facilitador de
   OpenZeppelin acepta un pagador contrato (1 a 2 h); si MPP Router tiene
   testnet; un rail con lista de destinos y tope mensual (cambio de contrato,
   con permiso del usuario).

## 8. Decisión del usuario

- [ ] ¿Se construye T146 como en la recomendación 1?
- [ ] ¿El camino B queda solo como diseño?
