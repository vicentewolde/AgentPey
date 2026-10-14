# T144 · dots, Muse y Grok Bot como agentes de AgentPey · prueba técnica

> Prueba técnica, sin código, sin nada en la red y sin compra (`R-29`). La
> prueba del chat de Grok, pedida por el usuario el 14-oct, salió de esta tarea
> a T156 (`R-37`). Fuentes oficiales leídas el **2026-10-14** en el navegador;
> lo que no tiene una fuente primaria dice **sin confirmar**. Spec:
> [T144](../SPEC.md).

## 1. En una frase

**Ninguno de los tres puede comprar hoy en AgentPey con las cuentas del
usuario.** dots pide ChatGPT Pro (el usuario tiene Plus), Grok Bot pide un plan
pago de Cursor o una cuenta SuperGrok, y Muse solo existe en Estados Unidos y
paga con tarjeta. dots podría usar el servidor MCP de AgentPey si acepta un
plugin propio (sin confirmar); para Grok Bot, que use un servidor MCP propio
también está sin confirmar; Muse no tiene una vía documentada. Y apareció un
camino que el spec no preveía: **el chat de Grok acepta un servidor MCP
propio**, pero hoy el inicio de sesión de AgentPey lo rechazaría (§2).

## 2. Qué haría falta del lado de AgentPey

El servidor MCP de T128 (`mcp.agentpey.com`) es lo que estos agentes usarían:
un servidor MCP remoto por HTTPS, con OAuth 2.1 (`R-2`, `R-7`), con las
herramientas `search_products`, `get_product`, `quote`, `pay`, `get_order` y
`open_claim`. Claude (T128) y ChatGPT (T129) ya compraron a través de él, en el
sentido de `R-11` (en T128 la persona apretó `pay`; en T129 lo llamó ChatGPT
tras su confirmación).

Tres límites que valen para cualquier agente nuevo:

- **El inicio de sesión solo devuelve a la persona a Claude, a ChatGPT o a una
  dirección local.** La lista está fija en el código
  (`DEFAULT_REDIRECT_URIS` en `apps/mcp/src/oauth/server.ts`), el registro de
  un cliente con otra dirección responde `invalid_redirect_uri`, y
  `apps/mcp/src/main.ts` no permite cambiarla en producción. dots no tendría
  este problema (usa los plugins de ChatGPT, cuya vuelta ya está permitida).
  El chat de Grok y Grok Bot sí: un cliente nuevo exige agregar su dirección
  exacta, que es un cambio de autorización (`R-37`, T156).
- **El inicio de sesión se firma con una wallet** (Freighter, xBull o LOBSTR,
  T143). Quien conecta el agente tiene que hacer ese paso en un navegador con
  la wallet instalada. Un agente que solo vive en su propia computadora en la
  nube no puede hacerlo solo.
- **Solo entra la wallet dueña del rail del MCP** (`R-33`). Hoy es la del
  usuario: sirve para una prueba suya, no para que lo use otra persona.

## 3. Agente por agente

| | dots (OpenAI) | Grok Bot (xAI) | Muse (Meta) |
|---|---|---|---|
| **Qué es** | Agente siempre encendido dentro de ChatGPT, con su propia computadora y navegador en la nube | "Equipo" de agentes siempre encendidos, con una computadora propia en la nube de Cursor; apps para macOS, Windows, Linux, iOS y Android | Agente personal con su propia máquina virtual y navegador; app, web y WhatsApp |
| **Quién lo tiene** | ChatGPT Pro 100, Pro 200 y Pro 500 (mayores de 18, fuera del EEE, Reino Unido y Suiza); Business Premium y Enterprise. Despliegue gradual | Incluido en todo plan individual pago de Cursor y en Cursor Teams, o enlazando una cuenta SuperGrok, SuperGrok Plus o SuperGrok Heavy. Tiene un uso propio, que no descuenta del plan y se reinicia cada semana | Solo Estados Unidos. Gratis para lo básico, con planes pagos |
| **Acceso del usuario** | No: tiene ChatGPT Plus (T129) | No confirmado: tiene Grok (5-oct), sin saber si es una cuenta SuperGrok | No: está en Chile |
| **¿Usa un servidor MCP propio?** | **Sin confirmar.** Usa "supported plugins installed and enabled for your account". En ChatGPT, un servidor MCP propio se agrega como plugin ("Add custom MCP server" → "Create as a plugin"), pero ninguna fuente dice si un plugin propio cuenta como "supported" para dots | **Sin confirmar.** Una guía de xAI dice "Grok Bot supports the same MCP servers, plugins, and skills as Cursor", pero la documentación oficial describe los conectores como plugins de un catálogo ("Browse the available plugins") y no menciona servidores MCP propios. Aunque los aceptara, el inicio de sesión de AgentPey lo rechazaría hoy (§2) | **No documentado.** "People choose which apps Muse connects to"; la página no menciona MCP ni conectores de terceros |
| **Cómo pagaría** | Con `pay` del MCP, desde el rail de AgentPey, como ChatGPT en T129. Su revisión automática decide si sigue solo, pide aprobación o deja el paso a la persona | Con `pay` del MCP. Vuelve a la persona "when something needs your approval" | Con Link de Stripe (una tarjeta de un solo uso); Shop Pay "coming soon". Es un riel con tarjeta, fuera de alcance de AgentPey |
| **Qué funciona hoy** | Nada probado: sin acceso | Nada probado: sin acceso confirmado | Nada: no disponible en Chile ni por un medio de pago de Stellar |
| **Qué falta** | Un plan Pro o Business Premium, y confirmar que dots usa un plugin propio | Un plan pago de Cursor o una cuenta SuperGrok; confirmar que acepta un servidor MCP propio; y que AgentPey acepte su dirección de vuelta (§2) | Que Meta lo abra fuera de EE. UU. y que admita conectores de terceros o un medio de pago que no sea tarjeta |
| **Riesgo propio** | Trabaja solo en segundo plano: sus "Custom Rules" deberían pedir aprobación antes de `pay` | Trabaja solo en segundo plano. Su documentación recomienda poner "Purchases and financial transfers" detrás de una aprobación, y deja las confirmaciones de pago a la persona ("the Bot should hand you control") | No aplica |

