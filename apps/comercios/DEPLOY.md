# Publicar el panel de AgentPey para comercios (Start-Up Chile)

Rama `cc/startup-chile-demo`. No empuja ni despliega nada por sí sola.

## Modo público (`PUBLIC=1`)
- Solo se ven las tiendas de `PUBLIC_STORES` (coma). El resto da 404: Black Friday sin diagnóstico completo y los pilotos sin OK.
- El vendedor con IA usa siempre la API de pago (`ANTHROPIC_API_KEY`). La suscripción no puede atender al público.
- `/api/vender/*` limita las preguntas por IP (30 por hora; `SELLER_LIMIT_PER_HOUR`). Responde 429 al pasarse.
- Si falta la base de datos (`DATABASE_URL`), la clave o la lista de tiendas, el servidor no parte.

## Dónde viven los datos (decidido el 16-nov)
Render borra los archivos del servicio en cada despliegue, así que el panel publicado no usa el archivo SQLite: usa la **Postgres que ya tiene el piloto**, en un esquema propio `comercios`, con un rol `comercios` que solo ve ese esquema (igual que Vitrinee con `vitrinee`). Sin disco y sin costo extra.

En local, sin `DATABASE_URL`, el servidor sigue leyendo `data/comercios.db`, que llena la CLI.

## Dentro del servicio de Render que ya existe (decidido el 13-nov)
No hay servicio nuevo: el panel es una aplicación más del gateway (`apps/gateway`, `COMERCIOS_TARGET`), en `panel.agentpey.com`. Mientras falten sus variables, ese dominio responde 503 y lo demás funciona igual.

Variables del servicio AgentPey en Render (el servicio no lee `render.yaml`):
- `COMERCIOS_PUBLIC` = `1`
- `COMERCIOS_PUBLIC_STORES` = ids separados por coma
- `COMERCIOS_DATABASE_URL` = la conexión del rol `comercios` (la imprime el paso 2). Nunca la `DATABASE_URL` de AgentPey: la pasarela no se la entrega al panel.
- `COMERCIOS_ANTHROPIC_API_KEY` = la clave de la API (solo la ve el panel)
- opcional: `COMERCIOS_SELLER_LIMIT_PER_HOUR` (30 por defecto)

Pasos:
1. Poner la rama al día con `main` y mergearla (Render despliega desde `main`).
2. Lo corre Vicente, desde `apps/comercios`, porque imprime un secreto:
   ```
   npx tsx scripts/setup-postgres.ts --env ~/agentes/AgentPay/.env.local --check <tiendas...>
   npx tsx scripts/setup-postgres.ts --env ~/agentes/AgentPay/.env.local <tiendas...>
   ```
   Crea el rol y el esquema, comprueba que el rol no alcanza las tablas de AgentPey, crea las tablas y sube las tiendas desde `data/comercios.db`. Imprime `COMERCIOS_DATABASE_URL`, que se pega en Render. Volver a correrlo actualiza los catálogos y cambia la contraseña del rol (hay que pegar el valor nuevo); las mediciones reales y los clics que ya están en Postgres no se tocan.
3. En Render, Custom Domains: agregar `panel.agentpey.com`. El CNAME `panel` → `agentpey.onrender.com` ya está en Cloudflare (16-nov, solo DNS).
4. Probar: `/` solo muestra las tiendas elegidas, `/tienda/<otra>` da 404, el vendedor responde.
5. El script de medición de cada tienda apunta a `https://panel.agentpey.com/m/snippet.js?tienda=<id>`.

## Costo por abusos
Cada pregunta al vendedor es una llamada paga. Con 30 por hora por IP el gasto está acotado, pero conviene poner un tope de gasto mensual en la consola de Anthropic.
