# Bitácora — Fase 7 (Estándar de comercio agéntico sobre Stellar)

> Qué se hizo, qué falta, y qué significa cada cosa en lenguaje llano.
> Spec: [SPEC.md](SPEC.md) · Decisiones: [DECISIONES.md](DECISIONES.md) ·
> Salidas crudas de cada tarea: `evidencia/T<n>.md`
>
> La numeración continúa la de las fases anteriores: esta fase empieza en T120.
> El tablero del día a día es [`docs/ESTADO.md`](../ESTADO.md); aquí queda la
> narrativa de cada tarea cerrada.

---

## Estado actual

**Fecha:** 2026-09-30 · Spec aprobado. **T120 cerrada** (opción A, `E-1` a
`E-4`). **T121 en revisión**: cada tienda publica su perfil y su catálogo UCP.
**Sigue:** la decisión `VT-36`, el deploy y T122.

| Tarea | Estado |
|---|---|
| T120 Prueba técnica | cerrada |
| T121 Perfil y catálogo UCP | en revisión |
| T122 a T125 | pendientes |

## Apertura de la fase (2026-09-30)

El usuario decidió cambiar cómo se presenta AgentPey (`P-14`): en vez de
competir como "identidad y permisos para agentes", un terreno que en Stellar
ya tiene varios proyectos financiados, AgentPey hace funcionar sobre Stellar
los estándares de comercio que ya están ganando (UCP, AP2, x402) y les agrega
lo que les falta: el pago en Stellar, los recibos verificables, las tiendas de
Latinoamérica y las disputas.

El mismo día cambió la forma de trabajar (`P-15`): cada fase tiene un spec que
el usuario aprueba antes de que se escriba código, y cada sesión sigue el
ciclo `/estado`, `/tarea`, `/revisar` y merge.

## T120 · ¿Cabe un pago de Stellar dentro de UCP? (2026-09-30, cerrada)

**En lenguaje llano.** UCP es el idioma común que Google, Shopify y otros
definieron para que un agente compre en una tienda. La pregunta era si ese
idioma deja pagar con Stellar. La respuesta es sí: UCP permite que cualquiera
defina un "medio de pago" propio, siempre que publique sus reglas en su
dominio. El de AgentPey se llamaría `com.agentpey.stellar_x402` y sus reglas
vivirían en `agentpey.com`. El agente firma el pago con el mismo contrato con
límites de siempre y se lo entrega a la tienda al cerrar la compra; la tienda
lo cobra, crea el pedido y devuelve el recibo verificable dentro de la orden.

Tres sorpresas: el ida y vuelta "402" de x402 no existe dentro de UCP (el pago
viaja al cerrar la compra); la ficha de la tienda no lleva productos (el
catálogo se consulta aparte); y el checkout actual de Vitrinee no sirve de
puerta de entrada, aunque casi todo lo de adentro se reutiliza.

También apareció algo para más adelante: los mandatos AP2, tal como UCP los
pide, usan un tipo de firma distinto al de Stellar. T123 es más que "exportar".

Documento completo, con opciones y horas:
[T120-handler-stellar-ucp.md](T120-handler-stellar-ucp.md). Citas:
[evidencia/T120.md](evidencia/T120.md).

**Lo que decidió el usuario** (`E-1` a `E-4`): construir la versión nativa de
UCP, sobre la versión `2026-04-08`, con la compra expresada en la moneda de
la tienda y con despacho mínimo. La revisión (`/revisar`) encontró dos cosas
de diseño que quedaron escritas en el spec: las rutas UCP van bajo `/ucp/v1`
para no chocar con las actuales, y la prueba de que el contrato rechaza un
pago excedido se hace con un script aparte, sin agregarle ningún atajo al
agente.

## T121 · Cada tienda de Vitrinee habla UCP para mostrar lo que vende (2026-09-30, en revisión)

**En lenguaje llano.** Cada tienda de Vitrinee tiene ahora una "ficha" en el
formato que definieron Google, Shopify y compañía (`/.well-known/ucp`). La
ficha dice qué sabe hacer la tienda y cómo se le paga: con USDC en Stellar,
usando el medio de pago de AgentPey. Un agente que hable UCP puede leer esa
ficha y buscar productos en el catálogo, con precios en pesos chilenos y, al
lado, cuánto costaría en USDC. Todavía no puede comprar: eso es T122. Lo que
ya existía (la ficha propia de Vitrinee y el checkout de hoy) sigue igual.

También quedaron escritas las reglas públicas del medio de pago y del recibo
verificable, en inglés, listas para publicar en `agentpey.com`. Y un pequeño
programa de prueba que lee una tienda como lo haría un agente UCP, y que se
niega a usar una ficha que diga pagar con AgentPey pero apunte a otro dominio.

**Hallazgo.** Uno de los esquemas oficiales de UCP tiene una referencia rota;
se corrigió solo para los tests y quedó anotado para reportarlo.

**Decidido.** Los montos salen como números enteros en la respuesta, calculados
sin decimales de por medio (`VT-36`). Las reglas del medio de pago se publican
en `agentpey.com` junto con este cambio. **Pendiente:** probar el programa
contra una tienda real, apenas esté desplegado. Evidencia: [evidencia/T121.md](evidencia/T121.md).
