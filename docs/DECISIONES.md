# Decisiones del proyecto

> Registro de decisiones que afectan a **más de una fase** o a la estructura del
> proyecto completo. Una entrada por decisión, con su motivo y la alternativa
> que se descartó. **No se borran entradas**: si una decisión se revierte, se
> marca como `Superada` y se agrega la nueva.
>
> **Prefijo `P-`** (proyecto), para que nunca se confundan con las decisiones de
> una fase concreta. Las de la Fase 1 viven aparte, en
> [fase-1-agentpass/DECISIONES.md](fase-1-agentpass/DECISIONES.md), con sus
> prefijos `A-` (brief original) e `I-` (implementación).
>
> Plan maestro: [../ROADMAP.md](../ROADMAP.md)

Estados: `Vigente` · `Superada` · `Pendiente`

---

### P-1 · Monorepo único para las siete fases, AgentPass fusionado con su historia completa · `Vigente`
**Fecha:** 2026-09-02

Todo el proyecto AgentPay vive en un solo repositorio público. AgentPass, que
era un repositorio propio anidado, se fusionó en la raíz **preservando sus diez
commits como ancestros reales** de la historia (`git merge
--allow-unrelated-histories`), no copiando archivos. `packages/`, `contracts/`,
`deployments/`, `examples/` y `scripts/` quedan en la raíz: las fases siguientes
agregan hermanos ahí adentro, no carpetas paralelas.

**Motivo.** Tres razones concretas, no preferencia estética:

1. **Código compartido real.** El módulo de identidad DID/VC-JWT que ya existe
   en `packages/core` es exactamente lo que Mandato va a reutilizar. Con repos
   separados eso sería una dependencia publicada o un submódulo; aquí es un
   import.
2. **Estado compartido.** `deployments/testnet.json` es el único artefacto que
   cruza la frontera TypeScript↔Rust, y va a crecer con los contratos de
   PolicyRail y Mandato. Un solo archivo, un solo repo.
3. **La historia de commits es evidencia.** La postulación a Stellar Community
   Fund se apoya en historial de ejecución verificable. Fragmentado en cinco
   repos, ese historial pierde fuerza: nadie reconstruye la secuencia real de
   trabajo saltando entre repositorios.

**Alternativa descartada:** un repositorio por fase. Habría dado aislamiento
más limpio entre fases y despliegues independientes, pero a costa de las tres
razones de arriba — y ninguna fase es un producto separable, todas son capas de
la misma pila.

**Documentación separada por fase.** Se optó por `docs/fase-N-nombre/` en vez de
extender los mismos cuatro archivos a todo AgentPay. El `ROADMAP.md` original
recomendaba lo contrario (mantener un `DECISIONES.md` histórico único); se
decidió al revés porque un solo `BITACORA.md` cubriendo siete fases se vuelve
ilegible mucho antes de terminar, y porque el corte por fase deja obvio qué
documentación está cerrada y cuál está viva. Las decisiones que cruzan fases
—como esta— tienen este archivo.

**Supersede a `I-13`** (`Repo privado en GitHub`, en el registro de la Fase 1),
que queda desactualizada. Esa entrada no se edita: el registro de una fase
cerrada no se reescribe hacia atrás, se supersede desde aquí.

---

### P-2 · Devin (plan free) como segundo agente sobre la misma carpeta raíz · `Superada`
**Fecha:** 2026-09-02

Se suma Devin Desktop (plan free), apuntando a esta misma carpeta local, para
delegar tareas mecánicas y acotadas — boilerplate, tests, scaffolding,
documentación, refactors puntuales, scripts auxiliares — sin depender solo de
los tokens de Claude Code. Reglas:

1. **Git es la única fuente de verdad**, no la carpeta compartida en vivo.
   Ningún cambio se asume "sincronizado" solo porque comparte disco; se
   confirma con `git status` / `git log` antes de tocar algo que pudo haber
   cambiado del otro lado.
2. **Branches separadas por convención**: `cc/<feature>` para Claude Code,
   `devin/<task>` para Devin. **No es el default de Devin** — por su cuenta
   usa convención de conventional commits (`feature/`, `fix/`, `docs/`, etc.);
   se le indicó explícitamente usar el prefijo `devin/` para que la branch
   diga a simple vista qué agente la generó, que es lo que necesita la regla
   de no tocar la misma branch/archivo en simultáneo. Nunca los dos agentes
   trabajan sobre el mismo archivo o la misma branch en simultáneo.
3. **Todo lo que toca los contratos (AgentPass, PolicyRail, Mandato),
   MandateVault, la integración con el bazaar de Cabs, o cualquier decisión
   que afecte la narrativa de la postulación a SCF, se queda en Claude
   Code.** Devin no tiene el contexto de negocio de SCF ni de la Ley Fintech
   21.521 — el visto bueno de scope y toda decisión de arquitectura los da el
   usuario o Claude Code, nunca Devin solo. Cualquier PR o diff que venga de
   Devin se revisa antes de mergear.
4. **[docs/AGENT_LOG.md](AGENT_LOG.md)** es la bitácora corta compartida:
   qué se hizo, en qué branch, por qué, y qué queda pendiente, para que
   ninguna sesión nueva (de ningún agente) arranque sin contexto.

