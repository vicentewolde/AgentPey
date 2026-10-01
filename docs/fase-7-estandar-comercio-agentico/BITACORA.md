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

**Fecha:** 2026-10-01 · Spec aprobado. **T120 cerrada** (opción A, `E-1` a
`E-4`). **T121 cerrada**: cada tienda publica su perfil y su catálogo UCP. **T122
cerrada**: un agente compró por UCP en una tienda Shopify real, pagando en
Stellar desde un `policy_rail`, con pedido en Shopify (visto por el usuario) y
recibo válido. **T125 cerrada**: el anexo técnico para el SEP está escrito y revisado.
**T123 en revisión**: el Mandato se exporta como mandatos AP2 v0.2 y la librería
oficial de AP2 los verifica (`E-8` a `E-11`). **Sigue:** `/revisar` de T123; T124, si alcanza.

| Tarea | Estado |
|---|---|
| T120 Prueba técnica | cerrada |
| T121 Perfil y catálogo UCP | cerrada |
| T122 Compra UCP de punta a punta | cerrada |
| T123 Mandato como mandatos AP2 | en revisión |
| T124 Disputas | pendiente |
| T125 Anexo para el SEP | cerrada |

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

## T121 · Cada tienda de Vitrinee habla UCP para mostrar lo que vende (2026-09-30, cerrada)

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

**Lo que encontró la revisión** (`/revisar`, sin bloqueantes), ya corregido:
la spec pública decía que un comercio comprometido no podía desviar el pago,
y era falso, porque el comercio escribe los requisitos; ahora exige que la
plataforma los compare con el perfil antes de firmar. El cliente de prueba
aceptaba un perfil que simplemente omitía la dirección de las reglas del
medio de pago; ahora lo rechaza. Además: el nombre del campo de versión quedó
unificado, el esquema publicado solo admite testnet, un cuerpo que no es JSON
responde 400 en vez de 500, y los tests prueban que el validador de verdad
rechaza respuestas rotas.

**En vivo.** Después del deploy, el programa de prueba leyó la ficha UCP de
una tienda real de Jumpseller (`bazar-cordillera`) y listó sus seis productos,
y las reglas del medio de pago responden en `agentpey.com`.

## T122 · Un agente compra por UCP y paga en Stellar (2026-10-01, cerrada)

**En lenguaje llano.** Por primera vez un agente compró en una tienda real
hablando solo el idioma estándar del comercio (UCP). Abrió la compra de un
imán de cobre en una tienda Shopify, recibió el precio (1.490 pesos, o 1,57
USDC), revisó que la plata fuera a la cuenta que la tienda publica y que la
compra cupiera en su permiso firmado, y pagó desde su cuenta con límites en
Stellar. La tienda cobró, creó el pedido en Shopify y entregó un recibo que
cualquiera puede verificar: firma de la tienda, huella anclada en la red y
pago confirmado, los tres en verde.

También quedó probado que el límite no depende del agente. Una compra de dos
imanes (3,14 USDC) supera los 3,00 por compra del permiso: el agente la
rechaza solo, y si se le pide firmarla de todas formas, la rechaza el propio
contrato en la red.

**Lo que encontró la revisión.** Tres formas en que, si algo fallaba justo
después de cobrar, la tienda podía cobrar dos veces o perder el rastro de un
pago. Ahora el cobro queda guardado en la compra apenas se confirma, una
compra con un pago dudoso queda retenida en vez de volver a cobrarse, y el
pedido se arma con los datos de cuando se pagó (`E-6`).

**Decisiones:** `E-5` (el rail UCP, 3,00 y 5,00), `E-6` (el cobro nunca se
repite; conciliación manual de compras retenidas), `E-7` (la orden no muestra
la dirección del comprador). Evidencia: [evidencia/T122.md](evidencia/T122.md).

## T125 · El anexo técnico para el SEP (2026-10-01, cerrada)

**En lenguaje llano.** El chat de estrategia está escribiendo una propuesta de
estándar para Stellar ("Agentic Commerce on Stellar"), y AgentPey es el
ejemplo que funciona. Este anexo le da los detalles exactos: cómo se ve cada
documento firmado, qué revisa cada parte antes de pagar, qué contratos están
desplegados y dónde, y nueve cosas que el estándar de Google y Shopify no
resuelve y la propuesta debería resolver. Un test avisa si algún dato del
anexo deja de coincidir con lo que está desplegado.

