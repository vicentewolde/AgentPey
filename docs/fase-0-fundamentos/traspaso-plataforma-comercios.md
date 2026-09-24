Vas a planificar, con el método nuevo de Exponential, la plataforma de comercios de AgentPey: el espejo de RealOps para el lado de la oferta. Después la vamos a construir. Hoy es 2026-09-23 (noche). El video del hackathon "Find Your Way" se graba el martes 29 de septiembre de 2026. Trabajas en /Users/vicentewolde/dev/AgentPay.

## Antes de tocar nada
1. Lee CLAUDE.md completo. Manda sobre cualquier skill.
2. Corre git status, git log --oneline -10 y git fetch.
3. OJO: lo más reciente NO está en main. Está en la rama cc/t101-compra-real-jumpseller (PR #29, sin mergear a propósito, ver "Estado" abajo). Lee desde esa rama, sin hacer checkout si no hace falta (git show origin/cc/t101-compra-real-jumpseller:<ruta>):
   - docs/AGENT_LOG.md desde la entrada "2026-09-23 (8)" hasta el final.
   - docs/fase-6-agentguard-comercializacion/DECISIONES.md: C-88, C-114, C-130 a C-139.
   - docs/fase-6-agentguard-comercializacion/vitrinee/DECISIONES.md: VT-8, VT-10, VT-22 a VT-26.
   - docs/fase-6-agentguard-comercializacion/BITACORA.md: bloques T100, T102 y T101.
   - docs/fase-6-agentguard-comercializacion/vitrinee/INSTRUCCIONES.md (obligatorio antes de tocar cualquier *vitrinee*).
   - docs/fase-6-agentguard-comercializacion/PLATAFORMA-PARTNERS.md (modelo de entidades y fases).
4. Lee docs/planificacion-exponential/README.md, SYNC.md y COMPARACION.md, y P-13 en docs/DECISIONES.md. Ahí están el ritual, quién manda en qué, y cómo se adaptan las skills.
5. Exponential: el usuario ya renovó el token (2026-09-23). Ritual de apertura:
   exponential tickets list --product agentpey --json
   exponential actions list --project cmuebvdko001xl30497cuhc1z --json
   Compara con SYNC.md (el de la rama cc/t101-compra-real-jumpseller). Lo que cambió en la web pasa a SYNC.md; lo que toca alcance o decisiones se le muestra al usuario. Si un comando falla por autenticación, pídele al usuario un token nuevo.
6. Numeración: este chat toma los hitos desde T103. El chat de planificación paralelo que se había previsto nunca llegó a correr; su worktree AgentPay-plan y la rama cc/plan-exponential-t103 se borraron el 2026-09-23 (estaban vacíos).
Después resume en 5 líneas qué entendiste y qué vas a hacer, y espera el OK.

## La idea a planificar (del usuario, revisada)
- AgentPey es la infraestructura: identidad del agente, Mandato firmado, policy_rail con límites en la red, vault. Decide si un pago está permitido; no compra ni vende.
- RealOps es la demanda: personas con cuenta, que contratan agentes, les firman permisos y ven lo que compraron.
- Falta el espejo para la oferta: un lugar donde un comercio (hoy, una tienda Jumpseller) se registra, publica sus productos para agentes y ve lo que le compraron. Sin escribir código.
- Recomendación de la sesión anterior, para discutir, no decidida: que ese espejo sea Vitrinee hecho multi-tienda (ya tiene el conector a Jumpseller, catálogo x402, cobro, recibos firmados y anclados, y un panel de pedidos), y que SignalDesk siga siendo un comercio de ejemplo (C-88: vendedor independiente con sus propias llaves). El usuario proponía usar SignalDesk como esa plataforma; el nombre es decisión de marca, el motor sería el de Vitrinee.
- Lo que cada comercio valora de verdad es vender y que el pedido le llegue a su panel de Jumpseller. El portal le suma ventas de agentes, prueba del pago y recibos. Tenerlo presente para no prometer de más.

## Decisiones que el grill tiene que resolver, una pregunta a la vez
1. Qué producto es la plataforma (Vitrinee, SignalDesk o un nombre nuevo) y qué pasa con el otro.
2. Custodia (P-10): dónde viven las credenciales de Jumpseller y la llave de firma de recibos de cada tienda. La plata debería seguir yendo directo a la cuenta Stellar de cada comercio, sin pasar por nosotros.
3. Alta de un comercio: credenciales pegadas a mano, o una app de Jumpseller con autorización. Dato clave: Jumpseller (Carlos, soporte) ofreció marcar una tienda como "tienda de desarrollo" si se crea una app para su galería y se valida la identidad (https://jumpseller.com/support/apps/). Para un modelo multi-tienda, esa vía tiene sentido.
4. Registro de comercios: hoy cada tienda es una fila fija en apps/agent/src/catalog/venues.json (F7). Con muchas tiendas tiene que vivir en la base de datos. Toca cómo AgentPey resuelve un venue (por origen y dirección) y el grant firmado.
5. Identidad de cada tienda para los agentes: subdominio por tienda, ruta por tienda, o un venue con muchas cuentas payTo.
6. Dónde viven los pedidos. Hoy están en un archivo en el disco efímero de Render: un deploy los borra. Opción natural: Postgres, pero hoy Vitrinee no lee esa base a propósito (aislamiento de llaves y datos, C-136).
7. Qué entra antes del video del 29 y qué queda después. Con 6 días, probablemente una primera tajada vertical: una segunda tienda dada de alta por su dueño, sin tocar código.

## Cómo se trabaja (método EXPONENTIAL, P-13 y README de planificación)
1. /grill-with-docs: una pregunta a la vez, en español, actualizando CONTEXTO y DECISIONES de la fase mientras se decide. Registra el tiempo con exponential time log (métrica M8 de COMPARACION.md).
2. /to-prd: el PRD primero en el repo, en docs/fase-6-agentguard-comercializacion/prd/T<n>-<slug>.md, en español. Después se publica como Feature en Exponential con historias. Si difieren, manda el repo.
3. /to-expo: tickets verticales con "T<n> ·" en el título y --branch cc/t<n>-<slug>. Los que necesitan al usuario van en NEEDS_REFINEMENT. Los comentarios usan -m, no -b.
4. Cada hito: /start-ticket (anota la fecha de inicio en SYNC.md), implementar, cierre de hito de CLAUDE.md (bitácora, evidencia, decisiones, AGENT_LOG), /ship-ticket, PARAR y esperar OK. Merge fast-forward manual con OK del usuario. Nunca git add -A: los archivos .codex/ y "logo agentpey/" están sin trackear y no son tuyos.
5. Marcar cada ticket como EXPONENTIAL en SYNC.md y medir en COMPARACION.md (M1 a M9). Los números M7, M8 y M9 los da el usuario.

## Estado al traspaso (2026-09-23, noche)
- T100 DONE y T102 DONE (mergeados). Vitrinee corre en vivo en https://vitrinee.agentpey.com como cuarto proceso del servicio único de Render (C-134, C-136), con ADAPTER=jumpseller.
- Render: el servicio "AgentPey" se subió a 1 CPU y 2 GB (25 USD/mes, C-138) porque con 512 MB no cabían las cuatro apps. El dominio vitrinee.agentpey.com cuesta 0,25 USD/mes. El servicio NO sincroniza render.yaml: toda variable nueva se carga también en el panel.
- Rails de tenant nuevos: 25,00 por compra y 25,00 por día; crédito patrocinado 3 USDC (C-137). Reserva con ~90 USDC, 7 cupos de patrocinio.
- C-139 (mergeado): el cliente x402 paga como máximo lo que AgentPey autorizó (antes traía un tope escondido de 1 USD), y un error de la librería antes de firmar sale como PaymentNotCreated y devuelve el gasto.
- T101 IN_PROGRESS. La compra real se pagó: café 9,4631579 USDC, tx b8506514c0087fcf2d142bea6029e4858a3c7ac55253adc280f2c0a8c2aa3a93, recibo con las tres comprobaciones en verde. Pero Jumpseller responde 404 {"message":"Account not found."} a TODO POST /v1/orders.json (reproducido con curl, incluso pedido mínimo; la lectura sí funciona). El pedido de Vitrinee ord_muektgpgee1ebc73e5 quedó paid_unfulfilled. El usuario le escribió a soporte de Jumpseller; la primera respuesta no hablaba del 404. Borrador de seguimiento ya entregado al usuario.
- PR #29 (rama cc/t101-compra-real-jumpseller) SIN MERGEAR a propósito: agrega POST /orders/:id/fulfil (VT-26) y toda la documentación de T101. Cualquier merge a main redespliega y borra el pedido pendiente del disco efímero. Recomendación dada al usuario: cuando Jumpseller funcione, repetir la compra (9,46 USDC de testnet) en vez de pagar un disco. El usuario todavía no eligió. No mergees nada a main sin resolver esto con él.
- Métricas pendientes del usuario en COMPARACION.md: M9 de T100; M7, M8 y M9 de T102 y T101.
- Pendientes menores: clave de partner nueva (pnpm run partner:key -- --issue, la carga el usuario en Render); archivar el repo viejo vicentewolde/Vitrinee y apagar su servicio gratis viejo (ticket cmuedg4ld000pl004tv0q2n5o, bloqueado por T101).

## Reglas que se rompen más fácil
- Regla 1: para al cerrar cada hito y espera revisión. Regla 2: no cambies una decisión de DECISIONES.md por tu cuenta; si parece equivocada, muestra la evidencia y espera. Cada vez que cambies un DECISIONES.md, dile al usuario si AGENTS.md (las instrucciones de Codex) también necesita actualizarse.
- Idioma: docs/ en español. Código, comentarios, commits y README.md en inglés. Textos de páginas del piloto: inglés por defecto más español latinoamericano neutro con tú. Nunca el carácter "—".
- Errores tipados (AgentPassError en AgentPey, VitrineeError en Vitrinee; no unificarlos sin proponerlo). zod en todo borde. Nada de any. Dinero de Vitrinee en bigint. Ninguna credencial hardcodeada.
- Vitrinee: secretos en .env.vitrinee.local, nunca en .env.local. En Render sus variables llevan prefijo VITRINEE_ y solo le llegan a ella (envAliases, C-136). Decisiones con prefijo VT-. contracts/receipt-registry no se redespliega sin permiso.
- Nada de custodia, llaves, firma, rails, fondos, grant firmado ni venues se delega a Codex (P-10).
- Tú nunca escribes ni lees claves, secretos ni tokens. El usuario carga los secretos en Render y los tokens en el CLI. Tampoco envías mensajes en su nombre.
- Cualquier gasto nuevo (plan, disco, dominio) se confirma con el usuario viendo el precio en el panel antes de aceptarlo.
- Fuera de alcance: mainnet, rieles fiat, AgentGuard.

## Al cerrar la sesión
Entrada en docs/AGENT_LOG.md con branch, qué, por qué, qué queda pendiente, y una línea "Exponential: qué cambié". Ritual de cierre: estado en Exponential y en SYNC.md iguales.
