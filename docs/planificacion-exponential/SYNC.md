# SYNC · Hitos T ↔ tickets en Exponential

> Una fila por hito. Las fechas son las de Exponential (`createdAt`,
> `completedAt`) salvo la de inicio, que Exponential no guarda y se anota aquí
> al correr `/start-ticket`. Método: `ANTERIOR` (definido en BITACORA/DECISIONES
> antes de adoptar Exponential) o `EXPONENTIAL` (grill → PRD → to-expo).
> Cómo se mantiene: [README.md](README.md). Enlace a un ticket:
> `https://www.exponential.im/tickets/<cuid>`.

Workspace `personal-cmud6knil0045l704wuoc5b1r` · Producto `agentpey`
(`cmuebiyap0001l3045w8q3i5x`) · Feature "Hackathon Find Your Way"
(`cmuebjyws0001l704hg8wwa4f`) · Proyecto `AgentPey` (`cmuebvdko001xl30497cuhc1z`, creado por el usuario en
la web el 2026-09-23): contiene las seis acciones y las dos metas.

## Hitos

| T | Ticket (CUID) | Título | Método | Estado | Creado | Inicio | Cierre | Doc | PR |
|---|---|---|---|---|---|---|---|---|---|
| T100 | `cmuebkyxg0005l704z3bdfdws` | Vitrinee como venue en `venues.json` y `agentKind` en RealOps | ANTERIOR | `DONE` | 2026-09-23 | 2026-09-23 | 2026-09-23 | [C-130](../fase-6-agentguard-comercializacion/DECISIONES.md), [C-134, C-135](../fase-6-agentguard-comercializacion/DECISIONES.md) | [PR](https://github.com/vicentewolde/AgentPey/pull/23) |
| T101 | `cmuebl14w0009l704htgreq46` | Compra real de punta a punta: `POST /v1/purchases` hasta el panel de Jumpseller | ANTERIOR | `READY_TO_PLAN` | 2026-09-23 | | | [C-130](../fase-6-agentguard-comercializacion/DECISIONES.md) | |
| T102 | `cmuebl38n000dl704hy8rw3gc` | Deploy de Vitrinee desde el `render.yaml` de AgentPey, en `vitrinee.agentpey.com` | ANTERIOR | `READY_TO_PLAN` | 2026-09-23 | | | [C-130, C-134](../fase-6-agentguard-comercializacion/DECISIONES.md), [P-12](../DECISIONES.md) | |

Dependencias en Exponential, **reordenadas el 2026-09-23** (`C-134`, opción (a)
elegida por el usuario): T102 bloqueado por T100; T101 bloqueado por T100 y
por T102. Archivar el repo viejo salió de T102 a un ticket propio (abajo),
bloqueado por T101. Ramas ya seteadas: `cc/t100-vitrinee-venue`,
`cc/t101-compra-real-jumpseller`, `cc/t102-vitrinee-deploy`.

## Deuda anotada (sin número T)

| Ticket (CUID) | Título | Estado | Origen |
|---|---|---|---|
| `cmuebl53x000hl704c89ktw57` | Rails de tenant con los límites del Mandato (opción b de `C-133`) | `BACKLOG` | [C-133](../fase-6-agentguard-comercializacion/DECISIONES.md) |
| `cmuedg4ld000pl004tv0q2n5o` | Archivar el repo viejo `vicentewolde/Vitrinee` (la segunda mitad de lo que era T102; CHORE, bloqueado por T101) | `READY_TO_PLAN` | [C-134](../fase-6-agentguard-comercializacion/DECISIONES.md) |

## Acciones del usuario y fechas de hitos

| Acción (CUID) | Qué | Fecha | Ticket enlazado |
|---|---|---|---|
| `cmuebnofp0007ie04sf2sg7a3` | Fondear la reserva `GAK6E5E7…GFP2K` desde el faucet de Circle | 2026-09-25 | |
| `cmuebnn3v0005ie04c2a4skbg` | Emitir la partner key y cargar el secreto en Render (`P-10`) | 2026-09-26 | |
| `cmuebnzs4000bie04zs6bi6sz` | T100 · fecha objetivo | 2026-09-26 | T100 |
| `cmuebo32v000fie04kwurqfre` | T102 · fecha objetivo (era 30 sep; movida el 2026-09-23 por el reorden) | 2026-09-27 | T102 |
| `cmuebo1im000die04z2cpfzdu` | T101 · fecha objetivo (era 27 sep; movida el 2026-09-23 por el reorden) | 2026-09-28 | T101 |
| `cmuebnpem0009ie04s3zm69vv` | Grabar el video del 29 | 2026-09-29 | |
| `cmuedg7ot000vl004mbbiwtbk` | Archivar el repo viejo de Vitrinee | 2026-09-30 | `cmuedg4ld…` (chore) |

## Metas

| Id | Meta | Período | Estado | Key results |
|---|---|---|---|---|
| 96 | Video demo SCF: 29 de septiembre | Q3-2026 | `active` | "Hitos T100, T101 y T102 en DONE" (0/3, enlazado al Feature) · "Video grabado y entregado" (0/1) |
| 97 | Primer partner piloto real en testnet | Q4-2026 | `planned` | "Partners externos con tenant y compra real en testnet" (0/1) |

## Fuera del experimento

Producto `vitrinee` (`cmudavioj006ekz04z3uogakq`): lo que tenía del repo viejo
(nueve tickets y el Feature "Vitrinee para el developer con un agente") se
**borró** el 2026-09-23 a pedido del usuario; el PRD original sigue en el repo,
en `docs/fase-6-agentguard-comercializacion/vitrinee/PRD.md`. Quedan por borrar
desde la web, porque el CLI no lo hace: el producto vacío y la página
"PRD · Vitrinee para el developer con un agente" (`cmudaxo5l007qkz04ynt5psiz`).

## Última sincronización

- **2026-09-23**, Claude Code, sesión de adopción (`P-13`). Se creó todo lo de
  arriba desde el CLI. Misma sesión, después: el usuario creó el proyecto
  `AgentPey` en la web; metas y acciones quedaron enlazadas a él; se borraron
  los tickets y el Feature viejos de `vitrinee`.
- **2026-09-23**, Claude Code, sesión de T100. Ritual de apertura sin
  diferencias con esta tabla. Cambios hechos desde el CLI, con OK del usuario:
  T102 desbloqueado de T101 y bloqueado por T100, título y cuerpo nuevos;
  T101 bloqueado además por T102; fechas de T102 y T101 al 27 y 28; ticket
  nuevo "Archivar el repo viejo" con acción al 30; T100 a `IN_PROGRESS` y
  después a `QA` con el PR. Motivo: `C-134`.
