# Contexto

> Qué es Vitrinee, por qué existe, qué **no** es, y el marco en que se construye.
> Decisiones: [DECISIONES.md](DECISIONES.md) · Estado: [BITACORA.md](BITACORA.md)

## Qué es

**Vitrinee hace que cualquier tienda de e-commerce en Latinoamérica sea comprable
por agentes de IA.** Es un middleware que se conecta a la plataforma de la tienda
(Jumpseller primero, WooCommerce después), publica el catálogo en un formato que
un agente entiende (`/.well-known/agent-storefront.json`), cobra vía **x402 en
USDC sobre Stellar**, crea el pedido real en la plataforma y entrega un **recibo
firmado cuyo hash queda anclado en Stellar**.

Frase para el pitch: *AgentPey le da al agente una billetera con reglas.
Vitrinee le da a la tienda una puerta para recibirlo.*

## La tesis

Los agentes ya saben pagar: x402 existe, hay facilitators públicos en Stellar,
hay billeteras con políticas de gasto (AgentPey, entre otras). Lo que no existe
es el **lado del vendedor** para el comercio real de Latinoamérica: una pyme de
Ñuñoa con su tienda en Jumpseller no tiene hoy ninguna forma de recibir a un
agente. Ese espacio está vacío mientras el de "capas de pago para agentes"
está saturado. Vitrinee se para en el vacío.

Tres propiedades lo hacen valioso:

1. **Cualquier cliente x402 estándar puede comprar.** Vitrinee no impone su
   propio SDK al comprador. Funciona con AgentPey, con REAPP, con un script
   de 40 líneas que use `@x402/fetch`.
2. **La tienda no cambia nada.** No hay plugin que instalar ni tema que
   editar: Vitrinee habla con la plataforma por su API y la tienda solo ve
   pedidos pagados llegar a su panel.
3. **El recibo es prueba para las dos partes.** El merchant y el principal
   del agente tienen el mismo documento firmado y el mismo hash anclado en
   Soroban. Ninguno depende del otro para probar qué se compró y qué se pagó.

## Qué NO es

- **No es un wallet, un facilitator x402, un marketplace ni una "capa de
  pagos para agentes".** Está del lado del vendedor.
- **No es un plugin PHP/Liquid nativo.** Es un gateway HTTP que habla con la
  plataforma por su API ([V-1](DECISIONES.md)).
- **No es custodio de fondos.** El pago x402 va directo a la cuenta Stellar del
  merchant (`payTo`). Vitrinee nunca tiene llaves de pago del merchant ni del
  comprador ([V-4](DECISIONES.md)).
- **No es un producto en mainnet.** 100% Stellar testnet, USDC de testnet, sin
  fiat, sin PSP. Ver abajo.

## Relación con AgentPey

[AgentPey](https://github.com/vicentewolde/AgentPey) es el proyecto hermano:
identidad, mandatos y políticas de gasto para agentes de IA sobre Stellar
testnet, con un merchant x402 funcionando. Vitrinee **no depende de él**: no
importa paquetes `@agentpey/*` en el núcleo. Sí reutiliza patrones probados
(bootstrap idempotente, `deployments/testnet.json` como único artefacto
compartido entre TypeScript y Rust, bitácora y decisiones con prefijo) y la
convención `did:stellar` para identificar al merchant en el recibo. El único
punto de contacto es opcional y va al final: un modo `--payer agentpey` en el
agente demo, para mostrar los dos proyectos juntos.

## Marco regulatorio: testnet por decisión

Chile promulgó la **Ley 21.521 (Ley Fintech)** en enero de 2023. Entre otras
cosas, somete a registro y supervisión de la CMF a quienes prestan servicios de
custodia de criptoactivos, intermediación, iniciación de pagos y actividades
afines. Un gateway que moviera USDC real por cuenta de terceros, o que
recibiera pagos reales para comerciantes, tendría que evaluar seriamente su
posición frente a esa ley antes de operar.

Vitrinee resuelve eso por diseño, no por omisión:

- **Solo Stellar testnet.** El USDC que se mueve es el USDC de prueba de Circle
  en testnet. No tiene valor, no se puede convertir a nada y no es un activo
  en el sentido de la ley.
- **Sin custodia.** Aunque estuviera en mainnet, Vitrinee no toca fondos:
  el pago va del comprador al merchant, y el facilitator (un tercero) es
  quien somete la transacción.
- **Sin fiat, sin PSP.** No hay conversión a pesos ni integración con medios
  de pago regulados.

El camino a mainnet existe y está en el roadmap, pero es una decisión
regulatoria y comercial que se toma con asesoría, no una limitación técnica.
Esto no es asesoría legal; es la restricción de diseño que el proyecto se
impone y que un revisor debería poder verificar leyendo el código.

## Alcance del hackathon

Vitrinee se construye en 8 días (22 al 30 de septiembre de 2026) para el
hackathon **"Find Your Way"** (Tellus Cooperative, ecosistema Stellar), track
General. Los criterios de evaluación y cómo cada uno se evidencia están en el
[README](../README.md). Lo que **nunca** se recorta: checkout x402 real, orden
creada en la plataforma, recibo firmado, anchor en Soroban, verificación,
README reproducible, video.
