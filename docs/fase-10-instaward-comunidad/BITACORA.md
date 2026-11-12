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
| T184 a T206 | ⏳ pendientes (T201 es un extra) |

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
