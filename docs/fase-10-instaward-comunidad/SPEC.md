# Spec Fase 10 · Compras protegidas con la comunidad y tótem de llegada

- **Estado:** Aprobado (2026-11-10). El anexo A es el texto exacto enviado (puesto el 10-nov). El sprint arranca el 11-nov (lo indica el usuario; Tellus no lo confirmó por escrito) y las tareas solo si el capítulo aprueba el Instaward
- **Rama base:** `main`
- **Tareas:** T182 a T206 (la numeración sigue la de la Fase 9, cuyo último número es T181)
- **Fechas:** 30 días, del **11-nov al 10-dic-2026**. El usuario indicó el 10-nov que el sprint parte el 11-nov; Tellus no lo confirmó por escrito (su correo del 10-nov dice solo que AgentPey fue seleccionado). El 23-nov del formulario era solo el campo "Suggested sprint start date". **Solo si el capítulo aprueba el Instaward**; si no lo aprueba, el spec queda como plan y el usuario decide si construye algo
- **Referencias:** [`P-24`](../DECISIONES.md) (alcance), [`P-15`](../DECISIONES.md) (método), [`P-10`](../DECISIONES.md) (perímetro de "nunca Codex"), [`P-20`](../DECISIONES.md) (T171 pasó a una fase futura; aquí vuelve), [spec de la Fase 9](../fase-9-compra-protegida/SPEC.md) (escrow, `X-1` a `X-33`), [spec de la Fase 8](../fase-8-agentes-reales/SPEC.md) (MCP, `R-33`), [INSTRUCCIONES de Vitrinee](../fase-6-agentguard-comercializacion/vitrinee/INSTRUCCIONES.md). Decisiones de la fase con prefijo `Y-` en [`DECISIONES.md`](DECISIONES.md)

## 1. Objetivo

La Fase 9 conectó las piezas de una compra protegida: el pago queda retenido en un contrato, el reclamo sale del chat y el
veredicto reembolsa desde el pago retenido. La Fase 10 suma **personas reales y lo que les falta para confiar**:

1. el comprador confirma que está conforme y eso libera el pago; el reclamo lleva evidencia sellada; cada persona tiene su
   propia cuenta de gasto con sus topes; el asistente gana dos acciones (confirmar y adjuntar evidencia);
2. una tienda real, **Tapline**, con su propio escrow, donde cinco o más miembros de la comunidad de Stellar Chile compran con su
   asistente, y una página pública que lista cada compra y su resultado, leída de Stellar;
3. un **tótem de llegada** impreso en 3D para los eventos de Stellar Chile: el asistente se registra con la tarjeta NFC que
   compró o con un QR que cambia cada 30 s, y el organizador ve en su teléfono quién llegó.