**Compra real desde dots** (segundo criterio del spec): **no aplica**. El
usuario no tiene acceso a dots y la fuente oficial no confirma que use un
servidor MCP propio (`R-29`).

## 4. Un camino que el spec no preveía: el chat de Grok

La documentación de Grok dice, en su página de conectores (actualizada el
**10-oct-2026**):

- "Connectors are available to all Grok users" (frase que presenta los
  conectores en general; la sección de servidores propios no dice qué planes
  la tienen, y en Grok Business y Enterprise un administrador habilita los
  conectores primero).
- En "Custom MCP connectors": "you can bring your own Model Context Protocol
  (MCP) server", se agrega en `grok.com/connectors` → New Connector → Custom,
  con la URL y "any required authentication".
- "Your MCP server must be reachable over the public internet" (el de AgentPey
  lo está).

Con la cuenta de Grok que el usuario ya tiene, el chat de Grok **podría**
conectarse a `mcp.agentpey.com`, pero hoy el registro fallaría: Grok vuelve a
`grok.com` y el servidor solo acepta Claude, ChatGPT o una dirección local
(§2). La dirección exacta que Grok envía no está en la documentación de xAI;
dos reportes de terceros la sacan de los logs de un servidor real:
`https://grok.com/connectors-oauth-exchange-code/`
([dinglebear-ai/unraid#390](https://github.com/dinglebear-ai/unraid/issues/390),
6-sep-2026, y
[norman-finance/norman-mcp-server#136](https://github.com/norman-finance/norman-mcp-server/pull/136)).
El mismo reporte dice que el formulario de Grok solo admite OAuth con PKCE y
registro dinámico (DCR), que es lo que el servidor de AgentPey ya ofrece.

**El 14-oct el usuario eligió abrirle la puerta a Grok** (`R-37`): queda como
tarea propia, T156, porque cambia quién puede recibir un código de inicio de
sesión. No es Grok Bot (es el chat).

## 5. Contraste con `R-29`

`R-29` resumió el 8-oct: "Grok Bot pide plan pago, dots no acepta conectores
propios, Muse es solo de EE. UU.". Con las fuentes de hoy:

- **Grok Bot pide plan pago:** confirmado.
- **Muse es solo de EE. UU.:** confirmado ("rolling out in the US").
- **dots no acepta conectores propios:** más fuerte de lo que dicen las
  fuentes. Lo correcto es "**sin confirmar** que dots use un conector propio";
  lo que sí está confirmado es que pide un plan Pro que el usuario no tiene.
  `R-29` quedó precisada con esto el 14-oct, con OK del usuario.

La conclusión de `R-29` para T144 (tabla, sin compra) no cambia. La compra
desde el chat de Grok es de T156 (`R-37`).

## 6. Criterios del spec

- [x] `T144-agentes.md` con una tabla agente por agente: qué funciona, qué
  falta, evidencia (este documento, §3)
- [ ] ~~una compra real desde dots~~: no aplica, el usuario no tiene acceso
  (§3, `R-29`)

## 7. Fuentes (leídas el 2026-10-14)

| Tema | Fuente |
|---|---|
| dots: qué es, planes, plugins | https://learn.chatgpt.com/docs/dots · https://learn.chatgpt.com/docs/dots/computers-and-apps |
| dots: anuncio (29-sep-2026; leído en el navegador, un lector sin navegador recibe 403) | https://openai.com/index/introducing-dots/ |
| ChatGPT: un servidor MCP propio se agrega como plugin | https://developers.openai.com/plugins/deploy/connect-chatgpt |
| Grok Bot: anuncio (11-ago-2026) | https://x.ai/news/introducing-grok-bot |
| Grok Bot: plataformas, planes y uso (7-oct-2026) | https://docs.x.ai/grok-bot |
| Grok Bot: conectores como plugins de un catálogo (12-oct-2026) | https://docs.x.ai/grok-bot/computer-and-apps |
| Grok Bot: aprobaciones y pagos (12-oct-2026) | https://docs.x.ai/grok-bot/approvals-security-and-privacy |
| Grok Bot: "the same MCP servers, plugins, and skills as Cursor" (guía) | https://x.ai/bot/guides/grok-bot-101 |
| Grok: conectores y servidores MCP propios (10-oct-2026) | https://docs.x.ai/grok/connectors |
| Grok: dirección de vuelta del conector propio (terceros, de logs reales) | https://github.com/dinglebear-ai/unraid/issues/390 · https://github.com/norman-finance/norman-mcp-server/pull/136 |
| Muse: anuncio, país, Link de Stripe (8-sep-2026) | https://about.fb.com/news/2026/09/introducing-muse-personal-ai-agent/ |

Una guía de un tercero sobre Grok Bot y MCP (2slides.com, septiembre de 2026)
cita a alguien de Cursor diciendo que Grok Bot admite "remote HTTP/SSE MCP";
no se usó como evidencia porque no es una fuente oficial.
