# Diseño web de AgentPey (T207, `Y-7`)

Fecha: 2026-11-11. Todas las páginas de AgentPey siguen el diseño de las publicaciones de la marca, que el usuario armó
con la sesión de AgentSales (`~/agentes/AgentSales/docs/marca/agentpey/DISENO.md`, fuera de este repo). Ese diseño es
para imágenes de 1080×1350 y no define estados, enlaces, foco, formularios ni modo oscuro web: este documento los define
y la hoja [`apps/web/public/brand/agentpey.css`](../../apps/web/public/brand/agentpey.css) los implementa. **Una sola hoja
para todas las páginas**, para que no se vuelvan a separar.

Ejemplos de las publicaciones: [post de X](diseno/x-instawards-es.png) (estilo «keynote», oscuro) y
[carrusel de Instagram](diseno/ig-meet-es.png) (estilo «bento», claro).

## 1. Lo que manda (de las publicaciones)

- **Fondos:** negro `#000` o niebla `#f5f5f7`. Tarjetas blancas `#fff` sobre la niebla; en oscuro, `#1c1c1e` sobre negro.
- **Tinta:** `#1d1d1f` sobre claro, `#f5f5f7` sobre oscuro. Secundaria `#6e6e73` (claro) y `#86868b` (oscuro).
- **Un solo acento:** azul `#176bff` (claro) y `#2997ff` (oscuro). Nada de naranja, morado ni otros colores de marca.
- **Degradado** `#176bff → #14b8a6` (claro) o `#2997ff → #6df2c0` (oscuro), con `background-clip: text`, **en una sola palabra o
  frase por página**. Nunca en fondos de interfaz ni en botones. Clase `.ap-grad`.
- **Tipografía:** titulares `Inter Tight` 600 (tracking −0,028em en el titular grande; nunca más apretado que −0,03em);
  texto `Inter` 400, 500 y 600, 17 px. Se dejan **Bricolage Grotesque, Instrument Sans y DM Mono**.
- **Tarjetas sin bordes ni sombras:** se separan por el tono. Radio 18 px (los 34 px del post divididos por ~2).
- **Mucho aire**, todo centrado en las portadas; el texto dentro de las tarjetas, a la izquierda.
- **Logo:** `apps/web/public/brand/agentpey-mark.svg`, la marca «AP» con su muesca diagonal en `currentColor` (la muesca es
  parte del logo, no se «arregla»), más «AgentPey» en Inter Tight 600.
- **No:** sombras duras, bordes gruesos, emojis de adorno, logos de terceros (Stellar incluido), muchas cajas compitiendo,
  imitaciones de Apple (anillos de Actividad).

## 2. Lo que se agregó para la web (`Y-7`)

| Qué | Claro | Oscuro | Por qué |
|---|---|---|---|
| Enlace de texto | `#0a5bd9` | `#2997ff` | `#176bff` sobre la niebla da 4,2:1 y no llega al mínimo AA de 4,5:1; `#0a5bd9` da 5,5:1 |
| Botón principal | fondo `#176bff`, texto blanco (4,6:1) | fondo `#2997ff`, texto negro | El acento es la acción, como en apple.com. Botones en píldora (`--ap-pill`) |
| Foco | contorno 2 px del acento, separado 3 px | igual | Se ve en los dos temas |
| Bien (verificado, liberado) | `#1a7f45` sobre `#e8f6ee` | `#30d158` sobre `#0f2a19` | Verde sobrio; cumple AA |
| Mal (rechazado, fallido) | `#c4122f` sobre `#fdecee` | `#ff6961` sobre `#3a1414` | |
| Aviso (en espera, plazo) | `#a35200` sobre `#fff3e0` | `#ffb340` sobre `#3a2a0c` | |
| Hashes y direcciones | `ui-monospace` del sistema | igual | Las publicaciones no tienen monoespaciada; un hash sin ella no se lee. Solo para datos, nunca en titulares |
| Modo oscuro | — | con la preferencia del sistema, o forzado con `<html data-theme="dark">` | La portada es siempre oscura (como el post de X); las páginas de trámite siguen al sistema |

Contrastes medidos el 11-nov con la fórmula de WCAG 2: todos los pares de texto de la tabla dan ≥ 4,5:1.

## 3. Cómo se usa en una página