La fase cumple los tres entregables del **Instaward de noviembre** enviado a Stellar Chile (Stellar Passport) el 9-nov-2026
(USD 4.000, sprint del 11-nov al 10-dic; el formulario sugería el 23-nov). El texto enviado está en el [anexo A](#anexo-a--texto-enviado-al-instaward-9-nov-2026):
**lo que dice el anexo es el compromiso**, y este spec no promete ni más ni menos.

> **Sobre el anexo A.** Es el texto exacto de los campos que se escribieron en el formulario el 9-nov (transcrito por la sesión
> de investigación; Passport pide iniciar sesión y no se releyó lo guardado). Lo que el anexo no dice, el spec no lo promete:
> en particular, **la asistencia en Stellar no es un compromiso** (T201 es un extra).

## 2. Alcance

| Entregable | Semana | Tareas |
|---|---|---|
| **D1** · Protección para cualquier compra, física o digital | 1 | T182–T190 |
| **D2** · Compras reales de la comunidad en Tapline | 2 | T191–T195 |
| **D3** · Tótem de llegada para los eventos | 3 y 4 | T196–T206 |

Todo en testnet. Las compras, disputas y tiendas de la Fase 9 siguen funcionando como hoy: el escrow nuevo es **otro
contrato** para Tapline (`Y-2`) y el de `agentcommerce` no se toca.

## 3. Fuera de alcance (igual que lo enviado)

- Rieles de tarjeta o fiat, y mainnet o dinero real. Todo en testnet.
- Otras plataformas de tienda (solo Shopify) y sumar otros comercios que no sean Tapline.
- Reemplazar Luma o Passport (está en lo enviado como fuera de alcance): el tótem se suma a ambos y los lee, no los sustituye.
- Reconocimiento facial o rastreo automático de personas.
- Auditoría externa de seguridad.
- Tocar la tienda `agentcommerce` (la de la demo en vivo) y el escrow `CBQFELK5…DO27A`.
- Cerrar la Fase 9 (T162–T167 en vivo): es una **dependencia anterior al sprint (vence el 11-nov)**, no una tarea de esta fase (sección 8).

## 4. Diseño

### 4.1 Hechos del código que fijan el diseño (leídos el 10-nov sobre `main` en `64359ea`)

| Hecho | Dónde | Consecuencia |
|---|---|---|
| El escrow libera solo después de `mark_shipped` y de que cierra la ventana (`release`); no existe liberación por confirmación del comprador | `contracts/purchase-escrow/src/lib.rs` (`mark_shipped`, `release`) | Función nueva en el contrato y redespliegue (`Y-1`) |
| `open` de un pagador-rail se autoriza con la firma Ed25519 de la **llave de agente** (`owner()`) sobre un mensaje propio, porque el rail solo autoriza `transfer` | `lib.rs` (`open`, `open_message`) | `confirm` no puede copiar ese patrón: confirmar libera plata, y no debe poder hacerlo el agente solo (`Y-1`) |
| El rail expone `principal()`, la wallet de la persona | `contracts/policy-rail/src/lib.rs:211` | `confirm` exige la autorización de esa wallet |
| El reclamo guarda solo `claim_hash` (32 bytes) | `lib.rs` (`open`) | La evidencia va fuera de la red y su huella entra en el reclamo firmado: `claim_hash` = sha256 del reclamo, que ya contiene las huellas (`Y-3`); no hace falta tocar el contrato para eso |
| El MCP sirve a una sola wallet: no arranca si `MCP_ALLOWED_WALLET` no es el `principal` del rail; una sola llave de agente | `apps/mcp/src/runtime.ts`, `config.ts` | Cuenta por persona = retomar `R-33` (T171) (`Y-4`) |
| La tienda marca el despacho leyendo Shopify y llama `mark_shipped` | `packages/vitrinee-gateway/src/ucp/order-events.ts`, `escrow-release.ts` | Un producto digital necesita su propia marca de entrega (`Y-5`) |
| `expire` lo llama la tienda cuando vence la ventana del árbitro (T181, mergeada el 9-nov) | `escrow-release.ts` | Liberación por vencimiento y reembolso por vencimiento ya existen |
| Un `escrow` por tienda; `VITRINEE_COMERCIO_ESCROWS` lo enciende por comercio | `docs/fase-9-compra-protegida/DECISIONES.md` (`X-11`, `X-23`) | Tapline = otro contrato y otra entrada en esa variable |
| `/en-vivo` lista compras y disputas leídas de la red | `apps/web/public/en-vivo.html` | Base para la página pública de compras (T195) |

### 4.2 Escrow v2

Un contrato nuevo `purchase-escrow` (mismo directorio, versión de esquema 2), con todo lo de la Fase 9 más:

| Función | Quién la firma | Qué hace |
|---|---|---|
| `confirm(order_ref)` | Pagador clásico: él mismo. Pagador-rail: la `principal()` del rail | El comprador está conforme: libera el pago a `payee` desde `Held` o `Shipped`, sin esperar la ventana. No vale con una disputa abierta |
| Todo lo demás | Como en la Fase 9 | `hold`, `mark_shipped`, `release`, `open`, `respond`, `resolve`, `expire`, `claim_refund` |

Estados: `Held|Shipped → Released` (por confirmación o por vencimiento), o `→ Disputed → (Responded) → Resolved|Expired`.
Un nuevo evento `Confirmed`. El wasm nuevo entra en la lista de hashes permitidos de `@vitrinee/anchor`
(`PURCHASE_ESCROW_WASM_HASHES`) junto al de la Fase 9.

### 4.3 Evidencia sellada

El reclamo (hoy un JWS firmado) gana una lista `evidence: [{ name, media_type, bytes, sha256 }]`. El archivo vive en la tienda
(Postgres, con tope de tamaño) y se sirve al árbitro con un enlace firmado; su huella viaja dentro del reclamo, y la huella del
reclamo es el `claim_hash` que el escrow guarda. Quien lea la red puede comprobar que el archivo que ve el árbitro es el que la
persona adjuntó. **Un archivo cambiado después deja de coincidir.**

### 4.4 Cuenta de gasto por persona

Cada persona de la lista cerrada tiene su `policy_rail` (su wallet como `principal`, topes elegidos al desplegar) y una llave de
agente derivada por persona (SEP-0005, `packages/tenancy`), como decidió `R-33`. El MCP elige el rail según la wallet que
inició sesión. Un pago sobre el tope lo rechaza la red, y eso es evidencia (T190).

### 4.5 Producto digital

Tapline vende al menos un producto digital (la credencial digital del evento o el diseño de la tarjeta). La tienda emite un
**enlace de descarga único** por pedido; la primera descarga marca la entrega (`mark_shipped`) y abre la ventana. Sin apps de
pago en Shopify (`Y-5`).

### 4.6 El tótem

```
tarjeta NFC (NDEF con un token firmado) ─┐
QR en pantalla (cambia cada 30 s)        ├─▶ lector ─▶ servicio de llegada ─▶ vista del organizador (teléfono)
                                         ┘                    │
                  Luma (lista / CSV) ───────────────────────▶ │ ──▶ exportar CSV
          perfil público de Passport ─────────────────────────▶ │ ──▶ (extra, T201) huella de la asistencia en Stellar
```

El lector es una Raspberry Pi o un ESP32 con un PN532, o el teléfono del organizador (Web NFC en Android) como respaldo:
**sin el hardware, el registro funciona igual con el QR en el teléfono** y el tótem es la carcasa. Luma: su API pide Luma Plus en
el calendario del capítulo y la clave solo sirve para ese calendario; el respaldo es importar el CSV. Passport: API pública de
solo lectura. Anclar la asistencia en Stellar como la huella de un registro, sin datos personales en la red (`Y-6`), es un **extra opcional** (T201): lo enviado al capítulo no lo promete.

### 4.7 Decisiones

`Y-1` a `Y-6` están en [`DECISIONES.md`](DECISIONES.md) como propuestas, con las respuestas del usuario del 10-nov.

## 5. Tareas

Todas: rama `cc/t<n>-<slug>` desde `origin/main`; `pnpm check` en verde, más `vitrinee:check` si toca Vitrinee y `cargo test` si
toca contratos; bitácora, evidencia en `evidencia/T<n>.md` y `ESTADO.md`. **Ninguna se delega a Codex** (`P-10`: contrato,
fondos, firma, autorización) salvo que el usuario lo decida para una tarea del tótem que no toque firma ni fondos. Cada
despliegue en testnet y cada gasto necesitan el OK explícito del usuario. Las horas son estimaciones de este borrador.

### Antes del sprint · el diseño de la marca en todas las páginas

#### T207 · Todas las páginas con el diseño de las publicaciones (agregada el 11-nov, a pedido del usuario)
- **Estimación:** 2 días · **Depende de:** nada · **Va antes de T182** (decidido por el usuario el 11-nov)
- **Por qué:** el usuario pidió que agentpey.com, Vitrinee, los recibos y las páginas de reclamo sigan el diseño nuevo de las publicaciones de AgentPey (estilo Apple: negro o niebla, un solo azul, Inter Tight e Inter), antes de que la comunidad las use en el sprint
- **Qué hace:** una hoja de estilos única, `apps/web/public/brand/agentpey.css`, con lo que las publicaciones no definen para la web (estados, enlaces, foco, formularios, modo oscuro: `Y-7`, [DISENO-WEB.md](DISENO-WEB.md)); el gateway de Vitrinee sirve la misma hoja en sus dominios; y las 13 páginas la usan, la portada incluida (se rehace al estilo nuevo)
- **Límites:** cambia la apariencia, nunca el comportamiento: los `id`, los textos que leen las pruebas y los scripts quedan. Fuera: el tema de Shopify de Tapline y las demos RealOps, SignalDesk y el tablero de estado
- **Hecho cuando:**
  - [ ] las 13 páginas de [DISENO-WEB.md](DISENO-WEB.md) §4 cargan la hoja única y no usan Bricolage, DM Mono ni el naranja
  - [ ] capturas de cada página en claro y oscuro, a 1280 y 390 px, en `evidencia/T207.md`
  - [ ] `pnpm check` y `vitrinee:check` en verde

### Semana 1 (11–17 nov) · D1

#### T182 · `confirm` en el contrato de escrow
- **Estimación:** 8 h · **Depende de:** nada
- **Archivos principales:** `contracts/purchase-escrow/`
- **Descripción:** la función `confirm` de 4.2, con su evento y la autorización de `principal()`.
- **Hecho cuando:**
  - [ ] tests: confirmar desde `Held` y desde `Shipped` libera al `payee`; confirmar con una disputa abierta, ya liberada o por quien no es `principal` se rechaza; un pagador clásico confirma firmando él mismo
  - [ ] `cargo test` en verde y los 35 tests de la Fase 9 siguen pasando

#### T183 · Despliegue del escrow v2 para Tapline
- **Estimación:** 4 h · **Depende de:** T182 y el OK del usuario para el despliegue
- **Archivos principales:** `deployments/testnet.json`, `packages/vitrinee-anchor/src/escrow.ts`, script de despliegue
- **Hecho cuando:**
  - [ ] el contrato está en testnet, su wasm en la lista de hashes permitidos, y `verifyStoreEscrow` lo acepta
  - [ ] hay un ensayo en el escrow v2: una compra liberada por confirmación y una por vencimiento, con sus hashes

#### T184 · Evidencia sellada: guardar, sellar y servir al árbitro
- **Estimación:** 8 h · **Depende de:** nada
- **Archivos principales:** `packages/vitrinee-gateway/src/disputes.ts`, `packages/resolve/`, `scripts/resolve.ts`
- **Hecho cuando:**
  - [ ] el reclamo con `evidence` se firma, su huella es el `claim_hash` que guarda el escrow, y el archivo se guarda con tope de tamaño
  - [ ] `resolve:decide` muestra el archivo y comprueba que su huella coincide con la del reclamo; un archivo cambiado se detecta
  - [ ] hay un reclamo con evidencia y el hash de su apertura en la red

#### T185 · Las dos acciones nuevas del asistente
- **Estimación:** 8 h · **Depende de:** T182, T184
- **Archivos principales:** `apps/mcp/src/tools.ts`, `shopper.ts`, `apps/web/public/` (página para firmar)
- **Descripción:** `attach_evidence` (adjuntar un archivo al reclamo) y `confirm_purchase`: como confirmar libera plata y lo firma la wallet de la persona, la herramienta entrega un enlace a una página de firma (como la del comercio, `responder.html`), nunca firma sola (`Y-1`).
- **Hecho cuando:**
  - [ ] Claude confirma una compra: la persona firma en su wallet y la orden pasa a liberada
  - [ ] el agente no puede confirmar sin la firma de la persona

#### T186 · Una cuenta de gasto por persona: despliegue y alta
- **Estimación:** 8 h · **Depende de:** nada (retoma `R-33` y T171)
- **Archivos principales:** `packages/tenancy/`, `scripts/`, `deployments/`
- **Hecho cuando:**
  - [ ] un script da de alta a una persona: deriva su llave de agente, despliega su `policy_rail` con sus topes y deja el rail fondeado con el OK del usuario
  - [ ] un rail de una persona no puede gastar los fondos de otro (prueba)

#### T187 · El MCP elige el rail según la wallet
- **Estimación:** 10 h · **Depende de:** T186
- **Archivos principales:** `apps/mcp/src/runtime.ts`, `config.ts`, `oauth/`
- **Hecho cuando:**
  - [ ] el inicio de sesión acepta una lista cerrada de wallets y cada una paga con su propio rail y su llave derivada
  - [ ] una wallet fuera de la lista se rechaza, y la compra de la wallet única de hoy sigue funcionando

#### T188 · La entrega de un producto digital
- **Estimación:** 8 h · **Depende de:** nada
- **Archivos principales:** `packages/vitrinee-gateway/src/`
- **Hecho cuando:**
  - [ ] un pedido digital recibe un enlace de descarga único; la primera descarga llama `mark_shipped` y abre la ventana; un segundo uso del enlace no cambia nada
  - [ ] las compras físicas siguen marcándose por Shopify como hoy

#### T189 · Un pago sobre el tope, rechazado por la red
- **Estimación:** 3 h · **Depende de:** T186
- **Hecho cuando:**
  - [ ] hay el hash de un pago sobre el `perTx` de un rail por persona, rechazado en la red, para la evidencia

#### T190 · Corrida de D1 y evidencia
- **Estimación:** 6 h · **Depende de:** T183 a T189
- **Hecho cuando:**
  - [ ] `evidencia/T190.md` con: el ID del contrato y sus tests; los hashes de una liberación por confirmación, una por vencimiento y un reclamo con evidencia sellada; el pago sobre el tope rechazado

### Semana 2 (18–24 nov) · D2

#### T191 · Tapline en Vitrinee con su propio escrow
- **Estimación:** 8 h · **Depende de:** T183 y el OK del usuario (cuentas y credenciales de Shopify)
- **Archivos principales:** `packages/vitrinee-gateway/src/platform/`, Render
- **Hecho cuando:**
  - [ ] Tapline aparece en el directorio con su perfil UCP, cobra a su escrow y `prod:check` sigue en verde
  - [ ] `agentcommerce` no cambia (prueba de que sus compras siguen igual)

#### T192 · Alta y fondeo de los cinco compradores
- **Estimación:** 6 h · **Depende de:** T186, T187
- **Hecho cuando:**
  - [ ] un script y una guía de una página dejan a una persona lista: wallet, rail, tope, fondos de testnet, inicio de sesión en Claude o ChatGPT
  - [ ] los fondos de testnet salen de AgentPey y eso no aparece en lo público

#### T193 · El catálogo de Tapline y un digital que se entrega
- **Estimación:** 4 h · **Depende de:** T188, T191 (la tarea A del encargo carga el catálogo inicial)
- **Hecho cuando:**
  - [ ] la tienda tiene la tarjeta NFC, la credencial física y al menos un producto digital con su descarga

#### T194 · Las compras de la comunidad
- **Estimación:** 12 h, repartidas en la semana · **Depende de:** T191 a T193
- **Hecho cuando:**
  - [ ] cinco o más miembros compran con su asistente: el asistente cotiza y la persona aprueba
  - [ ] al menos una compra digital y una física, una confirmada y una reembolsada tras un reclamo con evidencia
  - [ ] cada compra queda con su evidencia y las grabaciones se guardan con permiso de cada persona

#### T195 · La página pública de compras de Tapline
- **Estimación:** 8 h · **Depende de:** T191
- **Archivos principales:** `apps/web/public/` (a partir de `en-vivo.html`)
- **Hecho cuando:**
  - [ ] una página pública lista cada compra y su resultado (retenida, confirmada, liberada, reembolsada), leído de Stellar y sin datos personales

### Semanas 3 y 4 (25 nov – 10 dic) · D3 (semana 3: 25 nov–2 dic, T196 a T201; semana 4: 3–10 dic, T202 a T206)

#### T196 · El servicio de llegada y sus datos
- **Estimación:** 10 h · **Depende de:** nada
- **Archivos principales:** `apps/totem/` (nueva) o un módulo de `apps/web`, a decidir en el plan de la tarea
- **Hecho cuando:**
  - [ ] eventos, personas inscritas y llegadas se guardan; un token de tarjeta o de QR se valida; el QR rota cada 30 s y uno vencido se rechaza
  - [ ] una persona que llega sin estar inscrita queda marcada como tal

#### T197 · La vista del organizador
- **Estimación:** 10 h · **Depende de:** T196
- **Hecho cuando:**
  - [ ] en un teléfono se ve quién llegó, quién es nuevo y quién no se había inscrito, y se exporta la lista en CSV

#### T198 · La tarjeta NFC como producto y su registro
- **Estimación:** 8 h · **Depende de:** T193, T196
- **Hecho cuando:**
  - [ ] la tarjeta comprada en Tapline queda vinculada a su comprador y registra la llegada al acercarla al lector

#### T199 · Lector NFC y QR en pantalla
- **Estimación:** 12 h · **Depende de:** T196, el hardware pedido
- **Hecho cuando:**
  - [ ] el lector registra una tarjeta y el QR en pantalla registra a otra persona; el respaldo con Web NFC en un teléfono Android funciona

#### T200 · Luma y Passport
- **Estimación:** 10 h · **Depende de:** T196
- **Hecho cuando:**
  - [ ] la lista de Luma entra por CSV (y por la API si el capítulo da una clave de un calendario con Luma Plus); el perfil de Passport se lee por su API pública de solo lectura
  - [ ] ninguna de las dos se reemplaza ni se escribe

#### T201 · La asistencia en Stellar (extra, no es un compromiso)
- **Estimación:** 8 h · **Depende de:** T196 · **Extra:** el formulario enviado no lo promete; se hace solo si sobra tiempo
- **Hecho cuando:**
  - [ ] la huella de cada llegada queda anclada en testnet sin datos personales (`Y-6`); se puede verificar contra la lista exportada

#### T202 · La carcasa 3D
- **Estimación:** 6 h de diseño; la impresión la hace quien el usuario elija · **Depende de:** T199
- **Hecho cuando:**
  - [ ] hay un modelo imprimible y un tótem armado con el lector

#### T203 · Ensayo del tótem
- **Estimación:** 6 h · **Depende de:** T197 a T202
- **Hecho cuando:**
  - [ ] un ensayo con cinco personas: llegadas por tarjeta y por QR, un inscrito, un nuevo y uno no inscrito, y la lista exportada

#### T204 · El evento de entrega de tarjetas con el capítulo
- **Estimación:** 8 h · **Depende de:** T203 y la fecha que acuerde el capítulo
- **Hecho cuando:**
  - [ ] el tótem debuta en un evento real con la comunidad, queda la lista de llegadas en vivo y se graba un video corto

#### T205 · Corrida final, QA y verificación de lo prometido
- **Estimación:** 8 h · **Depende de:** T190, T194, T195, T204
- **Hecho cuando:**
  - [ ] `pnpm check`, `cargo test` y `pnpm run prod:check` en verde; `evidencia/T205.md` enlaza cada hash y cada entregable contra el anexo A

#### T206 · Informe final y cierre con el capítulo
- **Estimación:** 4 h · **Depende de:** T205
- **Hecho cuando:**
  - [ ] la revisión final con el líder del capítulo (semana 4), el informe final entregado y ESTADO, ROADMAP y la bitácora cierran la fase

## 6. Criterios de aceptación de la fase (la evidencia que se prometió)

| Entregable | Evidencia prometida | Tarea |
|---|---|---|
| D1 | El ID del contrato y sus tests; los hashes de una liberación confirmada, una por vencimiento y un reclamo con evidencia sellada; un pago sobre el tope rechazado por la red | T182, T183, T184, T189, T190 |
| D2 | Cinco o más compras de la comunidad, una digital y una física, una confirmada y una reembolsada con evidencia; una página pública que las lista leídas de Stellar | T194, T195 |
| D3 | El tótem funcionando en un evento (tarjeta y QR), la lista de llegadas en vivo y un video corto. Además se construyen la vista del organizador con exportación y la lectura de Luma y Passport (entregable); la asistencia en Stellar (T201) es un extra | T196 a T200, T202 a T204 (T201 extra) |

## 7. Plan de demo

Una compra de punta a punta en Tapline: Claude cotiza, la persona aprueba, el pago queda retenido; la persona confirma desde su
wallet y el pago se libera; otra compra con reclamo y evidencia que termina en reembolso; la página pública las muestra; la
tarjeta comprada se usa en el tótem de un evento y la llegada aparece en el teléfono del organizador. Se graba un video corto.

## 8. Orden, fechas y cortes

| Semana | Tareas |
|---|---|
| Antes del sprint (11-nov) | Cerrar la Fase 9 (T162–T167 en vivo), la tienda Tapline y su catálogo (tarea A del encargo), pedir el hardware, preguntar al capítulo por Luma |
| 1 (11–17 nov) | T182 a T190 |
| 2 (18–24 nov) | T191 a T195 |
| 3 (25 nov – 2 dic) | T196 a T201 |
| 4 (3–10 dic) | T202 a T206; evento de entrega ~6–7 dic, a acordar con el capítulo |

La línea de corte de la semana 2 es la noche del 24-nov. Start-Up Chile cierra el 24-nov a las 13:00 y pide un MVP del 11 al 13: es carga del usuario
en paralelo y no está en este plan. La fecha del 11-nov la indica el usuario; si el capítulo fija otra, se corren todas.

**Línea de corte:** T201 (la asistencia en Stellar) es un extra que no se prometió y no se hace si algo aprieta; si al final de la
semana 2 falta algo, se corta T201 primero y después T200 (la API de Luma, queda el CSV). **D1 y las compras de D2 no se cortan.** Sin el tótem físico, el registro funciona con el QR en el teléfono
del organizador.

## 9. Riesgos

| Riesgo | Mitigación |
|---|---|
| El hardware tarda (desde AliExpress a Chile, 2 a 4 semanas; supuesto sin verificar) | Pedir el lector y las tarjetas antes del inicio del sprint; el respaldo es Web NFC en un teléfono Android y el QR |
| Cambiar el contrato de escrow a mitad del sprint | El contrato v2 es la primera tarea y el despliegue la segunda; Tapline usa uno nuevo y `agentcommerce` no se toca |
| La clave de Luma sirve solo para el calendario que la emite y exige Luma Plus | Importar el CSV; preguntarle al capítulo |
| Que el capítulo pregunte para qué necesita la red la asistencia | No se prometió: T201 es un extra opcional; si se hace, la huella se ancla sin datos personales |
| Confirmar libera plata: un error de autorización sería grave | Firma de la wallet de la persona, tests de quien no es `principal`, y el agente no puede confirmar solo |
| La tienda Tapline sigue en prueba gratis (vence ~12-nov) y con contraseña | Decisión del usuario: suscribir (USD 1/mes por 3 meses, luego 25) |
| Personas reales: sus compras y grabaciones | Permiso de cada persona y nada de datos personales en la red ni en la página pública |

## 10. Preguntas abiertas

- [x] ¿Quién firma `confirm`? **La wallet del comprador** (la `principal()` del rail), decidido por el usuario el 10-nov (`Y-1`)
- [x] ¿Se retoma la cuenta por persona (`R-33`, T171) en esta fase? **Sí**, decidido por el usuario el 10-nov (`Y-4`)
- [x] ¿Cómo se marca la entrega de un digital? **Enlace de descarga propio**, decidido el 10-nov (`Y-5`)
- [x] Suscripción de Tapline: **suscribir** (USD 1/mes por 3 meses y luego 25), decidido el 10-nov; el pago lo hace el usuario en Shopify
- [x] **El texto exacto del anexo A:** puesto el 10-nov, transcrito del formulario enviado (pasado por la sesión de investigación)
- [x] **La fecha de inicio del sprint:** 11-nov, indicada por el usuario el 10-nov (Tellus no lo confirmó por escrito)
- [x] Prefijo de decisiones `Y-` y carpeta `docs/fase-10-instaward-comunidad/`: aprobados con el spec el 10-nov
- [ ] ¿El tótem va en `apps/totem` o dentro de `apps/web`? Se decide en el plan de T196
- [ ] ¿Quién imprime la carcasa 3D y cuándo es el evento de entrega? Los fija el usuario con el capítulo

## 11. Registro de cambios del spec

| Fecha | Cambio |
|---|---|
| 2026-11-10 | Fechas corridas: el sprint parte el 11-nov y dura hasta el 10-dic (S1 11–17 nov, S2 18–24, S3 25 nov–2 dic, S4 3–10 dic), según el usuario; el 23-nov era solo la fecha sugerida del formulario |
| 2026-11-10 | Anexo A reemplazado por el texto exacto enviado: D3 sin asistencia en Stellar (T201 pasa a extra), evidencia de D3 = tótem, lista en vivo y video, semana 4 con video y revisión final con el líder del capítulo, presupuesto de D3 con "3D design and printing", tercer documento de apoyo (`tapline-cl.myshopify.com`). Fecha del 23-nov: sugerida, por confirmar |
| 2026-11-11 | T207 agregada a pedido del usuario: todas las páginas con el diseño de las publicaciones, antes de T182, con la portada rehecha y las 13 páginas de una vez (`Y-7`) |
| 2026-11-10 | **Aprobado** por el usuario, sin cambios en las tareas; `Y-2`, `Y-3` y `Y-6` quedan como se propusieron; el anexo A sigue provisional |
| 2026-11-10 | Borrador a partir del encargo de la sesión de investigación y de la lectura del código. Respuestas del usuario sobre `confirm`, cuenta por persona, entrega digital y suscripción. Anexo A provisional |

---

## Anexo A · Texto enviado al Instaward (9-nov-2026)

> **Texto exacto de los campos del formulario**, transcrito del envío del 9-nov-2026 (~22:18 hora de Chile) por la sesión de investigación (`investigacion-instaward/25-formulario-enviado-texto-exacto.md`). No es una lectura de la plataforma después del envío: Passport pidió iniciar sesión. Estado en Passport el 10-nov: "Application submitted", paso 2 de 4, "Chapter review"; Tellus escribió que AgentPey fue seleccionado. El texto está en inglés, como se envió.

### Project scope
- **Project name:** AgentPey
- **Requested funding (USD):** 4000
- **Suggested sprint start date:** 2026-11-23 (solo una sugerencia; el sprint parte el 11-nov, ver la sección 8)
- **Supporting documents:**
  - https://github.com/vicentewolde/AgentPey
  - https://agentpey.com
  - https://tapline-cl.myshopify.com
- Casillas "The scope takes 30 days or less" y "The deliverables are concrete and measurable": marcadas.

### Problem & objective
AI assistants can now buy things for us. The hard part comes when a purchase goes wrong: the item never shows up, or it isn't what we paid for, and by then the money is gone.

AgentPey fixes that on Stellar: the payment waits in an escrow until the buyer is happy with what they got. If not, they open a claim from the same chat, show what went wrong, and get their money back.

This sprint puts it in real hands. People from the Stellar community will buy NFC cards and event badges from a real store, each purchase protected until they confirm it. Those cards then get a job at Stellar Chile events: a 3D-printed arrival totem where members check in with a tap, working with Luma and Stellar Passport, while organizers see who arrived in real time.

### Deliverables

**1. Protection for any purchase**
- *What will be delivered:* The AgentPey escrow is extended so a purchase is released when the buyer confirms they are satisfied, or when the claim window passes without a claim. It works for physical goods (confirmed on arrival) and digital goods (confirmed after access). Claims carry evidence, such as photos or files, whose fingerprint is sealed on Stellar for the arbiter. Each buyer gets their own spending account with their own limits, funded from their own wallet. The AI assistant gets two new actions: confirm a purchase, and attach evidence to a claim.
- *Planned evidence:* Escrow contract ID on Stellar Expert and its tests; transaction hashes for a release confirmed by the buyer, a release after the claim window and a claim with sealed evidence; one over-limit payment rejected by the network.

**2. Real purchases from the Stellar community**
- *What will be delivered:* Tapline, a store selling NFC cards and event badges, connected to AgentPey with its own escrow. 5 or more Stellar community members buy through their AI assistant (Claude or ChatGPT): the assistant quotes, the person approves. Purchases include at least one digital item and one physical item; at least one is confirmed by the buyer and one is refunded after a claim with evidence. A public page lists every purchase and its outcome, read from Stellar.
- *Planned evidence:* Store URL; transaction hashes for purchases, confirmations and the refund; the public page; screen recordings.

**3. Arrival totem for Stellar Chile events**
- *What will be delivered:* A 3D-printed totem, a gift for Stellar Chile's community events. Members tap their NFC card, or scan the code on its screen (it changes every 30 seconds), and are checked in within a second. The organizer sees on their phone who arrived, who is new and who had not registered, and can export the list. It reads the Luma guest list and the member's Stellar Passport profile. It debuts at a card-handover event with the community, planned with the chapter.
- *Planned evidence:* The totem working at a community event; the live arrivals list; a short video.

### Out of scope y presupuesto
- **Out of scope:** Card or fiat payment rails; other store platforms; onboarding other merchants; replacing Luma or Stellar Passport; facial recognition or automatic tracking; an external security audit.
- **Budget:** USD 4,000 in total.
  - Deliverable 1: USD 1,100 (escrow confirmation and evidence, per-buyer spending accounts, assistant actions, tests).
  - Deliverable 2: USD 800 (store integration, onboarding, live runs, public page, recordings).
  - Deliverable 3: USD 1,600 (3D design and printing, NFC reader and electronics, NFC cards, check-in app and organizer view, event).
  - Infrastructure and tooling: USD 500 (hosting and database, Stellar RPC, domain, store plan, card shipping).

### Execution plan
- **Week 1:** Escrow extended: release on buyer confirmation, release after the claim window, sealed evidence on claims, with tests on testnet. Per-buyer spending accounts. New assistant actions to confirm a purchase and attach evidence.
- **Week 2:** Tapline connected to AgentPey. First community buyers: one digital and one physical purchase, one confirmation, one claim with evidence and its refund. Public page of purchases.
- **Week 3:** Totem built: 3D print, NFC reader, check-in app and the organizer's live view, reading the Luma guest list and Passport profiles. Cards produced.
- **Week 4:** Card-handover event with the community using the totem. Video and final review with the Chapter Lead.

### Pasos 7 y 8
- **7 · After the sprint:** "Apply for a follow-on Instaward, if eligible".
- **8 · Acknowledgements:** las cinco reglas aceptadas.

### Lo que el anexo no promete
La asistencia en Stellar **no** es parte de lo enviado: ni el entregable 3, ni su evidencia, ni la semana 4 la mencionan (T201 es un extra, no un compromiso). Tampoco se prometió "sin datos personales" en la página pública (T195 lo cumple por diseño, no por compromiso) ni "sin reemplazar Luma ni Passport" como entregable (solo aparece en "Out of scope"). Los dos modos de registro del tótem, la tarjeta NFC y el QR que cambia cada 30 s, sí son compromiso.
