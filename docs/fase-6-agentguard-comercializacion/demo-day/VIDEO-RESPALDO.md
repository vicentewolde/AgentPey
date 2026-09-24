# Demo Day · video de respaldo y demo en vivo (T106)

> Qué hacer, en orden, para grabar el respaldo el viernes 2026-09-25 a las 11:00
> y repetir la misma demo en vivo a las 19:00. El video dura unos 60 segundos,
> sin audio: si hace falta en el escenario, lo reproduces y narras encima con
> el guion de la slide 3 ([GUION.md](GUION.md)).
>
> Cada compra es real en testnet: unos 1,04 USDC de prueba. Hay dos
> previstas (video y en vivo). El contrato que paga tenía 12,49 USDC el
> 2026-09-24, así que alcanza. Si RealOps te crea un cliente nuevo, se le dan 3
> USDC en su primer pago, que también alcanza para las dos.

## A. Contratar el comprador nuevo (antes de las 11:00; mejor hoy)

Hace falta uno nuevo: los compradores contratados antes de T104 ya no pueden
comprar (`C-145`, punto 8).

1. Entra a `https://realops.agentpey.com` → **Entrar** (link por email).
2. **Catálogo** → sección **Tiendas en Vitrinee** → tarjeta del **Pack de
   stickers Cordillera** (Bazar Cordillera).
3. **Ver el permiso que esto necesita →** → revisa → **Configurar este agente**.
4. Página **Revisar el permiso**: mira la tabla (tope por compra, tope por
   día, tienda, USDC) → **Firmar en AgentPey**.
5. En AgentPey (`agentpey.com/consent/…`):
   - **Conectar wallet**: Freighter pide una firma de verificación. No mueve
     dinero.
   - **Firmar Mandato**: Freighter pide **dos** aprobaciones: firmar el
     Mandato y anclarlo en testnet.
   - Aparece **Mandato anclado** → **Volver**.
6. De vuelta en RealOps: "✓ Firmado. Mandato …". Listo. Avísame y verifico el
   Mandato.

## B. Preparar la pantalla (10:45)

- Modo "No molestar" activado. Barra de marcadores oculta. Zoom del navegador
  al 125 %.
- Freighter desbloqueado y en **Testnet**.
- **Pestaña 1, RealOps:** `Catálogo`, tarjeta del Pack de stickers con
  "dentro del permiso", **Cantidad 1**, y los campos de envío ya llenos. Usa
  datos de prueba, no tu dirección real: se ven en pantalla.
- **Pestaña 2, panel de Vitrinee:** `https://vitrinee.agentpey.com` →
  **Connect Freighter** con la wallet **dueña de Bazar Cordillera**. La sesión
  dura 12 horas: si entras a las 10:45, te dura hasta la demo de la noche.
- Cierra todo lo demás.

## C. Grabar (11:00)

En el Mac: `Cmd + Shift + 5` → **Grabar toda la pantalla** (o la ventana del
navegador) → **Grabar**. Para terminar, el botón de parar en la barra de
arriba.

| Segundo | Qué haces | Qué se ve |
|---|---|---|
| 0 a 8 | Pestaña 1. Sube un poco para que se vea que el comprador tiene su permiso firmado | La tarjeta "dentro del permiso" |
| 8 a 12 | Clic en **Pedirle al agente que lo compre** | RealOps pasa a **Mis servicios** |
| 12 a 25 | Espera la tarjeta en **Entregas** y haz clic en **Ver el pago en Stellar ↗** | Stellar Expert: **Successful**, una transferencia de USDC. Quédate 5 segundos |
| 25 a 40 | Pestaña 2, **recarga** el panel | El pedido nuevo arriba, con la etiqueta "Pagado, pedido aún no llega a tu tienda" y los links Pago y Recibo |
| 40 a 55 | Clic en **Recibo**. Si Chrome ofrece "Dar formato", márcalo | `"valid": true` y las tres comprobaciones con `"ok": true` |
| 55 a 60 | Para la grabación | |

No te detengas en la etiqueta "entregado" de RealOps: el pedido todavía no
llega a Jumpseller (T101).

## D. Después de grabar

1. Mira el video completo una vez, a pantalla completa, en QuickTime.
2. Guárdalo en el **Escritorio** como `agentpey-demo-respaldo.mov`.
3. Pégame el link del **Recibo** (no es un secreto). Verifico el pago y las
   tres comprobaciones y lo anoto en `evidencia/T106.md`.

## E. Demo en vivo (18:00, antes de salir; y 18:45 en el lugar)

- [ ] Freighter desbloqueado y en Testnet.
- [ ] Pestaña 1 RealOps con la tarjeta lista (Cantidad 1, datos de envío
      llenos). Si la sesión de RealOps venció, entra de nuevo.
- [ ] Pestaña 2 con el panel de Vitrinee abierto con la wallet dueña.
- [ ] El deck abierto en modo presentación, en la slide 1, y el PDF descargado.
- [ ] El video en el escritorio, probado.
- [ ] Internet probado en el lugar; hotspot del teléfono listo.
- [ ] Avísame a las 18:00: compruebo que los cuatro sitios responden y que la
      testnet anda.

En el escenario: el mismo recorrido de la tabla de C, narrado con el guion de la
slide 3. Si algo tarda más de 10 segundos: "les muestro la grabación de esta
mañana", y abres el video.
