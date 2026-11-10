# Spec Fase 10 · Compras protegidas con la comunidad y tótem de llegada

- **Estado:** Borrador (2026-11-10), a la espera de la aprobación del usuario (`P-15`)
- **Rama base:** `main`
- **Tareas:** T182 a T206 (la numeración sigue la de la Fase 9, cuyo último número es T181)
- **Fechas:** 23-nov → 21-dic-2026 (30 días), **solo si el capítulo aprueba el Instaward**. Si no lo aprueba, el spec queda como plan y el usuario decide si construye algo
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
(USD 4.000, inicio sugerido el 23-nov). El texto enviado está en el [anexo A](#anexo-a--texto-enviado-al-instaward-9-nov-2026):
**lo que dice el anexo es el compromiso**, y este spec no promete ni más ni menos.

> **Aviso sobre el anexo A.** La plataforma de Passport pide iniciar sesión y no se pudo leer el texto exacto. El anexo está
> armado con el resumen fiel de las notas de la sesión de investigación (v3 del formulario) y está marcado como
> **provisional**: el usuario pega el texto exacto antes de aprobar el spec.

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
- Reemplazar Luma o Passport: el tótem se suma a ambos y los lee, no los sustituye.
- Reconocimiento facial o rastreo automático de personas.
- Auditoría externa de seguridad.
- Tocar la tienda `agentcommerce` (la de la demo en vivo) y el escrow `CBQFELK5…DO27A`.
- Cerrar la Fase 9 (T162–T167 en vivo): es una **dependencia anterior al 23-nov**, no una tarea de esta fase (sección 8).

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
          perfil público de Passport ─────────────────────────▶ │ ──▶ huella de la asistencia en Stellar
```

El lector es una Raspberry Pi o un ESP32 con un PN532, o el teléfono del organizador (Web NFC en Android) como respaldo:
**sin el hardware, el registro funciona igual con el QR en el teléfono** y el tótem es la carcasa. Luma: su API pide Luma Plus en
el calendario del capítulo y la clave solo sirve para ese calendario; el respaldo es importar el CSV. Passport: API pública de
solo lectura. La asistencia queda anclada en Stellar como la huella de un registro, sin datos personales en la red (`Y-6`).

### 4.7 Decisiones

`Y-1` a `Y-6` están en [`DECISIONES.md`](DECISIONES.md) como propuestas, con las respuestas del usuario del 10-nov.

## 5. Tareas

Todas: rama `cc/t<n>-<slug>` desde `origin/main`; `pnpm check` en verde, más `vitrinee:check` si toca Vitrinee y `cargo test` si
toca contratos; bitácora, evidencia en `evidencia/T<n>.md` y `ESTADO.md`. **Ninguna se delega a Codex** (`P-10`: contrato,
fondos, firma, autorización) salvo que el usuario lo decida para una tarea del tótem que no toque firma ni fondos. Cada
despliegue en testnet y cada gasto necesitan el OK explícito del usuario. Las horas son estimaciones de este borrador.

### Semana 1 (23–29 nov) · D1

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

### Semana 2 (30-nov – 6-dic) · D2

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

### Semanas 3 y 4 (7–21 dic) · D3

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

#### T201 · La asistencia en Stellar
- **Estimación:** 8 h · **Depende de:** T196
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
  - [ ] el tótem debuta en un evento real con la comunidad y queda el registro de llegadas

#### T205 · Corrida final, QA y verificación de lo prometido
- **Estimación:** 8 h · **Depende de:** T190, T194, T195, T204
- **Hecho cuando:**
  - [ ] `pnpm check`, `cargo test` y `pnpm run prod:check` en verde; `evidencia/T205.md` enlaza cada hash y cada entregable contra el anexo A

#### T206 · Informe final y cierre con el capítulo
- **Estimación:** 4 h · **Depende de:** T205
- **Hecho cuando:**
  - [ ] el informe final está entregado y ESTADO, ROADMAP y la bitácora cierran la fase

## 6. Criterios de aceptación de la fase (la evidencia que se prometió)

| Entregable | Evidencia prometida | Tarea |
|---|---|---|
| D1 | El ID del contrato y sus tests; los hashes de una liberación confirmada, una por vencimiento y un reclamo con evidencia sellada; un pago sobre el tope rechazado por la red | T182, T183, T184, T189, T190 |
| D2 | Cinco o más compras de la comunidad, una digital y una física, una confirmada y una reembolsada con evidencia; una página pública que las lista leídas de Stellar | T194, T195 |
| D3 | El tótem funcionando (tarjeta y QR), la vista del organizador con exportación, Luma y Passport leídos, la asistencia en Stellar, y su debut en un evento | T196 a T204 |

## 7. Plan de demo

Una compra de punta a punta en Tapline: Claude cotiza, la persona aprueba, el pago queda retenido; la persona confirma desde su
wallet y el pago se libera; otra compra con reclamo y evidencia que termina en reembolso; la página pública las muestra; la
tarjeta comprada se usa en el tótem de un evento y la llegada aparece en el teléfono del organizador.

## 8. Orden, fechas y cortes

| Semana | Tareas |
|---|---|
| Antes del 23-nov | Cerrar la Fase 9 (T162–T167 en vivo), la tienda Tapline y su catálogo (tarea A del encargo), pedir el hardware, preguntar al capítulo por Luma |
| 1 (23–29 nov) | T182 a T190 |
| 2 (30-nov – 6-dic) | T191 a T195 |
| 3 y 4 (7–21 dic) | T196 a T206 |

**Línea de corte:** si al final de la semana 2 falta algo, se corta primero T201 (la asistencia en Stellar) y después T200 (la API
de Luma, queda el CSV). **D1 y las compras de D2 no se cortan.** Sin el tótem físico, el registro funciona con el QR en el teléfono
del organizador.

## 9. Riesgos

| Riesgo | Mitigación |
|---|---|
| El hardware tarda (desde AliExpress a Chile, 2 a 4 semanas; supuesto sin verificar) | Pedir el lector y las tarjetas antes del 23-nov; el respaldo es Web NFC en un teléfono Android y el QR |
| Cambiar el contrato de escrow a mitad del sprint | El contrato v2 es la primera tarea y el despliegue la segunda; Tapline usa uno nuevo y `agentcommerce` no se toca |
| La clave de Luma sirve solo para el calendario que la emite y exige Luma Plus | Importar el CSV; preguntarle al capítulo |
| Que el capítulo pregunte para qué necesita la red la asistencia | El registro anclado es opcional y lo central es la compra protegida; la huella se ancla sin datos personales |
| Confirmar libera plata: un error de autorización sería grave | Firma de la wallet de la persona, tests de quien no es `principal`, y el agente no puede confirmar solo |
| La tienda Tapline sigue en prueba gratis (vence ~12-nov) y con contraseña | Decisión del usuario: suscribir (USD 1/mes por 3 meses, luego 25) |
| Personas reales: sus compras y grabaciones | Permiso de cada persona y nada de datos personales en la red ni en la página pública |

## 10. Preguntas abiertas

- [x] ¿Quién firma `confirm`? **La wallet del comprador** (la `principal()` del rail), decidido por el usuario el 10-nov (`Y-1`)
- [x] ¿Se retoma la cuenta por persona (`R-33`, T171) en esta fase? **Sí**, decidido por el usuario el 10-nov (`Y-4`)
- [x] ¿Cómo se marca la entrega de un digital? **Enlace de descarga propio**, decidido el 10-nov (`Y-5`)
- [x] Suscripción de Tapline: **suscribir** (USD 1/mes por 3 meses y luego 25), decidido el 10-nov; el pago lo hace el usuario en Shopify
- [ ] **El texto exacto del anexo A:** lo pega el usuario antes de aprobar
- [ ] Prefijo de decisiones `Y-` y carpeta `docs/fase-10-instaward-comunidad/`: propuestos, a confirmar con el spec
- [ ] ¿El tótem va en `apps/totem` o dentro de `apps/web`? Se decide en el plan de T196
- [ ] ¿Quién imprime la carcasa 3D y cuándo es el evento de entrega? Los fija el usuario con el capítulo

## 11. Registro de cambios del spec

| Fecha | Cambio |
|---|---|
| 2026-11-10 | Borrador a partir del encargo de la sesión de investigación y de la lectura del código. Respuestas del usuario sobre `confirm`, cuenta por persona, entrega digital y suscripción. Anexo A provisional |

---

## Anexo A · Texto enviado al Instaward (9-nov-2026)

> **PROVISIONAL.** Resumen fiel de las notas de la sesión de investigación (`15-formulario-final.md` a `17-formulario-v3-y-evaluacion.md`), no el texto exacto. El usuario lo reemplaza por el texto enviado antes de aprobar el spec.

**Proyecto:** AgentPey · USD 4.000 · inicio sugerido 23-11-2026 · duración 4 semanas · capítulo: Stellar Chile.

**Presupuesto (v3):** D1 USD 1.100 · D2 USD 800 · D3 USD 1.600 · infraestructura USD 500.

**Entregables:**
1. *Protección para cualquier compra, física o digital (semana 1).* El escrow libera cuando el comprador confirma que está conforme, o cuando vence la ventana sin reclamo. El reclamo lleva evidencia (fotos o archivos) con su huella sellada en Stellar para el árbitro. Cada comprador tiene su propia cuenta de gasto, con sus topes y fondeada desde su propia wallet. El asistente gana dos acciones: confirmar la compra y adjuntar evidencia. Evidencia: el ID del contrato y sus tests; los hashes de una liberación confirmada, una liberación por vencimiento y un reclamo con evidencia sellada; un pago sobre el tope rechazado por la red.
2. *Compras reales de la comunidad de Stellar (semana 2).* Tapline, conectada a AgentPey con su propio escrow. Cinco o más miembros de la comunidad compran con su asistente (Claude o ChatGPT): el asistente cotiza y la persona aprueba. Al menos una compra digital y una física, al menos una confirmada y una reembolsada tras un reclamo con evidencia. Una página pública lista cada compra y su resultado, leído de Stellar.
3. *Tótem de llegada para los eventos de Stellar Chile (semanas 3 y 4).* Un tótem impreso en 3D. El asistente se registra con la tarjeta NFC comprada, o con un QR en pantalla que cambia cada 30 s. El organizador ve en su teléfono quién llegó, quién es nuevo y quién no se había inscrito, y puede exportar la lista. Lee la lista de Luma y el perfil de Stellar Passport, sumándose a ambos sin reemplazarlos. La asistencia queda en Stellar. Debuta en un evento de entrega de tarjetas con la comunidad.

**Fuera de alcance:** rieles de tarjeta o fiat, otras plataformas de tienda, sumar otros comercios, reemplazar Luma o Passport, reconocimiento facial o rastreo automático, auditoría externa. Todo en testnet.
