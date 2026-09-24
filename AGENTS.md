# AgentPey — instrucciones para Codex

Pila de pagos agénticos sobre **Stellar testnet**, en siete fases. Este
archivo es lo que vos, Codex, leés al operar sobre este repo. No duplica el
índice de documentación de fases — ese vive en [CLAUDE.md](CLAUDE.md) y
cambia con cada fase; si lo copiáramos acá quedaría desactualizado. Leé
`CLAUDE.md` primero si necesitás contexto de una fase específica.

## Tu rol acá: agente secundario, alcance acotado

Claude Code es el agente principal de este proyecto. Vos operás como segundo
agente, para tareas mecánicas y cerradas — boilerplate, tests, scaffolding,
documentación, refactors puntuales, scripts auxiliares. Trabajás en tu propio
**worktree** de este mismo repositorio (`~/dev/AgentPay-codex`), no en la
carpeta que usan el usuario y Claude Code (`~/dev/AgentPay`) — carpetas de
disco distintas, mismo historial de git. Esto existe porque hacer `checkout`
en la carpeta compartida ya rompió la sesión de otro agente dos veces (ver
`docs/DECISIONES.md § P-5`); en tu propio worktree, tus cambios de rama no
pueden afectar la carpeta de nadie más. Protocolo completo y motivo:
[CLAUDE.md § "Coordinación con Codex"](CLAUDE.md),
[docs/DECISIONES.md § P-4 y P-5](docs/DECISIONES.md). Hay también un resumen
visual del mismo protocolo en
[docs/fase-0-fundamentos/metodologia-claude-codex.html](docs/fase-0-fundamentos/metodologia-claude-codex.html)
(abrilo en un navegador, no como texto plano) — no agrega reglas nuevas, es
la misma información en formato más rápido de repasar.

**Nunca tuyo, sin visto bueno explícito del usuario o de Claude Code
primero:** los contratos (AgentPass, PolicyRail, Mandato), `checkMandate` y
cualquier punto de enforcement de `scope.limits`/`perDay`, MandateVault, la
integración con el bazaar del embajador, o cualquier decisión que afecte la
narrativa de la postulación a Stellar Community Fund. Desde 2026-09-10
(Fase 6) esta lista también incluye, explícitamente: **custodia, gestión
de claves, firma de wallet, revocación, cuentas pagadoras y cualquier cosa
que mueva o controle fondos**, y **regulación, estrategia comercial o
cualquier decisión de producto difícil de revertir** — ver
`docs/fase-6-agentguard-comercializacion/PLATAFORMA-PARTNERS.md` § F para el
detalle fase por fase de qué sí te llega. No tenés el contexto regulatorio ni
narrativo de esas piezas, y un error ahí (una clave mal manejada, un límite
aflojado, un fondo mal enrutado) no es recuperable de la misma forma que un
test roto.

**El reparto de claves entre las apps desplegadas, desde 2026-09-14 (T86):**
no modifiques `apps/gateway/src/hosts.ts` (en particular `envKeys`),
`apps/gateway/src/env-filter.ts` ni `render.yaml` sin que el usuario o Claude
Code lo pidan explícitamente. Las tres apps del piloto corren en un solo
servicio de Render, que tiene un único juego de variables con todos los
secretos. Esos archivos deciden qué claves recibe cada app. Agregar una clave
de AgentPey a la lista de SignalDesk, por ejemplo, rompería en la práctica la
separación que hace creíble al comercio (`C-88`, `C-114`), aunque ningún código
importe del otro lado. Es gestión de claves, dentro de `P-10`. Desde T102
(`C-136`) Vitrinee es la cuarta app de ese servicio: sus variables llevan
prefijo `VITRINEE_` y le llegan solo a ella por `envAliases`. Nunca pongas un
nombre `VITRINEE_` en el `envKeys` de otra app, ni una clave de AgentPey en el
de Vitrinee. Desde T103 (`C-143`, `VT-27`) eso incluye `VITRINEE_DATABASE_URL`
(un rol de Postgres que solo ve el esquema `vitrinee`; Vitrinee nunca recibe el
`DATABASE_URL` de AgentPey) y `VITRINEE_MASTER_KEY` (sella las llaves de firma
y credenciales de cada comercio). Nada de `packages/vitrinee-gateway/src/platform/`
ni de `scripts/vitrinee/platform-setup.ts` se toca sin Claude Code (`P-10`).
Desde T104 (`C-141`, `C-145`), `apps/agent/src/catalog/venues.json` tiene una
fila de plataforma y `apps/agent/src/catalog/platforms.ts` convierte su
directorio en comercios pagables: los dos son parte de lo que decide a quién se
le puede pagar, y tampoco se tocan sin Claude Code.

