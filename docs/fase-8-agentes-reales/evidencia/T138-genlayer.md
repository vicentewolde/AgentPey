# T138 · GenLayer como jurado de AgentResolve · prueba técnica

> Prueba técnica, sin código, sin nada en la red. Fuentes leídas el **2026-10-14**; lo que no tiene una fuente
> primaria dice **sin confirmar**. Spec: [T138](../SPEC.md). Planteada como evaluación para **después** del trabajo en
> curso sobre AgentResolve: no cambia el árbitro de hoy, `E-17`, `E-18` ni el escrow de la Fase 9. T140 está cortada
> (`P-19`); retomarla pide una decisión nueva del usuario, en una fase futura.

## 1. En una frase

**GenLayer puede ser el jurado de AgentResolve, pero no como Internet Court "tal cual": su dinero vive en Base y su
veredicto es un sí o no.** Lo que sí encaja es un contrato propio en GenLayer (un *Intelligent Contract* en Python)
que lea el reclamo, la respuesta del comercio y el recibo, devuelva un veredicto con tramos de reembolso, y un relevo
(el script del árbitro de hoy) lo lleve a Stellar. Recomendación: no construir ahora; cuando se construya, contrato
propio en la testnet Bradbury, **relevo único auditable** y la confirmación humana de `E-18` intacta. Unas 27 h (19 sin
T140, cuya interfaz conviene hacer primero). En una compra con escrow, la ventana del árbitro tiene que alcanzar para
GenLayer (§7).

## 2. Qué es cada cosa (fuentes)

**GenLayer.** Una red donde "many independent AI models each reason on their own, then reach agreement" (genlayer.com).
Cada validador corre un modelo distinto; un líder propone una respuesta, un comité la vota y cualquiera puede apelar
dentro de una ventana ("Optimistic Democracy"). Los *Intelligent Contracts* son programas en Python que pueden leer la
web y llamar a modelos. Hoy está en testnet: **Bradbury** ("production-like testnet with real AI/LLM workloads") y
Asimov, más Studionet para desarrollo. La hoja de ruta de la portada pone **mainnet en el cuarto trimestre de 2026**,
"permissioned validator set to progressive decentralization".

**Internet Court.** El tribunal de GenLayer para disputas entre agentes, lanzado el 10-jul-2026 por un consorcio
(CoinDesk). Según su repositorio oficial (`genlayer-foundation/internetcourt`):

- Dos partes crean un contrato con una **afirmación** ("statement"), **criterios** ("guidelines") y qué evidencia
  puede presentar cada una.
- Quien lo crea **deposita USDC en un escrow en Base**.
- Si las dos partes están de acuerdo, se resuelve sin jurado. Si no, cada una sube su evidencia y el jurado (5
  validadores, 5 modelos) devuelve **TRUE, FALSE o UNDETERMINED** con su razonamiento.
- El veredicto viaja de GenLayer a Base por **LayerZero V2**, pasando por zkSync, con un **servicio de relevo fuera de
  la cadena** (`bridge/service/src/relay/GenLayerToEvm.ts`) que lee el contrato de GenLayer y reenvía el mensaje.
