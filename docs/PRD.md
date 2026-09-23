# PRD · Vitrinee para el developer con un agente

> **Versión** 1.0 · 22 de septiembre de 2026
> **Usuario objetivo** el developer o equipo que ya tiene un agente en operación ([V-20](DECISIONES.md))
> Contexto: [CONTEXTO.md](CONTEXTO.md) · Decisiones: [DECISIONES.md](DECISIONES.md) · Estado: [BITACORA.md](BITACORA.md) · Glosario: [../CONTEXT.md](../CONTEXT.md)

---

## 1. Descripción

### El problema, desde el lado de quien tiene el agente

Un equipo construyó un agente que hace algo útil: gestiona trabajo, repone
insumos, opera un proceso. En algún momento ese agente necesita **comprar algo
real** — y ahí se detiene.

No se detiene por falta de forma de pagar. x402 existe, hay facilitators en
Stellar, hay billeteras con políticas de gasto. Se detiene por tres cosas
distintas:

1. **No hay dónde comprar.** Las tiendas reales exponen una web hecha para ojos
   humanos: carrito, sesión, formularios, a veces captcha. Un agente que quiera
   comprar ahí tiene que hacer scraping de un checkout, que es frágil, y que
   además ninguna tienda autorizó.
2. **Lo que existe para probar es de juguete.** El developer termina comprando
   contra un endpoint de demo que devuelve `{"ok": true}`. Eso no prueba nada:
   no hay inventario, no hay stock que se agote, no hay pedido que despachar.
3. **No queda prueba de la compra.** El agente compró por cuenta de alguien —
   su principal: una empresa, un equipo, una persona. Ese principal necesita
   saber qué se compró, cuánto se pagó y a quién, **sin tener que confiar en la
   palabra de la tienda ni en los logs del agente**. Hoy el comprobante, si
   existe, es un correo HTML que cualquiera puede fabricar.

El tercero es el que nadie está resolviendo, y es el que importa cuando el
agente gasta plata de otro.

### La solución

**Vitrinee es la puerta de entrada de agentes a una tienda real.** Es un gateway
HTTP que se conecta a la plataforma de la tienda por su API ([V-1](DECISIONES.md)),
y le da al agente cuatro cosas en un solo circuito:

1. **Un catálogo legible por máquina.** `/.well-known/agent-storefront.json`
   declara qué vende la tienda, en qué moneda, a qué tasa, con qué stock y bajo
   qué condiciones. El agente no adivina ni raspa: lee.
2. **Un cobro estándar.** `POST /checkout/:productId` responde `402` con los
   requisitos de pago x402 en USDC sobre Stellar. Cualquier cliente x402 sirve —
   Vitrinee no impone un SDK al comprador.
3. **Un pedido de verdad.** Liquidado el pago, el gateway crea la orden en la
   plataforma de la tienda, con su stock, su cliente y su dirección de despacho.
   La tienda sólo ve llegar un pedido pagado a su panel de siempre.
4. **Una prueba que no depende de la tienda.** El recibo es un JWS firmado por
   el merchant, y su `sha256` queda anclado en un contrato Soroban. El principal
   del agente verifica **tres cosas por separado** ([V-13](DECISIONES.md)): que
   la tienda lo firmó, que lo registró en la blockchain, y que el pago que cita
   existió. Sin pedirle nada a la tienda y sin pasar por Vitrinee.

### Qué recibe la tienda

USDC en **su propia cuenta Stellar**, que ella crea y custodia
([V-19](DECISIONES.md)). Vitrinee no genera esa cuenta, no conoce su llave y no
convierte a pesos. Si la tienda quiere CLP, es asunto suyo con un tercero
licenciado. Es la única forma de que el gateway no sea custodio ni intermediario
— lo que lo mantiene fuera del alcance de la Ley 21.521 y lo hace confiable para
un merchant: no hay nada que robar.

### Qué no es, explícitamente

Vitrinee **no resuelve la demanda de la tienda** ([V-20](DECISIONES.md)). No
promete compradores, no rankea, no recomienda y no cobra comisión sobre venta
referida. El agente de consumidor que descubre tiendas y sugiere dónde comprar
es roadmap. Prometer eso hoy convertiría el gateway en un marketplace, que es
justamente lo que [CONTEXTO.md](CONTEXTO.md) declara que Vitrinee no es.

### Por qué esto sobrevive a que cambie el riel