Documento: [ANEXO-SEP.md](ANEXO-SEP.md). Evidencia: [evidencia/T125.md](evidencia/T125.md).

**Lo que encontró la revisión.** El anexo daba a entender que revocar el
permiso detiene la cuenta pagadora en la red, y no es así: la red aplica los
límites, pero no consulta si el permiso fue revocado ni a quién va el pago. Lo
que corta la cuenta del todo es que su dueño cambie la llave o retire la plata.
Ahora el anexo lo dice con todas las letras, y es una de las brechas que el
estándar debería resolver.

## T123 · El permiso del usuario, en el idioma de AP2 (2026-10-01, en revisión)

**En lenguaje llano.** AP2 es el formato que Google propone para que un agente
demuestre que el usuario lo autorizó a pagar. El Mandato de AgentPey ya dice
eso ("este agente puede gastar hasta tanto, en estas tiendas, hasta tal
fecha"), pero en su propio formato. Ahora AgentPey puede traducirlo: para una
compra concreta produce los dos documentos que AP2 entiende, "este agente puede
comprar este producto en esta tienda" y "puede pagar hasta este monto, a esta
tienda, con USDC en Stellar". Cualquiera que tenga la llave pública de AgentPey
los puede verificar sin preguntarle nada a nadie. La librería oficial de AP2,
escrita por otros, los acepta.

AgentPey solo los firma si el Mandato está vigente y no revocado en la red, y si
la compra cabe dentro de lo que el usuario autorizó. Si alguien sube el monto en
una copia, la verificación lo rechaza y dice por qué.

**Lo que cambió al leer las fuentes.** AP2 sacó su versión 0.2 en abril y ya no
tiene los tres mandatos que nombraba el spec (Intent, Cart, Payment): tiene uno
de checkout y uno de pago, "abiertos" (con límites, firmados en nombre del
usuario) o "cerrados" (firmados por el agente al comprar). El Mandato
corresponde a los abiertos. El usuario eligió exportar y verificar fuera de
línea, sin tocar el checkout de las tiendas (`E-8`), con las llaves Stellar que
ya existen (`E-9`), y dejar fuera del export el tope diario y la revocación,
que AP2 no tiene: los mandatos AP2 vencen en una hora (`E-10`). Un mandato
abierto de AP2 es una compra, no un permiso permanente; por eso se exporta uno
por compra (`E-11`).

**Una corrección en el camino.** El replanteo decía que la librería oficial de
AP2 solo acepta llaves P-256. Al probarla, verificó también los mandatos en
Ed25519, la curva de Stellar. Donde sí pide P-256 es un paso después, cuando el
agente "cierra" el mandato, que T123 no hace. `E-9` quedó corregida.

**Qué no se hizo.** Negociar AP2 dentro del checkout UCP de Vitrinee, y los
mandatos cerrados: es el camino de la grabación del 11 de octubre y la
extensión cambió de nombre en UCP `2026-08-25`. Queda como brecha 14 del anexo.

**Evidencia técnica.**

- Paquete nuevo `@agentpey/ap2`: SD-JWT sobre `jose`, esquemas zod de AP2 v0.2,
  emisión y verificación del par, siete códigos `Ap2*` nuevos en `AgentPassError`.
- `exportMandateAsAp2` en el agente: Mandato verificado en la red, intención
  verificada, `checkMandate` sin cambios; solo entonces firma.
- `pnpm run ap2:export`: Mandato real `874339dd…` anclado en testnet, par
  exportado en Ed25519 y verificado; una copia alterada es rechazada con
  `Ap2DisclosureMismatch`.
- `scripts/ap2-crosscheck/verify.py`: la librería oficial de AP2 (commit
  `e1ea56d`) verifica el par real en Ed25519 y el mismo par en P-256.
- Sección 4.5 y brechas 5, 12, 13 y 14 del anexo para el SEP, atadas al código
  por `scripts/fase7-anexo.test.ts`. Salidas crudas en
  [evidencia/T123.md](evidencia/T123.md).