- Desplegado en **Base Sepolia, zkSync Sepolia y Studionet** (`bridge/deployments.json`). Último commit: 19-ago-2026.
- Un issue abierto desde el 15-sep-2026, sin respuesta: el receptor del puente en Base no comprueba quién envió el
  mensaje, y alguien podría escribir un veredicto a su gusto
  ([internetcourt#11](https://github.com/genlayer-foundation/internetcourt/issues/11)). Es una revisión estática del
  reportero; no está confirmado ni corregido.

**Stellar no aparece** en la documentación de GenLayer ni en el repositorio de Internet Court. LayerZero sí documenta
Stellar (Soroban), con una auditoría de su endpoint en abril de 2026; no confirmé en qué redes está vivo.

## 3. Cómo decide AgentResolve hoy

- El comprador firma un reclamo (`AgentResolveClaim`) con el recibo entero adentro; el comercio responde firmando
  (`E-20` a `E-22`).
- El árbitro es Claude Opus 5.5, sin fallback a otro modelo (`E-17`). Propone `refund_full`, `refund_partial` o
  `rejected` con un monto en unidades atómicas; el código lo recorta al monto en disputa y el contrato al recibo
  anclado (`packages/resolve/src/verdict.ts`).
- **Una persona confirma** el veredicto antes de mover fondos (`E-18`).
- La cuenta del árbitro (`E-16`) firma `resolve(receipt, verdict_hash, refund)` en `agent-resolve`, que exige su
  autorización (`contracts/agent-resolve/src/lib.rs`).

**Desde la Fase 9 hay un segundo contrato: el `purchase-escrow` de cada tienda** (`X-26`, T157, T158 y T160). En una
compra pagada a un escrow, el comprador abre el reclamo en ese contrato con su propia firma (`open`), la tienda
responde ahí (`respond`) y el árbitro decide ahí (`resolve`), con el reembolso saliendo del mismo pago retenido. El
contrato pone plazos: la tienda tiene `response_window` para responder y el árbitro `resolve_window` después. Si nadie
decide a tiempo, cualquiera puede llamar `expire` y el comprador recibe todo (`X-7`). En `agentcommerce` son 900 s y
3.600 s (`fase-9-compra-protegida/evidencia/T160.md`). Las compras sin escrow siguen en `agent-resolve`, sin plazo
para el árbitro.

GenLayer reemplazaría **solo el paso del modelo**: quién propone el veredicto, en cualquiera de los dos contratos.

## 4. Cómo se presenta un reclamo como caso

**Internet Court tal cual no sirve** para AgentResolve: su escrow y su liquidación viven en Base, y el dinero de
AgentResolve está en Stellar. Usarlo obligaría a mover el pago a Base, que es otra cadena y otro riel.

**Lo que sí sirve es un contrato propio en GenLayer**, como el ejemplo oficial `ShipmentDeadlineCourt.py` del mismo
repositorio (una sola pregunta, criterios congelados y versionados, evidencia leída de una URL):

| Pieza del caso | De dónde sale en AgentResolve |
|---|---|
| Afirmación | Fija por versión, por ejemplo: "el comprador del recibo R tiene derecho a un reembolso" |
| Criterios | Los de hoy en el prompt del árbitro, congelados con una versión (`agentresolve-v1`) |
| Evidencia del comprador | El reclamo firmado (JWS), leído de una URL pública |
| Evidencia del comercio | La respuesta firmada, o "sin respuesta en 48 h" (`E-22`) |
| Hechos objetivos | El recibo anclado y la disputa abierta, leídos de la red de Stellar (Horizon o RPC) |

El contrato **comprueba hashes antes de juzgar**: el hash del reclamo y del recibo que lee tiene que ser el que tiene
abierto `agent-resolve` o el `purchase-escrow` de la tienda. La documentación de GenLayer recomienda justamente "validate hashes, signatures, or
other objective evidence before using qualitative interpretation". Así un validador no juzga una evidencia cambiada.

**Una consecuencia a decidir: la evidencia queda pública.** Hoy el texto del reclamo y la respuesta no están en la red
(`E-24`: la orden muestra solo lo que está en la red, no el razonamiento). En GenLayer, el caso y su razonamiento son
públicos. Para la demo en testnet no importa; para compradores reales, sí.

## 5. Un reembolso parcial con un veredicto de tres valores

AgentResolve tiene tres resultados con monto; Internet Court, tres valores sin monto. Opciones:

| Opción | Cómo | Contra |
|---|---|---|
| **A · Tramos en un contrato propio** (recomendada) | El contrato devuelve `outcome` y un porcentaje de un conjunto cerrado: 0, 25, 50, 75 o 100 %. El principio de equivalencia acepta la propuesta del líder si el resultado y el tramo coinciden | Un reembolso queda redondeado a un tramo |
| B · Varias afirmaciones | Un caso por tramo ("¿corresponde al menos el 50 %?", "¿el 100 %?") | Dos o tres casos por reclamo: más costo, más tiempo y resultados que pueden contradecirse |
| C · Monto libre con margen | El contrato devuelve un monto y los validadores aceptan si está dentro de, por ejemplo, ±10 % | Más difícil de auditar y de explicar; un margen ancho deja decidir al líder |

En las tres, **UNDETERMINED pasa a la persona**, como hoy pasa una negativa del modelo (`E-17`). El monto final sigue
recortado por el código y por el contrato.

## 6. Cómo llega el veredicto a Stellar: las tres opciones de relevo

| Opción | Cómo | Confianza | Cambio en contratos |
|---|---|---|---|
| **1 · Relevo único auditable** (recomendada) | El script del árbitro espera el veredicto **finalizado** en GenLayer, lo muestra a la persona (`E-18`) y llama `resolve` con un `verdict_hash` que incluye el id del caso de GenLayer | Se confía en el relevo, pero cualquiera puede comparar lo pagado en Stellar con el veredicto público en GenLayer | Ninguno |
| 2 · Varios relevos con multifirma | La cuenta del árbitro pasa a ser una cuenta de Stellar con varios firmantes y un umbral (por ejemplo, 2 de 3). `require_auth` de Soroban, sobre una cuenta clásica, exige sus firmantes hasta el umbral medio ("This supports the Stellar multisig with medium threshold", documentación de autorización de Stellar) | Hace falta que varios relevos independientes coincidan | **Ninguno**: se agregan firmantes a la cuenta del árbitro de hoy. Es gestión de llaves (`P-10`) |
| 3 · Puente | GenLayer → relevo → zkSync → LayerZero → un contrato receptor en Stellar | El puente de Internet Court **también usa un relevo fuera de la cadena**, y tiene el issue #11 abierto; LayerZero en Stellar, sin red confirmada | Un contrato nuevo en Stellar que reciba mensajes de LayerZero |

Las conclusiones valen igual para el `purchase-escrow`: su `arbiter` es una `Address` fijada al desplegarlo, así que
una cuenta con multifirma sirve sin cambiar el contrato.

La opción 1 cuesta lo mismo que hoy en confianza: el relevo es la misma llave del árbitro. Lo que gana es que la
propuesta deja de venir de un solo modelo y queda pública. La 2 es el paso siguiente, sin tocar contratos, cuando haya
más de un operador. La 3 no se recomienda mientras el único puente existente dependa de un relevo y tenga un problema
de autorización sin responder.

## 7. Costo y tiempo

- **Testnet:** sin costo (faucet de GEN). Studionet puede ser incluso sin cuota.
- **Costo por caso en producción:** **sin confirmar**. La portada de GenLayer muestra ejemplos ilustrativos de 0,85 a
  1,45 USD y de 30 a 60 minutos por decisión ("Did the delivered API spec match the contract? 30 min · $0.90"). La
  documentación dice que las cuotas se cotizan con su estimador y no se deben fijar a mano, y que la parte no usada se
  devuelve al finalizar.
- **Tiempo:** el veredicto es definitivo solo al terminar la ventana de apelación, cuya duración "is governed by the
  protocol configuration". Una apelación agrega rondas con comités más grandes. Hoy, Claude decide en alrededor de un
  minuto y la persona confirma.
- **El choque con el escrow:** en una compra con escrow, el veredicto tiene que llegar antes de que venza
  `resolve_window`, o el caso se cierra con `expire` y reembolso completo, sin veredicto. Con los 3.600 s de
  `agentcommerce`, los 30 a 60 minutos de GenLayer, más la apelación y la confirmación humana, un caso puede vencer.
  En T158 cuatro casos vencieron así con Claude, por la caída de la RPC y respuestas tardías. Si se construye, la
  ventana del árbitro se fija por tienda al desplegar su escrow, con margen para GenLayer; no hace falta cambiar el
  contrato.
- **Horas para construirlo** (opción A con relevo 1, en Bradbury):

| Trabajo | Horas |
|---|---|
| T140 primero: la interfaz de resolutor con la implementación de hoy (pedida por el spec) | 8 |
| Intelligent Contract `agentresolve-v1`: lectura y chequeo de hashes, criterios, tramos, tests con `genlayer-test` | 8 |
| El resolutor de GenLayer en `resolve:decide`: enviar el caso, esperar la finalización, mostrar a la persona | 6 |
| Una disputa real en testnet con GenLayer y su evidencia | 3 |
| Documentación, decisiones y anexo del SEP | 2 |
| **Total** | **27** (19 sin T140) |

## 8. Recomendación

1. **No construir ahora.** GenLayer está en testnet, su mainnet es del cuarto trimestre de 2026 con validadores
   permisionados, y el trabajo de AgentResolve en curso no debe cambiar de árbitro a mitad de camino.
2. **Cuando se construya:** contrato propio (no Internet Court), **tramos** para el reembolso parcial, **relevo único
   auditable**, y `E-18` igual: GenLayer propone, una persona confirma. Primero T140, para que Claude y GenLayer sean
   dos implementaciones de la misma interfaz.
3. **Decisiones que se tomarían entonces:** cambiar `E-17` (quién propone), qué evidencia se publica en GenLayer
   (§4), y el conjunto de tramos.
4. **Para el SEP:** GenLayer encaja como un resolutor posible detrás de la misma interfaz de veredicto, sin cambiar el
   contrato de Stellar. Es un buen argumento para que el estándar defina el veredicto (hash, monto, firma del
   árbitro) y no quién lo produce.

## 9. Sin confirmar

- El costo real por caso y la duración de la ventana de apelación en Bradbury y en mainnet.
- Si LayerZero en Stellar está vivo en testnet o mainnet.
- Si GenLayer ofrecerá un puente oficial a Stellar.
- Si el issue #11 de Internet Court es real y si se corrigió.
- Cuánto margen sobre los 30 a 60 minutos de GenLayer necesitaría la ventana del árbitro de un escrow.
- El texto exacto del "sin respuesta" que el contrato propio aceptaría como evidencia del comercio.

## 10. Criterios del spec

- [x] `T138-genlayer.md` con las respuestas citadas, opciones, recomendación y horas (este documento)
- [x] el usuario decidió si se construye: **no por ahora, agendado para después** (14-oct)

## 11. Fuentes (leídas el 2026-10-14)

| Tema | Fuente |
|---|---|
| GenLayer: qué es, Optimistic Democracy, hoja de ruta, ejemplos de costo y tiempo | https://genlayer.com/ |
| GenLayer: redes (Bradbury, Asimov, Studionet), web access, equivalencia, apelaciones, finalidad, cuotas, mensajes a EVM | https://docs.genlayer.com/ (descarga completa: https://docs.genlayer.com/full-documentation.txt) |
| Internet Court: afirmación, criterios, escrow en Base, TRUE/FALSE/UNDETERMINED, arquitectura con LayerZero | https://github.com/genlayer-foundation/internetcourt (README, `bridge/deployments.json`, `bridge/service/src/relay/GenLayerToEvm.ts`) |
| Internet Court: contrato de ejemplo de una sola pregunta | `contracts/bridge/ShipmentDeadlineCourt.py` en el mismo repositorio |
| Internet Court: problema de autorización del puente, abierto | https://github.com/genlayer-foundation/internetcourt/issues/11 |
| Internet Court: lanzamiento (10-jul-2026) | https://www.coindesk.com/business/2026/07/10/okx-metamask-matter-labs-back-dispute-resolution-court-for-ai-agents |
| Stellar: `require_auth` de una cuenta clásica con multifirma (umbral medio) | https://developers.stellar.org/docs/learn/fundamentals/contract-development/authorization |
| LayerZero en Stellar | https://docs.layerzero.network/v2/developers/stellar/overview · https://code4rena.com/audits/2026-04-layerzero-stellar-endpoint |
| AgentResolve hoy | `packages/resolve/src/verdict.ts`, `contracts/agent-resolve/src/lib.rs`, `E-14` a `E-24` en [Fase 7](../../fase-7-estandar-comercio-agentico/DECISIONES.md) |
| El `purchase-escrow` de la Fase 9 | `contracts/purchase-escrow/src/lib.rs`, `X-7` y `X-26` en [Fase 9](../../fase-9-compra-protegida/DECISIONES.md), [`evidencia/T160.md`](../../fase-9-compra-protegida/evidencia/T160.md) |
