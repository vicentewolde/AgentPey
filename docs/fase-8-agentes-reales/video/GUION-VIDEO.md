# Video de Find Your Way · guion final (T142)

> **Entregado el 13-oct-2026.** Duración **2:59,0**, 1080p. La **voz va en inglés** (voz clonada del usuario, ElevenLabs `eleven_multilingual_v2`, velocidad 0,85, 0,4 s de pausa entre frases) y los **subtítulos en español**; la pantalla va en inglés. Este documento es el texto y los tiempos que se usaron, con la evidencia de cada afirmación. El método y los scripts están en [`herramientas/`](herramientas/README.md); cómo llegamos al texto, en [PROPUESTA-V3.md](PROPUESTA-V3.md); cómo se grabó, en [HOJA-DE-MARCAS.md](HOJA-DE-MARCAS.md).

## 1. El video en una tabla

| Escena | Duración | Empieza en |
|---|---|---|
| 0 · El problema | 13.4 s | 0:00,0 |
| 1 · El estándar | 16.8 s | 0:13,1 |
| 2 · Claude compra | 28.7 s | 0:29,6 |
| 3 · Aparece sola, y su recibo | 16.6 s | 0:58,0 |
| 4 · Si sale mal: la postventa | 79.1 s | 1:14,2 |
| 5 · El SEP, lo que sigue y el cierre | 25.9 s | 2:33,0 |
| **Total** (fundidos de 0,3 s) | **2:58,9** | |

## 2. Escena por escena

«De–A» son segundos dentro de la escena. «Acelerado» es una espera recortada; «acercamiento» es un zoom suave y temporal.

### Escena 0 · El problema (13.4 s)

| De–A | Voz (EN) | Subtítulo (ES) | Pantalla |
|---|---|---|---|
| 0.4–2.9 | AI agents already shop for us. | Los agentes de IA ya compran por nosotros. | Tu toma de la portada, quieta (la que ya tienes) |
| 3.3–7.6 | But if their rules live in the prompt, one injected line can change them. | Pero si sus reglas viven en el prompt, una sola línea inyectada puede cambiarlas. | Igual; la portada sigue quieta |
| 8.0–12.4 | AgentPey puts the limits on Stellar, where the agent can't touch them. | AgentPey pone los límites en Stellar, donde el agente no los puede tocar. | Igual; fundido hacia la escena 1 |

**Respaldo:**

- La tesis del proyecto: [`fase-1-agentpass/CONTEXTO.md`](../../fase-1-agentpass/CONTEXTO.md).
- El tope vive en el contrato (`__check_auth` del `policy_rail`), no en el agente: [evidencia/T128.md](../evidencia/T128.md) §4 y §7. El titular de la portada: [evidencia/T152.md](../evidencia/T152.md).

### Escena 1 · El estándar (16.8 s)

| De–A | Voz (EN) | Subtítulo (ES) | Pantalla |
|---|---|---|---|
| 0.4–2.5 | This is our Shopify test store. | Esta es nuestra tienda de prueba en Shopify. | 1A: la portada de la tienda y baja a los productos (tiempo real) |
| 2.9–4.7 | A person sees it like this. | Una persona la ve así. | 1A: clic en el imán; ficha a $490 (tiempo real) |
| 5.1–12.0 | An agent sees it through UCP, the Universal Commerce Protocol: the open standard for AI agents to shop. | Un agente la ve por UCP, el Universal Commerce Protocol: el estándar abierto para que los agentes de IA compren. | 1B: /stores con las tres tiendas; acercamiento suave a los enlaces «UCP profile» |
| 12.9–15.3 | Each store publishes its profile. | Cada tienda publica su perfil. | 1B: sigue en /stores; imagen fija al final para leer |

**Respaldo:**

- UCP en dos versiones y la suite oficial: [evidencia/T131.md](../evidencia/T131.md), [evidencia/T133.md](../evidencia/T133.md).
- `/stores` lista las tres tiendas con su perfil UCP y su último recibo, leídos de la red: [evidencia/T141.md](../evidencia/T141.md).

### Escena 2 · Claude compra (28.7 s)

