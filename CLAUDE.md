# AgentPey — instrucciones de trabajo

Pila de pagos agénticos sobre **Stellar testnet**, en siete fases. La Fase 1
(**AgentPass**) está cerrada: un agente prueba criptográficamente quién lo opera
y qué puede hacer, y esa autorización se puede cortar desde fuera del agente —
imposible de saltar por prompt injection.

## Lee esto antes de tocar nada

| | |
|---|---|
| [ROADMAP.md](ROADMAP.md) | **Empieza aquí.** Las siete fases, en cuál estamos, qué sigue |
| [docs/DECISIONES.md](docs/DECISIONES.md) | Decisiones que cruzan fases o afectan la estructura del proyecto (prefijo `P-`) |
| [docs/fase-1-agentpass/CONTEXTO.md](docs/fase-1-agentpass/CONTEXTO.md) | Qué es el proyecto, la tesis, qué **no** es, fuera de alcance |
| [docs/fase-1-agentpass/ARQUITECTURA.md](docs/fase-1-agentpass/ARQUITECTURA.md) | Mapa técnico denso y autocontenido — para dar contexto a un chat nuevo sin que lea el código |
| [docs/fase-1-agentpass/BITACORA.md](docs/fase-1-agentpass/BITACORA.md) | Estado actual, qué hito sigue, qué se hizo en cada uno |
| [docs/fase-1-agentpass/DECISIONES.md](docs/fase-1-agentpass/DECISIONES.md) | Toda decisión importante, con su motivo y lo que se descartó |
| [docs/fase-2-agente-compra/ARQUITECTURA.md](docs/fase-2-agente-compra/ARQUITECTURA.md) | Mapa técnico de la Fase 2: catálogo, herramientas, verificación de credencial, scope, forma del `PurchaseIntent` |
| [docs/fase-2-agente-compra/BITACORA.md](docs/fase-2-agente-compra/BITACORA.md) | **Cerrada, T9–T15.** Estado actual y qué se hizo en cada hito |
| [docs/fase-2-agente-compra/DECISIONES.md](docs/fase-2-agente-compra/DECISIONES.md) | Decisiones de la Fase 2 (prefijo `B-`) |
| [docs/fase-3-policyrail-mandato/CONTEXTO.md](docs/fase-3-policyrail-mandato/CONTEXTO.md) | **Cerrada.** Qué prueba, qué no es, el bloqueante externo y qué se decidió hacer con él |
| [docs/fase-3-policyrail-mandato/ARQUITECTURA.md](docs/fase-3-policyrail-mandato/ARQUITECTURA.md) | Mapa técnico de la Fase 3: los tres documentos firmados, la forma del Mandato, dónde vive el enforcement |
| [docs/fase-3-policyrail-mandato/BITACORA.md](docs/fase-3-policyrail-mandato/BITACORA.md) | **Cerrada, T16–T23.** Estado actual y qué sigue |
| [docs/fase-3-policyrail-mandato/DECISIONES.md](docs/fase-3-policyrail-mandato/DECISIONES.md) | Decisiones de la Fase 3 (prefijo `M-`). `M-1` quedó **superada** en T19; `M-11` y `M-12` la reemplazan |
| [docs/fase-4-mandategate/CONTEXTO.md](docs/fase-4-mandategate/CONTEXTO.md) | **Fase en curso.** Qué prueba, qué no es, qué cambió del alcance documentado y por qué |
| [docs/fase-4-mandategate/ARQUITECTURA.md](docs/fase-4-mandategate/ARQUITECTURA.md) | Mapa técnico de la Fase 4: el módulo de pago x402, identidades resueltas contra tráfico real |
| [docs/fase-4-mandategate/BITACORA.md](docs/fase-4-mandategate/BITACORA.md) | **T24–T26 cerrados.** Estado actual y qué sigue |
| [docs/fase-4-mandategate/DECISIONES.md](docs/fase-4-mandategate/DECISIONES.md) | Decisiones de la Fase 4 (prefijo `G-`) |
| [docs/fase-5-mandatevault/CONTEXTO.md](docs/fase-5-mandatevault/CONTEXTO.md) | **Cerrada.** Qué prueba, qué no es, qué cambió del alcance documentado y por qué |
| [docs/fase-5-mandatevault/ARQUITECTURA.md](docs/fase-5-mandatevault/ARQUITECTURA.md) | Mapa técnico de la Fase 5: el paquete `@agentpey/vault`, la cadena de hashes, el seam de `policyRail?` |
| [docs/fase-5-mandatevault/BITACORA.md](docs/fase-5-mandatevault/BITACORA.md) | **Cerrada, T27–T31.** Estado actual y qué se hizo en cada hito |
| [docs/fase-5-mandatevault/DECISIONES.md](docs/fase-5-mandatevault/DECISIONES.md) | Decisiones de la Fase 5 (prefijo `V-`) |
| [docs/fase-6-agentguard-comercializacion/CONTEXTO.md](docs/fase-6-agentguard-comercializacion/CONTEXTO.md) | **Fase en curso, iniciada 2026-09-09.** Qué prueba la mitad de "comercialización", qué sigue sin alcance (AgentGuard) y por qué |
| [docs/fase-6-agentguard-comercializacion/BITACORA.md](docs/fase-6-agentguard-comercializacion/BITACORA.md) | Bitácora hito a hito, empieza en T32 |
| [docs/fase-6-agentguard-comercializacion/PLATAFORMA-PARTNERS.md](docs/fase-6-agentguard-comercializacion/PLATAFORMA-PARTNERS.md) | **El plano de la plataforma para partners** (T37): modelo de entidades, brechas contra el repo real, plan de diez fases con puertas de aprobación |
| [docs/fase-6-agentguard-comercializacion/PILOTO-F9.md](docs/fase-6-agentguard-comercializacion/PILOTO-F9.md) | **Propuesta de F9, el piloto externo público** (T72): arquitectura de RealOps/SignalDesk/AgentPey, la regla "RealOps pide, AgentPey decide", los hitos T73–T83 y las nueve decisiones que esperan al usuario |
| [docs/fase-6-agentguard-comercializacion/DECISIONES.md](docs/fase-6-agentguard-comercializacion/DECISIONES.md) | Decisiones de la Fase 6 (prefijo `C-`) |
| [docs/fase-6-agentguard-comercializacion/vitrinee/INSTRUCCIONES.md](docs/fase-6-agentguard-comercializacion/vitrinee/INSTRUCCIONES.md) | **Vitrinee**, fusionada en T98 (`P-12`): cómo un comercio real se suma a AgentPey sin escribir código. **Léelo antes de tocar cualquier `*vitrinee*`** — tiene reglas propias (secretos, prefijo `VT-`, contrato aparte) |
| [docs/planificacion-exponential/README.md](docs/planificacion-exponential/README.md) | **Cómo se planifica desde el 2026-09-23 (`P-13`):** Exponential como tablero, el repo como registro, el ritual de sincronización y cómo se adaptan las skills `/start-ticket`, `/ship-ticket`, `/to-prd` y `/to-expo`. `SYNC.md` es la tabla hito ↔ ticket |
| [docs/AGENT_LOG.md](docs/AGENT_LOG.md) | **Leer siempre, antes de tocar nada.** Bitácora corta compartida entre Claude Code y Codex: qué se hizo, en qué branch, qué queda pendiente |
| [docs/fase-0-fundamentos/metodologia-claude-codex.html](docs/fase-0-fundamentos/metodologia-claude-codex.html) | Resumen visual del protocolo de coordinación Claude Code ↔ Codex — roles, el ciclo vía git, qué hace el usuario en cada punto. Abrir en el navegador |
| [README.md](README.md) | Cómo correr el proyecto |

