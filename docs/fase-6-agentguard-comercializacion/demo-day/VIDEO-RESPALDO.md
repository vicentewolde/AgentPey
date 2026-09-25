# Demo Day · video de respaldo y demo en vivo (T106)

> Qué hacer, en orden, para grabar el respaldo el viernes 2026-09-25 a las 11:00
> y repetir la misma demo en vivo a las 19:00. El video dura unos 60 segundos,
> sin audio: si hace falta en el escenario, lo reproduces y narras encima con
> el guion de la slide 3 ([GUION.md](GUION.md)).
>
> **La demo compra en MycoKit, no en Bazar Cordillera** (cambiado el
> 2026-09-25). El panel del dueño solo muestra las tiendas que cobran en la
> wallet con que entras: MycoKit cobra en la tuya (`GD2M…K5GN`); Bazar
> Cordillera cobra en una cuenta que creó la plataforma y que no está en tu
> Freighter.
>
> Cada compra es real en testnet: el **Kit de cultivo Cola de Pavo**, el más
> barato, cuesta **2,09 USDC**. Hay dos previstas (video y en vivo): 4,19 USDC.
> **Usa tu cuenta de RealOps de antes** (la de los stickers del 24): su contrato
> de pago tenía 12,49 USDC. Una cuenta nueva recibe solo 3 USDC de crédito y
> alcanzaría para un kit, no para dos.

## A. Contratar el comprador nuevo (antes de las 11:00; mejor hoy)

Hace falta uno nuevo: los compradores contratados antes de T104 ya no pueden
comprar (`C-145`, punto 8).

1. Entra a `https://realops.agentpey.com` → **Entrar** (link por email).
2. **Mis agentes** → **Contratar un agente** → **¿Qué quieres que haga?**:
   *Comprar en MycoKit (tienda)*. Los límites se ponen solos en 25,00 por compra
   y por día. El nombre es opcional. → **Contratar y firmar →** (`C-150`).
   (También sirve desde el **Catálogo**: tarjeta del Kit Cola de Pavo → **Ver el
   permiso que esto necesita →** → **Contratar y firmar →**.)
3. Te lleva directo a AgentPey (`agentpey.com/consent/…`):
   - Arriba a la derecha, **Conectar wallet**: Freighter pide una firma de
     verificación, que no mueve dinero. El botón pasa a mostrar tu cuenta.
   - Abajo, **Firmar Mandato**: Freighter pide **dos** aprobaciones, firmar el
     Mandato y anclarlo en testnet.
   - Aparece **Mandato anclado** y un botón grande **Seguir en
     realops.agentpey.com →**.
4. Vuelves a RealOps directo a **Lo que puede comprar** tu comprador: los
   cuatro kits, "dentro del permiso". Listo. Avísame y verifico el Mandato.
5. Un comprador por tienda: si ya tenías uno para MycoKit, "Contratar y
   firmar" abre su firma o, si ya estaba firmado, su catálogo.

## B. Preparar la pantalla (10:45)

- Modo "No molestar" activado. Barra de marcadores oculta. Zoom del navegador
  al 125 %.
- Freighter desbloqueado y en **Testnet**.
- **Pestaña 1, RealOps:** **Lo que puede comprar** tu comprador (desde su ficha, **Ver lo que puede comprar →**), tarjeta del Kit de cultivo Cola de Pavo con
  "dentro del permiso", **Cantidad 1**, y los campos de envío ya llenos. Usa
  datos de prueba, no tu dirección real: se ven en pantalla.
- **Pestaña 2, panel de Vitrinee:** `https://vitrinee.agentpey.com` →
  **Connect Freighter** con **tu wallet, la dueña de MycoKit** (`GD2M…K5GN`). La sesión
  dura 12 horas: si entras a las 10:45, te dura hasta la demo de la noche.
- Cierra todo lo demás.

## C. Grabar (11:00)

En el Mac: `Cmd + Shift + 5` → **Grabar toda la pantalla** (o la ventana del
navegador) → **Grabar**. Para terminar, el botón de parar en la barra de
arriba.

| Segundo | Qué haces | Qué se ve |
|---|---|---|
| 0 a 8 | Pestaña 1, **Lo que puede comprar** tu comprador (`/catalogo?agente=…`), con la tarjeta del Kit Cola de Pavo lista | La tarjeta "dentro del permiso" |
| 8 a 12 | Clic en **Pedirle al agente que lo compre** | RealOps pasa a **Mis servicios** con un aviso verde arriba: **Comprado: Kit de cultivo Cola de Pavo** |
| 12 a 25 | En ese aviso, clic en **Ver el pago en Stellar ↗** | Stellar Expert: **Successful**, una transferencia de USDC. Quédate 5 segundos |
| 25 a 40 | Pestaña 2, **recarga** el panel | El pedido nuevo arriba, con la etiqueta "Pagado, pedido aún no llega a tu tienda" y los links Pago y Recibo |
| 40 a 55 | Clic en **Recibo** | La página **Recibo de venta**: "Recibo válido: pasan las tres comprobaciones", las tres en verde, el kit y el total |
| 55 a 60 | Para la grabación | |

No te detengas en la etiqueta "entregado" de la tarjeta de Entregas: el pedido
todavía no llega a Jumpseller (T101). El aviso verde de arriba dice "Comprado",
que sí es cierto.

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
