# Publicar el panel de AgentPey para comercios (Start-Up Chile)

Rama `cc/startup-chile-demo`. No empuja ni despliega nada por sí sola.

## Modo público (`PUBLIC=1`)
- Solo se ven las tiendas de `PUBLIC_STORES` (coma). El resto da 404: Black Friday y los pilotos sin OK por escrito.
- El vendedor con IA usa la API de pago (`COMERCIOS_LLM=api`, `ANTHROPIC_API_KEY`). La suscripción no puede atender al público.
- `/api/vender/*` limita las preguntas por IP (30 por hora; `SELLER_LIMIT_PER_HOUR`). Responde 429 al pasarse.
- Si falta la clave o la lista de tiendas, el servidor no parte.

## Dentro del servicio de Render que ya existe (decidido el 13-nov)
No hay servicio nuevo: el panel es una aplicación más del gateway (`apps/gateway`, `COMERCIOS_TARGET`), en `panel.agentpey.com`. Mientras falten sus variables, ese dominio responde 503 y lo demás funciona igual.

Variables que hay que crear en el panel de Render (el servicio no lee `render.yaml`):
- `COMERCIOS_PUBLIC` = `1`
- `COMERCIOS_PUBLIC_STORES` = ids separados por coma, por ejemplo `csbyte,bestmart,bpets`
- `COMERCIOS_DB_PATH` = `/var/data/comercios.db`
- `COMERCIOS_ANTHROPIC_API_KEY` = la clave de la API (solo la ve el panel; ninguna clave de AgentPey le llega)
- opcional: `COMERCIOS_SELLER_LIMIT_PER_HOUR` (30 por defecto)

Pasos:
1. Mergear la rama a `main` (Render despliega desde ahí). Antes, ponerla al día con `main`.
2. En Render, agregar un **disco persistente** al servicio (por ejemplo 1 GB montado en `/var/data`): sin eso, la base de datos se borra en cada despliegue.
3. Crear en Vercel el CNAME `panel` hacia el servicio (igual que `mcp`).
4. Copia de datos solo con las tiendas elegidas: `npx tsx scripts/export-public-db.ts data/publico.db <tienda> [...]`, y subirla a `/var/data/comercios.db` por la consola o SSH de Render. No subirla al repositorio: es público.
5. Probar: `/` solo muestra las tiendas elegidas, `/tienda/<otra>` da 404, el vendedor responde.
6. El script de medición de cada tienda apunta a `https://panel.agentpey.com/m/snippet.js?tienda=<id>`.

## Modo público (`PUBLIC=1`)
- Solo se ven las tiendas de `PUBLIC_STORES`; el resto da 404.
- El vendedor con IA usa siempre la API de pago. La suscripción no puede atender al público.
- `/api/vender/*` limita las preguntas por IP (30 por hora). Responde 429 al pasarse.
- Si falta la clave o la lista de tiendas, el servidor no parte.

## Costo por abusos
Cada pregunta al vendedor es una llamada paga. Con 30 por hora por IP el gasto está acotado, pero conviene poner un tope de gasto mensual en la consola de Anthropic.
