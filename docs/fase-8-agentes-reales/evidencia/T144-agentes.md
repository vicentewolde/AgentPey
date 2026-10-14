# T144 · dots, Muse y Grok Bot como agentes de AgentPey · prueba técnica

> Prueba técnica, sin código, sin nada en la red y sin compra (`R-29`).
> Fuentes oficiales leídas el **2026-10-14** en el navegador; lo que no tiene
> una fuente primaria dice **sin confirmar**. Spec: [T144](../SPEC.md).

## 1. En una frase

**Ninguno de los tres puede comprar hoy en AgentPey con las cuentas del
usuario.** dots pide ChatGPT Pro (el usuario tiene Plus), Grok Bot pide un plan
pago de Grok o de Cursor, y Muse solo existe en Estados Unidos y paga con
tarjeta. Técnicamente, dots y Grok Bot sí podrían conectarse al servidor MCP de
AgentPey (los dos usan conectores MCP); Muse no tiene una vía documentada. Y
apareció un camino que el spec no preveía: **el chat de Grok acepta un
servidor MCP propio para todos sus usuarios** (documentado el 10-oct), sin
plan pago y sin probar todavía.

## 2. Qué haría falta del lado de AgentPey

Nada nuevo. El servidor MCP de T128 (`mcp.agentpey.com`) ya es lo que estos
agentes necesitan: un servidor MCP remoto por HTTPS, con OAuth 2.1 (`R-2`,
`R-7`), con las herramientas `search_products`, `get_product`, `quote`, `pay`,
`get_order` y `open_claim`. Claude (T128) y ChatGPT (T129) ya compraron a
través de él.

Dos límites que valen para cualquier agente nuevo:

- **El inicio de sesión se firma con una wallet** (Freighter, xBull o LOBSTR,
  T143). Quien conecta el agente tiene que hacer ese paso en un navegador con
  la wallet instalada. Un agente que solo vive en su propia computadora en la
  nube no puede hacerlo solo.
- **Solo entra la wallet dueña del rail del MCP** (`R-33`). Hoy es la del
  usuario: sirve para una prueba suya, no para que lo use otra persona.

## 3. Agente por agente

| | dots (OpenAI) | Grok Bot (xAI) | Muse (Meta) |
|---|---|---|---|
| **Qué es** | Agente siempre encendido dentro de ChatGPT, con su propia computadora y navegador en la nube | "Equipo" de agentes siempre encendidos, con una computadora propia en la nube; app de escritorio (macOS) e iOS | Agente personal con su propia máquina virtual y navegador; app, web y WhatsApp |
| **Quién lo tiene** | ChatGPT Pro 100, Pro 200 y Pro 500 (mayores de 18, fuera del EEE, Reino Unido y Suiza); Business Premium y Enterprise. Despliegue gradual | Beta para SuperGrok, SuperGrok Plus y SuperGrok Heavy, y para Cursor Pro, Pro+, Ultra y Teams. Uso cobrado aparte del plan | Solo Estados Unidos. Gratis para lo básico, con planes pagos |
| **Acceso del usuario** | No: tiene ChatGPT Plus (T129) | No confirmado: tiene Grok (5-oct), sin saber si es un plan SuperGrok | No: está en Chile |
| **¿Usa un servidor MCP propio?** | **Sin confirmar.** Usa "supported plugins installed and enabled for your account". En ChatGPT, un servidor MCP propio se agrega como plugin ("Add custom MCP server" → "Create as a plugin"), pero ninguna fuente dice si un plugin propio cuenta como "supported" para dots | **Probable.** Una guía oficial dice "Grok Bot supports the same MCP servers, plugins, and skills as Cursor", y Cursor admite servidores MCP remotos. No hay una página que lo diga para un servidor con OAuth | **No documentado.** "People choose which apps Muse connects to"; la página no menciona MCP ni conectores de terceros |
| **Cómo pagaría** | Con `pay` del MCP, desde el rail de AgentPey, como ChatGPT en T129. Su revisión automática decide si sigue solo, pide aprobación o deja el paso a la persona | Igual, con `pay` del MCP. Vuelve a la persona "when something needs your approval" | Con Link de Stripe (una tarjeta de un solo uso); Shop Pay "coming soon". Es un riel con tarjeta, fuera de alcance de AgentPey |
| **Qué funciona hoy** | Nada probado: sin acceso | Nada probado: sin acceso confirmado | Nada: no disponible en Chile ni por un medio de pago de Stellar |
| **Qué falta** | Un plan Pro o Business Premium, y confirmar que dots usa un plugin propio | Un plan pago de Grok o de Cursor, y confirmar que el inicio de sesión con wallet funciona desde la app de Grok Bot | Que Meta lo abra fuera de EE. UU. y que admita conectores de terceros o un medio de pago que no sea tarjeta |
| **Riesgo propio** | Trabaja solo en segundo plano: sus "Custom Rules" deberían pedir aprobación antes de `pay` | Igual que dots | No aplica |

