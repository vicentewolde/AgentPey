# PRD · Vitrinee, la plataforma de comercios de AgentPey (T103 a T105)

> **Fuente de verdad.** Este archivo manda. La copia en Exponential (Feature
> "Plataforma de comercios", `cmueyqbph0001jx04mkeobqxa`, con 24 historias) es derivada: si difieren, manda
> el repo (`P-13`).
> Fecha: 2026-09-24 · Autor: Claude Code, desde un `/grill-with-docs` con el
> usuario · Decisiones: `C-140` a `C-144` en [DECISIONES.md](../DECISIONES.md),
> `VT-27` a `VT-29` en [vitrinee/DECISIONES.md](../vitrinee/DECISIONES.md) ·
> Glosario: [vitrinee/CONTEXT.md](../vitrinee/CONTEXT.md)

## Problema

AgentPey tiene un lado de la demanda: en RealOps, una persona contrata un
agente, le firma un permiso y ve lo que compró. No tiene un lado de la oferta.
Hoy un **comercio** se suma a AgentPey de una sola forma: alguien del equipo
agrega una fila a `venues.json`, configura variables en Render y redespliega.
Vitrinee, el motor que conecta una **tienda** Jumpseller con los agentes, sirve a
un solo comercio, fijado por variables de entorno, y guarda sus pedidos en un
disco que cada deploy borra.

Para el dueño de un comercio eso significa que no puede entrar solo: depende de
nosotros, de un deploy y de que nadie redespliegue antes de que se cumpla su
pedido. Para el video del 29, significa que la frase "un comercio se suma sin
escribir código" hoy es cierta solo si el que escribe el código somos nosotros.

## Solución

Vitrinee pasa a atender a muchos comercios (`C-140`). El dueño de una tienda
Jumpseller entra a `vitrinee.agentpey.com` con la wallet de su cuenta de cobro
(`VT-29`), pega el login y el token de API de su tienda (`VT-28`), y Vitrinee
prueba esas credenciales, revisa que su cuenta pueda recibir USDC, le genera una
llave de firma de recibos (`VT-27`) y publica su tienda para agentes en
`<slug>.vitrinee.agentpey.com` (`C-142`). Desde ese momento su comercio aparece
en el **directorio de comercios** de Vitrinee, que AgentPey lee para saber a
quién puede pagarle (`C-141`), y en RealOps una persona puede contratar un
"Comprador de la tienda" para ese comercio y firmarle el permiso. El dueño ve en
su panel los pedidos que le llegaron.

La plata sigue yendo directo de la cuenta de gasto del agente a la cuenta de
cobro del comercio. Vitrinee nunca tiene una llave que mueva fondos.

**Lo que no se promete.** Lo que un comercio valora de verdad es vender y que el
pedido le llegue a su panel de Jumpseller. Vitrinee le suma ventas de agentes,
la prueba del pago en la red y un recibo verificable; no le trae compradores.

## Hitos

Tres hitos verticales antes del video del 29 (`C-144`), cada uno demostrable
por sí solo, en este orden:

| Hito | Qué se demuestra al cerrarlo |
|---|---|
| **T103** · Vitrinee atiende a varios comercios, con datos en Postgres | Un deploy no borra comercios ni pedidos, y Bazar Cordillera vende desde `bazar-cordillera.vitrinee.agentpey.com` |
| **T104** · AgentPey y RealOps leen el directorio | Un agente compra en un comercio que AgentPey conoció solo por el directorio, y en RealOps la persona elige el comercio al contratar |
| **T105** · Un dueño da de alta su tienda sin código | Una segunda tienda Jumpseller (cuenta de prueba) entra por el portal y aparece en RealOps sin tocar código; su dueño ve su panel de pedidos |

Si el tiempo no alcanza, lo primero que se cae es el panel mínimo de pedidos de
T105. El alta se mantiene: es la escena del video.

## Decisiones de implementación

### Módulos de Vitrinee

1. **Almacén de Vitrinee (Postgres, esquema `vitrinee`).** Tablas de comercios
   y de pedidos, con migraciones propias. Se conecta con `VITRINEE_DATABASE_URL`,
   un rol que solo ve su esquema (`C-143`). El almacén de pedidos de hoy, que
   escribe un archivo, queda detrás de una interfaz con dos implementaciones: en
   memoria para los tests y Postgres para producción. Un pedido pertenece a un
   comercio; ninguna consulta de pedidos se hace sin el id del comercio.