**Motivo.** El plan free de Devin tiene cupo diario/semanal limitado, así que
las tareas delegadas deben ser chicas y cerradas, no abiertas a mucha
iteración — y no deben tocar ninguna decisión que dependa del contexto
regulatorio o narrativo del proyecto, que Devin no tiene.

**Alternativa descartada:** dejar que ambos agentes trabajen libremente sobre
`main` y resolver conflictos según aparezcan. Se descartó porque el riesgo de
que Devin toque sin saberlo una zona con una decisión de arquitectura
pendiente (p. ej. el enforcement de `scope.limits` en Fase 3) es mayor que el
costo de la disciplina de branches.

### P-3 · La cohorte de alumnos, la demo grabable y el formulario de Build Award quedan sin prioridad; la Instaward se gestiona vía Tellus · `Vigente`
**Fecha:** 2026-09-05

Hasta este punto, `ROADMAP.md §4.5` definía el cierre de negocio de la Fase 5
como tres piezas propias: correr el piloto con una cohorte real de ~60
alumnos y la comunidad aliada, grabar una demo de punta a punta, y enviar el
formulario de interés de Build Award en `communityfund.stellar.org`. El
usuario informó un cambio de contexto: el encargado de Tellus —un referente
de Stellar en Chile— se ofreció a gestionar la Instaward directamente, y a
cambio pidió un mensaje de WhatsApp explicando el proyecto, con un link al
MVP (`apps/web`) y un link a la landing (`apps/web/public/landing.html`, ya
construida para este propósito exacto —
`docs/fase-0-fundamentos/prompt-landing-yc-style.md`).

**Motivo.** El camino a la Instaward ya no depende de que este proyecto arme
su propio expediente de negocio (cohorte + demo + formulario) — depende de
que el MVP y la landing sostengan la conversación que Tellus ya tiene
avanzada. Seguir invirtiendo esfuerzo en la cohorte de alumnos o en grabar
una demo ahora sería trabajo que no mueve la aguja del canal real por el que
se está gestionando el financiamiento.

**Qué cambia en la práctica.**

- La cohorte de alumnos, la demo grabable, y el formulario de interés de
  Build Award salen del camino crítico de la Fase 5 — anotados como
  pendientes para después, sin prioridad, no descartados.
- La definición de "listo" de la Fase 5 pasa a ser: el ciclo técnico
  completo en testnet (ya cerrado, T16–T31), el repo público (ya resuelto),
  el MVP funcionando bien, la landing funcionando bien, y el mensaje de
  WhatsApp a Tellus enviado con los dos links.
- Ningún candidato técnico nuevo se agrega — el trabajo que sigue es
  verificar que lo que ya existe (`apps/web`, `/landing`) funcione
  correctamente, no construir nada nuevo.

**Alternativa descartada:** seguir con el plan original (cohorte + demo +
formulario) en paralelo al canal de Tellus, por si la Instaward no se
concreta. Se descartó por ahora — el usuario prioriza no dispersar esfuerzo
en dos caminos de negocio a la vez; si el canal de Tellus no avanza, el plan
original sigue disponible para retomar (nada de lo hecho hasta acá se
pierde, ver `docs/fase-5-mandatevault/`).

---

### P-4 · Devin discontinuado; Codex (ChatGPT Plus) como segundo agente en su lugar · `Vigente`
**Fecha:** 2026-09-07

