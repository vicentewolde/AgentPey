---
name: estado
description: Resume en qué fase y tarea va AgentPey, qué hay sin commitear, qué dejó el otro agente y cuál es el siguiente paso. Usar al abrir cada sesión.
disable-model-invocation: true
---

# /estado — ¿Dónde estamos?

Contexto del repositorio:
- Rama actual: !`git branch --show-current`
- Cambios sin commitear: !`git status --short`
- Últimos commits: !`git log --oneline -10`
- Commits locales que `origin/main` no tiene: !`git log --oneline origin/main..main`

Este comando es el checklist de apertura de `AGENTS.md` ("Coordinación con Codex", pasos 1 y 2) más el tablero.

Pasos:
1. Lee `docs/ESTADO.md`.
2. Lee la última entrada de `docs/AGENT_LOG.md` (el archivo es largo: lee solo el final). Dice qué dejó pendiente la sesión anterior, de Codex o de Codex.
3. Lee del spec de la fase actual (la ruta está en ESTADO) solo la sección de tareas y los criterios de aceptación.
4. Contrasta: ¿la rama, los commits y el árbol de trabajo coinciden con lo que dice ESTADO? Señala lo que no calce: tarea hecha pero no marcada, rama `cc/` o `codex/` sin mergear, cambios sin commitear, commits en `main` que no están en `origin/main`.
5. Espejo de Exponential (`P-13`), solo lectura:
   ```bash
   exponential tickets list --workspace personal-cmud6knil0045l704wuoc5b1r --product agentpey --json
   ```
   ```bash
   pnpm run exp:sync -- --dry-run
   ```
   Compara los tickets de la fase con la tabla de ESTADO. Si el usuario movió algo en la web (prioridad, orden, un ticket nuevo), dilo. Si difieren en alcance o decisiones, manda el repo y decide el usuario.

Responde en español, breve, con este formato:

**Fase:** Fase N · nombre — X de Y tareas terminadas (spec: borrador / aprobado)
**Rama actual:** … (limpia / con cambios sin commitear)
**Última tarea:** …
**Siguiente paso recomendado:** `/tarea T<n>` — título, en una línea
**Pendientes del usuario:** solo los que bloquean el siguiente paso
**Codex:** qué dejó, si hay algo por revisar
**Inconsistencias:** solo si las hay (repo, ESTADO, Exponential)

No modifiques archivos ni el tablero en este comando.