Lo durable no es x402. Es el manifest, el recibo firmado y el anclaje: la capa
de *"esta tienda es legible y esta compra es demostrable"*. El esquema de pago
es un detalle reemplazable, y el manifest ya es un feed que otra plataforma
podría ingerir como un formato de salida más del mismo catálogo, sin tocar el
checkout ni el recibo.

---

## 2. Historias de usuario

### El developer con un agente

| # | Como… | quiero… | para que… |
|---|---|---|---|
| D-1 | developer con un agente | apuntar mi agente a una URL y que descubra solo qué se vende y a qué precio | no tener que codificar el catálogo a mano ni raspar una web |
| D-2 | developer con un agente | que la tienda me cobre con x402 estándar | usar el cliente x402 que ya tengo, sin adoptar un SDK propietario |
| D-3 | developer con un agente | que la compra mueva inventario real y genere un pedido despachable | estar probando contra comercio de verdad y no contra un mock |
| D-4 | developer con un agente | recibir un recibo firmado en la misma respuesta del checkout | no tener que hacer polling para saber qué compré |
| D-5 | developer con un agente | saber el precio exacto en USDC **antes** de firmar el pago | que la política de gasto de mi agente pueda evaluarlo y rechazarlo |
| D-6 | developer con un agente | que un fallo de la tienda después del pago no se me reporte como "no pagaste" | no reintentar una compra que ya me cobraron |
| D-7 | developer con un agente | poder reintentar un checkout con la misma `Idempotency-Key` sin riesgo | que un timeout de red no me cueste una compra doble |
| D-8 | developer con un agente | leer la lista de lo que puedo comprar en un formato que ya parseo | no escribir un parser para cada tienda |

### El principal del agente

| # | Como… | quiero… | para que… |
|---|---|---|---|
| P-1 | principal de un agente | verificar el recibo sin pedirle nada a la tienda ni a Vitrinee | no depender de la buena fe de quien me vendió |
| P-2 | principal de un agente | que la verificación falle si alguien cambió un solo número del recibo | poder confiar en el documento como prueba |
| P-3 | principal de un agente | ver quién pagó, cuánto, a quién y por qué producto, en un documento firmado | rendir cuentas de lo que gastó mi agente |
| P-4 | principal de un agente | correr la verificación en mi propia máquina con una herramienta que no controle la tienda | que la prueba sea independiente de la contraparte |

### El merchant

| # | Como… | quiero… | para que… |
|---|---|---|---|
| M-1 | dueño de una tienda | recibir el pago directo en mi cuenta, sin que el gateway lo toque | no exponerme a que un tercero custodie mi plata |
| M-2 | dueño de una tienda | seguir usando el panel de mi plataforma tal como está | no aprender un sistema nuevo ni instalar un plugin |
| M-3 | dueño de una tienda | ver el pedido del agente con su hash de transacción en el historial | poder conciliar la venta contra la blockchain |
| M-4 | dueño de una tienda | usar mi propia wallet, creada por mí | que nadie más tenga la llave de donde llega mi plata |
| M-5 | dueño de una tienda | que el gateway me diga con claridad si mi cuenta no está lista para recibir | no descubrirlo cuando un agente ya firmó un pago |
| M-6 | dueño de una tienda | tener el mismo recibo firmado que el comprador | poder probar qué vendí sin depender de él |

### El operador de la demo

| # | Como… | quiero… | para que… |
|---|---|---|---|
| O-1 | operador | ver las órdenes, su estado de anclaje y su verificación en una pantalla | poder mostrar el circuito completo sin una terminal |
| O-2 | operador | levantar todo desde cero en una máquina limpia siguiendo el README | que un evaluador pueda reproducirlo sin mí |
| O-3 | operador | que el anclaje se reintente solo y se reanude tras un reinicio | que un RPC lento no deje recibos sin anclar |

---

## 3. Criterios de aceptación

### Circuito principal

- [ ] Un cliente x402 estándar, sin código específico de Vitrinee, completa una
      compra de punta a punta contra el gateway desplegado.
- [ ] `GET /.well-known/agent-storefront.json` declara catálogo, moneda, tasa de
      cambio con su fuente, cuenta `payTo`, cuenta de firma y id del contrato de
      registro.
- [ ] El precio en USDC que publica el manifest, el que exige el `402` y el que
      dice el recibo son **el mismo entero**, para el mismo producto y cantidad.
- [ ] El pedido aparece en el panel de la tienda con estado pagado, el producto
      correcto, el stock descontado, y el hash de la transacción visible en
      `additional_information` y en el historial ([V-11](DECISIONES.md)).
