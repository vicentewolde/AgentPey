# Contexto — Fase 6 (AgentGuard + comercialización)

> Plan maestro: [../../ROADMAP.md](../../ROADMAP.md) §4.6 · Decisión de
> arranque: [docs/DECISIONES.md § P-6](../DECISIONES.md) · Bitácora:
> [BITACORA.md](BITACORA.md) · Decisiones de esta fase:
> [DECISIONES.md](DECISIONES.md)

## 1. Qué prueba esta fase (la mitad que arrancó)

Que AgentPey puede dejar de ser una demo de un solo visitante compartiendo
una sola identidad Stellar, y convertirse en algo que un tercero —un
comercio, un equipo de hackathon, un desarrollador de agentes— pueda
integrar de verdad, en Stellar testnet, sin presupuesto de escala.

No prueba que el negocio funcione: prueba que el software puede sostener a
más de un tenant sin comprometer las garantías que las Fases 1–5 ya
construyeron (identidad revocable, mandato firmado, enforcement on-chain,
auditoría encadenada).

## 2. Qué NO es esta fase

- **No es AgentGuard.** El nombre existe en `ROADMAP.md §4.6` desde el
  diseño original, pero su alcance —monitoreo de comportamiento del agente
  en tiempo de ejecución, detección de anomalías, kill-switch— sigue sin
  definir. Nada de esta fase construye eso todavía.
- **No es mainnet ni rieles fiat.** Sigue vigente la restricción de
  `CLAUDE.md` y la ventana de la Ley Fintech 21.521 (meta julio 2027).
- **No es la ejecución de negocio del piloto original** (cohorte de
  alumnos, demo grabable, formulario de Build Award) — eso sigue sin
  prioridad por `P-3`, sin relación con este arranque.
- **No cambia el enforcement de las Fases 1–5.** `checkMandate`,
  `scope.limits`/`perDay`, y los contratos Soroban (`agent_registry`,
  `policy_rail`) no se tocan — todo lo de esta fase es aditivo, namespacing
  y superficie nueva alrededor de lo ya cerrado.

## 3. Por qué arrancó ahora, y qué cambió del plan documentado

`ROADMAP.md §4.6` decía, desde antes de la Fase 2, que esta fase se diseña
"recién después de que las Fases 2–5 den evidencia real sobre la que
apoyarse". Ese momento llegó el 2026-09-09: las cinco fases técnicas están
cerradas (T1–T31) y el mensaje del MVP + landing a Tellus (el criterio de
"listo" de `P-3`) ya se envió. Mientras se espera la revisión de la
Instaward de SCF, el usuario pidió explícitamente seguir construyendo un
producto real en vez de esperar — ver `docs/DECISIONES.md → P-6` para el
detalle completo, incluida la investigación de mercado/competencia/técnica/
financiera que precedió cualquier código.

## 4. Punto de partida técnico (lo que ya existía al arrancar)

- `apps/web` es un servidor `node:http` sin router, con **una sola
  identidad Stellar compartida** por todos los visitantes
  (`AGENT_SECRET_KEY`/`ISSUER_SECRET_KEY` fijos), sesión por cookie con un
  `Map` en memoria, y un vault en disco (`data/mandate-vault-<uuid>.jsonl`)
  que se borra en cada redeploy de Render (filesystem efímero del free
  tier).
- Ningún paquete del monorepo se publica a npm; no hay superficie de API
  HTTP documentada, ni autenticación por API key, ni rate limiting.

## 5. Hacia dónde apunta (hoja de ruta, sin comprometerse a fechas)

Cuatro etapas, detalladas en el plan de trabajo "AgentPey: De Piloto a
Producto" (2026-09-09): (1) multi-tenancy + persistencia real — **en
curso, T32 arranca la mitad de derivación de llaves**; (2) superficie de
API para terceros; (3) publicación de paquetes npm + hardening de
dependencias; (4) boceto de modelo de cobro, sin conectar cobro real
todavía. Ninguna etapa está comprometida a un plazo — se cierra un hito,
se muestra el resultado, y se decide el siguiente con el usuario.

**Desde T37 (2026-09-10), las etapas 1 y 2 tienen un plano detallado.** El
usuario pidió diseñar la plataforma completa antes de construirla:
[PLATAFORMA-PARTNERS.md](PLATAFORMA-PARTNERS.md) lo desarrolla en diez fases
con puertas de aprobación, y `DECISIONES.md` → `C-19` a `C-25` registra las
decisiones que lo gobiernan. Las dos que cambian todo lo demás: un **tenant**
es la relación entre un partner y un usuario final suyo (`C-19`), y el
**modelo de fondos** es un `policy_rail` por tenant, fondeado por el propio
principal, con los límites aplicados por la red (`C-20`). El plano no altera
nada de lo ya construido: sigue en pie que esta fase es aditiva y que
`checkMandate`, `scope.limits`/`perDay` y los contratos Soroban no se
tocan.

**Desde el 2026-09-24, el lado de la oferta tiene plan: Vitrinee como
plataforma de comercios.** RealOps es la demanda: personas que contratan
agentes y les firman permisos. Faltaba el espejo para la oferta: un lugar donde
un comercio se registra, publica su catálogo para agentes y ve lo que le
compraron, sin escribir código. Es Vitrinee, hecha multi-comercio (`C-140`), y
SignalDesk sigue siendo un comercio de ejemplo. Las decisiones que la gobiernan
salieron de un `/grill-with-docs` (`P-13`): llave de firma por comercio,
cifrada (`VT-27`); alta con credenciales pegadas hasta que exista la app de
Jumpseller (`VT-28`); AgentPey confía en la plataforma y lee su directorio
(`C-141`); un subdominio por comercio (`C-142`); datos en Postgres con un rol
propio (`C-143`); el dueño entra con la wallet de su cuenta de cobro (`VT-29`);
y qué entra antes del video del 29 (`C-144`). El PRD vive en
[prd/T103-plataforma-comercios.md](prd/T103-plataforma-comercios.md).

**Lo que un comercio valora de verdad**, y conviene no prometer de más: vender,
y que el pedido le llegue a su panel de Jumpseller. Vitrinee le suma ventas de
agentes, la prueba del pago en la red y un recibo verificable.