**Compra real desde dots** (segundo criterio del spec): **no aplica**. El
usuario no tiene acceso a dots y la fuente oficial no confirma que use un
servidor MCP propio (`R-29`).

## 4. Un camino que el spec no preveía: el chat de Grok

La documentación de Grok dice, en su página de conectores (actualizada el
**10-oct-2026**):

- "Connectors are available to all Grok users".
- En "Custom MCP connectors": "you can bring your own Model Context Protocol
  (MCP) server", se agrega en `grok.com/connectors` → New Connector → Custom,
  con la URL y "any required authentication".
- "Your MCP server must be reachable over the public internet" (el de AgentPey
  lo está).

Es decir: con la cuenta de Grok que el usuario ya tiene, **el chat de Grok
podría conectarse a `mcp.agentpey.com`** y cotizar, igual que Claude y
ChatGPT. Sin confirmar: que el conector propio de Grok haga el OAuth con
descubrimiento que pide el servidor (la página no dice qué autenticación
admite), y si Grok llama a `pay` él mismo o lo deja a la persona, como Claude
(`R-11`).

No es Grok Bot (es el chat). **El 14-oct el usuario pidió probarlo** y se
agregó como criterio de T144: no mueve nada hasta `pay`, y una compra del imán
gasta unos 0,52 USDC de testnet del rail del MCP, solo con su OK. El resultado
va en la §8.

## 5. Contraste con `R-29`

`R-29` resumió el 8-oct: "Grok Bot pide plan pago, dots no acepta conectores
propios, Muse es solo de EE. UU.". Con las fuentes de hoy:

- **Grok Bot pide plan pago:** confirmado.
- **Muse es solo de EE. UU.:** confirmado ("rolling out in the US").
- **dots no acepta conectores propios:** más fuerte de lo que dicen las
  fuentes. Lo correcto es "**sin confirmar** que dots use un conector propio";
  lo que sí está confirmado es que pide un plan Pro que el usuario no tiene.

La conclusión de `R-29` (T144 queda como tabla, sin compra) no cambia.

## 6. Criterios del spec

- [x] `T144-agentes.md` con una tabla agente por agente: qué funciona, qué
  falta, evidencia (este documento, §3)
- [ ] ~~una compra real desde dots~~: no aplica, el usuario no tiene acceso
  (§3, `R-29`)
- [ ] (agregado el 14-oct) el chat de Grok conectado a `mcp.agentpey.com`:
  qué funciona, y con OK del usuario una compra real (§8)

## 7. Fuentes (leídas el 2026-10-14)

| Tema | Fuente |
|---|---|
| dots: qué es, planes, plugins | https://learn.chatgpt.com/docs/dots · https://learn.chatgpt.com/docs/dots/computers-and-apps |
| dots: anuncio (29-sep-2026) | https://openai.com/index/introducing-dots/ |
| ChatGPT: un servidor MCP propio se agrega como plugin | https://developers.openai.com/plugins/deploy/connect-chatgpt |
| Grok Bot: anuncio y planes (11-ago-2026) | https://x.ai/news/introducing-grok-bot |
| Grok Bot: "the same MCP servers, plugins, and skills as Cursor" | https://x.ai/bot/guides/grok-bot-101 |
| Grok: conectores MCP propios para todos (10-oct-2026) | https://docs.x.ai/grok/connectors |
| Muse: anuncio, país, Link de Stripe (8-sep-2026) | https://about.fb.com/news/2026/09/introducing-muse-personal-ai-agent/ |

Una guía de un tercero sobre Grok Bot y MCP (2slides.com, septiembre de 2026)
cita a alguien de Cursor diciendo que Grok Bot admite "remote HTTP/SSE MCP";
no se usó como evidencia porque no es una fuente oficial.

## 8. Prueba del chat de Grok

Pendiente: la conexión la hace el usuario en `grok.com/connectors`.