`ROADMAP.md` dice en qué fase estamos; dentro de una fase cerrada, su
`BITACORA.md` dice qué se hizo hito a hito.

## Reglas de trabajo

1. **Para al cerrar cada hito y muestra el resultado.** No encadenes hitos sin
   revisión. La numeración es continua entre fases: T1–T8 fue la Fase 1,
   T9–T15 es la Fase 2.
2. **No cambies unilateralmente una decisión de `DECISIONES.md`.** Si al
   implementarla parece equivocada: dilo, muestra la evidencia, propón la
   alternativa y **espera**.
3. **Resume en lenguaje llano.** Al cerrar un hito, primero *qué quedó
   funcionando* en palabras que entienda alguien no técnico; después la
   evidencia técnica. Antes de empezar un hito, 3-4 líneas de qué vas a hacer.
4. **Idioma:** documentación del proyecto (`docs/`) en español. Código,
   comentarios, mensajes de commit y `README.md` en inglés.
5. **No construyas lo que está fuera de alcance.** PolicyRail y Mandato
   —incluido el enforcement de `scope.limits`— entraron en alcance con la Fase
   3 (cerrada). MandateGate (pagos x402 reales), un frontend simple y
   `execute_payment` (la tool de pago del agente) entraron en alcance con la
   Fase 4 (cerrada, T24–T26) — ver `docs/fase-4-mandategate/CONTEXTO.md` §5 y
   `DECISIONES.md` → `G-12`. **MandateVault entró en alcance el 2026-09-04, a
   pedido explícito del usuario** — Fase 5, ver `ROADMAP.md` §4.5. `policy_rail`
   como pagador real en testnet entró en alcance el 2026-09-04 (T31), también a
   pedido explícito del usuario. **Convertir el piloto en un producto
   integrable por terceros (multi-tenancy, superficie de API, publicación de
   paquetes) entró en alcance el 2026-09-09, a pedido explícito del
   usuario** — Fase 6, ver `docs/DECISIONES.md` → `P-6` y
   `docs/fase-6-agentguard-comercializacion/`. **Vitrinee —la puerta del vendedor para comercios reales— y la entrega de AgentPey al hackathon "Find Your Way" entraron en alcance el 2026-09-23, a pedido explícito del usuario** — ver `docs/DECISIONES.md` → `P-12` y `docs/fase-6-agentguard-comercializacion/DECISIONES.md` → `C-130`. Sigue fuera: AgentGuard
   (monitoreo/kill-switch en tiempo de ejecución) sin alcance definido; la
   cohorte de alumnos, comunidad aliada, demo grabable y formulario de Build
   Award, sin prioridad desde `P-3`; cualquier cosa en mainnet o con rieles
   fiat. Si el trabajo actual parece pedir algo de lo que sigue fuera:
   anótalo y déjalo sin construir.

