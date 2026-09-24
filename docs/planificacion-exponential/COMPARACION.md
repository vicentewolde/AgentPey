# Comparación · hitos T (método ANTERIOR) vs. Exponential

> El experimento que `P-13` deja abierto. Las métricas y los criterios de
> cierre están escritos **antes** de medir, para que el resultado no se
> acomode a lo que uno quería que saliera.

## Los dos métodos

**ANTERIOR.** El hito se define en conversación con Claude Code, queda escrito
en una decisión (`C-`, `VT-`, `P-`) y en la bitácora de la fase, se construye en
una rama `cc/`, se revisa, se mergea en fast-forward y se documenta con
evidencia. Sin tablero: el orden y la prioridad viven en la cabeza del usuario
y en el "Sigue:" de la bitácora.

**EXPONENTIAL.** El hito se planifica con `/grill-with-docs` (una pregunta a la
vez, actualizando CONTEXTO y DECISIONES mientras se decide), se escribe un PRD
en el repo con `/to-prd`, y `/to-expo` lo corta en tickets verticales con
número T en Exponential. Se construye igual (`cc/`, revisión, fast-forward), con
`/start-ticket` y `/ship-ticket` moviendo el estado del ticket. El tablero
manda en prioridad, orden y fechas.

## Hipótesis

1. Planificar con `EXPONENTIAL` **no tarda más** que definir un hito con el
   método anterior, porque el grill reemplaza conversación dispersa por
   preguntas dirigidas.
2. Los tickets `EXPONENTIAL` llegan al merge con **menos cambios de alcance**,
   porque el PRD y los criterios de aceptación se escriben antes de tocar
   código.
3. El tablero mejora la **sensación de control** del usuario sobre el orden,
   que hoy depende de leer la bitácora.

**Sesgo conocido, dicho antes de empezar.** La línea base son tres hitos
definidos con decisiones ya maduras (`C-130`, del 2026-09-23) y con una fecha
externa encima (el video del 29). Los hitos `EXPONENTIAL` van a ser trabajo
posterior al video, con menos presión y menos contexto previo. Cualquier
diferencia en "días a merge" hay que leerla con eso en mente.

## Métricas

| # | Métrica | Fuente | Cómo se mide |
|---|---|---|---|
| M1 | Días entre creación del ticket y merge | `createdAt` en Exponential; fecha del commit de merge en `git log` | diferencia en días, con decimales |
| M2 | Cambios de alcance después de empezar | Repo | decisiones `C-`/`VT-` nuevas o bloques "qué cambió" en la bitácora, escritos entre la fecha de inicio y la de cierre del hito |
| M3 | Decisiones corregidas después de cerrar | Repo | decisiones del hito que pasan a `Superada` después de su cierre; se cuenta al cerrar el experimento |
| M4 | Tamaño del PR | `git diff --stat main...<rama>` antes del merge, o GitHub | líneas cambiadas y archivos |
| M5 | Rondas de revisión antes de aprobar | SYNC.md y GitHub | veces que el usuario pidió cambios antes del OK de merge |
| M6 | Bloqueos no previstos | `AGENT_LOG.md` | cosas que detuvieron el hito y no estaban en el ticket ni en la decisión |
| M7 | Claridad del ticket al empezar | **Usuario**, 1 a 5 | se pone al correr `/start-ticket` |
| M8 | Tiempo de planificación | **Usuario**, minutos | `EXPONENTIAL`: desde que empieza `/grill-with-docs` hasta que `/to-expo` crea el último ticket, con `exponential time log`. `ANTERIOR`: estimación del usuario de lo que tomó definir el hito |
| M9 | Sensación de control sobre el orden | **Usuario**, 1 a 5 | al cerrar el hito. Es lo único que mide el tablero visual |

## Criterio de cierre

El experimento cierra con **tres hitos mergeados de cada método, o el
2026-10-31**, lo que llegue primero. T100, T101 y T102 son los tres `ANTERIOR`.
Los tres primeros tickets `EXPONENTIAL` que se mergeen cierran la otra mitad.