**Supersede a `P-2`.** El usuario discontinuó Devin (plan free): la calidad
del trabajo que producía no estaba al nivel de Claude Code para este
proyecto. No se rescata nada de lo que Devin generó — el usuario confirmó
que no había trabajo relevante pendiente de su lado, y en la práctica no
queda ningún artefacto vivo: no hay branches `devin/*` en el repo remoto (se
verificó con `git ls-remote`), y la única rama que llegó a mergearse
(`devin/guards-unit-tests`, PR #1) sigue siendo válida y no se revierte solo
por venir de Devin.

En su lugar, el usuario va a usar **Codex** (el agente de código de OpenAI,
incluido en ChatGPT Plus) con el mismo rol: tareas mecánicas y acotadas sobre
esta misma carpeta local, nunca decisiones de arquitectura ni nada que toque
contratos, MandateVault, la integración con el bazaar del embajador, o la
narrativa de SCF — ver `CLAUDE.md` § "Coordinación con Codex" para el
protocolo completo.

**Motivo, con evidencia — por qué el protocolo con Codex es más estricto que
el que tuvo Devin, no solo un reemplazo de nombre.** La experiencia con Devin
dejó dos incidentes documentados que informan el protocolo nuevo:

1. **Un bypass de seguridad real.** La rama `devin/agent-web-frontend` se
   borró por completo porque el adaptador que generó se saltaba
   `checkMandate` — ver
   [fase-2/DECISIONES.md § B-25](fase-2-agente-compra/DECISIONES.md). Es
   la razón concreta detrás de la regla nueva de prestarle atención particular,
   en toda revisión de un diff de Codex, a cualquier cambio a `checkMandate`,
   al enforcement de `scope.limits`/`perDay`, o a cualquier punto de
   autorización.
2. **Una colisión de branches.** Devin escribió sobre `cc/t20-anchor-mandate`
   — una rama reservada para Claude Code — causando confusión hasta que el
   usuario pausó esa sesión y revirtió el commit (`b6bcee0`); ver
   `docs/AGENT_LOG.md`, entradas de 2026-09-03, y
   [fase-3/BITACORA.md](fase-3-policyrail-mandato/BITACORA.md). Es la razón
   detrás de la regla nueva de parar y confirmar con `git log` quién escribió
   el último commit si el branch activo no coincide con lo esperado.

**Qué cambia en la práctica frente a `P-2`.**

- Prefijo de branch: `codex/<task>` en vez de `devin/<task>`.
- Nueva regla explícita de detección temprana de colisión de branches (punto
  3 del checklist en `CLAUDE.md`), que `P-2` no tenía.
- Nueva regla de atención reforzada, en la revisión de todo PR de Codex, a
  cambios que toquen puntos de autorización — `P-2` solo pedía "revisar antes
  de mergear", sin nombrar qué mirar con más cuidado.
- El resto del protocolo (git como fuente de verdad, `AGENT_LOG.md`
  obligatorio, alcance restringido, commitear antes de que el otro agente
  haga `checkout`) se mantiene igual — no falló, solo cambia de nombre.

**Qué NO cambia — la historia no se reescribe.** Todas las entradas de
`docs/AGENT_LOG.md`, `fase-2-agente-compra/DECISIONES.md` (`B-25`) y
`fase-3-policyrail-mandato/BITACORA.md` que narran el trabajo y los
incidentes con Devin se mantienen intactas, siguiendo la misma regla de este
archivo: no se borran entradas ni se reescribe hacia atrás el registro de
fases cerradas. Son evidencia real de disciplina de ingeniería —el bypass se
detectó y se corrigió— y otros documentos las referencian por fecha; borrarlas
rompería esas referencias sin ganar nada.

**Alternativa descartada:** borrar también el historial de Devin en
`AGENT_LOG.md` y en la documentación de fases cerradas, para que el proyecto
quede "sin rastro". Se descartó porque viola la convención que este mismo
archivo establece en su encabezado, huerfanaría las referencias cruzadas
existentes, y porque el incidente de seguridad detectado es, en sí mismo,
evidencia positiva para la narrativa de SCF — no algo que convenga esconder.

---

### P-5 · Codex trabaja en su propio worktree, no en la carpeta compartida · `Vigente`
**Fecha:** 2026-09-08

`P-2` y `P-4` asumían que el segundo agente opera sobre la misma carpeta
local que Claude Code y el usuario (`~/dev/AgentPay`), con reglas de
disciplina (commitear antes de delegar, parar si el branch activo no
coincide) para evitar que un `checkout` de un agente arrastre el estado de
otro. Esa disciplina falló dos veces en la práctica: primero con Devin
(`docs/AGENT_LOG.md`, 2026-09-03 — un `checkout` de Devin arrastró ediciones
sin commitear de Claude Code a la rama `devin/guards-unit-tests`) y después
con Codex (`docs/AGENT_LOG.md`, 2026-09-07 (6) y sesión siguiente — la
primera tarea de prueba dejó la carpeta compartida parada en
`codex/sdk-config-tests` en vez de `main`). Dos incidentes con la misma causa
raíz —carpeta física compartida— son un patrón, no mala suerte puntual.

**Qué cambia.** Codex pasa a operar en `~/dev/AgentPay-codex`, un **worktree
de git** separado (`git worktree add --detach ~/dev/AgentPay-codex main`):
carpeta de disco distinta, mismo `.git` y el mismo historial de commits. La
configuración del proyecto en Codex/ChatGPT apunta a esa carpeta, no a
`~/dev/AgentPay`. Codex arranca cada tarea con `git fetch origin` y
`git checkout -B codex/<task> origin/main`, así siempre parte del último
`main` pusheado, no de lo que haya quedado en su worktree de la tarea
anterior.

**Motivo.** Un worktree resuelve el problema de raíz en vez de depender de
que alguien recuerde aplicar una regla en el momento exacto: dos carpetas de
disco distintas no pueden pisarse mutuamente el `checkout`, sin importar qué
tan apurada esté la sesión. Es la misma técnica que ya se usaba para revisar
los PRs de Devin y Codex antes de mergear (worktree temporal, borrado al
terminar) — acá se vuelve permanente para el propio trabajo de Codex, no solo
para revisarlo.

**Qué NO cambia.** Git sigue siendo la única fuente de verdad; `AGENT_LOG.md`
sigue siendo obligatorio; todo PR de Codex se sigue revisando antes de
mergear, con la misma atención reforzada a puntos de autorización que dejó
`P-4`. Lo único que se elimina es la coordinación de checkouts en disco,
porque deja de ser necesaria.

**Alternativa descartada:** mantener la carpeta compartida y agregar más
disciplina (por ejemplo, un hook de git que bloquee el `checkout` si hay
cambios ajenos sin commitear). Se descartó porque agrega complejidad
mantenible a cambio de resolver un problema que un worktree elimina por
completo, sin hooks ni pasos adicionales que alguien pueda saltarse.

---

### P-6 · El piloto pasa a construirse como producto real, buscando partners en testnet, mientras se espera la resolución de SCF · `Vigente`
**Fecha:** 2026-09-09

El MVP y la landing (criterio de "listo" de `P-3`) ya se enviaron a Tellus.
Mientras se espera su revisión y la eventual gestión de la Instaward ante el
Stellar Community Fund (ventana estimada: revisión sep-oct 2026, fondos
posibles nov 2026), el usuario pidió explícitamente seguir construyendo
AgentPay como un producto real — no solo una demo para una postulación —
para empezar a conseguir reuniones con clientes o partners que prueben sus
funcionalidades, siempre en Stellar testnet.

**Esto no reabre `P-3` ni contradice ninguna decisión previa.**
`ROADMAP.md §4.6` (Fase 6 — "Después: AgentGuard + comercialización") ya
decía, desde antes de la Fase 2, que esa fase se diseña **recién cuando las
Fases 2-5 den evidencia real sobre la que apoyarse** — ese momento llegó: las
cinco fases técnicas están cerradas (T1-T31) y el mensaje a Tellus ya salió.
Este giro es la ejecución de ese punto del plan, no una decisión nueva sobre
la marcha.

**Investigación previa a cualquier código, con la misma disciplina que el
resto del proyecto.** Antes de tocar nada se corrieron cuatro investigaciones
paralelas con fuentes verificables: panorama competitivo (incluida la
pregunta explícita del usuario sobre si "Meta Muse" —lanzado el 8-sep-2026—
es competencia u oportunidad), mercado y cliente objetivo, requisitos
técnicos de productización, y evaluación financiera/funding. Resultado
consolidado y presentado al usuario como un plan de 60 días (artefacto
`AgentPay: De Piloto a Producto`, 2026-09-09):

- **Meta Muse no es competidor** — es un agente de consumo con aprobación
  humana en cada compra sensible, sin identidad de agente ni mandato ni
  enforcement on-chain. Es señal de demanda de mercado, no una amenaza.
- **El competidor real es `Vellar`**, un proyecto nativo de Stellar con casi
  la misma tesis que PolicyRail ("dale a tu agente un presupuesto, no tus
  llaves"), en la misma cadena, el mismo protocolo (x402) y el mismo estadio
  (testnet) — sin evidencia pública de una bitácora encadenada por hash
  anclada on-chain equivalente a MandateVault. Queda pendiente verificar con
  Tellus si compite por el mismo fondeo del embajador.
- **Segmento de cliente priorizado:** el ecosistema de developers y comercios
  que ya construyen sobre x402 dentro de Stellar (el bazaar del embajador,
  equipos de hackathons como Cards402/clevercon/TollPay) — no el mercado
  masivo de "agentic commerce" ni los frameworks genéricos de agentes, ya
  disputados por competidores financiados muy por encima de lo que un
  fundador solo puede igualar ($5-48M).
- **Hoja de ruta técnica priorizada**, sin tocar `checkMandate` ni el
  enforcement de `scope.limits`/`perDay`: multi-tenancy vía derivación
  determinística de llaves Stellar (SEP-0005/BIP-44) desde un único seed
  maestro, persistencia real del vault (hoy se borra en cada redeploy de
  Render), superficie de API para terceros, y un boceto de billing sin
  construir cobro real todavía. Costo de infraestructura estimado al final:
  ~$7-15 USD/mes.
- **Sin formalizar la SpA todavía** — mantenerla activa costaría ~$25-45
  USD/mes de contabilidad sin que hoy exista una razón legal que lo exija
  (actividad 100% testnet, sin custodia de fondos reales de terceros).

**Qué sigue igual.** Presupuesto techo de $200 USD/mes, todo en Stellar
testnet (nada de mainnet ni rieles fiat), el protocolo de coordinación con
Codex, y el criterio de cerrar cada hito con revisión antes de encadenar el
siguiente.

**Alternativa descartada:** seguir esperando la resolución de SCF antes de
invertir más trabajo, o mantener el alcance de `P-3` (solo MVP + landing)
como definición de "listo" indefinida. Se descartó porque el usuario evaluó
que el tiempo de espera (semanas, no días) es tiempo de construcción
desperdiciado, y porque el propio `ROADMAP.md` ya anticipaba este punto de
partida — no hacerlo ahora sería posponer sin motivo un trabajo que el plan
original siempre calificó como "el siguiente paso natural" una vez cerradas
las Fases 2-5.

---

### P-7 · El repo tiene licencia explícita (Apache-2.0) · `Vigente`
**Fecha:** 2026-09-09

Hasta este punto el repo era público pero no tenía ningún archivo `LICENSE`
ni campo `license` en ningún `package.json`/`Cargo.toml` — legalmente,
"todos los derechos reservados" por defecto, pese a estar visible en
GitHub. Se agregó `LICENSE` (Apache License 2.0) en la raíz, `"license":
"Apache-2.0"` en el `package.json` raíz, y `license = "Apache-2.0"` en los
dos `Cargo.toml` de `contracts/`.

**Motivo.** Se encontró al preparar el contenido de difusión técnica de la
Fase 6 (`P-6`): la táctica de GTM recomendada por la investigación —ofrecer
integrar AgentPay como capa de mandato/auditoría a otros equipos que ya
construyen sobre x402 en Stellar (hackathons, el bazaar del embajador)—
necesita que esos equipos puedan legalmente usar o integrar el código.
"Público en GitHub" no es lo mismo que "con permiso de uso" — sin una
licencia explícita, cualquiera que lo integrara estaría expuesto. Apache-2.0
se eligió por ser la misma licencia que ya usa el bazaar del embajador
(`stellar-bazaar-x402`, ver `docs/fase-2-agente-compra/DECISIONES.md → B-25`)
y buena parte del ecosistema x402/Stellar investigado (`stellar-hd-wallet`,
entre otros) — reduce fricción de compatibilidad de licencias para
cualquiera que quiera combinar ambos.

**Nota sobre el titular del copyright.** El texto de la licencia y el
`README.md` citan "Vicente Wolde" (derivado del `git config user.name` de
este repo) como titular — no se inventó un nombre distinto, pero tampoco se
confirmó con el usuario. Si en el futuro la SpA en trámite (`P-6`) se
constituye con una razón social distinta, esta nota queda como el lugar
donde corregirlo, actualizando `LICENSE` y `README.md` sin necesidad de una
decisión nueva.

**Alternativa descartada:** MIT, la licencia permisiva más común en
proyectos chicos. Se descartó porque Apache-2.0 agrega una concesión de
patentes explícita (relevante para un proyecto que toca pagos e
identidad, superficie con más riesgo de disputas de propiedad intelectual
que una librería genérica) sin ninguna desventaja práctica frente a MIT
para este caso — y por la compatibilidad directa con la licencia que ya
usa el bazaar del embajador.

---

### P-8 · Nombre de marca elegido: TirevPay — todavía sin ejecutar el rename · `Superada por P-9`
**Fecha:** 2026-09-09

El usuario pidió un nombre minimalista de dos sílabas, con `.com`
disponible, para la marca pública del proyecto. Se investigaron 55+
candidatos vía `whois`/RDAP contra el registro real (no adivinado) — la
inmensa mayoría de combinaciones cortas y pronunciables ya están
registradas en `.com` (fenómeno de mercado, no mala suerte con estos
nombres puntuales). El usuario confirmó **TirevPay**, con `tirevpay.com`
verificado como disponible.

**Qué NO se hizo todavía, a propósito.** No se renombró el repo de GitHub,
los paquetes (`@agentpass/*`, `@agentpay/*`), `render.yaml` (nombre del
servicio `agentpay-web`), la landing, el README, ni ningún texto de
`apps/web`. Es un cambio de superficie muy grande (afecta links ya
compartidos con Tellus, el nombre del servicio en Render, y potencialmente
los scopes de npm si algún paquete ya se publicó) que merece su propia
sesión dedicada, no hacerse de pasada mientras se construía otra cosa
(T34, conectar wallet). El nombre interno del proyecto (`AgentPay`,
`@agentpass/*`) sigue siendo el que aparece en todo el código y la
documentación hasta que se decida ejecutar el rename.

**Alternativa descartada:** ninguna — es una decisión de nombre, no de
arquitectura. Se registra acá para que ninguna sesión futura, de
cualquiera de los dos agentes, se confunda si el usuario menciona
"TirevPay" en una conversación mientras el código todavía dice
"AgentPay".

---

### P-9 · El nombre de marca es VynGent · `Vigente` — supersede a `P-8`
**Fecha:** 2026-09-10

El usuario descartó "TirevPay" ("no me convenció") y eligió **VynGent**.
Todo lo que `P-8` dejó explícitamente sin hacer sigue sin hacerse, por las
mismas razones: el repo de GitHub, los paquetes (`@agentpass/*`,
`@agentpay/*`), el nombre del servicio en Render (`agentpay-web`), la
landing y el README siguen diciendo "AgentPay". Ejecutar ese rename es una
tarea propia y deliberada — afecta links ya compartidos con Tellus y el
nombre del servicio desplegado — no algo para hacer de pasada.

**Qué sí se cambió acá, y por qué sólo eso.** "TirevPay" aparecía en
exactamente **un** lugar del código: el mensaje que la wallet firma al
conectarse (`challengeMessage`, `apps/web/src/server.ts`) — texto que el
usuario ve dentro de Freighter al aprobar la firma. Ese string quedó en
"VynGent". Las otras 15 apariciones del nombre viejo están en
documentación **histórica** (`AGENT_LOG.md`, este archivo, las bitácoras y
la evidencia de T34) y no se tocan: este archivo establece en su propio
encabezado que no se reescribe hacia atrás, y esas entradas son el
registro de qué se decidió cuándo.

**Alternativa descartada:** aplicar el rename completo ahora que hay un
nombre definitivo. Se descartó por el mismo motivo que en `P-8` y porque
el usuario eligió `T36` (blindar `apps/web`) como el trabajo siguiente —
el rename compite por la misma superficie (`apps/web`) y conviene hacerlo
después, sobre código que ya tenga tests.

---

### P-10 · El perímetro de "nunca Codex" se amplía: custodia, claves, fondos, regulación y producto irreversible · `Vigente`
**Fecha:** 2026-09-10

`P-4`/`P-5` establecieron el protocolo de Codex como segundo agente; su lista
de áreas restringidas —contratos, `checkMandate`, `scope.limits`/`perDay`,
MandateVault, la integración del bazaar, la narrativa de SCF— se escribió
antes de que existiera un modelo de fondos multi-tenant (`C-20`). El usuario
pidió, al diseñar cómo Codex participa de la Fase 6, una lista explícita de
lo que Claude Code conserva siempre, y esa lista agrega dos categorías que
antes no estaban nombradas:

- **Custodia, gestión de claves, firma de wallet, revocación, cuentas
  pagadoras y flujo de fondos.** Con `C-20` (un `policy_rail` por tenant,
  fondeado por el principal) y `C-21` (identidad on-chain creada de forma
  perezosa), F4 y F6 van a escribir código que decide quién controla una
  clave capaz de mover dinero real de un tercero, aunque sea testnet. Eso no
  estaba cubierto por el texto anterior salvo por inferencia.
- **Regulación, estrategia comercial y decisiones de producto difíciles de
  revertir.** Cubría antes solo "la narrativa de SCF"; la Fase 6 introduce
  decisiones —modelo de negocio, a qué categoría CMF exponerse, cuándo
  considerar mainnet— que no son SCF pero son del mismo tipo: equivocarse no
  se arregla con un revert.

**Motivo, dicho igual que `P-4`/`P-5` ya lo dicen para el resto de esta
lista:** Codex no tiene el contexto regulatorio ni narrativo de estas
piezas, y un error acá —una clave mal manejada, un límite aflojado en el
camino de pago, un fondo enrutado al lugar equivocado— no es recuperable de
la misma forma que un test roto o una rama borrada. El precedente que ya
motivó `P-4` (el bypass de `checkMandate` de Devin, `B-25`) es exactamente
la clase de daño que esta ampliación busca no repetir sobre una superficie
nueva: dinero de un tercero, no solo lógica de autorización.

**Dónde vive el detalle operativo.** Esta decisión solo fija el perímetro.
El desglose fase por fase de qué sí es delegable a Codex, con tickets
concretos, archivos permitidos/prohibidos y criterios de verificación, vive
en `docs/fase-6-agentguard-comercializacion/PLATAFORMA-PARTNERS.md` § F — no
se duplica acá porque es específico de la Fase 6 y va a cambiar fase a fase.

**Archivos actualizados en el mismo movimiento:** `AGENTS.md` (la lista
"Nunca tuyo" que Codex lee directamente) y `CLAUDE.md` § "Coordinación con
Codex", punto 6 — el memo interno de este proyecto ya señalaba que un cambio
de `DECISIONES.md` que toque el perímetro de Codex debe reflejarse también
en `AGENTS.md`, no solo documentarse acá.

**Alternativa descartada:** dejarlo implícito, confiando en que "cualquier
punto de autorización" ya cubría custodia y fondos por extensión. Se
descartó porque `AGENTS.md` es lo que Codex lee al arrancar, y una regla que
solo existe por inferencia en un documento que Codex no necesariamente abre
(`docs/DECISIONES.md`) no protege nada — la Fase 2 ya probó, con `B-25`, que
la ambigüedad en este perímetro específico tiene consecuencias reales.

---

### P-11 · El nombre de marca definitivo es AgentPey · `Vigente` — supersede a `P-9`
**Fecha:** 2026-09-11

El usuario probó varias identidades visuales candidatas vía Codex
(VynGent, AgenGent, AienGent, AgentPey — cada una en su propia rama,
`codex/<nombre>-brand-assets`) y decidió: **AgentPey**, pronunciado
"Agent Pay". Supersede a `P-9` (VynGent) igual que `P-9` superó a `P-8`
(TirevPay) — se registra la cadena completa para que ninguna sesión
futura se confunda si aparece alguno de los nombres descartados en
documentación histórica.

**Qué se hizo en este mismo movimiento.** Se revisó y mergeó el kit de
identidad visual de AgentPey que Codex ya había preparado (PR #12:
monograma `AP`, lockup horizontal, variantes claro/oscuro, favicons,
`apps/web/public/brand/agentpey/`) — mismo protocolo de revisión que
cualquier PR de Codex (diff completo, build/typecheck/test limpios). Se
cerraron sin mergear los tres kits de los nombres descartados (PRs #3,
#9, #10) y se borraron sus ramas remotas, para que no quede ambigüedad
sobre cuál identidad es la vigente.

**Qué NO se hizo todavía, a propósito — mismo motivo que `P-8`/`P-9`.**
El rename real (repo de GitHub, paquetes `@agentpass/*`/`@agentpay/*`,
el nombre del servicio en Render, la landing, el README, y el string que
la wallet firma en `challengeMessage`) sigue sin ejecutarse. Es una
superficie grande y con consecuencias hacia afuera —links ya compartidos
con Tellus, el nombre del servicio desplegado, y potencialmente scopes de
npm si algún paquete llegó a publicarse— que sigue mereciendo su propia
sesión dedicada, con el usuario, no algo para Codex ni para hacer de
pasada. El código y la documentación de trabajo siguen diciendo
"AgentPay" hasta que esa sesión ocurra.

**Alternativa descartada:** ejecutar el rename completo ahora que hay
nombre e identidad visual definitivos. Descartada por el mismo motivo que
`P-8`/`P-9` — el blast radius (repo, paquetes publicados, servicio
desplegado) amerita una sesión propia con el usuario presente, no
encadenarla a la revisión de un kit de marca.

---

### P-12 · Vitrinee se fusiona en AgentPey con su historia completa, como funcionalidad de AgentPey · `Vigente`
**Fecha:** 2026-09-23 · **Hito:** T98 · Decidido por el usuario; la forma, de Claude Code

**Qué pasó.** Vitrinee se construyó como repo propio
(`github.com/vicentewolde/Vitrinee`, 22–23 de septiembre) porque el brief del
hackathon "Find Your Way" (Tellus, Stellar) pedía un repo nuevo, creado después
del 14 de septiembre. La organización confirmó después que un proyecto existente
califica. El usuario decidió que **la entrega es AgentPey**, y que Vitrinee pasa
a ser una funcionalidad suya: **la forma en que un comercio real se suma a
AgentPey sin escribir código**. Regla explícita del usuario: **manda AgentPey**.

**Cómo se fusionó: igual que AgentPass en `P-1`.** Los 20 commits de Vitrinee
son ancestros reales de la historia (`git merge --allow-unrelated-histories`,
merge `f1b1364`), no una copia de archivos. Antes del merge, un commit en el lado
de Vitrinee (`7f08999`) movió cada archivo a su lugar definitivo, así que el
merge no tuvo ningún conflicto. El código queda como **hermanos**, no como
carpeta paralela, que es lo que `P-1` exige:

| Antes (repo Vitrinee) | Ahora (AgentPey) |
|---|---|
| `packages/{core,adapters,anchor,gateway}` | `packages/vitrinee-*` |
| `apps/{agent,console,dashboard}` | `apps/vitrinee-*` |
| `contracts/` (workspace de Cargo) | `contracts/receipt-registry/` |
| `scripts/` | `scripts/vitrinee/` |
| `deployments/testnet.json` | `deployments/vitrinee-testnet.json` |
| `docs/`, `README.md`, `CLAUDE.md`, el brief | `docs/fase-6-agentguard-comercializacion/vitrinee/` |
| `.env.local` | `.env.vitrinee.local` |
| `pnpm gateway`, `pnpm demo:buy`, … | `pnpm run vitrinee`, `pnpm run vitrinee:buy`, … |

**Cinco desvíos respecto de `P-1`, cada uno con su motivo:**

1. **Secretos en `.env.vitrinee.local`, no en `.env.local`.** Los dos proyectos
   usan `AGENT_SECRET_KEY` para cuentas **distintas**. Compartir el archivo haría
   que el agente de prueba de Vitrinee firmara con la llave del agente de
   AgentPey. El patrón `.env.*.local` que AgentPey ya ignora lo cubre.
2. **`deployments/vitrinee-testnet.json` aparte.** `P-1` quiere un solo archivo de
   despliegue. Pero el script de Vitrinee que lo escribe reemplaza el archivo
   entero con su propio esquema: sobre el de AgentPey, borraría los contratos de
   AgentPey. Unificarlos exige primero cambiar ese script; queda anotado.
3. **`receipt-registry` es su propio workspace de Cargo**, excluido de
   `contracts/Cargo.toml`. Se desplegó compilado con `soroban-sdk` 28.0.0; los
   contratos de AgentPey fijan 27.0.6. Dos SDK en un solo lockfile re-resolverían
   el grafo de los otros contratos, y recompilarlo en otro entorno podría cambiar
   el wasm que ya está vivo en testnet.
4. **Prefijo `VT-` para las decisiones de Vitrinee.** Usaban `V-`, que en AgentPey
   es de la Fase 5 (MandateVault). Se renumeró uno a uno (`V-7` → `VT-7`) en el
   código y en los documentos. Los mensajes de commit anteriores a la fusión
   siguen diciendo `V-n`: la historia no se reescribe.
5. **Lint y CI solo para Vitrinee.** Vitrinee corría eslint y GitHub Actions;
   AgentPey no tiene ninguno de los dos. Encenderlos para todo el repo sería
   cambiar la forma de trabajar de AgentPey como efecto secundario de una
   fusión. `eslint.config.mjs` y `.github/workflows/vitrinee.yml` están
   acotados a las rutas de Vitrinee. Extenderlos es otra decisión.

**Lo que no cambió.** Los paquetes siguen llamándose `@vitrinee/*` (renombrarlos
es cosmético y tocaría cada import). Vitrinee sigue usando `VitrineeError` y no
`AgentPassError`: unificar los errores es una decisión aparte, que no se toma sin
proponerla. **Ninguna dependencia de AgentPey cambió de versión** con el nuevo
lockfile, verificado versión por versión.

**Lo que queda en el repo viejo, a propósito.** El deploy vivo
(`vitrinee-gateway.onrender.com`) sigue desplegándose desde
`vicentewolde/Vitrinee`, rama `day-3-jumpseller-catalog`. Moverlo al
`render.yaml` de AgentPey es un hito aparte: agregar un servicio a ese blueprint
puede crear uno nuevo en Render con variables vacías. **Hasta entonces, no
archivar ni borrar el repo Vitrinee.**

**Alternativa descartada: traer Vitrinee como una carpeta `vitrinee/` aislada**
con su propio workspace (`git subtree add`). Era lo más rápido y lo que Claude
Code propuso primero, antes de leer `P-1`. Descartada porque es exactamente la
"carpeta paralela" que `P-1` prohíbe, y porque aislaría a Vitrinee justo de lo
que tiene que compartir con AgentPey: el workspace, el comprador de `apps/agent`
y la narrativa de una sola pila.

**Otra alternativa descartada: fusionar sin reubicar antes.** Habría producido
conflictos en `packages/core`, `apps/agent`, `apps/gateway`, `contracts/`,
`deployments/testnet.json`, `docs/DECISIONES.md` y todos los archivos de la raíz,
resueltos a mano en medio de un merge. Reubicar primero en un commit revisable
deja el merge limpio y cada decisión de ruta visible por separado.

---

### P-13 · Exponential como tablero de planificación, en un experimento contra el método de hitos T · `Vigente`
**Fecha:** 2026-09-23 · **Hito:** ninguno; afecta cómo se definen los hitos desde T103 · Decidido por el usuario; la forma, de Claude Code

**Qué cambia.** El usuario adopta Exponential (exponential.im) como tablero
visual de AgentPey: prioridad, orden y fechas de los hitos se manejan ahí. El
repo sigue siendo el registro: alcance, decisiones, bitácora y evidencia no se
mueven. Los dos se mantienen sincronizados a mano, con un ritual al abrir y al
cerrar cada sesión, descrito en
[`docs/planificacion-exponential/README.md`](planificacion-exponential/README.md).
La tabla de correspondencia entre hitos T y tickets vive en
[`SYNC.md`](planificacion-exponential/SYNC.md).

**Quién manda en qué.** Exponential manda en prioridad, orden, fechas y estado
de las tareas del usuario. El repo manda en alcance, decisiones y qué se hizo.
Si difieren, Claude Code lo muestra y el usuario decide; ninguna de las dos
herramientas sobreescribe a la otra sola.

**El experimento.** T100, T101 y T102, definidos en `C-130` con el método
anterior, son la línea base. Los hitos siguientes se planifican con
`/grill-with-docs`, `/to-prd` y `/to-expo`, con tickets verticales que continúan
la numeración T. Cada ticket se marca `ANTERIOR` o `EXPONENTIAL` en SYNC.md y se
mide con las métricas de
[`COMPARACION.md`](planificacion-exponential/COMPARACION.md). Cierra con tres
hitos de cada método o el 2026-10-31, lo que llegue primero. Los criterios para
quedarse con un método u otro están escritos antes de medir, en el mismo
archivo.

**Cómo se adaptan las skills.** Los tickets nacen con rama `cc/t<n>-<slug>`
(`P-2`), así `/start-ticket` la respeta. `/ship-ticket` solo abre el PR y pasa
el ticket a `QA`; el merge sigue siendo fast-forward manual después de la
revisión del usuario (regla 1 de `CLAUDE.md`), y `DONE` lo escribe Claude Code.
Los PRD se escriben en `docs/fase-<n>-…/prd/`, en español, antes de publicarse
en Exponential; si difieren, manda el repo.

**Qué se creó el 2026-09-23.** Producto `agentpey`; un Feature que agrupa T100
a T102 para el video del 29; los tres tickets con rama, dependencias y un
comentario que los marca como línea base; un ticket de deuda para la opción (b)
de `C-133`; dos metas ("Video demo SCF: 29 de septiembre" y "Primer partner
piloto real en testnet") con key results; y seis acciones con fecha, tres del
usuario y tres que le ponen fecha a los hitos. Los nueve tickets del producto
`vitrinee`, creados desde el repo viejo antes de `P-12`, quedaron `ARCHIVED`
con un comentario que apunta acá.

**Lo que no cambia.** `CLAUDE.md` tiene prioridad sobre cualquier skill. Codex
no toca Exponential: su protocolo (`P-4`, `P-5`) sigue por git y `AGENT_LOG.md`.

**Alternativa descartada: migrar la bitácora a Exponential y dejar el repo solo
con código.** Descartada porque `DECISIONES.md` y `BITACORA.md` son la
narrativa de la postulación a SCF y el contexto que un chat nuevo necesita; un
tablero no reemplaza un documento con motivos y alternativas.

**Otra alternativa descartada: un script de sincronización desde el primer
día.** Se pospone hasta ver qué se desincroniza de verdad en tres o cuatro
sesiones; escribirlo ahora sería diseñar contra un problema que todavía no se
vio.
