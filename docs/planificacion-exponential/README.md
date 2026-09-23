# Planificación con Exponential

> Cómo se planifica AgentPey desde el 2026-09-23: Exponential
> ([exponential.im](https://www.exponential.im)) como tablero visual, el repo
> como registro, y los dos sincronizados a mano en cada sesión.
> Decisión de fondo: [`docs/DECISIONES.md` § P-13](../DECISIONES.md).
> Manda [`CLAUDE.md`](../../CLAUDE.md) sobre cualquier skill de Exponential.

| | |
|---|---|
| [SYNC.md](SYNC.md) | La tabla de correspondencia: número T, ticket en Exponential, método, estado, fechas, enlaces |
| [COMPARACION.md](COMPARACION.md) | El experimento: hipótesis, métricas, registro por ticket, conclusión |

## Qué es cada cosa en Exponential

La jerarquía de Exponential es `workspace → producto → feature → ticket →
acción`. Las metas (objetivos con key results) y los proyectos van aparte y se
enlazan.

| En Exponential | En AgentPey |
|---|---|
| Producto `agentpey` | El repo entero. Aquí viven los tickets |
| Ticket `T<n> · …` | Un hito T. Uno por hito, con el número T en el título y la rama `cc/t<n>-<slug>` ya seteada |
| Ticket sin número T | Deuda anotada o trabajo sin hito todavía. Estado `BACKLOG` |
| Feature | Un grupo de hitos con un resultado demostrable (hoy: el video del 29). Los PRD de `/to-prd` también se publican como Feature |
| Acción | Una tarea del usuario (cargar un secreto, fondear una cuenta, grabar un video) o la fecha objetivo de un hito, enlazada a su ticket |
| Meta y key results | Lo que se quiere lograr en un período, medido en números. Los KR se enlazan a Features |
| Proyecto `AgentPey` | El contenedor de acciones y metas. Se creó en la web: el CLI no crea proyectos |
| Producto `vitrinee` | Histórico. Sus tickets del repo viejo están `ARCHIVED` desde el 2026-09-23, superados por `P-12` |

Los tickets **no tienen fecha** en Exponential. La fecha de un hito vive en la
acción enlazada a su ticket (`dueDate`), que es lo que aparece en la vista de
hoy del usuario.

## Quién es la fuente de verdad de qué

| Campo | Manda | Cómo llega al otro lado |
|---|---|---|
| Prioridad, orden, fechas límite | **Exponential** (lo que el usuario mueve en la web) | Claude Code lo lee al abrir la sesión y lo refleja en SYNC.md |
| Estado de una acción del usuario | **Exponential** | Se copia a SYNC.md si la acción está en la tabla |
| Estado de un ticket (`IN_PROGRESS`, `QA`, `DONE`) | Lo escribe **Claude Code** al cambiar de fase del hito | El merge a `main` es lo que confirma `DONE` |
| Alcance, decisiones, qué se hizo, evidencia | **Repo** (`DECISIONES.md`, `BITACORA.md`, `evidencia/`) | El cuerpo del ticket enlaza a la decisión; si difieren, manda el repo |
| Número T, rama, URL del PR | **Repo** | Se copian al ticket (`--branch`, `--pr`) |
| PRD | **Repo**, en `docs/fase-<n>-…/prd/T<n>-<slug>.md`, en español | La copia en Exponential (Feature + historias) es derivada |

Regla de conflicto: si al abrir una sesión Exponential y el repo dicen cosas
distintas sobre alcance o decisiones, Claude Code lo muestra y **el usuario
decide**. Ninguna herramienta sobreescribe a la otra sola.

## El ritual

**Al abrir cada sesión**, además de lo que ya exige `CLAUDE.md` (`git status`,
`git log`, `AGENT_LOG.md`):

```bash
exponential tickets list --workspace personal-cmud6knil0045l704wuoc5b1r --product agentpey --json
```

```bash
exponential actions list --json
```

Comparar contra [SYNC.md](SYNC.md). Lo que cambió en la web (prioridad, fecha,
estado de una acción, tickets nuevos que el usuario creó) se refleja en SYNC.md
y se anota en el bloque "Última sincronización". Lo que toca alcance o
decisiones se muestra al usuario antes de tocar nada.

**Al cerrar cada sesión o hito:**

1. Estado del ticket en Exponential (`tickets update --id <cuid> --status …`,
   `--pr <url>` si hay PR).
2. Misma fila en SYNC.md: estado, fechas, enlaces.
3. Entrada en `docs/AGENT_LOG.md` con una línea "Exponential: qué cambié".

## Cómo se usan las skills, adaptadas a `CLAUDE.md`

| Skill | Uso en AgentPey |
|---|---|
| `/grill-with-docs` | Antes de cualquier hito `EXPONENTIAL`. Una pregunta a la vez, en español. Actualiza CONTEXTO y DECISIONES de la fase mientras se decide |
| `/to-prd` | Escribe el PRD **primero en el repo**, en `docs/fase-<n>-…/prd/T<n>-<slug>.md`, en español. Después lo publica como Feature con historias nativas. No pide vocabulario de triage: aquí no hay |
| `/to-expo` | Cada ticket nace con `T<n> ·` en el título y `--branch cc/t<n>-<slug>` (`P-2`). Los HITL van en `NEEDS_REFINEMENT`. El flag de comentarios es `-m`, no `-b` como dice la skill |
| `/start-ticket` | Sin cambios. Respeta la rama seteada, pasa el ticket a `IN_PROGRESS`, escribe `.exponential/current-ticket` (ignorado por git). Se anota la fecha de inicio en SYNC.md porque Exponential no la guarda |
| `/ship-ticket` | Solo abre el PR y pasa el ticket a `QA`. **Antes** se deja el árbol limpio a mano con commits que explican el porqué, así su `git add -A` no arrastra nada. **No mergea**: el merge a `main` sigue siendo fast-forward manual después del OK del usuario (regla 1), y `DONE` lo escribe Claude Code. Sin `/setup-merge-hook` |

Codex no toca Exponential. Su protocolo sigue por git y `AGENT_LOG.md`
(`P-4`, `P-5`).

## Limitaciones del CLI encontradas (v1.18.1, 2026-09-23)

- No crea proyectos (`projects create` no existe). El proyecto se crea en la web.
- `epics create` falla con `productId: Required`: el servidor pide un producto
  que el CLI no manda. Se usan Features para agrupar en su lugar.
- `tickets comment add` usa `-m`, no `-b`.
- Los tickets no tienen fecha límite ni fecha de inicio.
- El workspace no tiene default configurado: hay que pasar `--workspace` en
  cada comando de tickets, features y metas.

## Script de sincronización

Pendiente a propósito. Después de tres o cuatro sesiones con el ritual manual,
si vale la pena, `scripts/exponential/sync.ts` leerá SYNC.md, correrá el CLI y
reportará diferencias (filas nuevas, estados distintos, fechas distintas,
tickets desaparecidos) **sin escribir nada**. Se decide con lo que el ritual
manual muestre que se desincroniza de verdad.