- [ ] La respuesta del checkout incluye el recibo firmado, el id de la orden y
      el hash de la transacción de settlement, en una sola vuelta.
- [ ] El `sha256` del recibo queda anclado en `receipt-registry` dentro de los
      30 segundos siguientes, y `GET /orders/:id` lo refleja.

### Verificación

- [ ] `pnpm demo:verify` corre los tres checks **sin tocar el gateway** y los
      tres pasan.
- [ ] `pnpm demo:verify -- --tamper` altera el monto sin re-firmar y los tres
      fallan.
- [ ] `POST /receipts/verify` acepta un recibo arbitrario, incluido uno que el
      gateway no emitió.
- [ ] La verificación de anclaje lee el storage del contrato directamente, sin
      requerir cuenta fuente ni llave alguna.

### Cuenta del merchant

- [ ] `pnpm bootstrap` acepta una cuenta `payTo` externa y, en ese modo, **no
      genera cuenta ni escribe secreto alguno** ([V-19](DECISIONES.md)).
- [ ] Antes de servir, el gateway comprueba que la `payTo` existe, está fondeada
      y tiene trustline USDC; si no, falla al arrancar con un mensaje que dice
      exactamente qué falta y cómo arreglarlo.
- [ ] `git grep -nE 'S[A-Z2-7]{55}'` no devuelve nada en el repo.

### Despliegue

- [ ] El gateway corre en una URL pública con `ADAPTER=jumpseller`.
- [ ] El manifest publica URLs absolutas del host público, no del contenedor.
- [ ] El dashboard se sirve desde el mismo origen, sin CORS que configurar
      ([V-18](DECISIONES.md)).
- [ ] Un evaluador siguiendo el README en una máquina limpia llega a una compra
      real sin intervención del autor.

---

## 4. Casos límite

Cada uno tiene una respuesta definida. Varios ya están implementados; se listan
para que no se pierdan al refactorizar.

| Caso | Respuesta esperada |
|---|---|
| **La plataforma falla después de que el pago se liquidó** | `200` con `status: "paid_unfulfilled"` y registro para cumplimiento manual. Nunca `≥400`: haría creer al agente que no pagó ([V-10](DECISIONES.md)). |
| **Dos agentes compran la última unidad a la vez** | El segundo recibe `409` **antes** de pagar. El stock queda reservado mientras el pago está en vuelo ([V-15](DECISIONES.md)). |
| **El agente reintenta con la misma `Idempotency-Key`** | Se devuelve la misma orden con `Idempotent-Replayed: true`, antes del `402`, sin cobrar de nuevo. |
| **La misma clave se reusa para otra compra** | `409 IdempotencyConflict`. |
| **El facilitator devuelve el mismo settle dos veces** | Una transacción, una orden: se devuelve la existente. |
| **El anclaje falla o el RPC no responde** | El recibo ya es válido; el anclaje reintenta a 2, 5 y 15 s y la orden expone `pending → anchored \| failed` con `lastError`. Se reanuda al arrancar ([V-5](DECISIONES.md)). |
| **El contrato responde `AlreadyAnchored`** | Éxito: un intento anterior sí llegó. |
| **La `payTo` no tiene trustline USDC** | El gateway no arranca. Detectarlo después del `402` significa cobrarle a un agente un pago que no puede liquidar. |
| **El plan de la tienda no permite crear pedidos por API** | El adapter traduce el `403` a un error accionable, no filtra el `403` crudo al agente ([V-21](DECISIONES.md)). |
| **Un producto tiene stock 0** | Sigue en el manifest, donde el cero es información; **no** aparece en `/discovery/resources`, que es una oferta que el checkout rechazaría ([V-17](DECISIONES.md)). |
| **Un producto tiene variantes o SKU ambiguo** | El adapter lo filtra del catálogo: un agente no puede referenciar lo que no puede nombrar sin ambigüedad. |
| **El comprador declara un `stellarAccount` distinto del que pagó** | Se ignora. El pagador se lee de la transacción firmada o del facilitator; el recibo no se fía del cliente ([V-10](DECISIONES.md)). |
| **Alguien edita el recibo y lo presenta como válido** | Los tres checks fallan. El `kid` debe coincidir con el `merchantDid`, o cualquiera podría firmar con su propia llave ([V-13](DECISIONES.md)). |
| **El proceso se reinicia con órdenes en vuelo** | Las órdenes persisten; en el plan gratuito de Render el disco es efímero y sólo sobreviven mientras viva la instancia. Asumido para una demo de testnet. |

