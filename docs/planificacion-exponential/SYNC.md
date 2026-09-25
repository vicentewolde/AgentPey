# SYNC · Hitos T ↔ tickets en Exponential

> Una fila por hito. Las fechas son las de Exponential (`createdAt`,
> `completedAt`) salvo la de inicio, que Exponential no guarda y se anota aquí
> al correr `/start-ticket`. Método: `ANTERIOR` (definido en BITACORA/DECISIONES
> antes de adoptar Exponential) o `EXPONENTIAL` (grill → PRD → to-expo).
> Cómo se mantiene: [README.md](README.md). Enlace a un ticket:
> `https://www.exponential.im/tickets/<cuid>`.

Workspace `personal-cmud6knil0045l704wuoc5b1r` · Producto `agentpey`
(`cmuebiyap0001l3045w8q3i5x`) · Feature "Hackathon Find Your Way"
(`cmuebjyws0001l704hg8wwa4f`) · Feature "Plataforma de comercios"
(`cmueyqbph0001jx04mkeobqxa`, PRD en
[`prd/T103-plataforma-comercios.md`](../fase-6-agentguard-comercializacion/prd/T103-plataforma-comercios.md)) · Proyecto `AgentPey` (`cmuebvdko001xl30497cuhc1z`, creado por el usuario en
la web el 2026-09-23): contiene las seis acciones y las dos metas.

## Hitos

