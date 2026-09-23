# CONTEXT

> Glosario y decisiones de producto de Vitrinee, para agentes y humanos que
> llegan sin contexto.
>
> Este archivo es el **índice**. Las decisiones completas, con su motivo y la
> alternativa descartada, viven en [docs/DECISIONES.md](docs/DECISIONES.md) con
> prefijo `V-` y no se duplican acá. Qué es el proyecto y por qué:
> [docs/CONTEXTO.md](docs/CONTEXTO.md). En qué día vamos:
> [docs/BITACORA.md](docs/BITACORA.md).

## Glosario

Vocabulario del dominio. Si un ticket, un PRD o un nombre de módulo usa otra
palabra para una de estas cosas, está mal el ticket.

| Término | Qué es |
|---|---|
| **Gateway** | El servidor de Vitrinee. Sirve el manifest, cobra x402, crea el pedido y emite el recibo. No es plugin de la plataforma (V-1). |
| **Manifest** | `/.well-known/agent-storefront.json`. Lo que un agente lee para saber que esta tienda es comprable, qué vende y en qué condiciones. |
| **Adapter** | El traductor a una plataforma de e-commerce concreta (`mock`, `jumpseller`). Es lo único que cambia entre plataformas. |
| **Merchant** | La tienda. Tiene dos cuentas Stellar distintas: la que **recibe** (`payTo`) y la que **firma** recibos (V-8). |
| **`payTo`** | La cuenta Stellar del merchant que recibe el USDC. La trae el merchant desde su propia wallet; Vitrinee no la genera ni conoce su llave (V-19, V-4). |
| **Agente** | El comprador. Cualquier cliente x402 estándar, no un SDK de Vitrinee. |
| **Principal** | El humano o la empresa por cuenta de quien compra el agente. Es quien necesita el recibo verificable. |
| **Recibo** | JWS firmado por el merchant con lo que se compró y lo que se pagó. Vale desde que se emite. |
| **Anclaje** | El `sha256` del recibo escrito en el contrato `receipt-registry` de Soroban. Hace el recibo verificable por un tercero. Es asíncrono (V-5). |
| **Verificación** | Los tres checks independientes: firma, anclaje, pago (V-13). Un recibo es válido sólo si pasa los tres. |
| **Settlement** | El movimiento de USDC que somete el facilitator x402. Ocurre **antes** de que exista la orden (V-10, flujo `upfront`). |
| **`paid_unfulfilled`** | El estado feo pero honesto: el agente pagó y la plataforma falló. Se responde 200, nunca ≥400 (V-10). |

## Decisiones de producto

Tomadas en la entrevista del 22 de septiembre de 2026. El detalle, con motivo y
alternativa descartada, está en `docs/DECISIONES.md`.

- **[V-19](docs/DECISIONES.md) — La tienda recibe USDC en su propia cuenta Stellar, creada por ella en Freighter.** Vitrinee no genera la cuenta, no custodia la llave y no convierte a CLP. Lo que compra: no ser sujeto regulado por la Ley 21.521.
- **[V-20](docs/DECISIONES.md) — El usuario del MVP es el developer con un agente, no el consumidor final.** Es el único al que se llega sin permiso de una plataforma, y el único para quien el recibo verificable es el argumento de compra. Vitrinee **no resuelve la demanda** de la tienda.
- **[V-21](docs/DECISIONES.md) — Se paga un mes de Jumpseller; no se cambia de plataforma.** "Pedido real en tienda real" queda dentro del MVP. El recurso escaso es el tiempo, no la plata.

El PRD que sale de estas decisiones: [docs/PRD.md](docs/PRD.md).

## Riesgo abierto

- **Jumpseller**: el plan trial devuelve `403` en `POST /orders.json` y vence cerca del 29 de septiembre de 2026, sobre el día del video. Confirmar con soporte que un plan pagado lo habilita, antes de pagar. Ver [docs/BITACORA.md](docs/BITACORA.md).
