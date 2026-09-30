---
name: fase-plan
description: Redacta o revisa el spec de una fase y lo deja aprobado por el usuario, antes de escribir código.
argument-hint: "[numero-de-fase]"
disable-model-invocation: true
---

# /fase-plan $ARGUMENTS — Planificar la fase

Objetivo: dejar `docs/fase-$ARGUMENTS-…/SPEC.md` en estado **Aprobado**, con tareas pequeñas, ordenadas y verificables.

## Pasos

1. **Contexto.** Lee `docs/ESTADO.md`, `ROADMAP.md`, `docs/DECISIONES.md` (las `P-` que abren la fase) y el `DECISIONES.md` de la fase. Confirma que lo que la fase pide está en alcance según la regla 5 de `CLAUDE.md`; si no, detente y pregunta.

2. **Spec.**
   - Si **no existe**, créalo con las secciones del spec de la Fase 7 (`docs/fase-7-estandar-comercio-agentico/SPEC.md`): objetivo, alcance, fuera de alcance, diseño, tareas, criterios de aceptación, plan de demo, riesgos, preguntas abiertas y registro de cambios.
   - Si **existe en borrador**, revísalo contra el código real (lee los paquetes, no supongas).
   - Si la fase integra un estándar o servicio externo, verifica primero su documentación oficial vigente y cita URL y fecha.

3. **Tareas.** Cada tarea:
   - Lleva el siguiente número T de la numeración continua.
   - Idealmente cabe en medio día; si es más grande, pártela o justifícalo.
   - Tiene dependencias explícitas, archivos principales y "Hecho cuando" verificable.
   - Dice si es delegable a Codex. Por defecto no lo es nada dentro del perímetro de `P-10`.

4. **Preguntas al usuario.** Toda decisión de producto, de fondos, de contratos o que dependa de sus cuentas va a "Preguntas abiertas". Házselas (máximo 4, concretas, con opciones y tu recomendación) y actualiza el spec con las respuestas.

5. **Aprobación.** Muestra un resumen: objetivo, número de tareas, riesgos principales y decisiones nuevas. Solo cuando el usuario diga que aprueba:
   - Cambia el estado del spec a **Aprobado** y agrega una fila al registro de cambios.
   - Actualiza la tabla de progreso de `docs/ESTADO.md`.
   - Espejo (`P-13`): un ticket `T<n> · …` por tarea en Exponential, con `--branch cc/t<n>-<slug>`, y su fila en `SYNC.md` con método `SPEC`.

No escribas código de la aplicación en este comando.