2. **Caja de secretos.** Cifra y descifra los secretos de cada comercio (llave
   de firma y credenciales de tienda) con una llave maestra
   (`VITRINEE_MASTER_KEY`, que carga el usuario en Render). Cifrado autenticado:
   un secreto alterado en la base no se descifra, falla con un error tipado.
   Nunca devuelve un secreto a una respuesta HTTP ni a un log. Módulo profundo:
   dos funciones, sin I/O.
3. **Selector de tienda por dominio.** Del `Host` del pedido saca el slug, busca
   el comercio y le entrega el pedido a **una instancia de la tienda de ese
   comercio**, construida con la misma fábrica que arma la tienda de hoy, a
   partir de la configuración de ese comercio (su cuenta de cobro, su llave de
   firma, sus credenciales, su adaptador). Las instancias se guardan en memoria
   y se reconstruyen cuando el comercio cambia. Así el checkout, el cobro x402,
   el recibo y el anclaje no se reescriben: cada tienda sigue teniendo un
   `payTo` fijo, que es lo que el middleware x402 espera. Un slug desconocido
   responde 404 sin tocar la base de pedidos. El `Host` raíz va al portal.
4. **Directorio de comercios.** `GET` público en el portal con, por cada
   comercio activo: slug, nombre, URL de su tienda, cuenta de cobro y DID de su
   llave de firma. Sin credenciales ni nada privado. Es lo que AgentPey lee
   (`C-141`).
5. **Portal: entrada con wallet.** Desafío firmado con SEP-0053, verificado con
   la pieza neutral de `@agentpass/core` (`VT-29`). Sesión con cookie solo en
   `vitrinee.agentpey.com`, nunca en los subdominios de las tiendas.
6. **Portal: alta de comercio.** Con la sesión de la wallet: nombre y slug,
   login y token de Jumpseller. Antes de guardar nada, cuatro pruebas, cada una
   con su motivo de rechazo tipado: el slug es válido y está libre; la cuenta de
   cobro existe y tiene línea de confianza de USDC de testnet; las credenciales
   leen el catálogo de la tienda; la llave de firma nueva queda fondeada con XLM
   del faucet de testnet. Si todo pasa, el comercio queda activo y en el
   directorio.
7. **Panel mínimo del comercio.** Con la sesión: la URL de su tienda, su estado
   y la lista de sus pedidos, con su estado (`paid`, `paid_unfulfilled`) y el
   enlace para verificar cada recibo.
8. **Migración de Bazar Cordillera.** Un comando que da de alta la tienda de hoy
   como primer comercio, a partir de las variables `VITRINEE_` que ya existen,
   con su misma cuenta de cobro y su misma llave de firma (los recibos ya
   emitidos siguen verificando). Idempotente: correrlo dos veces no crea dos
   comercios.
9. **Rescate del pedido pendiente de T101.** El registro público de
   `ord_muektgpgee1ebc73e5` se respaldó el 2026-09-24; la dirección de despacho
   de prueba está en el registro de compra de AgentPey (`delivery.resource_url`,
   `VT-25`). Un comando lo importa al almacén de pedidos como pedido de Bazar
   Cordillera, `paid_unfulfilled`, con su recibo sin tocar. Si funciona, el
   primer merge de T103 deja de estar bloqueado por PR #29 (`C-144`); si no, el
   bloqueo sigue y decide el usuario.

### Gateway del servicio único

10. **Regla de subdominios.** `apps/gateway` acepta, además de los dominios
    exactos de hoy, `<etiqueta>.vitrinee.agentpey.com` cuando `<etiqueta>` es
    una sola etiqueta con forma de slug, y lo manda al proceso de Vitrinee.
    Nunca por prefijo (`C-109`, `C-142`). `VITRINEE_DATABASE_URL` y
    `VITRINEE_MASTER_KEY` se suman a las variables que solo le llegan a
    Vitrinee (`C-136`).

### AgentPey (el comprador)

11. **Fila de plataforma en el registro de comercios.** El esquema de
    `venues.json` admite una fila de tipo plataforma: dominio de la plataforma,
    activos aceptados y URL del directorio. La fila `vitrinee` de hoy pasa a ser
    esa fila.
12. **Resolución de comercios por directorio.** Un comercio `slug:cuenta` que no
    es fila fija se resuelve leyendo el directorio de su plataforma, y se
    rechaza con `InvalidProduct`, igual que hoy, si: no está en el directorio;
    su URL no es un subdominio de la plataforma; su cuenta no coincide con la
    del id; o pide un activo que la fila de la plataforma no nombra. El
    directorio nunca agrega activos (`C-141`). El camino de compra de `/v1` y la
    ruta de descubrimiento usan esta misma resolución.