| De–A | Voz (EN) | Subtítulo (ES) | Pantalla |
|---|---|---|---|
| 0.4–4.6 | I ask Claude to buy a magnet. It asks the store for a quote. | Le pido a Claude que compre un imán. Le pide una cotización a la tienda. | Tu texto pegado y enviado; Claude busca y cotiza (la espera va acelerada) |
| 7.0–11.0 | The quote: 490 pesos, about fifty cents in USDC. | La cotización: 490 pesos, unos cincuenta centavos de dólar en USDC. | La cotización aparece; acercamiento a «Exact amount» (tiempo real) |
| 11.4–15.2 | Claude doesn't choose who gets paid or how much: the quote does. | Claude no decide a quién pagarle ni cuánto: lo decide la cotización. | La cotización queda a la vista; acercamiento a «Recipient / Paid from» |
| 15.6–17.6 | I say yes to that exact amount. | Digo que sí a ese monto exacto. | Tú escribes «yes, pay» (tiempo real) |
| 18.3–23.6 | The payment comes from a contract on Stellar, with caps the network enforces. | El pago sale de un contrato en Stellar, con topes que aplica la red. | Claude paga: el contador de la herramienta se alcanza a leer (la espera va acelerada) |
| 24.7–28.2 | Claude reports back: order paid, receipt valid. | Claude informa: pedido pagado, recibo válido. | La respuesta de Claude; acercamiento a «Order / Paid / Receipt»; queda fija |

**Respaldo:**

- Claude busca, cotiza y paga después del «sí» de la persona: [evidencia/T150.md](../evidencia/T150.md) §5 y [evidencia/T151.md](../evidencia/T151.md) §6 (`R-28`; `R-11` sigue vigente).
- El destinatario y el monto salen de la cotización, y `pay` los revisa de nuevo: [evidencia/T128.md](../evidencia/T128.md). Los topes del rail los aplica la red (`PerTxExceeded`): [evidencia/T128.md](../evidencia/T128.md) §4.
- La compra de la grabación: `ord_mv72b5ma23c69f26bf`, 490 CLP = 0,5157895 USDC, pago `449f0669…8bcf` y ancla `b5081709…05a2` ([evidencia/T142.md](../evidencia/T142.md) §3).

### Escena 3 · Aparece sola, y su recibo (16.6 s)

| De–A | Voz (EN) | Subtítulo (ES) | Pantalla |
|---|---|---|---|
| 0.4–5.9 | This page reads the network every ten seconds: the purchase appeared on its own. | Esta página lee la red cada diez segundos: la compra apareció sola. | /live: la compra nueva aparece sola; acercamiento a la fila resaltada y a las cifras |
| 6.3–12.2 | The store signs a receipt and anchors it on Stellar: the page checks it against the network. | La tienda firma un recibo y lo ancla en Stellar: la página lo comprueba contra la red. | Clic en «Receipt» y carga el recibo (se corta la pantalla en blanco); acercamiento a las tres pruebas |
| 13.1–14.9 | All three checks green. | Las tres comprobaciones, en verde. | Las tres pruebas en verde, quietas; se baja a los datos y a los enlaces de Stellar |

**Respaldo:**

- `/live` lee la red cada 10 s y mostró sola la compra nueva: [evidencia/T151.md](../evidencia/T151.md); de dónde sale cada dato, `R-30`.
- La página del recibo y sus tres pruebas: [evidencia/T154.md](../evidencia/T154.md).

### Escena 4 · Si sale mal: la postventa (79.1 s)

