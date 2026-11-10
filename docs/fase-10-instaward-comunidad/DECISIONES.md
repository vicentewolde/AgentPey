# Decisiones — Fase 10 (Compras protegidas con la comunidad y tótem de llegada)

> Prefijo `Y-`. Cada decisión con su motivo y la alternativa descartada. Las que cruzan fases van a
> [`docs/DECISIONES.md`](../DECISIONES.md) con prefijo `P-` (la que abre esta fase es `P-24`); las que tocan Vitrinee por dentro,
> a su `DECISIONES.md` con prefijo `VT-`.

`Y-1`, `Y-4` y `Y-5` las **decidió el usuario** el 10-nov. `Y-2`, `Y-3` y `Y-6` las propuso Claude Code al leer el código y el usuario las aprobó con el spec el 10-nov.

---

### Y-1 · `confirm` lo autoriza la wallet de la persona (la `principal()` del rail), no la llave del agente · `Vigente` (decidida el 10-nov)
**Fecha:** 2026-11-10 · **Tareas:** T182, T185

`open` de un pagador-rail se autoriza con la firma de la llave de agente (`owner()`), porque el rail solo autoriza `transfer`.
Confirmar libera el pago al comercio: si lo firmara la misma llave del agente, un agente comprometido o engañado liberaría plata
sin que la persona lo supiera. `confirm` exige entonces la autorización de `principal()` (la wallet de la persona), y un pagador
clásico firma la llamada él mismo. El asistente entrega un enlace a una página de firma y nunca confirma solo.

**Alternativa descartada: la firma de la llave de agente sobre un mensaje propio** (como `open`). Reutilizaba un patrón probado
y evitaba una página de firma, pero deja que el agente libere el pago sin la persona.

### Y-2 · Tapline usa un escrow v2 nuevo; el de `agentcommerce` no se redespliega · `Vigente` (aprobada con el spec el 10-nov)
**Fecha:** 2026-11-10 · **Tareas:** T182, T183, T191

Un contrato por tienda (`X-11`). El de `agentcommerce` (`CBQFELK5…DO27A`) es el de la demo en vivo y la Fase 9 lo dejó funcionando
con el wasm anterior; cambiarlo a mitad del sprint arriesga esa demo. Tapline estrena el wasm v2 y la lista de hashes permitidos
(`PURCHASE_ESCROW_WASM_HASHES`) acepta los dos. **Alternativa descartada: redesplegar `agentcommerce` con el v2:** unifica, pero
toca la tienda de la demo y exige tocar `VITRINEE_COMERCIO_ESCROWS`.

### Y-3 · La evidencia vive fuera de la red; su huella entra en el reclamo y el reclamo es el `claim_hash` · `Vigente` (aprobada con el spec el 10-nov)
**Fecha:** 2026-11-10 · **Tarea:** T184

El escrow guarda 32 bytes por disputa. El archivo (foto, PDF) se guarda en la tienda con tope de tamaño y se sirve al árbitro con
un enlace firmado; su sha256 va dentro del reclamo firmado, y el sha256 del reclamo es el `claim_hash`. Así no se cambia el
contrato y un archivo alterado deja de coincidir. **Alternativa descartada: guardar los archivos en un almacenamiento
externo (IPFS u otro servicio):** un tercero nuevo, fuera de lo que prometió el formulario ("sin terceros nuevos" sigue siendo la
regla de la casa), y sin ganancia de verificación porque la huella ya viaja en la red.

### Y-4 · La cuenta de gasto por persona entra a esta fase (`R-33`, T171) · `Vigente` (decidida el 10-nov)
**Fecha:** 2026-11-10 · **Tareas:** T186, T187, T189 · Reabre `P-20` solo para esto

`P-20` pasó T171 a una fase futura. El formulario prometió que cada comprador tiene su propia cuenta de gasto, con sus topes y
fondeada desde su wallet. Se retoma tal como la decidió `R-33`: un `policy_rail` por persona, una llave de agente derivada por
persona (SEP-0005, `packages/tenancy`) y una lista cerrada de wallets. **Alternativa descartada: dejar la cuenta por persona fuera:**
incumplía lo enviado.

### Y-5 · Un producto digital se entrega con un enlace de descarga único; la primera descarga marca la entrega · `Vigente` (decidida el 10-nov)
**Fecha:** 2026-11-10 · **Tarea:** T188

El flujo de la Fase 9 supone un despacho físico leído de Shopify. Para un digital, la tienda emite un enlace único por pedido y
la primera descarga llama `mark_shipped`: abre la ventana de liberación y desde ahí la persona confirma o reclama.
**Alternativa descartada: que el comercio marque el pedido entregado a mano:** menos código, pero manual y sin prueba de que el
archivo llegó.

### Y-6 · La asistencia se ancla como una huella, sin datos personales en la red · `Vigente` (aprobada con el spec el 10-nov)
**Fecha:** 2026-11-10 · **Tarea:** T201

La llegada de una persona a un evento se guarda en el servicio del tótem; en Stellar se ancla solo la huella (hash) de un registro
firmado, con el evento y la hora. Ningún nombre, correo ni identificador de persona va a la red. Se decide en la tarea si reutiliza
`receipt-registry` (otro workspace de Cargo, con permiso del usuario) o lleva un contrato propio; nada en mainnet.
**Alternativa descartada: guardar la asistencia entera en la red:** mezcla datos personales con un registro que no se puede borrar.
