# Demo Day de Tellus · el guion tal como se habla

> Solo lo que dice Vicente, de corrido, sin indicaciones. Los pasos, la evidencia de cada frase y los planes B están
> en la [escaleta](ESCALETA.md); este texto la sigue bloque por bloque y suma la presentación, "¿por qué Stellar?" y
> el cierre. Para ensayarlo con el modo de voz de la app de Claude, pega el bloque completo en un chat nuevo del
> celular: la primera línea es la instrucción para que lo lea tal cual.
>
> Unas 500 palabras: a ritmo tranquilo son unos 3:30 de habla, y el resto de los 5:00 lo ocupan Claude cotizando y
> pagando, los clics y las pausas. Si cambia una cifra, cambian los dos documentos.

```text
Léeme en voz alta, en español y con ritmo natural, solo el texto que está debajo de esta línea, tal cual está escrito, sin títulos, sin resumirlo y sin comentarios. Haz una pausa breve en cada párrafo. Al terminar, espera. Si te digo "otra vez", léelo de nuevo.

Hola, soy Vicente y esto es AgentPey: pagos para agentes de inteligencia artificial, sobre Stellar.

Los agentes de IA ya pueden comprar por nosotros. El problema es la confianza. Si le das tu tarjeta a un agente, puede gastar lo que quiera. Y si las reglas están escritas en su prompt, una sola línea inyectada las cambia. AgentPey pone los límites en Stellar, en un contrato que el agente no puede tocar. Les muestro lo que ya funciona, en vivo, en testnet.

Este es Claude, conectado a AgentPey. Le pido que compre un imán en una tienda en Shopify, de prueba y nuestra, que habla el estándar abierto para que los agentes compren.

Claude busca el producto y pide una cotización. Fíjense en algo: Claude no decide a quién pagarle ni cuánto. Eso viene de la cotización de la tienda, y el servidor la vuelve a revisar justo antes de pagar.

Aquí está el monto: unos cincuenta centavos de dólar, en USDC. Yo digo que sí, sobre ese monto exacto. El pago sale de un contrato en Stellar con un tope por compra y otro por día. Si se intenta pagar más que el tope, la red lo rechaza, diga lo que diga el agente.

Esta página lee la red cada diez segundos. Nadie la actualizó: la compra que acabo de hacer apareció sola, con el producto, el monto y la hora. Y esta es la transacción en Stellar: salió del contrato con tope y llegó a la cuenta de la tienda.

La tienda firma un recibo de cada venta y lo ancla en Stellar. Cualquiera lo puede revisar sin confiar en nosotros ni en la tienda: la firma, el ancla en la red y el pago. Ahora le cambio el monto, sin tocar nada más. Las tres pruebas fallan.

¿Y si una compra sale mal? Esta es otra compra, del primero de octubre, que la tienda nunca preparó. El comprador firmó un reclamo. La tienda respondió con su propia firma y aceptó. Un árbitro de IA escribió un veredicto con sus razones, y una persona lo confirmó antes de mover el dinero. El contrato devolvió el monto completo desde una garantía que la tienda dejó en Stellar. Lo hicimos de verdad, ayer.

Lo mismo sirve para una empresa. Este equipo le da a su agente treinta centavos de dólar al día para comprar créditos de IA. Hace una hora, el agente intentó cuatro compras. Tres se pagaron en Stellar. La cuarta se rechazó antes de firmar nada. Y el contrato que paga tiene, además, sus propios topes en la red.

¿Por qué Stellar? Porque el límite vive fuera del agente: el contrato revisa el tope en la misma transacción que mueve el dinero. No lo cumple nuestro software, lo cumple la red. Y el pago en USDC se confirma en segundos.

Todo esto habla estándares abiertos: UCP, para que un agente compre en cualquier tienda que lo hable, y los mandatos de AP2. ChatGPT también compró por el mismo conector. Y publicamos un paquete en npm para que cualquier agente pague así en Stellar.

Hoy es testnet, con tres tiendas nuestras y más de treinta compras hechas por agentes, cada una con su recibo anclado en la red. Lo que sigue es una tienda que no es nuestra, vendiéndoles a agentes. Si tienes un comercio y quieres probarlo, hablemos.

AgentPey: agentes que compran, con límites que pone la red. Gracias.
```

## Qué párrafo va con qué pestaña

| Párrafo que empieza con | Pestaña | Bloque de la escaleta |
|---|---|---|
| "Hola, soy Vicente" y "Los agentes de IA" | 1 · Portada | 1 |
| "Este es Claude" | 2 · claude.ai: escribes el pedido | 2 |
| "Claude busca el producto" | 2 · mientras Claude cotiza | 2 |
| "Aquí está el monto" | 2 · escribes "Yes, pay it." | 2 |
| "Esta página lee la red" | 3 · `/en-vivo`, después clic en **Payment** | 3 |
| "La tienda firma un recibo" | 4 · Terminal: `verificar`, después con `--tamper` | 4 |
| "¿Y si una compra sale mal?" | 3 · `/en-vivo`, fila con **Refunded 1.57 USDC** | 5 |
| "Lo mismo sirve para una empresa" | 5 · Página del presupuesto del equipo | 6 |
| "¿Por qué Stellar?" | 1 · Portada | 7 |
| "Todo esto habla estándares abiertos" hasta "Gracias" | 1 · Portada, sección "What agents can do today" | 7 |

## Si vas atrasado

Corta en este orden, sin cambiar el resto:

1. "¿Por qué Stellar?" (unos 15 segundos).
2. "Lo mismo sirve para una empresa" (unos 25 segundos). Sin ese párrafo, la pestaña 5 no se abre.
3. La segunda mitad de "La tienda firma un recibo": no corras `--tamper` y termina en "el ancla en la red y el pago."

No cortes la compra, `/en-vivo` ni la disputa: son la demo.

## De dónde sale cada frase que no está en la escaleta

- **"Unos cincuenta centavos de dólar":** el imán está a 490 CLP desde el 8-oct en la noche (escaleta §2.4). Si en el
  ensayo Claude cotiza otro monto, ajusta la frase.
- **"El contrato revisa el tope en la misma transacción que mueve el dinero":** el `__check_auth` del `policy_rail`
  aplica los topes dentro de la transferencia ([evidencia/T128.md](../evidencia/T128.md) §7).
- **"Treinta centavos de dólar al día":** el presupuesto del equipo, 0,30 USDC
  ([evidencia/T146.md](../evidencia/T146.md)); lo revisa PolicyRail antes de firmar (`R-27`).
- **"Publicamos un paquete en npm":** `@agentpey/ucp-stellar@0.1.0` ([evidencia/T136.md](../evidencia/T136.md)).
- **"Tres tiendas nuestras y más de treinta compras":** `GET https://agentpey.com/api/live` el 8-oct: 3 tiendas y 32
  compras recientes, cada una confirmada en `receipt-registry` (`R-30`). Compruébalo en el chequeo (escaleta §2.3);
  si da menos de 30, di "decenas de compras".
- **"Lo que sigue es una tienda que no es nuestra":** T130, pendiente en el spec.
- **"Si tienes un comercio y quieres probarlo, hablemos":** el pedido de cierre es tuyo; cámbialo si en Tellus
  quieres pedir otra cosa.