| De–A | Voz (EN) | Subtítulo (ES) | Pantalla |
|---|---|---|---|
| 0.4–11.8 | What if something goes wrong? AgentPey is the only agentic payments stack on Stellar with after-sales protection built in: refund claims, an arbiter, and the money back. | ¿Y si algo sale mal? AgentPey es el único stack de pagos agénticos en Stellar con protección postventa integrada: reclamos de reembolso, un árbitro y el dinero de vuelta. | /live con filas «Refunded 0.52 USDC» y «Dispute open»; acercamiento lento y suave sobre las filas |
| 12.2–18.2 | This purchase is days old and the store is out of stock: I ask Claude for a refund claim. | Esta compra tiene días y la tienda no tiene stock: le pido a Claude un reclamo de reembolso. | Claude: tu pedido de reclamo con la orden y el motivo; acercamiento al texto (tiempo real) |
| 19.1–26.3 | Claude signs the claim with the key of the agent that paid. It can't open the dispute: that's the arbiter's job. | Claude firma el reclamo con la llave del agente que pagó. No puede abrir la disputa: eso lo hace el árbitro. | Claude trabaja (acelerado) y responde «claim signed, no dispute is open yet»; acercamiento a esas líneas. Después, 2,8 s sin voz: el claim_jws se escribe rápido y lo copias |
| 29.2–36.1 | Today the arbiter is me: I paste the claim. It checks the receipt, the claimant and the refund window. | Hoy el árbitro soy yo: pego el reclamo. Revisa el recibo, quién reclama y el plazo de reembolso. | El árbitro: pegas el reclamo y pulsas «Open the dispute» (tiempo real); la espera de 13 s va acelerada |
| 37.5–44.9 | Then it opens the dispute on Stellar and locks the amount in the store's guarantee. The live page shows it. | Luego abre la disputa en Stellar y bloquea el monto en la garantía de la tienda. La página en vivo lo muestra. | Resultados del árbitro: ✅ recibo, ✅ firmante, ✅ plazo y monto bloqueado (acercamiento); luego /live con «Dispute open · 0.52 USDC locked» |
| 46.8–55.3 | Now the store answers: it reads the claim, connects its wallet, accepts and signs. The answer is a signed file. | Ahora responde la tienda: lee el reclamo, conecta su wallet, acepta y firma. La respuesta es un archivo firmado. | La tienda: pega y lee el reclamo, conecta la wallet, acepta y escribe (acelerado); Freighter «Sign message» y Confirm (tiempo real); descarga del archivo |
| 56.3–64.0 | The arbiter checks that signature and asks an AI referee, which proposes a verdict: full refund. | El árbitro verifica esa firma y consulta a un árbitro de IA, que propone un veredicto: reembolso completo. | El árbitro: «Use the latest download» (se corta el diálogo de macOS), ✅ la firma de la tienda, «Request the verdict»; el árbitro de IA lee (acelerado) y llega «Reembolso completo» con sus razones |
| 66.1–72.5 | A person confirms with the verdict's hash, and only then does the contract pay the buyer back. | Una persona confirma con el hash del veredicto, y recién ahí el contrato devuelve el dinero al comprador. | Copiar el hash, pegarlo y «Confirmar y pagar» (tiempo real); el contrato paga (acelerado) |
| 73.9–77.4 | Refund paid, and the live page shows it. | Reembolso pagado, y la página en vivo lo muestra. | «Reembolso pagado» (acercamiento) y /live: «Refunded 0.52 USDC» en la fila (acercamiento a la insignia) |

**Respaldo:**

- **«The only agentic payments stack on Stellar…» no tiene evidencia**: es una decisión del usuario del 13-oct (ver §3).
- Claude **firma** el reclamo y no abre la disputa; la abre el árbitro: [ENSAYO-RECLAMO.md](../demo-day/ENSAYO-RECLAMO.md) y la descripción de `open_claim`.
- El árbitro revisa recibo, firmante y plazo, y bloquea el monto en la garantía de la tienda: [ENSAYO-RECLAMO.md](../demo-day/ENSAYO-RECLAMO.md) §0 y §2; la pantalla, [evidencia/T155.md](../evidencia/T155.md).
- La tienda firma con la wallet de su cuenta de cobro y la respuesta viaja como archivo: `E-20` y `E-21`.
- El árbitro de IA propone y una persona confirma con el hash antes de pagar: `E-18`.
- El reclamo real del video: `ord_mv1j4adu5b738b5e01`, reembolso de 0,5157895 USDC, veredicto `d270ccbf…4d849` ([evidencia/T142.md](../evidencia/T142.md) §4).

### Escena 5 · El SEP, lo que sigue y el cierre (25.9 s)

| De–A | Voz (EN) | Subtítulo (ES) | Pantalla |
|---|---|---|---|
| 0.4–2.8 | It all runs on open standards. | Todo funciona con estándares abiertos. | Tu toma 5A: la portada baja hasta las tarjetas «Real agents, real stores…» (tiempo real) |
| 4.4–10.7 | We're proposing it as an SEP, and we want AgentPey to be its reference implementation. | Lo proponemos como un SEP, y queremos que AgentPey sea su implementación de referencia. | Tu toma 5B: el anexo técnico en GitHub; baja lento por la tabla del recorrido (tiempo real) |
| 11.1–18.1 | Next: an escrow that holds each payment until the order is settled, and GenLayer as the standard AI arbiter. | Lo que sigue: un escrow que retenga cada pago hasta cerrar el pedido, y GenLayer como árbitro estándar con IA. | 5B: sigue en el anexo; imagen fija al final |
| 18.5–25.4 | AgentPey: agents that shop, with limits the network sets, and a refund when something goes wrong. | AgentPey: agentes que compran, con límites que pone la red, y reembolso si algo sale mal. | Tu toma 5C: la portada de arriba, quieta; fundido de salida |

