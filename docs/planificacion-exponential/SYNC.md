# SYNC · Hitos T ↔ tickets en Exponential

> Una fila por hito. Las fechas son las de Exponential (`createdAt`,
> `completedAt`) salvo la de inicio, que Exponential no guarda y se anota aquí
> al correr `/start-ticket`. Método: `ANTERIOR` (definido en BITACORA/DECISIONES
> antes de adoptar Exponential) o `EXPONENTIAL` (grill → PRD → to-expo).
> Cómo se mantiene: [README.md](README.md). Enlace a un ticket:
> `https://www.exponential.im/tickets/<cuid>`.

Workspace `personal-cmud6knil0045l704wuoc5b1r` · Producto `agentpey`
(`cmuebiyap0001l3045w8q3i5x`) · Feature "Hackathon Find Your Way"
(`cmuebjyws0001l704hg8wwa4f`) · Proyecto `AgentPey`: **pendiente, lo crea el
usuario en la web**.

## Hitos

| T | Ticket (CUID) | Título | Método | Estado | Creado | Inicio | Cierre | Doc | PR |
|---|---|---|---|---|---|---|---|---|---|
| T100 | `cmuebkyxg0005l704z3bdfdws` | Vitrinee como venue en `venues.json` y `agentKind` en RealOps | ANTERIOR | `READY_TO_PLAN` | 2026-09-23 | | | [C-130](../fase-6-agentguard-comercializacion/DECISIONES.md) | |
| T101 | `cmuebl14w0009l704htgreq46` | Compra real de punta a punta: `POST /v1/purchases` hasta el panel de Jumpseller | ANTERIOR | `READY_TO_PLAN` | 2026-09-23 | | | [C-130](../fase-6-agentguard-comercializacion/DECISIONES.md) | |
| T102 | `cmuebl38n000dl704hy8rw3gc` | Deploy de Vitrinee desde el `render.yaml` de AgentPey y archivo del repo viejo | ANTERIOR | `READY_TO_PLAN` | 2026-09-23 | | | [C-130](../fase-6-agentguard-comercializacion/DECISIONES.md), [P-12](../DECISIONES.md) | |

Dependencias en Exponential: T101 bloqueado por T100; T102 bloqueado por T101.
Ramas ya seteadas: `cc/t100-vitrinee-venue`, `cc/t101-compra-real-jumpseller`,
`cc/t102-vitrinee-deploy`.

## Deuda anotada (sin número T)

| Ticket (CUID) | Título | Estado | Origen |
|---|---|---|---|
| `cmuebl53x000hl704c89ktw57` | Rails de tenant con los límites del Mandato (opción b de `C-133`) | `BACKLOG` | [C-133](../fase-6-agentguard-comercializacion/DECISIONES.md) |

## Acciones del usuario y fechas de hitos

| Acción (CUID) | Qué | Fecha | Ticket enlazado |
|---|---|---|---|
| `cmuebnofp0007ie04sf2sg7a3` | Fondear la reserva `GAK6E5E7…GFP2K` desde el faucet de Circle | 2026-09-25 | |
| `cmuebnn3v0005ie04c2a4skbg` | Emitir la partner key y cargar el secreto en Render (`P-10`) | 2026-09-26 | |
| `cmuebnzs4000bie04zs6bi6sz` | T100 · fecha objetivo | 2026-09-26 | T100 |
| `cmuebo1im000die04z2cpfzdu` | T101 · fecha objetivo | 2026-09-27 | T101 |
| `cmuebnpem0009ie04s3zm69vv` | Grabar el video del 29 | 2026-09-29 | |
| `cmuebo32v000fie04kwurqfre` | T102 · fecha objetivo | 2026-09-30 | T102 |

## Metas

| Id | Meta | Período | Estado | Key results |
|---|---|---|---|---|
| 96 | Video demo SCF: 29 de septiembre | Q3-2026 | `active` | "Hitos T100, T101 y T102 en DONE" (0/3, enlazado al Feature) · "Video grabado y entregado" (0/1) |
| 97 | Primer partner piloto real en testnet | Q4-2026 | `planned` | "Partners externos con tenant y compra real en testnet" (0/1) |

## Fuera del experimento

Producto `vitrinee` (`cmudavioj006ekz04z3uogakq`): nueve tickets del repo viejo,
`ARCHIVED` el 2026-09-23 con un comentario que apunta a `P-12` y a T100–T102.
Su Feature "Vitrinee para el developer con un agente" se conserva como registro
del PRD original.

## Última sincronización

- **2026-09-23**, Claude Code, sesión de adopción (`P-13`). Se creó todo lo de
  arriba desde el CLI. Pendiente: enlazar acciones y metas al proyecto
  `AgentPey` cuando el usuario lo cree en la web.