---

## 5. Consideraciones técnicas

### Arquitectura

Monorepo pnpm. `packages/core` no hace I/O y es donde vive el dinero como
enteros; los adapters hablan con las plataformas; el gateway orquesta;
`contracts/` es un workspace Cargo aparte. El único artefacto compartido entre
TypeScript y Rust es `deployments/testnet.json`.

La frontera que importa: **la plataforma de e-commerce es un adapter, no un
supuesto**. Cambiar de Jumpseller a WooCommerce no debe tocar el checkout, el
recibo ni el anclaje.

### Dinero

Todo monto es `bigint` en unidades atómicas — CLP sin decimales, USDC con 7 —
con una sola división entera y redondeo half-up en la conversión
([V-7](DECISIONES.md)). Ningún `number` representa dinero en ningún punto. Un
float produce montos que no cuadran entre manifest, `402` y recibo, y el
facilitator rechaza un `amount` que no coincida exactamente.

La tasa CLP/USD es fija y declarada (`fx.source: "demo-fixed"`,
[V-2](DECISIONES.md)). No hay oráculo. Lo que se demuestra es que la conversión
es exacta y que el agente la ve antes de pagar.

### Pago

`@x402/express` 2.26.0 con `ExactStellarScheme` y el facilitator de
OpenZeppelin, en flujo `upfront`: el facilitator liquida **antes** de que corra
el handler ([V-10](DECISIONES.md)). Ninguna orden existe sin pago liquidado. El
precio se resuelve por request desde el adapter, no hay una ruta por producto
([V-6](DECISIONES.md)).

### Llaves

Tres cuentas, tres roles, y ninguna acumula poder:

- **`payTo`** recibe el USDC. La trae el merchant desde su wallet; el gateway no
  tiene su secreto ([V-19](DECISIONES.md), [V-4](DECISIONES.md)).
- **Cuenta de firma** emite los recibos y paga los fees de anclaje con su propio
  XLM. No puede mover fondos del merchant ([V-8](DECISIONES.md)).
- **Cuenta del agente** es del comprador y Vitrinee no la conoce.

Secretos en `.env.local` (modo 600) y variables del host. Nunca en logs, en
evidencia ni en mensajes de error.

### Contrato

`receipt-registry` en Soroban, `soroban-sdk` 28.0.0, sin admin y sin upgrade
([V-3](DECISIONES.md)): un admin podría alterar la prueba que el registro existe
para proteger. Si hay que cambiar el contrato, se despliega uno nuevo y el
manifest apunta al id nuevo.

El layout de storage se lee directo (`DataKey::Receipt(hash)`) en vez de simular
`get`, para que un verificador no necesite cuenta ni llave. La contrapartida es
que el cliente conoce el layout: si el contrato cambia, sube
`STORAGE_SCHEMA_VERSION` **en ambos lados**.

### Despliegue

Un solo servicio web: el gateway sirve la API, el manifest y el dashboard desde
el mismo origen ([V-18](DECISIONES.md)). Dos servicios significan dos despliegues
que se desincronizan, una variable con la URL del otro, y CORS — tres cosas que
se rompen en vivo.

### Restricción regulatoria

100% Stellar testnet, USDC de prueba, sin fiat y sin PSP. No es una limitación
técnica sino una decisión de diseño frente a la Ley 21.521, y debe poder
verificarse leyendo el código ([CONTEXTO.md](CONTEXTO.md)).

---

## 6. Fuera de alcance

- Mainnet, fiat, conversión a CLP y cualquier integración con un medio de pago
  regulado.
- Custodia de fondos, escrow, reembolsos automáticos y ventanas de retracto.
- Descubrimiento, ranking, recomendación y comisión sobre venta referida
  ([V-20](DECISIONES.md)).
- Oráculo de tipo de cambio ([V-2](DECISIONES.md)).
- Plugin nativo de plataforma y app oficial con OAuth ([V-1](DECISIONES.md)).
- Adapter de WooCommerce — es el segundo, y es lo primero que se corta si el
  tiempo aprieta (regla 8 de `CLAUDE.md`).
- Aparecer en el bazaar del facilitator declarando la discovery extension en las
  rutas de checkout ([V-17](DECISIONES.md)).
- Envoltura VC-JWT del recibo ([V-13](DECISIONES.md)).
- Multi-tenancy: el gateway sirve **una** tienda por despliegue.
