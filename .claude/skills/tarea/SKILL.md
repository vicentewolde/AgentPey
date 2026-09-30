---
name: tarea
description: Ejecuta una tarea del spec de punta a punta — rama, plan, implementación con tests, verificación, documentación y commit. Para y muestra el resultado.
argument-hint: "[id-tarea, ej. T120]"
disable-model-invocation: true
---

# /tarea $ARGUMENTS — Ejecutar una tarea

Estado del repositorio:
- Rama actual: !`git branch --show-current`
- Cambios sin commitear: !`git status --short`
- Últimos commits: !`git log --oneline -3`

`CLAUDE.md` manda sobre esta skill. Una tarea a la vez: al cerrarla, **para y muestra el resultado** (regla 1).

## 1. Preparar
- Lee `docs/ESTADO.md` y la sección **$ARGUMENTS** del spec de la fase actual (`docs/fase-<n>-…/SPEC.md`).
- El spec debe estar **Aprobado**. Si no, detente y sugiere `/fase-plan`.
- Verifica que sus dependencias estén ✅ en ESTADO. Si no, detente y avisa.
- Si la tarea toca Vitrinee, lee antes `docs/fase-6-agentguard-comercializacion/vitrinee/INSTRUCCIONES.md`.
- Árbol de trabajo: los archivos sin trackear del usuario (traspasos, `logo agentpey/`, `.codex/`) no se tocan. Si hay **cambios** sin commitear que no son de esta tarea, detente y pregunta.
- Otras sesiones comparten esta carpeta: confirma rama y HEAD, y crea la rama explícitamente desde `origin/main`:
  ```bash
  git fetch origin && git checkout -b cc/<id-en-minúsculas>-<slug> origin/main
  ```
- Marca la tarea 🔨 en `docs/ESTADO.md`.
- Espejo (`P-13`): pasa el ticket `$ARGUMENTS · …` a `IN_PROGRESS` y anota la fecha de inicio en `docs/planificacion-exponential/SYNC.md`:
  ```bash
  exponential tickets update --id <cuid> --status IN_PROGRESS --workspace personal-cmud6knil0045l704wuoc5b1r
  ```

## 2. Planificar
Primero 3 o 4 líneas en lenguaje llano de qué vas a hacer (regla 3). Después:
- Archivos a crear o modificar
- Pasos en orden
- Tests que vas a escribir
- **Perímetro:** si algo toca `checkMandate`, `scope.limits`/`perDay`, firma, claves, cuentas pagadoras, flujo de fondos, contratos o el reparto de claves del gateway, dilo explícitamente. Nada de eso va a Codex (`P-10`), y un contrato nuevo o un redeploy necesita permiso del usuario antes.
- Qué parte es mecánica y se podría delegar a Codex, si alguna
- Dudas o supuestos

**Espera el OK del usuario antes de editar**, salvo que la tarea sea trivial (1 o 2 archivos sin decisiones).

## 3. Implementar
- En incrementos pequeños, con los tests del comportamiento junto con el código.
- Criterios transversales: errores tipados (`AgentPassError` + `code`; `VitrineeError` dentro de Vitrinee), zod en todo borde, nada de `any`, sin credenciales hardcodeadas, dinero en `bigint` en Vitrinee. Código y comentarios en inglés.
- Nunca debilites un test para que pase.
- Si el spec está mal o incompleto: detente, explícalo y propón el cambio al spec antes de seguir.
- Si una decisión de algún `DECISIONES.md` parece equivocada: muestra la evidencia, propón la alternativa y **espera** (regla 2).
- Si aparece algo fuera de alcance: anótalo en ESTADO y déjalo sin construir (regla 5).

## 4. Verificar
- `pnpm check` completo. Si la tarea toca Vitrinee, también `pnpm run vitrinee:check`. Si toca contratos, `cargo test` en el workspace que corresponda (`export PATH="/opt/homebrew/opt/rustup/bin:$PATH"`).
- `pnpm run test:integration` y cualquier cosa contra testnet que mueva fondos: solo con el OK del usuario.
- Revisa uno por uno los "Hecho cuando" de la tarea y demuestra cada uno con un comando, una salida o un test.

## 5. Documentar
- `BITACORA.md` de la fase: **Estado actual** y el bloque de la tarea en lenguaje llano.
- `evidencia/$ARGUMENTS.md` de la fase: las salidas crudas.
- Toda decisión nueva, con motivo y alternativa descartada, al `DECISIONES.md` de la fase (o `docs/DECISIONES.md` con `P-` si cruza fases; `VT-` si es de Vitrinee). Di si `AGENTS.md` también tiene que cambiar para que Codex se entere.
- `docs/ESTADO.md`: tarea 👀, siguiente paso y notas breves.
- `docs/AGENT_LOG.md`: entrada con rama, qué, por qué, qué queda pendiente y una línea "Exponential: qué cambié".

## 6. Commit
- `git add` **por nombre de archivo**, nunca un directorio ni `-A`.
- Mensajes en inglés, Conventional Commits, que expliquen el **porqué**.
- **`push`, PR y merge solo con autorización explícita del usuario para esta rama.** Un permiso anterior no sirve para otra rama.

## 7. Cerrar
Responde al usuario, en este orden:
1. **Qué quedó funcionando**, en palabras que entienda alguien no técnico
2. **Evidencia técnica** (3 a 5 viñetas) y **cómo probarlo** (comandos exactos)
3. **Siguiente paso:** `/revisar`

Y detente ahí. No empieces otra tarea.

## Merge (después de `/revisar`, con el OK del usuario)
1. `git push -u origin <rama>` y `gh pr create`, con un cuerpo que enlace la tarea del spec.
2. Ticket a `QA` con `--pr <url>`.
3. Con el OK del usuario para el merge: fast-forward a `main`. Antes de pushear `main`, lista `git log origin/main..main` y confirma que cada commit es de esta tarea y está aprobado.
4. Borra la rama. Ticket a `DONE`, `pnpm run exp:sync`, fila de `SYNC.md`, y la tarea ✅ en `docs/ESTADO.md`.
