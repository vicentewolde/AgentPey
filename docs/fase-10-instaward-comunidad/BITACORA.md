# Bitácora — Fase 10 (Compras protegidas con la comunidad y tótem de llegada)

> Qué se hizo, qué falta, y qué significa cada cosa en lenguaje llano.
> Spec: [SPEC.md](SPEC.md) · Decisiones: [DECISIONES.md](DECISIONES.md) ·
> Salidas crudas de cada tarea: `evidencia/T<n>.md`
>
> La numeración continúa la de las fases anteriores: esta fase usa T182 a T206. El tablero del día a día es
> [`docs/ESTADO.md`](../ESTADO.md); aquí queda la narrativa de cada tarea cerrada.

---

## Estado actual

**Fecha:** 2026-11-10 · **Spec aprobado** por el usuario (`P-15`); anexo A con el texto exacto enviado. El sprint parte el 11-nov (hasta el 10-dic, lo indica el usuario) solo si el capítulo aprueba el Instaward enviado el 9-nov. Nada de esta fase está construido.

Pendiente: que Tellus confirme la fecha por escrito. Antes del sprint y fuera de esta fase: cerrar la Fase 9 en vivo, la tienda Tapline y su catálogo, pedir el hardware del tótem.

## Progreso

| Tarea | Estado |
|---|---|
| T207 Todas las páginas con el diseño de las publicaciones | ✅ en producción el 11-nov (PR #106, [evidencia](evidencia/T207.md)) |
| T182 `confirm` en el contrato de escrow | ✅ en `main` ([PR #107](https://github.com/vicentewolde/AgentPey/pull/107), [evidencia](evidencia/T182.md)); el contrato se despliega en T183 |
| T183 Escrow v2 en testnet | 👀 desplegado `CDSCZJEM…E3UML` y ensayado ([evidencia](evidencia/T183.md)); el de Tapline va con T191 (`Y-9`) |
| T184 Evidencia sellada | ✅ en `main` ([PR #110](https://github.com/vicentewolde/AgentPey/pull/110)) y corrida en testnet con foto ([evidencia](evidencia/T184.md)) |
| T185 Acciones del asistente | 🚧 `confirm_purchase` hecha en `cc/sitio-t185` (sin mergear); falta `attach_evidence` |
| T186 a T206 | ⏳ pendientes (T201 es un extra) |

## Bitácora

- 2026-11-10: spec escrito y **aprobado por el usuario**, hecho a partir del encargo de la sesión de investigación y de leer el código de la Fase 9. El
  usuario decidió `confirm` (`Y-1`), la cuenta por persona (`Y-4`), la entrega digital (`Y-5`) y la suscripción de Tapline.

## 2026-11-11 · T207 y T182

**T207.** Las 13 páginas de AgentPey siguen el diseño de las publicaciones de la marca, con una hoja de estilos única (`Y-7`). Revisada
por un agente independiente en dos pasadas, corregida y en producción el 11-nov.

**T182.** El comprador ya puede confirmar que está conforme: en el contrato, `confirm` paga a la tienda en el acto, desde una compra
retenida o despachada. Solo lo firma la wallet de la persona (o la cuenta que pagó, si es una cuenta normal); ni el agente, ni la tienda,
ni el árbitro pueden. Con una disputa abierta no se puede. 42 pruebas del escrow en verde. Falta desplegarlo para Tapline (T183, con OK).


## 2026-11-11 · T183

**T183.** El contrato nuevo del escrow, el que deja al comprador confirmar, ya está en testnet (`CDSCZJEM…E3UML`) y el
verificador de recibos lo acepta. Se ensayó con dos compras: una que el comprador confirmó y se pagó al tiro, y otra que
se liberó sola al vencer su plazo. El contrato propio de Tapline se despliega cuando Tapline entre a Vitrinee (T191),
porque su cuenta firmante nace en ese alta (`Y-9`); el cobro irá a la wallet que dio el usuario, con los plazos de
`agentcommerce`. La confirmación desde la wallet de una persona se prueba con la página de firma (T185).

## 2026-11-11 · T184

**T184.** Un reclamo ya puede traer fotos o PDF. El archivo no va a la red: el reclamo firmado guarda su huella y la red
guarda la huella del reclamo, así que si alguien cambia la foto después, deja de calzar. La tienda guarda el archivo solo
si el reclamo sellado lo nombra, y se lo entrega solo al árbitro, al comercio o al comprador, con un enlace que firman con
su propia llave y que vence en minutos, porque una foto de un paquete puede mostrar una dirección. El árbitro revisa cada
archivo antes de decidir y le dice al modelo cuáles calzan. La corrida en testnet salió bien: un reclamo con una foto quedó abierto en la red, la tienda la guardó, y el árbitro la leyó, comprobó su huella y rechazó el reclamo (era una prueba, sin daño real).

## 2026-11-12 · T185 (primera mitad)

**T185, `confirm_purchase`.** Claude ya puede ayudar a confirmar una compra, pero no puede confirmarla él: la herramienta le
da a la persona un enlace (`agentpey.com/resolve/confirmar?order=…`) y ahí conecta su wallet y firma. La tienda arma la
transacción solo para la cuenta que corresponde (la que pagó, o la wallet a la que responde su rail, nunca la llave del
agente) y la envía solo si es exactamente `confirm` de esa orden. Al firmar, la tienda cobra al tiro. Falta `attach_evidence`.
Un detalle de diseño: la foto de un reclamo se sella al firmarlo, así que hay que subirla antes de abrir el reclamo;
eso se resuelve con una página de subida (la segunda mitad de T185).