**Respaldo:**

- UCP y AP2 (verificado con la librería oficial): [evidencia/T133.md](../evidencia/T133.md), [evidencia/T134.md](../evidencia/T134.md); el paquete `@agentpey/ucp-stellar` en npm: [evidencia/T136.md](../evidencia/T136.md).
- AgentPey como implementación de referencia del SEP: [ANEXO-SEP.md](../../fase-7-estandar-comercio-agentico/ANEXO-SEP.md). **El SEP no está publicado**: el video dice «lo proponemos».
- **El escrow y GenLayer son lo que sigue, no algo hecho.** El de GenLayer es una prueba técnica pendiente (T138).

## 3. Lo que el video afirma sin respaldo, y lo que no dice

**Afirmaciones sin respaldo en el repo (decisión del usuario):**

- **«AgentPey is the only agentic payments stack on Stellar with after-sales protection built in»** (escena 4). No se verificó que sea cierto. El 13-oct se propuso decirlo con salvaguarda («as far as we know») o de forma más concreta; el usuario eligió decirlo **sin salvaguarda**. Existe Trustless Work (escrows y disputas en Stellar, T139 es su prueba técnica), que un juez del ecosistema podría conocer.
- **«Next: an escrow … and GenLayer as the standard AI arbiter»** (escena 5). Son planes. Ni el escrow ni GenLayer están construidos; T138 (GenLayer) y T139 (Trustless Work) siguen siendo pruebas técnicas pendientes de documento.

**Lo que no dice, a propósito:**

- Que Claude abre la disputa: Claude **firma** el reclamo; la abre el árbitro, que hoy es una persona con su pantalla. Lo mismo con la respuesta de la tienda: se pasa a mano como un archivo (`E-21`). El video ya no dice que el reclamo y la respuesta se pasan a mano (esa frase se quitó a pedido del usuario), pero sí dice «Today the arbiter is me» y que la respuesta es un archivo firmado.
- Que el pago quedó retenido: el pago fue directo a la tienda; el reembolso sale de la garantía que la tienda dejó en el contrato de disputas.
- Que hay una tienda de terceros: T130 sigue pendiente; la tienda de Shopify es de AgentPey, y la voz lo dice («our Shopify test store»).
- Que cualquiera puede conectar su Claude: en el piloto solo inicia sesión la wallet dueña del rail.
- Que el SEP está publicado: dice «lo proponemos».
- Que la red aplica el presupuesto de un equipo (el video no habla del presupuesto de equipo; la red aplica los topes del rail).
- Mainnet, dinero real, usuarios o ingresos: todo es testnet.

**Defectos conocidos del video:**

- El árbitro (una página local) aparece en inglés, traducido por Chrome, y vuelve a español al llegar el veredicto; el razonamiento del árbitro de IA sale en español (se ve unos 6 s).
- Las cifras de la portada (3 · 27 · 48,64 · 5) en las escenas 0 y 5 son de antes del reembolso; `/live` en la escena 3 ya muestra 27 · 47,59 · 4.
- La pantalla negra de Freighter y el diálogo de macOS «responder would like to access files in your Downloads folder» se cortaron al montar.

## 4. Dónde está cada cosa

| Qué | Dónde |
|---|---|
| Video final (40 MB) y copia liviana (19 MB) | `entrega/`, **solo en esta máquina** (excluido de git: pesa y el repo es público) |
| Voz final (`.mp3`) | `herramientas/audio2/`, **solo local** (es una voz clonada). Los tiempos de cada letra (`.align.json`) sí están versionados |
| Grabaciones de pantalla originales (`.mov`, ~270 MB) | El escritorio del usuario (`~/Desktop/AgentPey video/`); no se versionan |
| Entrega | La hizo el usuario el 13-oct; el video se subió a YouTube para el envío |