| T | Ticket (CUID) | Título | Método | Estado | Creado | Inicio | Cierre | Doc | PR |
|---|---|---|---|---|---|---|---|---|---|
| T100 | `cmuebkyxg0005l704z3bdfdws` | Vitrinee como venue en `venues.json` y `agentKind` en RealOps | ANTERIOR | `DONE` | 2026-09-23 | 2026-09-23 | 2026-09-23 | [C-130](../fase-6-agentguard-comercializacion/DECISIONES.md), [C-134, C-135](../fase-6-agentguard-comercializacion/DECISIONES.md) | [PR](https://github.com/vicentewolde/AgentPey/pull/23) |
| T101 | `cmuebl14w0009l704htgreq46` | Compra real de punta a punta: `POST /v1/purchases` hasta el panel de Jumpseller | ANTERIOR | `IN_PROGRESS` | 2026-09-23 | 2026-09-23 | | [C-130, C-137](../fase-6-agentguard-comercializacion/DECISIONES.md) | [PR](https://github.com/vicentewolde/AgentPey/pull/29) |
| T102 | `cmuebl38n000dl704hy8rw3gc` | Deploy de Vitrinee desde el `render.yaml` de AgentPey, en `vitrinee.agentpey.com` | ANTERIOR | `DONE` | 2026-09-23 | 2026-09-23 | 2026-09-23 | [C-130, C-134, C-136](../fase-6-agentguard-comercializacion/DECISIONES.md), [P-12](../DECISIONES.md) | [PR](https://github.com/vicentewolde/AgentPey/pull/25) |
| T103 | `cmueyt0dq001hjx04npk5vbh3` | Vitrinee atiende a varios comercios, con datos en Postgres | EXPONENTIAL | `DONE` | 2026-09-24 | 2026-09-24 | 2026-09-24 | [C-140, C-142, C-143, C-144](../fase-6-agentguard-comercializacion/DECISIONES.md), [VT-27, VT-30](../fase-6-agentguard-comercializacion/vitrinee/DECISIONES.md) | [PR](https://github.com/vicentewolde/AgentPey/pull/30) |
| T104 | `cmueyt2nf001ljx04jir9o7t2` | AgentPey y RealOps leen el directorio de comercios de Vitrinee | EXPONENTIAL | `DONE` | 2026-09-24 | 2026-09-24 | 2026-09-24 | [C-141, C-145](../fase-6-agentguard-comercializacion/DECISIONES.md) | [PR](https://github.com/vicentewolde/AgentPey/pull/31) |
| T105 | `cmueyt4lz001pjx04piff4zwy` | Un dueño da de alta su tienda en Vitrinee sin código | EXPONENTIAL | `DONE` | 2026-09-24 | 2026-09-24 | 2026-09-24 | [VT-27, VT-28, VT-29, VT-31](../fase-6-agentguard-comercializacion/vitrinee/DECISIONES.md) | [PR](https://github.com/vicentewolde/AgentPey/pull/32) |
| T106 | `cmug33wd50001kz04uvlavu4w` | Demo Day Stellarbarrio: pitch de 5 minutos, demo en vivo y respaldo grabado | EXPONENTIAL | `IN_PROGRESS` | 2026-09-24 | 2026-09-24 | | [C-146](../fase-6-agentguard-comercializacion/DECISIONES.md) | |
| T107 | `cmugh4ji00005l6049a7lvjl9` | RealOps se entiende: nombres, aviso de rechazo, email y grillas ordenadas | EXPONENTIAL | `QA` | 2026-09-25 | 2026-09-25 | | [C-148](../fase-6-agentguard-comercializacion/DECISIONES.md) | |
| T108 | `cmughle0e000pl6042nj1ies5` | Firma y recibo claros: wallet arriba, vuelta al catálogo, recibo legible | EXPONENTIAL | `QA` | 2026-09-25 | 2026-09-25 | | [C-149](../fase-6-agentguard-comercializacion/DECISIONES.md) | |
| T109 | `cmughv6vh0011l604343dn9zh` | Contratar en menos pasos: una pregunta, contratar y firmar, catálogo por agente, búsqueda | EXPONENTIAL | `QA` | 2026-09-25 | 2026-09-25 | | [C-150](../fase-6-agentguard-comercializacion/DECISIONES.md) | |

Dependencias en Exponential, **reordenadas el 2026-09-23** (`C-134`, opción (a)
elegida por el usuario): T102 bloqueado por T100; T101 bloqueado por T100 y
por T102. Archivar el repo viejo salió de T102 a un ticket propio (abajo),
bloqueado por T101. Ramas ya seteadas: `cc/t100-vitrinee-venue`,
`cc/t101-compra-real-jumpseller`, `cc/t102-vitrinee-deploy`.

Plataforma de comercios (Feature `cmueyqbph…`, `C-144`): T104 bloqueado por
T103; T105 bloqueado por T103 y T104. Ramas: `cc/t103-vitrinee-multi-comercio`,
`cc/t104-directorio-comercios`, `cc/t105-alta-comercio`. La planificación
misma vive en `cc/t103-plataforma-comercios` (solo documentación).

## Deuda anotada (sin número T)

| Ticket (CUID) | Título | Estado | Origen |
|---|---|---|---|
| `cmuebl53x000hl704c89ktw57` | Rails de tenant con los límites del Mandato (opción b de `C-133`) | `BACKLOG` | [C-133](../fase-6-agentguard-comercializacion/DECISIONES.md) |
| `cmuedg4ld000pl004tv0q2n5o` | Archivar el repo viejo `vicentewolde/Vitrinee` (la segunda mitad de lo que era T102; CHORE, bloqueado por T101) | `READY_TO_PLAN` | [C-134](../fase-6-agentguard-comercializacion/DECISIONES.md) |
| `cmueyt6kt001tjx04ew39o0up` | App de Jumpseller con OAuth para el alta de comercios (después del 29; bloqueado por T105) | `NEEDS_REFINEMENT` | [VT-28](../fase-6-agentguard-comercializacion/vitrinee/DECISIONES.md) |
| `cmueyt8k8001xjx04s8kkui2b` | Panel completo del comercio en Vitrinee (después del 29; bloqueado por T105) | `BACKLOG` | [C-144](../fase-6-agentguard-comercializacion/DECISIONES.md) |
| `cmueytafx0021jx045qin5t41` | El comercio trae su propia llave de firma (bloqueado por T105) | `BACKLOG` | [VT-27](../fase-6-agentguard-comercializacion/vitrinee/DECISIONES.md) |

## Acciones del usuario y fechas de hitos

| Acción (CUID) | Qué | Fecha | Ticket enlazado |
|---|---|---|---|
| `cmuebnofp0007ie04sf2sg7a3` | Fondear la reserva `GAK6E5E7…GFP2K` desde el faucet de Circle (**completada** 2026-09-23 20:07 UTC) | 2026-09-25 | |
| `cmuebnn3v0005ie04c2a4skbg` | Emitir la partner key y cargar el secreto en Render (`P-10`) (**completada** 2026-09-24) | 2026-09-26 | |
| `cmuebnzs4000bie04zs6bi6sz` | T100 · fecha objetivo | 2026-09-26 | T100 |
| `cmuebo32v000fie04kwurqfre` | T102 · fecha objetivo (era 30 sep; movida el 2026-09-23 por el reorden) | 2026-09-27 | T102 |
| `cmuebo1im000die04z2cpfzdu` | T101 · fecha objetivo (era 27 sep; movida el 2026-09-23 por el reorden) | 2026-09-28 | T101 |
| `cmuebnpem0009ie04s3zm69vv` | Grabar el video del 29 | 2026-09-29 | |
| `cmuedg7ot000vl004mbbiwtbk` | Archivar el repo viejo de Vitrinee | 2026-09-30 | `cmuedg4ld…` (chore) |
| `cmueytyol002hjx04cfdfili5` | Crear el rol de Postgres de Vitrinee; cargar `VITRINEE_DATABASE_URL` y `VITRINEE_MASTER_KEY` en Render | 2026-09-25 | T103 |
| `cmueyu1ka002njx04fln2263j` | Dominio comodín `*.vitrinee.agentpey.com` en Render y tres CNAME en Vercel | 2026-09-25 | T103 |
| `cmueyu4ag002tjx04voxe3jom` | Decidir PR #29 si el rescate del pedido de T101 no funciona | 2026-09-25 | T103 |
| `cmueyu6h3002zjx04gslskp9g` | T103 · fecha objetivo | 2026-09-26 | T103 |
| `cmueyu8l60035jx041ogelaea` | Crear la segunda tienda Jumpseller en prueba gratuita (**completada** 2026-09-24) | 2026-09-26 | T105 |
| `cmueyub38003bjx04igqgkjgo` | T104 · fecha objetivo | 2026-09-27 | T104 |
| `cmueyucwc003hjx042fystisz` | T105 · fecha objetivo (**completada** 2026-09-24) | 2026-09-28 | T105 |
| `cmueyueuv003njx04dsnuo7uf` | Trámite de la app de Jumpseller (portal de partners, publicación, tienda de desarrollo) | 2026-09-30 | App OAuth |
| `cmug344iu0005kz04c47qyor9` | T106 · fecha objetivo (sigue al ticket con `exp:sync`) | 2026-09-25 | T106 |
| `cmug3475y000bkz04j6mh98tr` | Contratar en RealOps el comprador nuevo y firmar su permiso con Freighter | 2026-09-25 | T106 |
| `cmug349ul000hkz04sg32oyyv` | Grabar el video de respaldo de la demo (11:00) | 2026-09-25 | T106 |
| `cmug34c64000nkz04mak51an0` | Ensayar el pitch con cronómetro (3 veces, corte a los 5:00) | 2026-09-25 | T106 |
| `cmug34eos000tkz04wi0c15d2` | Revisar Freighter, testnet y pestañas antes de salir (18:00) | 2026-09-25 | T106 |
| `cmug34gz5000zkz04s5r9bfr6` | Presentar en el Demo Day Stellarbarrio (19:00) | 2026-09-25 | T106 |

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
- **2026-09-24**, Claude Code, sesión de planificación de la plataforma de
  comercios (primera `EXPONENTIAL`). Ritual de apertura: una diferencia, la
  acción de fondear la reserva figuraba `COMPLETED` en la web desde el
  2026-09-23 20:07 UTC y no aquí; reflejada arriba. La meta del video figura
  `off-track` en la web; no se tocó. Creados desde el CLI: Feature
  `cmueyqbph…` con el PRD y 24 historias; T103, T104 y T105 con rama y
  dependencias; tres tickets para después del 29; ocho acciones con fecha;
  una entrada de tiempo `PROPOSED` de 52 minutos (M8) para que el usuario la
  confirme.
- **2026-09-24**, Claude Code, sesión de T103. Ritual de apertura sin
  diferencias. T103 `READY_TO_PLAN` → `IN_PROGRESS` (inicio 2026-09-24) → `QA`
  con el PR #30.
- **2026-09-24**, Claude Code, con OK del usuario: PR #29 y PR #30 mergeados a
  `main` en fast-forward. T101 sigue `IN_PROGRESS` (enlazado a PR #29, falta
  Jumpseller); T103 sigue `QA` hasta verificarlo en vivo, que espera los pasos
  del usuario. Comentarios en los dos tickets.
- **2026-09-24**, Claude Code: T103 verificado en vivo y `DONE`. Acciones del
  usuario completadas: rol y llave maestra, dominio comodín y CNAME, PR #29
  (se mergeó; el pedido se rescató igual).
- **2026-09-24**, Claude Code, sesión de T104. Ritual sin diferencias. T104
  `READY_TO_PLAN` → `IN_PROGRESS` → `QA` con el PR #31.
- **2026-09-24**, Claude Code: T104 verificado en vivo con una compra real y `DONE`.
- **2026-09-24**, Claude Code, sesión de T105. Ritual de apertura sin
  diferencias (acciones activas y tickets iguales a esta tabla). T105
  `READY_TO_PLAN` → `IN_PROGRESS` (inicio 2026-09-24) → `QA` con el PR #32.
- **2026-09-24**, Claude Code: PR #32 mergeado; T105 verificado en vivo con una tienda real (MycoKit) y `DONE`.
- **2026-09-24**, Claude Code, sesión del tablero (`cc/exp-sync-board`): acciones
  completadas movidas a Done y `pnpm run exp:sync` agregado. Sesión de la partner
  key: la acción "Emitir la partner key" `COMPLETED` (reflejada arriba).
- **2026-09-24**, Claude Code, sesión de T106. Ritual de apertura: `exp:sync` sin
  cambios, tickets iguales a esta tabla; la única diferencia era la acción de la
  partner key, ya completada en la web y no aquí (corregida). Creados desde el
  CLI con OK del usuario: ticket T106 (`IN_PROGRESS`, rama `cc/t106-demo-day`,
  Feature "Hackathon Find Your Way") y seis acciones con fecha 2026-09-25.
  `exp:sync` movió "T106 · fecha objetivo" a In Progress.
- **2026-09-25**, Claude Code: hallazgos del usuario al recorrer el flujo,
  convertidos en T107, T108 y T109 (creados `IN_PROGRESS`, rama por hito, sin
  acción con fecha). Mergeados a `main` con OK del usuario (`d496ba9`) y en
  `QA` hasta que el usuario vea en vivo las pantallas de RealOps, que piden sesión.

