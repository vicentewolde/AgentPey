Vas a construir T105 de AgentPey: el alta de un comercio en Vitrinee sin escribir código. Es la escena central del video del hackathon "Find Your Way", que se graba el martes 29 de septiembre de 2026. Hoy es jueves 24 de septiembre de 2026. Trabajas en /Users/vicentewolde/dev/AgentPay.

## Antes de tocar nada
1. Lee CLAUDE.md completo. Manda sobre cualquier skill.
2. Corre git status, git log --oneline -10 y git fetch. main está en 3daace5 o más nuevo y no hay ramas de trabajo abiertas. Los archivos sin trackear (.codex/, "logo agentpey/", este archivo y traspaso-plataforma-comercios.md) no son tuyos: nunca git add -A.
3. Lee docs/AGENT_LOG.md desde la entrada "2026-09-24 (1)" hasta el final.
4. Lee el PRD: docs/fase-6-agentguard-comercializacion/prd/T103-plataforma-comercios.md (manda sobre la copia en Exponential).
5. Lee las decisiones: C-140 a C-145 en docs/fase-6-agentguard-comercializacion/DECISIONES.md y VT-27 a VT-30 en docs/fase-6-agentguard-comercializacion/vitrinee/DECISIONES.md. Lee también vitrinee/INSTRUCCIONES.md (obligatorio antes de tocar cualquier cosa "vitrinee").
6. Lee docs/planificacion-exponential/README.md, SYNC.md y COMPARACION.md.
7. Ritual de apertura de Exponential:
   exponential tickets list --workspace personal-cmud6knil0045l704wuoc5b1r --product agentpey --json
   exponential actions list --project cmuebvdko001xl30497cuhc1z --json
   Compara con SYNC.md. Lo que cambió en la web pasa a SYNC.md; lo que toque alcance o decisiones se le muestra al usuario.
8. Resume en 5 líneas qué entendiste y qué vas a hacer, y espera el OK.

## Dónde estamos
- T100, T102, T103 y T104 están DONE y en producción. T101 sigue IN_PROGRESS (ver abajo).
- Vitrinee es la plataforma de comercios (C-140). Corre como cuarto proceso del servicio único de Render, en modo plataforma: comercios y pedidos en el esquema vitrinee de la base del piloto (Supabase, no Render), con un rol propio que no ve las tablas de AgentPey (C-143). Cada comercio tiene su llave de firma y sus credenciales de tienda sellados con AES-256-GCM (VT-27) y su propio subdominio <slug>.vitrinee.agentpey.com (C-142). Hoy hay un solo comercio: bazar-cordillera.
- AgentPey y RealOps leen el directorio público https://vitrinee.agentpey.com/api/comercios (C-141, C-145). Un comercio del directorio es una venue "vitrinee-<slug>:<cuenta de cobro>". AgentPey construye la URL de la tienda, fija los activos y fija el cobro a la cuenta del id.
- La compra real ya salió por ese camino (evidencia/T104.md § 6): 1,0421053 USDC de stickers desde un policy_rail, recibo con las tres comprobaciones en verde. El pedido quedó paid_unfulfilled porque Jumpseller responde 404 al crear pedidos.
- Hay dos pedidos pagados esperando en la base de Vitrinee: ord_muektgpgee1ebc73e5 (café) y ord_mufn0etw3d8329de61 (stickers). Se cumplen con `curl -X POST https://bazar-cordillera.vitrinee.agentpey.com/orders/<id>/fulfil`, sin volver a cobrar (VT-26), cuando Jumpseller funcione.

## T105, lo que hay que construir
Ticket cmueyt4lz001pjx04piff4zwy, rama cc/t105-alta-comercio (ya seteada), bloqueado por T103 y T104 (ambos DONE). Método EXPONENTIAL: /start-ticket, implementar, cierre de hito de CLAUDE.md, /ship-ticket, PARAR y esperar OK. Merge fast-forward manual con OK del usuario. Los comentarios usan -m, no -b.

El dueño de una tienda Jumpseller se da de alta solo, en el portal vitrinee.agentpey.com, y ve lo que le compraron:
1. Entra firmando con Freighter (SEP-0053): la cuenta conectada es su cuenta de cobro (VT-29). Sin firma válida no entra. La cookie de sesión vale solo en vitrinee.agentpey.com, nunca en los subdominios de las tiendas. Usa verifyStellarMessage de @agentpass/core, la pieza neutral que C-88 permite importar. Mira cómo apps/web hace la conexión de wallet para el patrón, sin importar nada de las apps de AgentPey.
2. Pega nombre, slug (máximo 31, C-145), login y token de API de Jumpseller (VT-28). Cuatro pruebas antes de guardar nada, cada una con su rechazo tipado y su test: el slug es válido y está libre; la cuenta de cobro existe y tiene línea de confianza de USDC de testnet (Horizon); las credenciales leen el catálogo (con JumpsellerStoreAdapter); la llave de firma nueva queda fondeada con XLM del friendbot. Si una falla, no se guarda nada. Las credenciales nunca vuelven a mostrarse.
3. Vitrinee genera la llave de firma, la sella con la llave maestra y registra el comercio (sealComercio, PostgresComercioStore). El comercio aparece en el directorio y, en menos de un minuto, en RealOps y AgentPey: el caché de la tienda es de 5 segundos y el del directorio, de 30.
4. Panel mínimo: URL de su tienda, estado, y sus pedidos con estado y enlace al recibo; nunca los de otro comercio. Si el tiempo no alcanza, lo primero que se cae es este panel. El alta se mantiene: es la escena del video.
5. Textos del portal en inglés por defecto más español latinoamericano neutro con tú. Nunca el carácter "—".
El conector de Jumpseller debe recibir "credenciales de tienda" sin asumir su forma, para que la app con OAuth de después del 29 no toque el resto (VT-28).