**Qué resultado deja cada método.**

- **Queda `EXPONENTIAL`** si M8 no es mayor que en `ANTERIOR` **y** mejora al
  menos dos de M1, M2 y M7.
- **Queda `ANTERIOR`** si `EXPONENTIAL` sube M2 o M3: sería señal de que los
  tickets se escriben con menos contexto de `DECISIONES.md` que una decisión
  escrita a mano.
- **Mixto**, cualquier otro caso: Exponential sigue como tablero (prioridad,
  fechas, tareas del usuario) y los hitos se siguen definiendo en el repo, sin
  PRD obligatorio.

## Registro por ticket

| T | Método | M1 días | M2 alcance | M3 corregidas | M4 líneas/archivos | M5 rondas | M6 bloqueos | M7 claridad | M8 min | M9 control |
|---|---|---|---|---|---|---|---|---|---|---|
| T100 | ANTERIOR | 0,05 | 2 | | 1.026 líneas / 23 archivos (612 / 16 sin `docs/`) | 0 | 2 | 4 | 60 | pendiente |
| T101 | ANTERIOR | | | | | | | | | |
| T102 | ANTERIOR | 0,12 | 2 | | 576 líneas / 15 archivos (332 / 8 sin `docs/`), más 81 / 6 del ajuste | 0 | 3 | pendiente | pendiente | pendiente |
| T103 | EXPONENTIAL | 0,03 | 2 | | 1.976 líneas / 28 archivos sin `docs/` (2.945 / 40 con la planificación) | 0 | 0 | 4 | 52 (compartidos por T103 a T105; confirmados por el usuario) | 4 |
| T104 | EXPONENTIAL | 0,49 | 2 | | 1.650 líneas / 40 archivos (PR #31, con `docs/`) | 0 | 1 | 4 | ver T103 | 4 |
| T105 | EXPONENTIAL | 0,49 | 1 | | 1.959 líneas / 20 archivos sin `docs/` | 0 | 0 | 4 | ver T103 | pendiente |

Notas por ticket (bloqueos, qué cambió, por qué) van debajo, una entrada por
hito, al cerrarlo.

**T100** (mergeado 2026-09-23 ~17:50 UTC; ticket creado 16:31 UTC).
- M1: 0,05 días (unas 1,3 horas). Hito chico y con las decisiones maduras
  (`C-130`, `C-132`); no es comparable con un hito que parte de cero.
- M2 = 2: `C-134` (T102 pasa antes que T101, Vitrinee en
  `vitrinee.agentpey.com` dentro del servicio único) y `C-135` (forma del kind
  de Vitrinee en RealOps). La primera sí cambia el alcance del plan; la
  segunda precisa el del hito.
- M5 = 0: el usuario aprobó el merge a la primera. En el mismo mensaje pidió
  sumar las frases escritas para los productos de la tienda; eso se hizo
  después del merge, en su propia rama, y no se cuenta como ronda.
- M6 = 2: el deploy vivo de Vitrinee no tenía T99 (reordenó los hitos), y
  `scripts/register-venue.ts` estaba roto desde T79. Ninguno estaba en el
  ticket ni en `C-130`.
- M9: pendiente del usuario.

## Conclusión

Pendiente. Se escribe al cerrar el experimento, con los números de arriba y la
decisión (`P-`) que resulte.

**T102** (ticket creado 16:31 UTC, `DONE` 2026-09-23 ~21:10 UTC).
- M1: 0,19 días (unas 4,6 horas), con esperas de Render y del usuario incluidas.
- M2 = 2: se reordenó antes de empezar (`C-134`, de T100) y la memoria obligó a
  `C-138` (plan de 2 GB) después de mergear.
- M5 = 0: sin cambios pedidos en la revisión; sí dos PR (#25 y #27) porque el
  primer deploy mostró un fallo.
- M6 = 3, ninguno en el ticket: el servicio de Render no sincroniza
  `render.yaml`; el dominio adicional cuesta 0,25 USD al mes (el ticket decía
  gratis); y Vitrinee no cabe en 512 MB.
- M7, M8, M9: pendientes del usuario.

**T103 a T105, planificación** (2026-09-24, 02:30 a 03:22 UTC).
- M8: 52 minutos para las ocho preguntas del grill, el PRD, el Feature con 24
  historias y los seis tickets. Es una sola planificación para tres hitos:
  para comparar con un hito `ANTERIOR`, dividir o no es decisión del usuario
  al cerrar el experimento. Registrada con `exponential time log` como
  `PROPOSED`; la confirma el usuario (`exponential time confirm`).
- Sesgo a tener presente: la planificación partió de un traspaso escrito con
  las siete decisiones ya listadas, que ahorró tiempo de descubrimiento.

**T103** (ticket creado 2026-09-24 03:21 UTC, mergeado 04:10 UTC, en vivo ~04:25 UTC).
- M1: 0,03 días (unas 0,8 horas hasta el merge). Como T100, un hito con las
  decisiones ya tomadas en el grill; el sesgo anotado arriba aplica.
- M2 = 2: `VT-30` (dos modos, raíz en transición, rescate del pedido), que
  precisa el alcance dentro de las decisiones del grill, y la corrección de
  `C-143` (la base es Supabase, no Render), que no cambia la decisión.
- M4: 1.976 líneas en 28 archivos sin `docs/`; el PR #30 mide 2.945 en 40
  porque llevó también los commits de planificación.
- M5 = 0: el usuario aprobó el merge a la primera.
- M6 = 0 detenciones. Dos incidentes que no detuvieron el hito: un rebase que
  dejó marcas de conflicto en un commit (error de Claude Code, rehecho limpio
  antes de mergear) y la contraseña del rol que pasó por el chat.
- M7, M9: pendientes del usuario.

**T104** (ticket creado 2026-09-24 03:21 UTC, mergeado 14:20 UTC, en vivo ~14:40 UTC).
- M1: 0,49 días (unas 11 horas). Incluye la espera de tu revisión entre el PR y
  el merge; el trabajo en sí fue de unas 4 horas.
- M2 = 2: `C-145` (el id `vitrinee-<slug>`, el slug máximo 31 y el candado del
  cobro, que precisan el alcance de `C-141`) y el hallazgo de que
  `toPaymentTerms` leía el registro fijo, que amplió el cambio a la ruta de pago.
- M4: 1.495 líneas añadidas y 155 quitadas en 40 archivos, con `docs/`.
- M5 = 0: aprobado a la primera.
- M6 = 1, no estaba en el ticket: `toPaymentTerms` con el registro fijo.
- M7, M9: pendientes del usuario.

**T105** (ticket creado 2026-09-24 03:21 UTC, iniciado ~14:50 UTC, PR abierto el mismo día).
- M1: se completa al mergear.
- M2 = 1: `VT-31` (una wallet con varias tiendas, sesión firmada con una llave
  derivada, orden y códigos de las cuatro pruebas, slugs reservados). Precisa
  la forma dentro de `VT-27` a `VT-29`; no cambia el alcance del ticket.
- M4: 1.959 líneas añadidas y 11 quitadas en 20 archivos, sin `docs/`.
- M6 = 0 detenciones. Dos errores que no detuvieron el hito, encontrados en la
  vista previa y corregidos antes del PR (el botón que no se ocultaba y el
  chequeo de `Origin` sin el puerto).
- M1: 0,49 días (merge `71c4f4c` el 2026-09-24 ~15:15 UTC, unas 11,8 horas desde que se creó el ticket a las 03:21 UTC).
- M5 = 0: aprobado a la primera.
- M7 = 4 (dada por el usuario el 2026-09-24, junto con M7 = 4 y M9 = 4 de T103 y T104). M9 de T105, pendiente.
- M8: el usuario confirmó en el chat los 52 minutos de la planificación; en Exponential la entrada sigue `PROPOSED` hasta que corra `exponential time confirm`, que es solo humano.
