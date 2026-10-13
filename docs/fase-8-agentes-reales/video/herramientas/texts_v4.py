# Narration v4: slower voice (speed 0.85), trimmed text. (EN voice, ES subtitle) per phrase.
S0 = [
 ("AI agents already shop for us.", "Los agentes de IA ya compran por nosotros."),
 ("But if their rules live in the prompt, one injected line can change them.", "Pero si sus reglas viven en el prompt, una sola línea inyectada puede cambiarlas."),
 ("AgentPey puts the limits on Stellar, where the agent can't touch them.", "AgentPey pone los límites en Stellar, donde el agente no los puede tocar."),
]
S1 = [
 ("This is our Shopify test store.", "Esta es nuestra tienda de prueba en Shopify."),
 ("A person sees it like this.", "Una persona la ve así."),
 ("An agent sees it through UCP, the Universal Commerce Protocol: the open standard for AI agents to shop.", "Un agente la ve por UCP, el Universal Commerce Protocol: el estándar abierto para que los agentes de IA compren."),
 ("Each store publishes its profile.", "Cada tienda publica su perfil."),
]
S2 = [
 ("I ask Claude to buy a magnet. It asks the store for a quote.", "Le pido a Claude que compre un imán. Le pide una cotización a la tienda."),
 ("The quote: 490 pesos, about fifty cents in USDC.", "La cotización: 490 pesos, unos cincuenta centavos de dólar en USDC."),
 ("Claude doesn't choose who gets paid or how much: the quote does.", "Claude no decide a quién pagarle ni cuánto: lo decide la cotización."),
 ("I say yes to that exact amount.", "Digo que sí a ese monto exacto."),
 ("The payment comes from a contract on Stellar, with caps the network enforces.", "El pago sale de un contrato en Stellar, con topes que aplica la red."),
 ("Claude reports back: order paid, receipt valid.", "Claude informa: pedido pagado, recibo válido."),
]
S3 = [
 ("This page reads the network every ten seconds: the purchase appeared on its own.", "Esta página lee la red cada diez segundos: la compra apareció sola."),
 ("The store signs a receipt and anchors it on Stellar: the page checks it against the network.", "La tienda firma un recibo y lo ancla en Stellar: la página lo comprueba contra la red."),
 ("All three checks green.", "Las tres comprobaciones, en verde."),
]
S4 = [
 ("What if something goes wrong? AgentPey is the only agentic payments stack on Stellar with after-sales protection built in: refund claims, an arbiter, and the money back.", "¿Y si algo sale mal? AgentPey es el único stack de pagos agénticos en Stellar con protección postventa integrada: reclamos de reembolso, un árbitro y el dinero de vuelta."),
 ("This purchase is days old and the store is out of stock: I ask Claude for a refund claim.", "Esta compra tiene días y la tienda no tiene stock: le pido a Claude un reclamo de reembolso."),
 ("Claude signs the claim with the key of the agent that paid. It can't open the dispute: that's the arbiter's job.", "Claude firma el reclamo con la llave del agente que pagó. No puede abrir la disputa: eso lo hace el árbitro."),
 ("Today the arbiter is me: I paste the claim. It checks the receipt, the claimant and the refund window.", "Hoy el árbitro soy yo: pego el reclamo. Revisa el recibo, quién reclama y el plazo de reembolso."),
 ("Then it opens the dispute on Stellar and locks the amount in the store's guarantee. The live page shows it.", "Luego abre la disputa en Stellar y bloquea el monto en la garantía de la tienda. La página en vivo lo muestra."),
 ("Now the store answers: it reads the claim, connects its wallet, accepts and signs. The answer is a signed file.", "Ahora responde la tienda: lee el reclamo, conecta su wallet, acepta y firma. La respuesta es un archivo firmado."),
 ("The arbiter checks that signature and asks an AI referee, which proposes a verdict: full refund.", "El árbitro verifica esa firma y consulta a un árbitro de IA, que propone un veredicto: reembolso completo."),
 ("A person confirms with the verdict's hash, and only then does the contract pay the buyer back.", "Una persona confirma con el hash del veredicto, y recién ahí el contrato devuelve el dinero al comprador."),
 ("Refund paid, and the live page shows it.", "Reembolso pagado, y la página en vivo lo muestra."),
]
S5 = [
 ("It all runs on open standards.", "Todo funciona con estándares abiertos."),
 ("We're proposing it as an SEP, and we want AgentPey to be its reference implementation.", "Lo proponemos como un SEP, y queremos que AgentPey sea su implementación de referencia."),
 ("Next: an escrow that holds each payment until the order is settled, and GenLayer as the standard AI arbiter.", "Lo que sigue: un escrow que retenga cada pago hasta cerrar el pedido, y GenLayer como árbitro estándar con IA."),
 ("AgentPey: agents that shop, with limits the network sets, and a refund when something goes wrong.", "AgentPey: agentes que compran, con límites que pone la red, y reembolso si algo sale mal."),
]
SCENES = {"escena0": S0, "escena1": S1, "escena2": S2, "escena3": S3, "escena4": S4, "escena5": S5}
