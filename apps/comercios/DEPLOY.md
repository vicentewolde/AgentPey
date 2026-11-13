# Publicar el panel de AgentPey para comercios (Start-Up Chile)

Rama `cc/startup-chile-demo`. No empuja ni despliega nada por sí sola.

## Modo público (`PUBLIC=1`)
- Solo se ven las tiendas de `PUBLIC_STORES` (coma). El resto da 404: Black Friday y los pilotos sin OK por escrito.
- El vendedor con IA usa la API de pago (`COMERCIOS_LLM=api`, `ANTHROPIC_API_KEY`). La suscripción no puede atender al público.
- `/api/vender/*` limita las preguntas por IP (30 por hora; `SELLER_LIMIT_PER_HOUR`). Responde 429 al pasarse.
- Si falta la clave o la lista de tiendas, el servidor no parte.

## Pasos (los hace Vicente, o yo con su OK en cada uno)
1. Elegir qué tiendas se muestran. Sin respaldo escrito, solo tiendas propias de prueba.
2. Copia de datos solo con esas tiendas: `npx tsx scripts/export-public-db.ts data/publico.db <tienda> [...]`
3. Servicio nuevo en el host, separado de agentpey.com (así no se mezcla con lo de Stellar). Comando: `npx tsx src/server.ts` en `apps/comercios`; variables: `PUBLIC=1`, `PUBLIC_STORES`, `DB_PATH` (el archivo del paso 2), `COMERCIOS_LLM=api`, `ANTHROPIC_API_KEY`.
4. Dominio, por ejemplo `panel.agentpey.com` (un CNAME).
5. Probar: `/` solo muestra las tiendas elegidas, `/tienda/bpets` da 404, el vendedor responde.
6. El script de medición de cada tienda apunta a ese dominio: `https://<dominio>/m/snippet.js?tienda=<id>`.

## Costo por abusos
Cada pregunta al vendedor es una llamada paga. Con 30 por hora por IP el gasto está acotado, pero conviene poner un tope de gasto mensual en la consola de Anthropic.
