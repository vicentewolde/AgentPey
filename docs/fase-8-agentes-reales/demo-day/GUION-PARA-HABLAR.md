# Demo Day de Tellus · el guion tal como se habla

> Solo lo que dice Vicente, de corrido, sin indicaciones. Los pasos, la evidencia de cada frase y los planes B están
> en la [escaleta](ESCALETA.md); este texto la sigue bloque por bloque. Para ensayarlo con el modo de voz de la app
> de Claude, pega el bloque completo en un chat nuevo del celular: la primera línea es la instrucción para que lo lea
> tal cual. El [video del ensayo guiado](#el-video-del-ensayo-guiado) muestra cada párrafo con su pantalla.
>
> La duración total se ajusta después (pedido del usuario el 9-oct). Si cambia una cifra, cambian los dos documentos.

```text
Léeme en voz alta, en español y con ritmo natural, solo el texto que está debajo de esta línea, tal cual está escrito, sin títulos, sin resumirlo y sin comentarios. Haz una pausa breve en cada párrafo. Al terminar, espera. Si te digo "otra vez", léelo de nuevo.

Hola, soy Vicente y esto es AgentPey: pagos para agentes de inteligencia artificial, sobre Stellar.

Los agentes de IA ya pueden comprar por nosotros. El problema es la confianza. Si le das tu tarjeta a un agente, puede gastar lo que quiera. Y si las reglas están escritas en su prompt, una sola línea inyectada las cambia. AgentPey pone los límites en Stellar, en un contrato que el agente no puede tocar. Les muestro lo que ya funciona, en vivo, en testnet.

Esta es la tienda donde va a comprar el agente. Es una tienda en Shopify, de prueba y nuestra, con productos y precios en pesos chilenos. Este imán cuesta 490 pesos. Una persona la ve así. Un agente la ve por el estándar abierto de comercio para agentes, UCP.

Ahora le pido a Claude que compre ese imán. Claude busca el producto y le pide una cotización a la tienda. Fíjense en algo: Claude no decide a quién pagarle ni cuánto. Eso viene de la cotización de la tienda, y el servidor la vuelve a revisar justo antes de pagar.

Yo digo que sí, sobre ese monto exacto: unos cincuenta centavos de dólar, en USDC. El pago sale de un contrato en Stellar con un tope por compra y otro por día. Si se intenta pagar más que el tope, la red lo rechaza, diga lo que diga el agente.

Esta página lee la red cada diez segundos. Nadie la actualizó: la compra que acabo de hacer apareció sola, con el producto, el monto y la hora.

La tienda firma un recibo de cada venta y lo ancla en Stellar. Esta página lo comprueba contra la red: la firma de la tienda, el ancla y el pago. Las tres, en verde. Y cualquiera puede hacer esta misma comprobación por su cuenta, sin confiar en nosotros.

Ahora lo más importante: ¿qué pasa si una compra sale mal? Esta mañana Claude compró otro imán, y la tienda me avisó que no tiene stock. Le pido a Claude que abra un reclamo. Claude lo firma con la llave del agente que pagó: nadie más puede reclamar por esta compra.

Hoy el árbitro soy yo, con esta pantalla. Revisa que el recibo sea válido, que quien reclama controle la cuenta que pagó y que esté dentro del plazo. Y abre la disputa en Stellar: el monto queda bloqueado en una garantía que la tienda dejó en el contrato.

Ahora soy la tienda. Yo no puedo entrar al chat del comprador: el árbitro me entrega su reclamo firmado, y como está firmado nadie pudo cambiarlo. Lo leo y respondo con mi propia firma, desde la cuenta que recibió el pago: acepto, no tengo stock.

Un árbitro de IA lee el recibo, el reclamo y la respuesta firmada, y escribe un veredicto con sus razones. No mueve dinero: solo propone. Dice que la falta de stock es responsabilidad del comercio, así que corresponde el reembolso total.

Una persona confirma el veredicto escribiendo su hash, y recién ahí el contrato devuelve el dinero a la cuenta que pagó. Todo quedó en la red: la disputa, el veredicto y el reembolso.

Lo mismo sirve para una empresa. Este equipo le da a su agente treinta centavos de dólar al día para comprar créditos de IA. Hace un rato, el agente intentó cuatro compras. Tres se pagaron en Stellar. La cuarta se rechazó antes de firmar nada. Y el contrato que paga tiene, además, sus propios topes en la red.

¿Por qué Stellar? Porque el límite vive fuera del agente: el contrato revisa el tope en la misma transacción que mueve el dinero. No lo cumple nuestro software, lo cumple la red. Y el pago en USDC se confirma en segundos.

Todo esto habla estándares abiertos: UCP, para que un agente compre en cualquier tienda que lo hable, y los mandatos de AP2. ChatGPT también compró por el mismo conector. Y publicamos un paquete en npm para que cualquier agente pague así en Stellar.

Hoy es testnet, con tres tiendas nuestras y más de veinte compras hechas por agentes, cada una con su recibo anclado en la red. Lo que sigue es una tienda que no es nuestra, vendiéndoles a agentes. Si tienes un comercio y quieres probarlo, hablemos.

AgentPey: agentes que compran, con límites que pone la red. Gracias.
```

## Qué párrafo va con qué pestaña

| Párrafo que empieza con | Pestaña | Bloque de la escaleta |
|---|---|---|
| "Hola, soy Vicente" y "Los agentes de IA" | 1 · Portada | 1 |
| "Esta es la tienda" | 2 · El imán en Shopify | 2 |
| "Ahora le pido a Claude" | 3 · claude.ai: escribes el pedido y Claude cotiza | 3 |
| "Yo digo que sí" | 3 · escribes "Sí, paga." | 3 |
| "Esta página lee la red" | 4 · `/en-vivo` | 4 |
| "La tienda firma un recibo" | 4 · clic en **Recibo**: la página del recibo | 5 |
| "Ahora lo más importante" | 3 · claude.ai: pides el reclamo | 6a |
| "Hoy el árbitro soy yo" | 6 · Pantalla del árbitro, paso 1; después 4 · `/en-vivo` | 6b |
| "Ahora soy la tienda" | 5 · `/resolve/responder` con Freighter | 6c |
| "Un árbitro de IA" | 6 · Pantalla del árbitro, pasos 2 y 3 | 6d |
| "Una persona confirma" | 6 · Pantalla del árbitro, paso 4; después 4 · `/en-vivo` | 6e |
| "Lo mismo sirve para una empresa" | 7 · Página del presupuesto del equipo | 7 |
| "¿Por qué Stellar?" hasta "Gracias" | 1 · Portada, sección "Lo que los agentes ya pueden hacer" | 8 |

## Si vas atrasado

Corta en este orden, sin cambiar el resto:

1. "¿Por qué Stellar?"
2. "Lo mismo sirve para una empresa" (sin ese párrafo, la pestaña 7 no se abre).
3. "La tienda firma un recibo" (el bloque 5 entero).

No cortes la compra, `/en-vivo` ni el reclamo: son la demo.

## De dónde sale cada frase que no está en la escaleta

Todas las frases de este texto están en la escaleta con su respaldo, salvo dos que resumen lo que se ve en vivo:

- **"Dice que la falta de stock es responsabilidad del comercio":** el razonamiento del árbitro en el ensayo
  ([ENSAYO-RECLAMO.md](ENSAYO-RECLAMO.md) §4). En vivo, lee lo que diga el veredicto de ese momento.
- **"Si tienes un comercio y quieres probarlo, hablemos":** el pedido de cierre es tuyo; cámbialo si en Tellus
  quieres pedir otra cosa.

## El video del ensayo guiado

Un video con voz (sintética, en español) y subtítulos recorre la escaleta sobre las páginas reales: arriba, en
amarillo, lo que haces; abajo, lo que dices. Vive solo en el computador del usuario
(`demo-day/ensayo-guiado.mp4`, excluido de git): Claude, Freighter y la terminal se muestran como tarjetas con lo que
se escribe, porque el video no entra a las cuentas del usuario.