### RealOps

13. **"Comprador de la tienda" por comercio.** El tipo de agente deja de tener
    fijos el comercio, sus productos y su cuenta. Al contratarlo, la persona
    elige un comercio de una lista leída del directorio, y el permiso propuesto
    nombra ese comercio, su cuenta de cobro y sus productos, con los límites de
    `C-137`. El catálogo muestra una sección por comercio del directorio.

### Del usuario, fuera del código

- Crear el rol de Postgres con el comando que se deja listo; pegar
  `VITRINEE_DATABASE_URL` y una `VITRINEE_MASTER_KEY` nueva en Render (`P-10`).
- Agregar el dominio comodín en Render (0,25 USD al mes, aprobado en `C-142`) y
  los tres CNAME en Vercel.
- Crear la segunda tienda Jumpseller en prueba gratuita, con un par de
  productos, y darla de alta en el portal durante T105.
- Decidir PR #29 si el rescate del punto 9 no funciona.
- El trámite de la app de Jumpseller (`VT-28`), en paralelo.

## Decisiones de pruebas

**Qué es una buena prueba acá:** prueba comportamiento que se ve desde afuera
(una respuesta HTTP, una fila en la base, un rechazo tipado), no cómo está
hecho por dentro. Cada rechazo de seguridad tiene una prueba que falla con el
código anterior, como en `C-139`.

- **Caja de secretos:** ida y vuelta; un secreto alterado falla tipado; otra
  llave maestra no descifra.
- **Almacén de Vitrinee:** contra Postgres real en los tests de integración (el
  mismo patrón que el vault y SignalDesk); en memoria para los unitarios. Una
  prueba de que un comercio no ve pedidos de otro.
- **Selector de tienda:** slug conocido llega a su tienda con su `payTo`; slug
  desconocido responde 404; dos comercios no comparten instancia.
- **Regla del gateway:** acepta `bazar.vitrinee.agentpey.com`, rechaza
  `bazar.vitrinee.agentpey.com.atacante.example`,
  `a.b.vitrinee.agentpey.com` y cualquier cosa por prefijo; las variables nuevas
  solo llegan a Vitrinee. Precedente: los tests de aislamiento de T102.
- **Alta:** cada una de las cuatro pruebas rechaza con su motivo; nada se guarda
  si una falla. La wallet sin firma válida no entra.
- **AgentPey:** resolución por directorio, con los cuatro rechazos del punto 12,
  y el test de contrato real contra Vitrinee
  (`scripts/vitrinee/agentpey-contract.test.ts`) extendido a dos comercios.
- **RealOps:** el permiso propuesto nombra el comercio elegido y ningún otro.
- **En vivo, al cerrar cada hito:** T103, un deploy no borra nada y Bazar
  Cordillera cobra desde su subdominio; T104, una compra en testnet resuelta por
  directorio con los tres checks del recibo en verde; T105, el alta de la tienda
  de prueba de punta a punta.

## Fuera de alcance

- La app de Jumpseller con OAuth: después del 29 (`VT-28`).
- El panel completo: recibos en detalle, reintentar un pedido desde el panel,
  desactivar el comercio, cambiar credenciales.
- Que un comercio traiga su propia llave de firma (`VT-27`).
- Más de una tienda por comercio, u otras plataformas además de Jumpseller.
- Cobrarle a un comercio, mainnet, rieles fiat, AgentGuard.
- Que Vitrinee le traiga demanda a un comercio.

## Notas

- **Riesgos conocidos al escribir esto.** No se verificó que el Postgres de
  Render permita un rol acotado; es lo primero de T103, y si no se puede, se
  cae a un Postgres aparte con el precio mostrado al usuario (`C-143`). El
  comodín de Render pide que la raíz apunte a Render, que ya se cumple; si
  falla, se cae a rutas `/c/<slug>` (`C-142`). Jumpseller sigue respondiendo
  `404` al crear pedidos (T101): la escena de compra depende de eso, no de este
  PRD.
- **Delegación a Codex.** Nada de estos hitos se delega: son custodia, llaves,
  firma, registro de comercios y el grant firmado (`P-10`).
- **`AGENTS.md`.** Cuando T103 agregue las variables nuevas de Vitrinee, la
  línea del reparto de claves de `AGENTS.md` se actualiza en el mismo hito.