## Coordinación con Codex — protocolo obligatorio, no opcional

Codex (OpenAI, incluido en ChatGPT Plus) trabaja como segundo agente, en
tareas mecánicas y acotadas. Reemplaza a Devin, discontinuado por calidad
insuficiente en su plan free — ver [docs/DECISIONES.md § P-4](docs/DECISIONES.md),
que también deja registrado por qué el protocolo con Codex es más estricto
que el que tuvo Devin: con Devin hubo un bypass de seguridad real en una rama
huérfana (`checkMandate`, ver
[fase-2/DECISIONES.md § B-25](docs/fase-2-agente-compra/DECISIONES.md)) y dos
episodios de colisión de branches por compartir la misma carpeta de disco —
uno con Devin (`docs/AGENT_LOG.md`, 2026-09-03) y otro con Codex
(`docs/AGENT_LOG.md`, 2026-09-07). Por eso Codex opera en su propio
**worktree** (`~/dev/AgentPay-codex`), no en esta carpeta — ver
[docs/DECISIONES.md § P-5](docs/DECISIONES.md). Lo que sigue es el checklist
que **toda sesión de Claude Code corre, siempre**, para que ninguna de las
dos herramientas pise trabajo de la otra ni pierda contexto:

1. **Antes de tocar cualquier archivo:** `git status` y `git log --oneline -10`.
   Codex trabaja en su propio worktree, pero comparte el mismo historial de
   git — nada se asume "al día" solo porque `origin/main` no cambió desde acá.
2. **Leé [docs/AGENT_LOG.md](docs/AGENT_LOG.md) primero.** Dice qué pasó la
   última vez, en qué branch, y qué falta — de cualquiera de los dos agentes.
3. **Todo el trabajo de Claude Code va en una rama `cc/<feature>`, y todo el
   de Codex en `codex/<task>` — nunca directo a `main`.** Al cerrar el hito,
   mergeá a `main` (fast-forward si se puede) y borrá la rama.
4. **Antes de delegarle una tarea a Codex:** no hace falta commitear nada
   propio pendiente por el riesgo de que un `checkout` ajeno lo arrastre —
   worktrees separados ya lo resuelven (`P-5`). Sí conviene pushear cualquier
   cosa que Codex necesite ver en `origin/main` antes de arrancarlo, porque su
   worktree parte de ahí, no de tu carpeta.
5. **Todo PR o diff que venga de Codex se revisa antes de mergear** — diff
   completo y tests corridos, idealmente en un worktree aislado. Nunca se
   mergea a ciegas. Prestá atención particular a cualquier cambio, directo o
   indirecto, a `checkMandate`, al enforcement de `scope.limits`/`perDay`, o a
   cualquier punto de autorización — el precedente de `B-25` es exactamente
   ese tipo de bug.
6. **Contratos (AgentPass, PolicyRail, Mandato), MandateVault, la integración
   con el bazaar del embajador, y cualquier decisión que afecte la narrativa
   de la postulación a SCF se quedan en Claude Code.** Desde 2026-09-10
   (Fase 6 — ver `docs/DECISIONES.md → P-10`) esto se extiende
   explícitamente a **custodia, gestión de claves, firma de wallet,
   revocación, cuentas pagadoras y flujo de fondos**, y a **regulación,
   estrategia comercial y decisiones de producto difíciles de revertir**. No
   se delegan a Codex sin que el usuario o Claude Code den el visto bueno
   explícito primero — Codex no tiene ese contexto regulatorio ni narrativo,
   y esta clase de error no es recuperable de la misma forma que un test
   roto. El desglose fase por fase de qué sí es delegable vive en
   `docs/fase-6-agentguard-comercializacion/PLATAFORMA-PARTNERS.md` § F.