En el `<head>`, antes de los estilos propios de la página:

```html
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter+Tight:wght@600;700&family=Inter:wght@400;500;600&display=swap">
<link rel="stylesheet" href="/brand/agentpey.css">
```

`<body class="ap">`. Encabezado y pie comunes (el SVG va en línea para heredar el color):

```html
<header class="ap-header"><div class="ap-wrap">
  <a class="ap-brand" href="https://agentpey.com/">
    <svg viewBox="0 0 512 512" aria-hidden="true"><defs><mask id="ap-cut" maskUnits="userSpaceOnUse" x="0" y="0" width="512" height="512"><rect width="512" height="512" fill="#fff"/><path d="M378 112l54 54" stroke="#000" stroke-width="60"/></mask></defs><g mask="url(#ap-cut)" fill="none" stroke="currentColor" stroke-width="60"><path d="M72 416 196 96h86v320"/><path d="M136 282h146"/><path d="M282 112h96"/><path d="M432 166v84l-48 48H282"/></g></svg>
    AgentPey</a>
  <nav class="ap-nav" aria-label="AgentPey">…</nav>
</div></header>
<main class="ap-wrap ap-main">…</main>
<footer class="ap-footer"><div class="ap-wrap"><span>AgentPey · Stellar testnet · Santiago de Chile</span><span>…</span></div></footer>
```

Componentes de la hoja: `.ap-card` (con `.ap-card-hero` negra y `.ap-card-blue`), `.ap-btn` (`.ap-btn-secondary`,
`.ap-btn-quiet`, `.ap-btn-sm`), `.ap-pill` y `.ap-note` con `.ap-ok`, `.ap-bad`, `.ap-warn` y `.ap-info`, `.ap-field`,
`.ap-label`, `.ap-hint`, `.ap-choice`, `.ap-table`, `.ap-dl`, `.ap-hash`, `.ap-lang`, `.ap-grid`, `.ap-row`, `.ap-stack`,
`.ap-inset`, `.ap-eyebrow`, `.ap-sub`, `.ap-muted`, `.ap-grad`.

Una página puede tener estilos propios para su contenido (una escena, un tablero), pero **solo con los tokens `--ap-*`**:
ningún color, fuente ni radio escrito a mano.

**Dónde se sirve la hoja:** en agentpey.com desde `apps/web/public/brand/`; en `vitrinee.agentpey.com` y en cada tienda, el
gateway de Vitrinee sirve el mismo archivo en `/brand/agentpey.css` y `/brand/agentpey-mark.svg`. La página de inicio de sesión
del MCP (`mcp.agentpey.com`) la lleva en línea, porque su CSP solo permite estilos en línea y ninguna fuente externa: ahí se ve con
la fuente del sistema.

## 4. Las páginas (13)

| Página | Dónde | Tema |
|---|---|---|
| Portada `landing.html` | agentpey.com | Siempre oscura, estilo keynote |
| Tiendas `tiendas.html`, En vivo `en-vivo.html` | agentpey.com | Sistema |
| Responder un reclamo `resolve/responder.html` | agentpey.com | Sistema |
| Firmar un Mandato `consent.html`, Revocar `revocar.html` | agentpey.com | Sistema |
| Laboratorio de wallets `wallet-lab.html` | solo local | Sistema |
| Recibo verificado `receipt-page.ts` | cada tienda | Sistema |
| Portal del comercio `vitrinee-portal`, panel `vitrinee-dashboard` | vitrinee.agentpey.com | Sistema |
| Consola del comprador `vitrinee-console` | local | Sistema |
| Inicio de sesión del conector `oauth/login-page.ts` | mcp.agentpey.com | Sistema, fuente del sistema |

Fuera de T207: la tienda Tapline (tema de Shopify; la ajusta la sesión de operaciones con estos colores y el logo) y las apps
de demostración RealOps, SignalDesk y el tablero de estado.

## 5. Cómo se revisa

Cada página, en claro y en oscuro, a 1280 px y a 390 px, con Chrome sin ventana:
`google-chrome --headless=new --window-size=1280,900 --screenshot=… <url>`. Las pruebas de cada app siguen en verde:
el rediseño cambia la apariencia, nunca el comportamiento (los `id`, los textos que leen las pruebas y los scripts quedan).