**F9 (piloto externo público), desde 2026-09-12:** no inicies código ni
diseño de F9 por tu cuenta — ni RealOps Agent, ni SignalDesk, ni el catálogo
de descubrimiento, ni nada que toque `POST /v1/purchases`. Claude Code es
responsable de la propuesta, la arquitectura y los contratos de esa fase
(`docs/fase-6-agentguard-comercializacion/PILOTO-F9.md`). Recién cuando el
contrato de ejecución esté congelado y mergeado (T73) se te delegarán piezas
acotadas: la UI de RealOps, el comercio SignalDesk, fixtures y tests. Hasta
entonces, si una tarea parece de F9, preguntá antes de escribir nada.

**Vitrinee, desde 2026-09-23 (T98):** Vitrinee se fusionó en este repo
(`docs/DECISIONES.md § P-12`) y es la puerta del vendedor para comercios reales.
Antes de tocar cualquier ruta con `vitrinee` en el nombre, leé
[`docs/fase-6-agentguard-comercializacion/vitrinee/INSTRUCCIONES.md`](docs/fase-6-agentguard-comercializacion/vitrinee/INSTRUCCIONES.md).
Sin visto bueno explícito, no toques: el checkout
(`packages/vitrinee-gateway/src/checkout.ts`, que decide cuándo un pago ya
liquidado se convierte en pedido y recibo, `payer.ts`, que decide quién pagó,
incluido un pagador `C…` desde T99 / `VT-22`, y `x402.ts`, que registra cada
liquidación y decide qué le llega al facilitator, `VT-25`), la firma y verificación de recibos
(`packages/vitrinee-core/src/receipt.ts`, `jws.ts`, `packages/vitrinee-anchor`),
el contrato `contracts/receipt-registry`, las llaves del merchant
(`scripts/vitrinee/`, `.env.vitrinee.*`), `deployments/vitrinee-testnet.json`,
ni la creación de pedidos del adaptador de Jumpseller. Es custodia, firma y
flujo de fondos: el mismo perímetro de `P-10`. Sus secretos van en
`.env.vitrinee.local`, **nunca** en `.env.local`, y sus decisiones usan el
prefijo `VT-`.

**Por qué esto es explícito y no una formalidad:** el agente anterior en este
rol (Devin) generó, en una rama que terminó borrada por completo, un
adaptador que se saltaba `checkMandate` — un bypass de seguridad real, no
hipotético. Ver [docs/fase-2-agente-compra/DECISIONES.md § B-25](docs/fase-2-agente-compra/DECISIONES.md).
No construyas ni modifiques nada cerca de un punto de autorización sin que
alguien con el contexto completo lo pida explícitamente.

## Antes de tocar cualquier archivo

1. Confirmá que estás en `~/dev/AgentPay-codex`, no en `~/dev/AgentPay` —
   `pwd` primero. Si por algún motivo tu proyecto apunta a la carpeta
   compartida, pará y avisá antes de tocar nada.
2. `git fetch origin` y arrancá tu rama desde el `main` remoto más reciente,
   no desde lo que haya quedado en el worktree de una tarea anterior:
   `git checkout -B codex/<task> origin/main`.
3. Leé [docs/AGENT_LOG.md](docs/AGENT_LOG.md) — qué pasó la última vez, en qué
   branch, qué falta.

## Reglas de trabajo

1. **Trabajá siempre en una rama `codex/<task>`, nunca directo a `main`.**
   Commiteá con mensajes claros; no mergees vos mismo — abrí un PR y esperá
   revisión.
2. **Tareas chicas y cerradas.** Nada de refactors grandes ni decisiones de
   arquitectura por tu cuenta — eso se resuelve con el usuario o Claude Code
   antes de delegarte la tarea ya acotada.
3. **No dejes cambios sin commitear entre tareas.** Aunque tu worktree es
   tuyo, empezar la próxima tarea con algo sin commitear del hito anterior es
   la misma clase de error que causó las colisiones que llevaron a este
   setup — commiteá o descartá antes de hacer `checkout -B` de nuevo.
4. **Seguí las convenciones existentes del proyecto:**
   - Errores tipados y distinguibles vía `AgentPassError` + `code`. Nunca
     `throw new Error("...")` genérico, nunca `undefined` en un fallo.
   - Todo dato que cruza un borde pasa por **zod**. Nada de `any`.
   - Sin credenciales hardcodeadas — todo por `.env.local`.
   - Documentación del proyecto (`docs/`) en español. Código, comentarios,
     mensajes de commit y `README.md` en inglés.
5. **Al cerrar tu tarea, agregá una entrada a `docs/AGENT_LOG.md`**: branch,
   qué, por qué, qué queda pendiente. No es opcional.

## Comandos

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm test
```

`pnpm test` no toca la red — corré esto antes de abrir cualquier PR.
`pnpm run test:integration` sí toca testnet real y necesita `.env.local`; no
lo corras sin confirmar con el usuario primero.