Código relevante: packages/vitrinee-gateway/src/platform/ (platform-app.ts, comercios.ts, postgres.ts, secret-box.ts, storefronts.ts), packages/vitrinee-adapters, apps/gateway/src/hosts.ts. Errores: VitrineeError con code nuevo si hace falta (no AgentPassError). Dinero en bigint. zod en todo borde.

## Lo que necesita al usuario
- Una segunda tienda Jumpseller para probar el alta. Recomendación dada: cuenta nueva en prueba gratuita (7 días, sin tarjeta, según jumpseller.com) con un par de productos. En prueba la lectura del catálogo debería funcionar; crear pedidos por API daba 403 (VT-21), así que la escena de compra se queda en Bazar Cordillera. No se sabe si una cuenta puede tener dos tiendas; el usuario lo prueba. Acción en Exponential cmueyu8l60035jx041ogelaea, vence el 26.
- Fecha objetivo de T105: 28 de septiembre (acción cmueyucwc003hjx042fystisz). El video es el 29.

## Pendientes del usuario que conviene recordarle
- Rotar la contraseña del rol de Vitrinee: pasó por el chat el 2026-09-24. Se hace en su terminal, no en la sesión de Claude: VITRINEE_MASTER_KEY='...' pnpm run vitrinee:platform-setup, y cargar la conexión nueva en Render.
- Borrar VITRINEE_ROOT_COMERCIO del panel de Render si no lo hizo (ya no corresponde desde T104). VITRINEE_BASE_URL nunca existió allí.
- scripts/vitrinee/platform-setup.ts tuvo dos fallos, corregidos en el PR de cc/fix-platform-setup (2026-09-24): comprobaba las llaves contra la dirección raíz de Vitrinee, que desde T104 ya no sirve la tienda, y cambiaba la contraseña del rol antes de comprobar la llave maestra. Ahora usa el subdominio del comercio y comprueba la llave maestra antes de tocar el rol.
- Jumpseller: el 404 "Account not found" en POST /v1/orders.json sigue sin respuesta (T101). Se le escribió a soporte; hay un mensaje de seguimiento nuevo.
- Métricas de COMPARACION.md: M7 y M9 de T103 y T104; M8 de la planificación (entrada de tiempo cmueyuydu0045jx046ow0jkp8, PROPOSED, la confirma él con exponential time confirm). T105 empieza con M7 pendiente.
- La clave de partner nueva (pnpm run partner:key -- --issue) y archivar el repo viejo vicentewolde/Vitrinee (ticket cmuedg4ld000pl004tv0q2n5o, bloqueado por T101).

## Reglas que se rompen más fácil
- Regla 1 de CLAUDE.md: para al cerrar cada hito y espera revisión. Regla 2: no cambies una decisión de DECISIONES.md por tu cuenta; si parece equivocada, muestra la evidencia y espera. Cada vez que cambies un DECISIONES.md, dile al usuario si AGENTS.md también necesita actualizarse.
- Idioma: docs/ en español. Código, comentarios, commits y README.md en inglés. Commits con el porqué, no solo el qué.
- Vitrinee: secretos en .env.vitrinee.local, nunca en .env.local. En Render sus variables llevan prefijo VITRINEE_. Decisiones con prefijo VT- (siguiente: VT-31) y C- (siguiente: C-146). contracts/receipt-registry no se redespliega sin permiso.
- Nada de custodia, llaves, firma, rails, fondos, grant firmado ni registro de comercios se delega a Codex (P-10).
- Tú nunca escribes ni lees claves, secretos ni tokens. Lección del 2026-09-24: un comando que imprime secretos (platform-setup) lo corre el usuario en su propia terminal, nunca desde la sesión de Claude, porque su salida llega al chat. Tú corres solo modos sin secretos, como --check.
- Nunca envías mensajes en su nombre. Cualquier gasto nuevo (plan, disco, dominio) se confirma viendo el precio en el panel antes de aceptarlo.
- Cada merge a main redespliega Render. Después de cada deploy, verifica en vivo lo que puedas sin secretos y anótalo en evidencia/T<n>.md.
- Cerrar hito: bitácora (bloque en lenguaje llano primero), evidencia, decisiones nuevas, AGENT_LOG con una línea "Exponential: qué cambié", SYNC.md y COMPARACION.md (M1, M2, M4, M5, M6 son tuyos; M7, M8, M9 del usuario). Estado en Exponential y en SYNC.md iguales.
- Fuera de alcance: mainnet, rieles fiat, AgentGuard, cobrarle a un comercio, la app de Jumpseller con OAuth (después del 29).

## Al cerrar la sesión
Entrada en docs/AGENT_LOG.md con branch, qué, por qué, qué queda pendiente y "Exponential: qué cambié".
