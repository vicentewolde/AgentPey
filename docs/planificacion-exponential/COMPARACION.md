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
| T100 | ANTERIOR | | | | | | | | | |
| T101 | ANTERIOR | | | | | | | | | |
| T102 | ANTERIOR | | | | | | | | | |

Notas por ticket (bloqueos, qué cambió, por qué) van debajo, una entrada por
hito, al cerrarlo.

## Conclusión

Pendiente. Se escribe al cerrar el experimento, con los números de arriba y la
decisión (`P-`) que resulte.
