# Demo Day Stellarbarrio · guion del pitch (T106)

> Viernes 2026-09-25, 19:00 (Santiago), presencial en Stellarbarrio. 5 minutos
> con corte duro a los 5:00. Presenta Vicente. Decisión: `C-146`.
> Slides: el deck "AgentPey Demo Day" (Artifact privado,
> <https://claude.ai/artifact/McgRzVYPWTysDudyWXHVMV>). Cada slide trae este mismo
> texto en sus notas.
> Paso a paso del video de respaldo y de la demo en vivo:
> [VIDEO-RESPALDO.md](VIDEO-RESPALDO.md).

## Tiempos (los del Notion de los organizadores)

| Tramo | Slide | Qué | Palabras aprox. |
|---|---|---|---|
| 0:00 a 0:20 | 1 | Proyecto y frase | 45 |
| 0:20 a 1:00 | 2 | Problema | 100 |
| 1:00 a 2:00 | 3 + navegador | Solución y demo en vivo | 130 |
| 2:00 a 2:45 | 4 | Por qué Stellar | 110 |
| 2:45 a 3:30 | 5 | Tracción | 100 |
| 3:30 a 4:15 | 6 | Roadmap | 90 |
| 4:15 a 5:00 | 7 | Equipo, ask y cierre | 80 |
| (solo si todo falla) | 8 | Respaldo: la compra real del 24 | |

Ritmo de referencia: unas 2,5 palabras por segundo. Si al ensayar pasas de
5:00, recorta primero en la slide 4 (Por qué Stellar), nunca en la demo.

## El guion, slide por slide

### 1 · Proyecto y frase (0:00 a 0:20)

Hola, soy Vicente y esto es AgentPey.

AgentPey ayuda a que un agente de inteligencia artificial compre por ti en
tiendas reales, sin salirse nunca del permiso que firmaste con tu wallet.

Y ese límite no lo cumple el agente: lo cumple Stellar.

### 2 · Problema (0:20 a 1:00)

Los agentes de IA ya pueden comprar. El problema es cómo les das permiso.

Hoy tienes dos opciones. Le pasas tu tarjeta o una API key, y es todo o nada.
O apruebas cada compra a mano, y pierdes la automatización.

Y hay algo peor: si la regla de cuánto puede gastar vive en el prompt del
agente, basta un texto escondido en una página web para reescribirla. Eso se
llama prompt injection.

Del otro lado, la tienda no tiene cómo saber si ese agente estaba autorizado.

Esto le pasa a cualquier empresa que quiera darle agentes a sus usuarios, y a
cualquier tienda que quiera venderles.

### 3 · Solución y demo en vivo (1:00 a 2:00)

Con la slide: Así funciona: contratas un agente, firmas su permiso, compra, y
la tienda recibe un recibo. Les muestro.

Cambia al navegador (ver [VIDEO-RESPALDO.md](VIDEO-RESPALDO.md) § "Demo en
vivo"):

- **Pestaña RealOps.** Esto es RealOps, una app de ejemplo. Ya contraté un
  comprador para la tienda MycoKit, que vende kits para cultivar hongos, y firmé
  su permiso con Freighter: máximo por compra, máximo por día, solo esta tienda,
  solo USDC.
- **Clic en "Pedirle al agente que lo compre".** Le pido un kit Cola de Pavo.
  AgentPey revisa el pedido contra el permiso firmado y paga desde un contrato
  en Stellar.
- **Clic en "Ver el pago en Stellar".** Esta es la transacción en la red:
  exitosa. Movió 2,09 dólares en USDC desde el contrato que tiene mis reglas
  directo a la wallet de la tienda, y la comisión fue menos de un centavo.
  (Qué señalar en la pantalla: § "Qué señalar en Stellar Expert".)
- **Pestaña del panel de Vitrinee, recargar.** Y este es el panel del dueño de
  la tienda: la venta está ahí, con su recibo. Tres comprobaciones: la firma de
  la tienda, el ancla en Stellar y el pago real. Las tres en verde.

Si algo falla: no expliques, abre el video de respaldo y narra encima con este
mismo texto.

### 4 · Por qué Stellar (2:00 a 2:45)

¿Por qué Stellar? Porque en Stellar el límite de gasto puede vivir fuera del
agente.

El agente no paga desde una wallet cualquiera. Paga desde un contrato Soroban,
que llamamos policy_rail, y ese contrato revisa el tope por compra y por día en
la misma transacción que mueve el dinero. Si el agente intenta pasarse, la red
rechaza el pago. No nuestro software: la red.

Además: USDC y pagos x402 que se liquidan en segundos por una fracción de
centavo. Freighter, para firmar el permiso sin contraseñas. Y un registro en
Stellar donde cada recibo queda anclado, para que cualquiera lo verifique.

Sin Stellar, esto sería una promesa. Con Stellar, es una regla.

### 5 · Tracción (2:45 a 3:30)

¿Dónde estamos? Todo esto corre hoy en Stellar testnet, en vivo.

Dos tiendas Jumpseller reales venden a agentes: Bazar Cordillera, y MycoKit,
que se dio de alta sola desde el portal, sin una línea de código y sin deploy.

Un agente ya hizo dos compras reales en esas tiendas, pagadas en USDC y con
recibo verificado. Hay tres contratos Soroban desplegados.

Y detrás: 105 hitos entregados, casi mil quinientos tests automáticos y más de
300 decisiones documentadas.

No tenemos miles de usuarios. Tenemos el camino completo funcionando, de punta
a punta.

### 6 · Roadmap (3:30 a 4:15)

Hoy: el lado del comprador y el lado del vendedor funcionan en testnet, con
tiendas reales.

Próximo hito, este trimestre: el primer partner externo que compra solo, sin
que nadie de nosotros toque una terminal. Y **[N]** tiendas Jumpseller
vendiendo a agentes, con una app de Jumpseller para darse de alta en un clic.

Después: mainnet. Pero solo con los contratos auditados por un tercero y con el
encaje regulatorio claro en Chile, bajo la Ley Fintech. Preferimos llegar tarde
a mainnet que llegar con plata real sobre contratos sin auditar.

### 7 · Equipo, ask y cierre (4:15 a 5:00)

Soy Vicente, **[tu rol y experiencia en una línea]**. Construí AgentPey con
agentes de código, bajo un protocolo estricto: cada cambio se revisa antes de
entrar y cada decisión queda escrita.

Lo que pedimos: tiendas Jumpseller que quieran vender a agentes, gratis en
testnet. Una introducción al equipo de Jumpseller. Y un primer partner que
quiera que sus agentes compren con reglas.

Lo que viene ahora: el primer partner externo comprando solo.

Gracias.

## Qué señalar en Stellar Expert

Una sola línea de la transacción:
`G…  invoked contract CBIE…DAMA transfer(C…, GD2M…K5GN, 20947368)`.

| Lo que ves | Qué es |
|---|---|
| **Successful** | El pago quedó en la red |
| `CBIE…DAMA` | El contrato de USDC en Stellar |
| El primer `C…` del `transfer` | **Quién paga**: el contrato con tus reglas (`policy_rail`), no una wallet del agente |
| `GD2M…K5GN` | **Quién cobra**: la wallet de MycoKit (la tuya) |
| `20947368` | 2,09 USDC (USDC usa 7 decimales) |
| La cuenta que invoca (`G…`) | Quien envía la transacción y paga la comisión, para que el agente no necesite XLM |

## De dónde sale cada cifra

Nada de esto es estimado; si una cifra cambia, se cambia aquí y en la slide 5.

| Cifra | Fuente |
|---|---|
| 2 tiendas reales (Bazar Cordillera 6 productos, MycoKit 4) | `evidencia/T105.md` § 6.3 |
| 2 compras reales de un agente, con recibo verificado | `evidencia/T101.md` (café, 9,46 USDC) y `evidencia/T104.md` § 6 (stickers, 1,04 USDC). El recibo de T104 se volvió a verificar en vivo el 2026-09-24 (`evidencia/T106.md`) |
| 0 líneas de código para sumar una tienda | T105: MycoKit se dio de alta por el portal, sin deploy |
| 3 contratos Soroban en testnet | `agent_registry` y `policy_rail` (`deployments/testnet.json`), `receipt-registry` (`deployments/vitrinee-testnet.json`) |
| 105 hitos | T1 a T105, `ROADMAP.md` y las `BITACORA.md` de cada fase |
| 1.495 tests | Último total completo, medido en T95 (`BITACORA.md` de la fase 6). Desde entonces se sumaron más, pero no hay un total nuevo; por eso se dice "casi mil quinientos" |
| Más de 300 decisiones | 313 registros en los ocho `DECISIONES.md` |

## Preguntas probables y respuestas cortas

- **¿Qué pasa si el agente intenta gastar más?** La red rechaza el pago. Lo
  probamos en testnet: un cliente que pasó su tope diario fue rechazado por el
  contrato, no por nuestro código.
- **¿Y si alguien roba la llave del agente?** Esa llave solo puede gastar
  dentro de los topes. El dueño de la wallet puede retirar todo el saldo o
  cambiar esa llave sin pedirnos permiso, y el permiso se puede revocar desde
  fuera del agente.
- **¿Quién guarda la plata?** Un contrato en Stellar, no AgentPey. La wallet
  del cliente puede sacarla cuando quiera. Hoy todo es testnet.
- **¿Por qué el panel dice "Pagado, pedido aún no llega a tu tienda"?**
  Jumpseller todavía no nos habilita crear pedidos por su API; ya escribimos a
  soporte. El pago y el recibo son reales, y cuando lo habiliten el pedido
  entra sin volver a cobrar.
- **¿Cuál es el modelo de negocio?** Hoy es gratis en testnet; lo vamos a
  definir con los primeros partners. (No prometas precios ni comisiones.)
- **¿Qué es x402?** Un estándar para pagar por HTTP: la tienda responde "pago
  requerido", el agente paga y recibe lo que pidió.
- **¿Cuándo mainnet?** Sin fecha. Primero auditoría externa de los contratos y
  encaje regulatorio en Chile.

## Qué NO mostrar ni decir

- Nada de terminal, Render, archivos `.env`, claves ni el panel de
  administración de Jumpseller.
- No digas "entregado": RealOps marca así la compra, pero el pedido todavía no
  llega a Jumpseller (T101).
- Nada de mainnet, dinero real, usuarios, ingresos, AgentGuard ni rieles fiat.
- No leas las slides: la slide acompaña, tú cuentas.

## Logística presencial

- Laptop cargada y cargador. Adaptador de tu laptop a HDMI (pregunta al llegar
  qué conector usa el proyector).
- Internet: la wifi del lugar y, de respaldo, el hotspot de tu teléfono ya
  probado.
- El video de respaldo guardado **en el escritorio**, no en la nube.
- El deck abierto en modo presentación y, por si falla internet, una copia
  descargada en PDF desde el mismo deck.
- Modo "No molestar" activado en el Mac, notificaciones fuera.
