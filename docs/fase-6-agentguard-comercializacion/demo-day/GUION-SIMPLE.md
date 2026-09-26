# Demo Day Stellarbarrio · guion del deck simple (T106)

> Deck: "AgentPey Demo Day simple" (presentación privada,
> <https://claude.ai/artifact/TW7uj8qi56RXAU3t9df6F9>). Siete slides, una idea por
> slide, tipografía grande y entre 9 y 19 palabras en pantalla, como piden los
> organizadores: "extremadamente simple, una idea por slide, poco texto, muestren el
> producto, usen números; el deck acompaña al founder, no compite con él".
> El deck original (más texto) se conserva sin cambios de estructura:
> <https://claude.ai/artifact/McgRzVYPWTysDudyWXHVMV>, guion en [GUION.md](GUION.md).
> Cada slide trae este mismo texto en sus notas.
> El texto de corrido, tal como se habla y listo para el modo de voz:
> [GUION-PARA-HABLAR.md](GUION-PARA-HABLAR.md).

**Reglas de palabras (usuario, 2026-09-25).** Decir "wallet", no el nombre de la
extensión. Decir "tienda", no el nombre de la plataforma. No nombrar las apps:
decir lo que hacen ("la app de compras", "el panel de la tienda"). Lo que se pide
va hacia Stellar: comercios en Stellar y proyectos x402.

| Tramo | Slide | En pantalla | Idea |
|---|---|---|---|
| 0:00 a 0:20 | 1 | AGENTPEY · "Agentes de IA que compran con reglas. En Stellar." | Qué es |
| 0:20 a 1:00 | 2 | "Darle tu tarjeta a un agente es darle todo." | El problema |
| 1:00 a 2:00 | 3 | "Tú firmas el permiso. La red lo cumple." + el recibo real | La solución y la demo |
| 2:00 a 2:45 | 4 | "El límite lo cumple la red." · Soroban · USDC · x402 | Por qué Stellar |
| 2:45 a 3:30 | 5 | **6** compras reales · **2** tiendas reales · **3** contratos | Tracción |
| 3:30 a 4:15 | 6 | **3** tiendas · **1** partner externo | Lo que sigue |
| 4:15 a 5:00 | 7 | Vicente Wolde · "Buscamos: comercios en Stellar y proyectos x402." | Equipo y ask |

## Lo que dices

**1 · (0:20)** Hola, soy Vicente y esto es AgentPey. Ayudamos a que un agente de
inteligencia artificial compre por ti, dentro de reglas que tú firmas, sobre Stellar.

**2 · (0:40)** Los agentes de IA ya pueden comprar. El problema es cómo les das
permiso. Si les das tu tarjeta, pueden gastar todo. Si la regla vive en su prompt, un
texto escondido en una página la puede reescribir: eso se llama prompt injection. Y la
tienda no tiene cómo saber si ese agente estaba autorizado. Esto le pasa a cualquier
empresa que quiera darle agentes a sus usuarios.

**3 · (1:00, con demo)** Tú firmas un permiso con tu wallet: qué tienda, cuánto por
compra, cuánto por día. El agente compra solo dentro de eso, y la red Stellar lo
cumple. Y la tienda recibe un recibo que cualquiera puede verificar. Les muestro.

Cambia al navegador: (1) la app de compras, el comprador ya contratado con su permiso
firmado; le pides el kit Cola de Pavo. (2) "Ver el pago en Stellar": la transacción
exitosa, 2,09 dólares en USDC desde el contrato con tus reglas a la wallet de la
tienda. (3) El panel de la tienda, "Recibo": las tres comprobaciones en verde. Si algo
falla, no expliques: abre el video de respaldo.

**4 · (0:45)** En Stellar el límite de gasto vive fuera del agente. Paga desde un
contrato Soroban que revisa el tope por compra y por día en la misma transacción que
mueve el dinero; si se pasa, la red rechaza el pago. USDC para pagar, en segundos y por
una fracción de centavo. Y x402, para que un comercio le cobre a un agente por
internet. Sin Stellar, esto sería una promesa. Con Stellar, es una regla.

**5 · (0:45)** Todo esto corre hoy en Stellar testnet. Seis compras reales hechas por
agentes, cada una con su recibo verificado. Dos tiendas reales vendiendo a agentes: la
segunda se sumó sola, sin escribir código ni desplegar. Tres contratos en Stellar. No
tenemos miles de usuarios: tenemos el camino completo funcionando.

**6 · (0:40)** Los próximos tres meses, dos metas medibles: tres tiendas vendiendo a
agentes y el primer partner externo comprando solo, sin que nadie de nosotros toque una
terminal. Después, auditoría externa de los contratos y el encaje regulatorio en Chile;
recién ahí, mainnet.

**7 · (0:45)** Soy Vicente, ingeniero y profesor de blockchain. Construí AgentPey con
agentes de código, bajo un protocolo estricto: cada cambio se revisa antes de entrar y
cada decisión queda escrita. Buscamos comercios en Stellar que quieran vender a
agentes, y proyectos x402 con los que integrarnos. Gracias.

## De dónde sale cada número

| Número | Fuente |
|---|---|
| 6 compras reales | `GET /orders` de las dos tiendas: 4 en Bazar Cordillera y 2 en MycoKit, todas con recibo anclado; los 6 recibos verificados en vivo el 2026-09-25 (firma, ancla y pago en verde) |
| 2 tiendas | Bazar Cordillera (6 productos) y MycoKit (4), `evidencia/T105.md` § 6.3 |
| 3 contratos | `agent_registry` y `policy_rail` (`deployments/testnet.json`), `receipt-registry` (`deployments/vitrinee-testnet.json`) |
| 3 tiendas y 1 partner | La meta que el usuario dio para el próximo hito (Meta 97 en Exponential: partner externo con compra real en testnet) |

## Qué no decir

Los mismos límites de [GUION.md](GUION.md): nada de mainnet como logro, dinero real,
usuarios, ingresos ni AgentGuard; no decir "entregado" del pedido; nada de claves ni
de las pantallas de administración de la plataforma de la tienda.