7. **Al cerrar cualquier sesión o hito, agregá una entrada a
   `docs/AGENT_LOG.md`** antes de terminar: branch, qué, por qué, qué queda
   pendiente. Esto no es opcional ni algo para hacer "si da tiempo" — es lo
   que evita que la próxima sesión, sea de Claude Code o de Codex, arranque a
   ciegas.

## Al cerrar cada hito

1. Actualiza **Estado actual** y la tabla de progreso en el `BITACORA.md` de la
   fase en curso, y agrega el bloque del hito en lenguaje llano.
2. Agrega las salidas crudas en `evidencia/T<n>.md` de esa misma fase.
3. Agrega toda decisión nueva al `DECISIONES.md` de la fase en curso, con motivo
   y alternativa descartada. Si la decisión afecta a más de una fase o a la
   estructura del proyecto, va a `docs/DECISIONES.md` con prefijo `P-`.
4. `pnpm run exp:sync`: mueve las tarjetas del tablero de Exponential según el
   estado de los tickets (`docs/planificacion-exponential/README.md`).
5. Commit con mensaje que explique el **porqué**, no solo el qué.

## Criterios transversales (no negociables)

- Errores tipados y distinguibles vía `AgentPassError` + `code`. **Nunca**
  `throw new Error("...")` genérico, nunca devolver `undefined` en un fallo.
- Todo dato que cruza un borde pasa por **zod**. Nada de `any`.
- Sin credenciales hardcodeadas. Todo por `.env.local`; `.env.example` versionado.
- Cada README documenta el **comando exacto**, no una descripción del comando.

## Vitrinee: lo imprescindible

Vitrinee es una funcionalidad de AgentPey desde T98: la forma en que un comercio
real (Jumpseller hoy) se suma sin escribir código. **Manda este archivo**; las
reglas propias de Vitrinee están en
[`docs/fase-6-agentguard-comercializacion/vitrinee/INSTRUCCIONES.md`](docs/fase-6-agentguard-comercializacion/vitrinee/INSTRUCCIONES.md).
Las cinco que más fácil se rompen:

1. **Secretos en `.env.vitrinee.local`, nunca en `.env.local`.** Los dos archivos
   tienen `AGENT_SECRET_KEY` para cuentas distintas.
2. **Decisiones de Vitrinee con prefijo `VT-`**, no `V-`, que es de la Fase 5.
3. **`contracts/receipt-registry` es su propio workspace de Cargo** (soroban-sdk
   28, el resto 27). No se agrega a `contracts/Cargo.toml` ni se redespliega sin
   permiso del usuario.
4. **Dinero en enteros** (`bigint`, unidades atómicas) en todo Vitrinee. Sus
   errores son `VitrineeError`, no `AgentPassError`: unificarlos es una decisión
   que se propone, no se toma.
5. **El deploy vivo de Vitrinee sale todavía del repo viejo**
   `vicentewolde/Vitrinee`. No archivarlo ni borrarlo hasta T102 (`C-130`).

## Comandos

```bash
pnpm install
```

```bash
pnpm run bootstrap
```

```bash
pnpm run deploy:registry
```

```bash
pnpm build
```

```bash
pnpm typecheck
```

```bash
pnpm test
```

```bash
pnpm run test:integration
```

```bash
cd contracts && cargo test
```

Vitrinee, desde la misma raíz:

```bash
pnpm run vitrinee:check
```

```bash
pnpm run vitrinee
```

```bash
pnpm run vitrinee:buy -- "compra un pack de stickers"
```

```bash
pnpm run vitrinee:verify
```

```bash
pnpm run vitrinee:test:contracts
```

`vitrinee:check` es typecheck + lint + tests de Vitrinee, sin red. `pnpm test`
de AgentPey ya incluye los tests de Vitrinee.

`rustup` viene de Homebrew y es keg-only; hace falta
`export PATH="/opt/homebrew/opt/rustup/bin:$PATH"` para que exista `cargo`.

`pnpm test` no toca la red. `test:integration` sí — corre el ciclo completo
contra testnet real y necesita `.env.local` con el contrato desplegado.

El binario del CLI, tras `pnpm build`, se invoca como
`node packages/cli/dist/bin.js <comando>`. El recorrido completo (emitir →
verificar → revocar → verificar falla) está en el README raíz, sección
"Full walkthrough".
