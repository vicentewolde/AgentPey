---
name: revisar
description: Revisión del trabajo en la rama actual frente al spec, los criterios transversales y el perímetro de autorización, usando el subagente revisor. También sirve para revisar una rama de Codex antes de mergearla.
argument-hint: "[id-tarea opcional, o una rama codex/…]"
disable-model-invocation: true
---

# /revisar — Revisión de la rama actual

Contexto:
- Rama: !`git branch --show-current`
- Archivos cambiados respecto a main: !`git diff --stat main...HEAD`

## Pasos
1. Identifica la tarea (argumento `$ARGUMENTS`, o el nombre de la rama) y su sección en el spec de la fase (`docs/fase-<n>-…/SPEC.md`).
2. Delega en el subagente **`revisor`**, pasándole:
   - el id de la tarea y la ruta del spec,
   - que revise `git diff main...HEAD` completo (o `main...<rama>` si se revisa una rama de Codex),
   - que corra `pnpm check`, y `pnpm run vitrinee:check` si el diff toca Vitrinee.
   Pásale el diff y el spec, no tu conclusión: la revisión vale porque no está anclada a la tuya.
3. Si el diff toca `checkMandate`, el enforcement de `scope.limits`/`perDay`, firma, claves, cuentas pagadoras, flujo de fondos, `apps/gateway/src/hosts.ts`, `env-filter.ts`, `render.yaml` o `contracts/`, revisa **tú mismo** además esas partes línea por línea. El precedente es `B-25`: un bypass de autorización que entró por una rama sin revisar.
4. Presenta los hallazgos consolidados, sin duplicados, en tres grupos:
   - 🔴 **Bloqueantes:** hay que arreglarlos antes del PR
   - 🟡 **Importantes:** arreglar ahora o dejar como deuda anotada en `docs/ESTADO.md`
   - 🟢 **Sugerencias**
5. Pregunta al usuario cuáles corregir. Corrige solo esos, vuelve a correr `pnpm check` y haz commit (`fix(...)` o `refactor(...)`, por nombre de archivo).

No hagas push ni merge desde este comando. El merge está descrito al final de `/tarea` y necesita el OK del usuario.
