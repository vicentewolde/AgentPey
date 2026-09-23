# Decisiones — Fase 6 (AgentGuard + comercialización)

> Una entrada por decisión, con su motivo y la alternativa que se descartó.
> **No se borran entradas**: si una decisión se revierte, se marca como
> `Superada` y se agrega la nueva. Prefijo `C-` (de "Comercialización").

---

### C-1 · Un seed maestro derivado, no un secreto por tenant · `Vigente`
**Fecha:** 2026-09-09 (T32)

`@agentpey/tenancy` deriva las llaves de cada tenant desde un único seed
BIP-39 vía SEP-0005/BIP-44, en vez de generar y guardar un secreto Stellar
independiente por cada uno.

**Motivo.** Con presupuesto casi nulo y un solo desarrollador, la superficie
de custodia que hay que proteger, rotar y auditar debe ser mínima: un seed
maestro en un gestor de secretos es una sola cosa que vigilar, contra N
secretos independientes que crecen con cada tenant nuevo. Es el mismo
patrón que usa Privy (wallets-as-a-service) para wallets de usuario final,
aplicado al estándar propio de Stellar. El costo marginal de un tenant
nuevo pasa a ser una fila en una tabla (su índice), no un secreto nuevo que
alguien tenga que generar y guardar con cuidado.

**Alternativa descartada:** una cuenta cloud (KMS/HSM) por tenant, al
estilo Turnkey. Se descartó por costo — Turnkey cobra desde ~$99 USD/mes
más cargo por firma, muy por encima del techo de $200 USD/mes total del
proyecto — y por complejidad operativa desproporcionada para un piloto con
pocos partners.

### C-2 · El rol (`agent`/`issuer`) se codifica como paridad del índice de cuenta, no como una ruta de derivación separada · `Vigente`
**Fecha:** 2026-09-09 (T32)

Dado un `tenantIndex`, la cuenta SEP-0005 derivada es `tenantIndex * 2` para
el agente y `tenantIndex * 2 + 1` para el issuer — un único nivel de
derivación (`m/44'/148'/<cuenta>'`), no dos rutas distintas por rol.

**Motivo.** SEP-0005 define un solo nivel de cuenta hardened; introducir un
nivel adicional para "rol" habría sido una extensión no estándar del
esquema, sin ganar nada — la paridad par/impar ya garantiza que ningún
tenant colisiona consigo mismo, y es trivialmente invertible (dado un
índice de cuenta, se sabe a qué tenant y rol pertenece: `tenantIndex =
Math.floor(cuenta / 2)`, `role = cuenta % 2 === 0 ? "agent" : "issuer"`) sin
guardar esa relación en ningún lado.

**Alternativa descartada:** dos wallets HD independientes (dos seeds, o dos
sub-árboles de derivación) para separar agente e issuer. Se descartó por
innecesaria — la paridad resuelve la separación con la misma garantía
criptográfica y una sola frase semilla que proteger.

### C-3 · `@agentpey/tenancy` no lee `.env.local` ni ninguna variable de entorno · `Vigente`
**Fecha:** 2026-09-09 (T32)

El paquete recibe el seed maestro como parámetro de función; no tiene
ningún código que lea `process.env` ni archivos de configuración.

**Motivo.** Mismo principio de capas que el resto del monorepo:
`packages/*` es lógica pura y reusable, `apps/*` decide de dónde sale cada
secreto. Hoy `apps/web` seguiría leyendo `.env.local` en desarrollo; la
migración a un gestor de secretos (Doppler/Infisical) es una decisión de
`apps/web`, no de este paquete — así el paquete sigue siendo válido sin
cambios el día que esa decisión cambie.

**Alternativa descartada:** que el paquete leyera `MASTER_MNEMONIC` de
`process.env` directamente, para ahorrarle una línea a quien lo use. Se
descartó porque acopla una librería pura a una convención de configuración
de una sola app, y porque dificulta testear la función con valores
explícitos (como hacen los tests de este mismo hito).

### C-4 · `stellar-hd-wallet` se usa solo para derivar strings, nunca sus objetos `Keypair` · `Vigente`
**Fecha:** 2026-09-09 (T32)

`deriveTenantKeypair` devuelve `{ publicKey, secret }` como strings — nunca
un objeto `Keypair` de la librería `stellar-hd-wallet`.

**Motivo.** `stellar-hd-wallet` depende de `@stellar/stellar-base@13.1.0`
internamente, una versión distinta (y potencialmente distinta identidad de
clase en tiempo de ejecución) de la que trae `@stellar/stellar-sdk@17.0.1`
que ya usa el resto del proyecto. Devolver strings strkey (`G.../S...`) —
un formato de texto estándar, no un objeto de una librería específica— deja
que cualquier llamador reconstruya su propio `Keypair` con la versión del
SDK que ya tiene, sin arriesgar bugs de `instanceof` entre dos copias de la
misma clase.

**Alternativa descartada:** forzar una única versión de `@stellar/stellar-base`
en todo el monorepo vía resoluciones de pnpm. Se descartó por alcance —
resuelve un problema que ni siquiera se manifestó (los tests de este hito
no necesitaron ningún objeto `Keypair` de `stellar-hd-wallet`) a cambio de
fijar una dependencia transitiva de un paquete de terceros.

### C-5 · La columna `entry` es `json`, no `jsonb` · `Vigente`
**Fecha:** 2026-09-09 (T33)

`vault_records.entry` en Postgres se declaró `json`, después de que la
primera versión (`jsonb`) hiciera fallar `verify()` en el propio test de
integración del hito, no en teoría.

**Motivo, con el bug real encontrado.** `computeHash` recalcula sobre
`JSON.stringify({ seq, prevHash, entry })` — sensible al orden de las
claves. Postgres's `jsonb` normaliza el objeto al guardarlo (no promete
preservar el orden de inserción de las claves), mientras que `json`
preserva el texto exacto que se le dio. Con `jsonb`, un registro escrito y
después releído en una instancia nueva (exactamente lo que pasa después de
un reinicio) podía volver con las claves en otro orden — mismo contenido,
`JSON.stringify` distinto, hash recalculado distinto, `verify()` reportando
manipulación que nunca ocurrió. El test
`"survives being reconstructed — the exact scenario a Render restart
forces"` lo encontró de inmediato contra la base real.

**Alternativa descartada:** una función de hash con serialización canónica
(claves ordenadas alfabéticamente) en vez de cambiar el tipo de columna. Se
descartó porque `computeHash` ya es una pieza probada y compartida con el
backend de archivo (`createFileMandateVault`) — cambiarla habría invalidado
retroactivamente cualquier hash ya calculado y anclado on-chain (T28), y el
backend de archivo nunca tuvo este problema porque `JSON.parse`/
`JSON.stringify` de Node sí preservan el orden de las claves de punta a
punta. Cambiar la columna de Postgres es la corrección más chica que no
toca nada ya cerrado.

### C-6 · T33 mantiene el modelo de tenancy por sesión; la identidad Stellar propia por tenant queda para un hito aparte · `Vigente`
**Fecha:** 2026-09-09 (T33)

`createPostgresMandateVault` se cableó en `apps/web` usando el mismo
`sessionId` que ya identificaba cada visitante (antes, la clave de un
archivo JSONL; ahora, la columna `tenant_id`). Ninguna cuenta Stellar nueva
se deriva todavía con `@agentpey/tenancy` (T32) dentro de `apps/web` — todos
los visitantes siguen firmando con `AGENT_SECRET_KEY`/`ISSUER_SECRET_KEY`
compartidos.

**Motivo.** El problema identificado con más urgencia en la investigación de
`P-6` tenía dos mitades independientes: (a) el vault se borra en cada
reinicio de Render (arreglado acá, T33) y (b) los visitantes comparten
fondos e identidad (sigue sin resolver). Resolver (b) de verdad exige
decidir antes un modelo de onboarding —¿se fondea automáticamente una
cuenta nueva por tenant vía Friendbot + trustline de USDC en el momento en
que se crea?, ¿qué dispara "esto es un tenant nuevo" en vez de "otra visita
anónima"?— que todavía no se conversó con el usuario. Separar (a) de (b)
deja lista la pieza de infraestructura (persistencia real) sin bloquearla
en una decisión de producto que merece su propia conversación, siguiendo el
mismo criterio que ya usó `G-8` en la Fase 4 (documentar un hueco conocido
en vez de resolverlo apurado).

**Alternativa descartada:** cablear `@agentpey/tenancy` en el mismo hito,
asumiendo un fondeo automático vía Friendbot para cada tenant nuevo. Se
descartó porque es una decisión de producto (qué cuenta como "tenant", cómo
se fondea, qué pasa si el fondeo falla a mitad de un flujo) que el usuario
no había visto todavía — construirla sin esa conversación arriesgaba
resolver la pregunta equivocada.

### C-7 · Las escrituras del vault de Postgres se serializan con una cola de promesas dentro del proceso · `Vigente`
**Fecha:** 2026-09-09 (T33)

`createPostgresMandateVault` encadena cada `append()` sobre el resultado del
anterior (`writeQueue = writeQueue.then(...)`), en vez de dejar que dos
llamadas concurrentes corran su `INSERT` en paralelo.

**Motivo.** A diferencia del backend de archivo (`V-7`), cuya escritura es
enteramente síncrona y por lo tanto atómica dentro de un tick del event
loop, acá el `INSERT` es async — hay un punto real de suspensión
(`await pool.query(...)`) entre leer `records.length` (para calcular `seq`)
y confirmar la escritura. Sin serializar, dos llamadas a `record()` que se
superpongan podrían calcular el mismo `seq`/`prevHash` y competir por la
misma fila, violando la restricción `primary key (tenant_id, seq)` de forma
impredecible en vez de en orden. La cola de promesas garantiza que la
segunda llamada empiece a leer `records.length` recién después de que la
primera ya empujó su registro — mismo límite ya documentado que el resto
del proyecto acepta (durable dentro de un proceso, no entre más de uno
escribiendo el mismo `tenant_id` a la vez), ahora aplicado a un backend
async.

**Alternativa descartada:** un `SELECT ... FOR UPDATE`/transacción a nivel
de base de datos para serializar entre procesos también. Se descartó por
alcance — el pilot corre una sola instancia de `apps/web` a la vez; resolver
la concurrencia entre procesos es la misma pregunta que "más de una
instancia de Render" abre en general, no algo específico de este hito.

### C-8 · Conectar la wallet ata la identidad del vault, no todavía quién firma el Mandato · `Vigente`
**Fecha:** 2026-09-09 (T34)

El usuario pidió interacción Web3 real al registrarse — conectar una wallet
o crear una nueva. T34 conecta una wallet real (Freighter) y verifica
criptográficamente que el visitante la controla, pero **no** cambia quién
firma la credencial ni el Mandato — eso sigue siendo `ISSUER_SECRET_KEY`/
`AGENT_SECRET_KEY`, igual que antes de este hito.

**Motivo, con el límite técnico real detrás.** Para que la wallet conectada
fuera de verdad el "principal" que firma el Mandato, la firma del documento
tendría que ser un `Ed25519` crudo hecho por esa wallet — pero las wallets
(por diseño, para que un sitio no pueda hacerte firmar a ciegas una
transacción disfrazada de mensaje) no exponen firma cruda: exponen
`signMessage` (SEP-0043), que envuelve el mensaje con el prefijo
`"Stellar Signed Message:\n"` y lo hashea con SHA-256 antes de firmar
(SEP-0053). `verifyMandate` (Fase 3, cerrada) no sabe verificar esa forma —
espera el perfil JWS propio de AgentPass. Extender esa verificación para
aceptar una firma SEP-0053 como alternativa válida es un cambio real al
esquema de firma de una fase cerrada, y merece su propia revisión explícita
con el usuario antes de tocarlo — no se hizo de pasada en este hito.

**Qué sí se resolvió con esto.** La identidad del **tenant** (para efectos
de la bitácora de MandateVault, T33) ahora puede ser la wallet conectada en
vez de una cookie aleatoria por visita — ver `C-9`. Es progreso real hacia
multi-tenancy sin tocar la superficie de firma cerrada.

**Alternativa descartada:** firmar el Mandato con la llave de la plataforma
pero declarando `principal` como la wallet conectada. Se descartó de
inmediato — `checkMandate`/`verifyMandate` comparan que quien firmó
coincida con quien el documento dice ser (`SignerMismatch`); mentir sobre
quién firmó sería el mismo tipo de bypass que `B-25` (Fase 2) ya documentó
como inaceptable, solo que introducido a propósito en vez de por un bug.

### C-9 · El `tenant_id` de una wallet conectada es determinístico, no un UUID aleatorio · `Vigente`
**Fecha:** 2026-09-09 (T34)

`walletTenantId(address)` deriva el `tenant_id`/cookie de sesión de un
visitante conectado como `sha256(address)` recortado y reacomodado con
guiones para tener la misma forma que un UUID — no un UUID v5 real (sin
bits de versión/variante), y no un `randomUUID()`.

**Motivo.** Sin esto, cada visita —incluso de la misma wallet— generaría un
`tenant_id` nuevo (como pasaba antes de este hito), y la bitácora de
MandateVault de un usuario que vuelve nunca se encontraría a sí misma.
Con la derivación determinística, conectar la misma wallet dos veces —
verificado en vivo, dos veces— cae siempre en el mismo `tenant_id`, así
que su historial persiste entre visitas, no solo entre reinicios del
servidor (que ya resolvía T33).

**Alternativa descartada:** una tabla `wallet_sessions` en Postgres que
mapee `address → session_id` aleatorio, generado una vez y reusado después.
Se descartó por innecesaria — un hash determinístico da la misma garantía
(mismo input, mismo output, siempre) sin una tabla ni una consulta extra
antes de poder emitir la cookie.

### C-10 · `isConnected()` se llama antes que `requestAccess()`, nunca al revés · `Vigente`
**Fecha:** 2026-09-09 (T34)

El flujo de conexión llama primero a `freighterApi.isConnected()` y solo
sigue a `requestAccess()` si devuelve `true`.

**Motivo, con el bug real encontrado probando contra un navegador sin la
extensión instalada — no leyendo la documentación de Freighter.**
`requestAccess()` espera una respuesta de la extensión vía mensajería del
navegador; si no hay ninguna extensión escuchando, esa promesa **nunca se
resuelve ni rechaza** — cuelga el botón para siempre, sin ningún mensaje de
error. `isConnected()`, en cambio, responde rápido en los dos casos.
Encontrado corriendo la página real sin Freighter instalado y viendo el
botón quedarse colgado, no por inspección de código.

**Alternativa descartada:** envolver `requestAccess()` en un timeout
propio (ej. `Promise.race` con un `setTimeout` de unos segundos). Se
descartó porque agrega un número mágico (¿cuántos segundos son
"razonables" para que alguien apruebe en su wallet?) a cambio de resolver
un problema que `isConnected()` ya resuelve gratis y sin inventar nada.

### C-11 · Deferred, sin construir todavía: una cuenta Stellar propia y fondeada por tenant · `Vigente`
**Fecha:** 2026-09-09 (T34)

`@agentpey/tenancy` (T32) sigue sin cablearse dentro de `apps/web` — cada
tenant, wallet conectada o no, sigue gastando desde la cuenta compartida
`AGENT_SECRET_KEY`.

**Motivo — el bloqueante real no es de código, es de un tercero.**
`scripts/fund-usdc-trustline.ts` (Fase 4) ya documentaba esto: la
trustline de USDC se puede abrir por script, pero el **saldo** de USDC
solo se puede cargar a mano, en el faucet de testnet de Circle (un
formulario web de terceros, no una API). Derivar y fondear con XLM una
cuenta nueva por tenant es automatizable (Friendbot); dejarla con USDC de
verdad para que pueda comprar algo, no — necesitaría una pantalla nueva
("tu wallet no tiene USDC todavía, andá a este faucet") que todavía no se
diseñó ni se le mostró al usuario.

**Alternativa descartada:** lanzar el fondeo automático igual, aceptando
que el primer intento de compra de cada tenant nuevo falle por falta de
saldo. Se descartó porque enviar a alguien a probar el producto y que
falle en el primer clic, sin explicación, es peor que no ofrecer la cuenta
propia todavía — mejor un hueco anotado que una demo rota.

### C-12 · El pool de Postgres pide SSL explícitamente, sin verificar la CA · `Vigente`
**Fecha:** 2026-09-09

`createPostgresMandateVault` pasa `ssl: { rejectUnauthorized: false }` a su
`Pool` de `pg` — antes no pasaba ninguna opción de `ssl`.

**Motivo, con el bug real en producción que lo disparó.** El usuario probó
`apps/web` desplegado en Render y "Iniciar sesión" falló con "could not
reach or initialise the vault's Postgres database" — el mismo código que
en local (contra la misma base de Supabase) funcionaba sin problema.
Supabase exige TLS para conexiones externas; `pg` no lo negocia solo a
partir de una cadena `postgresql://` común, y el paquete de autoridades
certificadoras que trae Node por defecto no incluye la cadena de Supabase
— por eso hace falta `rejectUnauthorized: false` (sigue siendo una
conexión cifrada; lo que se salta es la verificación de la CA, no el
cifrado en sí). Es el mismo ajuste que documentan casi todas las guías de
"conectar Supabase desde Render/Vercel/Heroku". Verificado localmente
antes de aplicarlo: conecta igual con la opción puesta, así que no hay
riesgo de regresión en desarrollo.

**Nota de higiene, en el mismo cambio.** El error real que causó esto
nunca llegaba a ningún lado — ni a los logs del servidor (nada llamaba a
`console.error`) ni a la respuesta HTTP (`details` no llevaba el mensaje
de la causa). Se agregó `console.error` en el punto exacto de la falla y
se sumó `details.cause` al error, que ahora también se muestra en la
página (`apps/web/public/index.html`) — la próxima vez que algo similar
falle, no va a hacer falta adivinar ni pedir los logs de Render a ciegas.

**Alternativa descartada:** verificar la CA de verdad, cargando el
certificado raíz de Supabase explícitamente. Se descartó por ahora —
agrega un archivo más para mantener sincronizado si Supabase rota su CA,
a cambio de una garantía que no cambia el riesgo real del proyecto (los
datos que viajan por acá son la bitácora de un piloto en testnet, no
información sensible de producción).

### C-13 · La wallet firma el Mandato por un camino de verificación paralelo, no extendiendo `verifyMandate` (JWS) · `Vigente` — resuelve el hueco de `C-8`
**Fecha:** 2026-09-09 (T35)

`packages/mandate/src/wallet-sign.ts` agrega `verifyWalletSignedMandate` como
una función nueva e independiente de `verifyMandate` — no una rama dentro de
ella. Un Mandato firmado por wallet no tiene JWS: es el documento en JSON
canónico más una firma SEP-0053 sobre un mensaje-resumen legible
(`mandateChallengeMessage`), verificada con `verifyStellarMessage` (`C-9`,
Fase 6, ya existente desde T34's wallet-connect).

**Motivo, con la incompatibilidad criptográfica real detrás — la misma que
`C-8` dejó anotada sin resolver.** Un JWS compacto EdDSA firma los bytes
crudos de `header.payload`, sin ningún prehash. SEP-0053 (lo único que una
wallet expone para firmar texto arbitrario) firma
`sha256("Stellar Signed Message:\n" + mensaje)` — un esquema de bytes
distinto, no una variante del mismo. Ninguna wallet puede producir jamás una
firma JWS válida; no es una limitación de Freighter en particular, es cómo
está diseñado el estándar (para que un sitio no pueda hacer firmar a ciegas
algo que parece un mensaje pero es otra cosa). Extender `verifyMandate` para
aceptar además una firma SEP-0053 habría significado ramificar una función
de una fase cerrada (Fase 3) según de dónde vino la firma — exactamente el
tipo de cambio silencioso a una decisión cerrada que `CLAUDE.md` prohíbe sin
avisar primero. Se avisó (con esta evidencia) antes de construir nada.

**Cómo quedó separado, en la práctica.** `MandateSource` (`apps/agent`) es
ahora `string | { mandate, signature }` — una unión, no un envoltorio con
discriminador — así que todo el código que ya pasaba un JWS crudo (agente,
tools, tests) sigue compilando sin cambios. `checkOwnMandate` y
`createOnChainMandateVerifier` despachan según `typeof source` hacia
`verifyMandate`+`verifyMandateOnChain` (JWS) o hacia
`verifyWalletSignedMandate`+`verifyWalletSignedMandateOnChain` (wallet) — las
dos ramas comparten el chequeo on-chain (`checkOnChainStatus`, extraído en
este hito) pero nunca comparten la verificación offline de la firma.

**Alternativa descartada.** Ramificar `verifyMandate` internamente según la
forma del string recibido (JWS vs. algo más). Se descartó de inmediato por
la razón de arriba — tocar una función cerrada de la Fase 3 en vez de sumar
una nueva al lado.

### C-14 · Anclar y revocar un Mandato firmado por wallet es un flujo de dos fases (`prepare` → firma en la wallet → `submit`), reusando `AssembledTransaction` de la Fase 1 · `Vigente`
**Fecha:** 2026-09-09 (T35)

`Registry.prepareAnchor`/`prepareRevoke` (`packages/sdk`) arman y simulan la
misma llamada al contrato que `anchor()`/`revoke()` ya hacían, pero se
detienen antes de firmar: devuelven `{ requestId, xdr }` (la transacción sin
firmar, serializada). `Registry.submitSigned(requestId, signedTxXdr)` la
retoma más tarde y la envía, usando el `signedTxXdr` que la wallet devolvió
como si fuera la respuesta de un `signTransaction` normal
(`.signAndSend({ signTransaction: async () => ({ signedTxXdr }) })`).

**Motivo.** Anclar un Mandato en `agent_registry` exige que quien lo firma
sea `issuer.require_auth()` — la wallet, no este servidor, que nunca tuvo ni
va a tener su llave secreta. Una transacción no se puede firmar a mitad de
una petición HTTP y esperar a que el navegador la apruebe: hacen falta como
mínimo dos idas y vueltas (preparar, firmar en la wallet, enviar). En vez de
reconstruir esto a mano contra XDR/RPC crudo, se usó
`AssembledTransaction` — la misma abstracción de `@stellar/stellar-sdk/contract`
que la Fase 1 ya trae adentro de `Client.from(...)` — porque ya expone
exactamente esta forma: `.toXdr()` para serializar sin firmar, y
`.signAndSend({ signTransaction })` acepta cualquier callback con la firma
de una wallet real, sin que este proyecto tenga que saber nada del formato
interno de la transacción.

**Por qué el `Registry` recuerda la transacción preparada en memoria, por
`requestId`, en vez de que el cliente la reenvíe completa.** Enviar solo la
firma (no la transacción entera de vuelta) es más chico y evita que un
cliente que edite el XDR a mano cuele una transacción distinta a la que se
simuló. El costo es que `pendingWrites` vive en memoria del proceso — con
TTL de 10 minutos, igual que `pendingWalletSessions` en `apps/web` — y por
eso las tres peticiones del flujo (`start` → `wallet-consent` → `wallet-anchor`)
tienen que compartir la misma instancia de `AgentPass`/`Registry`: una
instancia nueva por petición no sabría nada del `requestId` que una
petición anterior generó. `apps/web` lo resuelve guardando la instancia
completa en `PendingWalletSession`, no solo sus datos.

**Alternativa descartada.** Reconstruir la transacción a mano (leer el XDR,
armar los `Operation`, firmar) sin pasar por `AssembledTransaction`. Se
descartó por riesgo — reimplementar algo que el propio SDK de Stellar ya
resuelve y prueba, con auth entries de Soroban que son fáciles de armar mal
a mano.

### C-15 · Una wallet conectada se registra como issuer automáticamente, sin aprobación manual · `Vigente`
**Fecha:** 2026-09-09 (T35)

`ensureWalletIsRegisteredIssuer` (`apps/web/src/server.ts`) llama a
`registerIssuer` con la llave de administrador apenas una wallet verificada
(T34) intenta anclar su propio Mandato, si todavía no está registrada o
activa — sin ningún paso intermedio de revisión humana.

**Motivo.** Confirmado explícitamente con el usuario (pregunta directa,
antes de construir esto): para un piloto en testnet, "conectó y probó
criptográficamente que controla la wallet" ya es suficiente confianza para
dejarla anclar sus propios Mandatos — pedir una aprobación manual agregaría
fricción a la demo sin una amenaza real detrás en este contexto (testnet,
sin fondos reales en juego). Es una elección deliberada para esta etapa, no
una política que se vaya a llevar a producción sin revisarla de nuevo.

**Alternativa descartada.** Una cola de aprobación manual (el admin revisa y
aprueba cada wallet nueva antes de que pueda anclar). Se descartó por
alcance — resuelve un problema de confianza que este piloto todavía no
tiene (no hay fondos reales en juego, es testnet) a cambio de fricción real
en cada demo.

### C-16 · Deferred, sin construir en este hito: cuentas propias fondeadas por tenant, aunque la precondición de USDC ya no lo bloquea · `Vigente`
**Fecha:** 2026-09-09 (T35)

Con la wallet ahora firmando de verdad su propio Mandato, el agente sigue
gastando desde la cuenta compartida `AGENT_SECRET_KEY` — `@agentpey/tenancy`
(T32) sigue sin cablearse dentro de `apps/web`. El usuario ya removió el
bloqueante de fondeo de `C-11` (asumiendo que quien conecta su wallet ya
tiene USDC de testnet cargado de antes), pero eso resuelve la mitad del
problema, no las dos.

**Motivo.** Cablear identidad Stellar propia por tenant es una pieza
independiente de que la wallet firme el Mandato — el usuario pidió
explícitamente "dale con la firma del mandato" como alcance de este hito,
no "dale con todo lo de tenancy". Sumarlo de pasada habría sido expandir el
alcance sin que el usuario lo pidiera, la misma razón que ya justificó
`C-6` en T33.

**Alternativa descartada:** cablear `@agentpey/tenancy` en el mismo hito ya
que la precondición de USDC lo desbloquea. Se descartó por alcance — sigue
faltando decidir cómo y cuándo se deriva el índice de tenant de cada
wallet nueva, una conversación de producto que no se tuvo todavía.

### C-17 · La credencial nombra a la wallet como `principal` aunque la siga emitiendo la plataforma · `Vigente`
**Fecha:** 2026-09-10 (T35, corrección)

Cuando hay una wallet conectada, el `credentialSubject.principal` de la
credencial AgentPass es el DID de esa wallet — el mismo que el `issuer` del
Mandato. El `issuer` de la credencial sigue siendo la plataforma
(`ISSUER_SECRET_KEY`), sin cambios.

**Motivo, con el bug real en producción que lo forzó.** T35 hizo que el
Mandato lo firmara la wallet, pero dejó la credencial diciendo que el
principal del agente era la plataforma. `checkMandate` (T17, Fase 3)
compara `mandate.issuer` contra `intent.principal`, y `intent.principal`
se lee de la credencial — así que los dos documentos firmados se
contradecían y **toda compra** de una sesión con wallet fallaba con
`MandatePrincipalMismatch`. El chequeo hizo exactamente lo que debía: es
la evidencia de consentimiento la que no cerraba. Ahora los dos documentos
derivan el principal de un único valor (`principalDid` en `startSession`),
así que no pueden volver a separarse.

**Qué asunción de la Fase 1 cambia esto, dicho explícitamente.**
`packages/core/src/credential.ts` documentaba que `principal` era "siempre
el DID del propio emisor en este piloto — no hay un rol de principal
separado". T35 crea exactamente ese rol separado: la plataforma **atesta**
la identidad y el scope del agente (emisor), la wallet **consiente** el
gasto (principal). Ninguna verificación exigía que coincidieran —era una
observación, no una regla, y no hay ningún esquema ni chequeo que cambie—,
pero el comentario se actualizó para que no siga afirmando algo que dejó
de ser cierto.

**Alternativa descartada:** relajar `checkMandate` para que aceptara un
`principal` distinto del emisor del Mandato. Se descartó de inmediato — es
el chequeo que prueba que quien consintió es quien dice el intent; aflojarlo
sería exactamente el tipo de bypass que `B-25` (Fase 2) dejó documentado
como inaceptable. El problema nunca estuvo en el chequeo, sino en cómo
`apps/web` armaba los documentos.

### C-18 · `apps/web` se testea por costuras extraídas, no levantando el servidor · `Vigente`
**Fecha:** 2026-09-10 (T36)

`server.ts` se partió en tres módulos que no tocan la red ni el estado del
servidor — `env.ts` (leer y validar configuración), `session-documents.ts`
(construir la credencial y el Mandato) y `wallet-session.ts` (cookies,
nonces, y el estado efímero del flujo de wallet) — y los tests apuntan a
esos módulos. `server.ts` queda como cableado, rutas y `listen`.

**Motivo, elegido a partir de dónde fallaron las cosas de verdad.** Los tres
fallos de producción de T35 estuvieron exactamente en dos de esas costuras:
dos en la lectura de configuración (`ADMIN_SECRET_KEY` sin declarar, después
con una clave pública en vez del secreto) y uno en la construcción de los
documentos (`C-17`). Ninguno era un bug de red ni de HTTP; los tres eran
lógica pura que no tenía un solo test porque vivía dentro de un archivo que
levanta un servidor apenas se lo importa. Extraer la lógica pura es lo que
la vuelve testeable sin base de datos, sin testnet y sin puerto.

**Alternativa descartada:** exportar `handle(req, res)` y testear al nivel
de HTTP con `req`/`res` simulados. Se descartó porque el camino más
interesante —iniciar sesión— llama a testnet, a Postgres y al bazaar en la
misma función: un test así necesitaría simular todo eso para llegar a la
línea que importa, y terminaría probando los dobles más que el código. Los
caminos HTTP siguen verificándose como hasta ahora, de punta a punta contra
testnet real, que es donde ese tipo de camino sí se prueba de verdad.

**Un cambio de comportamiento chico, deliberado, en el mismo movimiento.**
Las sesiones de wallet a medio terminar vivían en dos `Map` paralelos (el
valor en uno, su vencimiento en el otro) que había que mantener sincronizados
a mano en cada llamada. Ahora hay un solo `createExpiringStore`, con el
vencimiento chequeado al leer, compartido con los nonces del challenge. De
paso, el nonce se consume **antes** de verificar la firma, no después: un
nonce se gasta por ser presentado, así que una firma incorrecta ya no puede
reintentarse contra el mismo challenge.

### C-19 · Un tenant es la relación (partner, usuario final), no el partner ni el workspace · `Vigente`
**Fecha:** 2026-09-10 (T37)

`CloudOps` es un **partner**. Cada usuario final suyo —`usr_123`— tiene su
propio **tenant**, aislado del resto. El escenario objetivo que el usuario
describió es de ~500 partners con miles de usuarios cada uno, es decir del
orden de **un millón de tenants**; el primer escenario a construir es
deliberadamente de dos partners, dos usuarios y dos comercios.

**Motivo.** Es la única lectura que sostiene las distinciones del brief: un
mismo principal usando la misma wallet con dos partners tiene que quedar en
espacios separados, y eso solo pasa si el tenant incluye al partner **y** al
usuario. Un tenant por partner metería a todos sus usuarios en el mismo
`perDay` y la misma bitácora.

**Consecuencia que obliga a `C-20` y `C-21`.** Un millón de tenants no es una
abstracción gratuita: bajo el modelo de fondos elegido, cada tenant querría
una cuenta Stellar y un contrato propios, y ambos cuestan saldo bloqueado y
renta en la cadena. Ver `C-21`.

**Alternativa descartada:** tenant = partner, con el usuario final como un
`principal` más dentro de él. Se descartó porque colapsa el aislamiento que
es la razón de ser de la entidad — y porque el brief pide explícitamente que
"un mismo principal pueda usar la misma wallet con varios partners y tener
tenants, agentes y mandatos separados".

---

### C-20 · El modelo de fondos del producto es el smart account por tenant, fondeado por el principal · `Vigente`
**Fecha:** 2026-09-10 (T37)

De las cuatro alternativas presentadas en
[PLATAFORMA-PARTNERS.md §4.1](PLATAFORMA-PARTNERS.md), el usuario eligió la
**opción 3**: Vinny fondea un `policy_rail` propio de su tenant, y el agente
gasta desde ahí con `per_tx`/`per_day` aplicados por la red dentro de la
misma transacción que mueve el dinero.

**Motivo.** Es la única de las cuatro donde los límites los aplica la cadena
y no el software, y es literalmente la tesis del proyecto ya escrita en Rust
(`contracts/policy-rail`, T22/T31). La opción 1 (la wallet firma cada pago)
elimina la autonomía que da sentido al producto; la opción 2 se descartó por
un hecho del protocolo y no por preferencia —Stellar da a los firmantes
adicionales *pesos y umbrales, no montos*, así que una "clave de sesión"
sobre una cuenta clásica tiene poder sobre todo el saldo—; la opción 4
(custodia total) es lo que el producto hace hoy en testnet y lo que su propia
narrativa dice que no hay que hacer.

**Lo que queda explícitamente rotulado, no escondido.** La opción 4 sigue
existiendo como **modo demo de testnet**, apagable, para que el visitante
casual pueda probar sin fondear nada. Lo que cambia es que deja de ser el
único modo y deja de ser el modo por omisión de un tenant real.

**Precondición registrada, no construida.** `contracts/policy-rail/src/lib.rs`
no tiene retiro, ni rotación de owner, ni revocación: quien fondee un rail
cuyo owner tenga AgentPey **no puede recuperar su saldo**. En testnet con
montos simbólicos es tolerable y así queda. Antes de cualquier fondo real es
bloqueante. Es un cambio de contrato — área restringida por `CLAUDE.md` — y
**no se construye sin pedido explícito del usuario**.

**Segunda limitación del contrato, encontrada al leerlo para esta decisión.**
`policy_rail` fija **un solo asset** en su constructor (`asset`, documentado
en su propio docstring como simplificación deliberada de `M-14`). Un tenant
que quiera comprar en dos assets necesita dos rails, o un cambio de contrato.
Se registra; no se resuelve.

**Alternativa descartada:** decidir esto más adelante y avanzar con la cuenta
compartida. Se descartó porque el modelo de fondos gobierna el modelo de
entidades, el onboarding y la superficie de API — construir esas tres cosas
sin la decisión tomada garantiza rehacerlas.

---

### C-21 · La identidad on-chain de un tenant se crea de forma perezosa: derivar es gratis, existir en la cadena no · `Vigente`
**Fecha:** 2026-09-10 (T37)

Crear un tenant **no** despliega nada en Stellar. Se le asigna su índice de
derivación y se calcula su par de llaves (`deriveTenantKeypair`, T32), que es
una operación local, offline y sin costo. La cuenta Stellar del agente y el
contrato `policy_rail` del tenant se crean **recién cuando ese tenant va a
gastar de verdad**.

**Motivo, con los números del propio repo.** Bajo `C-19` (un millón de
tenants) y `C-20` (un rail por tenant), crear todo por adelantado significa:
una cuenta Stellar por agente, cada una con el saldo mínimo que la red exige
para que la cuenta exista, más un despliegue de contrato por tenant con su
fee y su renta. El spike de T22 fondeó su rail de prueba con **1 XLM**
(`docs/fase-3-policyrail-mandato/evidencia/T22-spike.md` §8) y midió que la
renta de TTL es la partida que domina el costo —203 831 stroops contra
48 886 sin ella, §9.1—. Multiplicado por un millón de tenants, el costo de
existir en la cadena es del orden de un millón de XLM inmovilizados. La
inmensa mayoría de los usuarios de un partner nunca van a comprar nada.

**Alternativa descartada:** crear la cuenta y el rail al dar de alta el
tenant, para que "todo esté listo". Se descartó por el costo de arriba y
porque no compra nada: el momento en que el tenant necesita su identidad
on-chain es exactamente el momento en que consiente y fondea, no antes.

---

### C-22 · La integración es híbrida: API hospedada para lo que debe ser hospedado, SDK local para lo que debe ser verificable · `Vigente`
**Fecha:** 2026-09-10 (T37)

Confirmado por el usuario. **Hospedado por AgentPey:** alta de tenants y
agentes, flujo de consentimiento, custodia de las llaves derivadas, la
decisión de autorización que necesita estado (`perDay`), la bitácora y los
webhooks. **Biblioteca local en el partner:** verificar la credencial,
verificar el Mandato, `checkScope`, `checkMandate`, armar el
`PurchaseIntent`, hablar x402.

**Motivo.** El proyecto ya está construido así y la tesis depende de ello:
`@agentpass/core`, `@agentpass/sdk`, `@agentpey/mandate` y el motor de
`apps/agent` son bibliotecas puras, verificables sin red. Obligar a un
partner a preguntarle a una API si un Mandato es válido, cuando puede
verificar la firma él mismo, destruye la propiedad que hace al producto
distinto ("verificable, no confiable"). A la inversa, el consentimiento y la
bitácora tienen que estar hospedados porque su valor es justamente que no los
controla la parte interesada: un consentimiento que renderiza el partner deja
de ser evidencia de nada.

**Alternativa descartada:** solo SDK (cada partner hospeda todo), que hace
del consentimiento algo fabricable por el propio partner; y solo API, que
tira la verificabilidad local.

---

### C-23 · El primer partner y el primer comercio los construimos nosotros · `Vigente`
**Fecha:** 2026-09-10 (T37)

El usuario quiere diseñar él mismo, más adelante, un partner de referencia y
un comercio de referencia para la primera compra. Hasta entonces, el piloto
no depende de ningún tercero.

**Motivo, y por qué es una mejora sobre el plan anterior.** El riesgo
transversal número uno del `ROADMAP.md` §5 es la dependencia del embajador —
bloqueante directo en la Fase 2 y estructural en la Fase 4. Construir un
partner y un comercio propios lo elimina del camino crítico: el bazaar del
embajador pasa de ser la única integración posible a ser **la segunda**, lo
que además es la prueba real de que el camino de comercio se generalizó
(F7). Un comercio propio también permite ejercitar las variantes que un
tercero no va a producir a pedido: un `402` con un precio distinto al
cotizado, un asset no autorizado, un destinatario que no coincide.

**Alternativa descartada:** esperar a un partner externo antes de diseñar la
API. Se descartó porque congela el trabajo detrás de una conversación que no
depende de nosotros, y porque una API diseñada sin ningún integrador —ni
propio ni ajeno— se diseña a ciegas.

---

### C-24 · El éxito del piloto en testnet es el flujo completo con todas sus variantes, con una entidad de cada tipo · `Vigente`
**Fecha:** 2026-09-10 (T37)

Definición del usuario, textual: el flujo completo de punta a punta con todas
sus variantes y condicionales, con al menos un usuario, un partner, un
comercio, un agente, una compra y todo lo que la compra involucra. Cada
entidad puede ser externa o construida por nosotros (`C-23`).

**Qué significa "todas sus variantes", para que el criterio sea verificable y
no una intención.** No solo el camino feliz: también cada rechazo que el
sistema sabe producir. Como mínimo — venue no autorizado, asset no
autorizado, monto sobre `perTx`, acumulado sobre `perDay`, mandato fuera de
vigencia, mandato revocado, credencial revocada, principal que no coincide
con el firmante, y un `402` cuyo precio no reconcilia con lo firmado. Cada
uno con su código de error tipado y su registro en la bitácora.

**Motivo.** Es un criterio de completitud, no de volumen: no pide escala,
pide que ninguna rama del árbol de decisión quede sin ejercitar. Encaja con
cómo se verificó cada hito de las Fases 1 a 5.

**Alternativa descartada:** una métrica de volumen (N compras, N partners) o
de tiempo de integración. Se descartaron porque en testnet, sin usuarios
reales, ambas se pueden inflar sin que prueben nada.

---

### C-25 · Decisiones menores resueltas junto con las anteriores · `Vigente`
**Fecha:** 2026-09-10 (T37)

Cerradas sin discusión aparte, siguiendo las recomendaciones de
[PLATAFORMA-PARTNERS.md §4.2](PLATAFORMA-PARTNERS.md):

- **`D4` — namespace del `tenant_id` en el vault:** `<partner_id>:<ULID>`,
  no `sha256(wallet)`. El actual colisiona entre partners, que es
  exactamente lo que `C-19` prohíbe. Las filas ya escritas en
  `vault_records` bajo el id viejo **se quedan donde están**: reescribirlas
  rompería la cadena de hashes, que es lo único que el vault promete.
- **`D5` — fase:** esto sigue siendo **Fase 6**, no una fase nueva. Sus
  etapas 2 y 3 documentadas (`CONTEXTO.md` §5) son literalmente este
  trabajo.
- **`D1` — seed maestro:** gestor de secretos (Doppler o Infisical) cuando
  se cablee la derivación (F4), no antes. Confirma lo que `C-3` anticipó.
- **`D2` — quién emite la credencial:** la plataforma, como hoy (`C-17`).
- **`D3` — alta de emisores on-chain:** por partner al alta, **no** por
  wallet conectada. Reemplaza el registro automático de `C-15`, que es un
  camino de escritura on-chain sin límite pagado por la clave admin y
  disparable por cualquiera. `C-15` queda **superada** cuando F5 lo
  implemente; hasta entonces sigue vigente en `apps/web`.
- **`D6` — correlación de una misma wallet entre partners:** se acepta y se
  declara en testnet; se reevalúa antes de cualquier consideración de
  mainnet.

**Diferidas a pedido del usuario, sin decidir:** qué pasa cuando alguien
conecta varias wallets, y toda condición previa a mainnet. Ninguna de las dos
bloquea el trabajo inmediato.

---

### C-26 · El paquete se llama `@agentpey/directory`, no `registry` · `Vigente`
**Fecha:** 2026-09-10 (T38)

El paquete que guarda partners, tenants, principals, agentes, credenciales y
mandatos se llama **directory**.

**Motivo.** "Registry" ya está tomado dos veces en este monorepo y las dos
veces significa otra cosa: `agent_registry` es el contrato Soroban donde se
anclan y revocan hashes (Fase 1), y `packages/sdk/src/registry.ts` es su
cliente. Un tercer "registry" que nombrara un conjunto de tablas Postgres
obligaría, para siempre, a preguntar cuál de los tres es en cada conversación
—y la confusión caería justo sobre la palabra que nombra el punto de
revocación—.

**Alternativa descartada:** meterlo dentro de `@agentpey/tenancy`. Se descartó
porque ese paquete es deliberadamente puro: no lee entorno, no hace I/O, no
tiene dependencias fuera de la derivación (`C-3`). Agregarle un `Pool` de
Postgres rompería exactamente la propiedad que lo hace testeable sin nada
alrededor.

---

### C-27 · El índice de derivación se asigna por **agente**, no por tenant · `Vigente` — refina `C-1`
**Fecha:** 2026-09-10 (T38)

`deriveTenantKeypair(masterMnemonic, tenantIndex, role)` (T32) mapea un índice
a un par de llaves. Lo que ese índice identifica, desde este hito, es **una
identidad derivada** — y un tenant tiene una o varias, no exactamente una.

**Motivo.** El modelo objetivo pide explícitamente que un tenant pueda tener
más de un agente, y que renovar un mandato no cree un agente nuevo. Con un
índice por tenant, el segundo agente de un tenant no tendría de dónde derivar
llaves. `C-1` y `C-2` se escribieron en T32, antes de que existiera el modelo
de entidades de `C-19`, y asumían la correspondencia uno a uno que ese modelo
después descartó.

**Qué cambia y qué no.** El esquema de derivación de T32 no se toca: sigue
siendo `m/44'/148'/<índice>'` con paridad par/impar para el rol, y sigue
siendo cierto que dos índices distintos nunca colisionan. Lo único que cambia
es quién recibe un índice. `@agentpey/tenancy` no se modificó en este hito;
cuando F4 lo cablee habrá que decidir si el parámetro se renombra o se
documenta el mapeo — anotado, no resuelto.

**Confirmado leyendo el código, no supuesto:** el owner del `policy_rail` es
la llave del agente (`apps/web/src/server.ts`, `ownerSecret: current.agentSecret`),
así que "una identidad derivada" y "una cuenta que puede gastar" son la misma
cosa, y por eso la unidad correcta de asignación es el agente.

**Alternativa descartada:** darle un índice al tenant y derivar los agentes
como sub-rutas de ese índice. Se descartó porque exigiría cambiar el esquema
de derivación de T32 —una pieza cerrada y testeada— para resolver algo que la
asignación de índices ya resuelve sin tocarla.

---

### C-28 · El índice sale de una secuencia de Postgres, no de `max(key_index) + 1` · `Vigente`
**Fecha:** 2026-09-10 (T38)

`directory_key_index_seq`, leída con `nextval`, fuera de la transacción que
inserta el agente.

**Motivo.** El requisito real es **nunca reusar un índice**, no "no dejar
huecos". Una secuencia entrega un valor sin esperar a que termine la
transacción que lo pidió, así que dos creaciones concurrentes no pueden
recibir el mismo número. `max(key_index) + 1` sí puede: dos transacciones que
lean antes de que la otra escriba obtienen el mismo máximo. Y lo que está del
otro lado de esa colisión no es un id duplicado sino **dos agentes derivando
el mismo par de llaves Stellar del seed maestro** — dos tenants gastando de la
misma cuenta.

Los huecos que una secuencia deja al fallar una transacción son gratis: un
índice quemado no le cuesta nada a nadie, y el espacio derivable es de mil
millones de tenants (`InvalidTenantIndex` acota en 2³¹−1 y el rol consume la
paridad).

**Alternativa descartada:** una tabla contador con `update ... returning`. Es
correcta —el lock de fila serializa— pero convierte cada alta de agente en un
punto de contención global, y no compra nada frente a la secuencia.

---

### C-29 · La derivación entra como callback; el seed maestro nunca toca este paquete · `Vigente`
**Fecha:** 2026-09-10 (T38)

`createAgent({ tenantId, derive })` asigna el índice, se lo pasa a `derive` y
guarda la dirección que le devuelvan.

**Motivo, dos razones distintas.** La primera es de seguridad: el seed maestro
es el único secreto de todo el esquema multi-tenant, y un paquete que habla
con Postgres no tiene por qué tenerlo en su alcance. La segunda es de
corrección: con dos llamadas separadas —"dame un índice", después "guardá este
agente"— es cuestión de tiempo que alguien guarde un agente cuya dirección no
corresponde a su propio índice, y esa fila mentiría de forma indetectable
hasta que alguien intente firmar con ella. Con un callback, no hay forma de
expresar esa combinación.

**Alternativa descartada:** que el paquete importe `@agentpey/tenancy` y
derive él mismo. Se descartó por lo anterior; `@agentpey/tenancy` sí aparece
como **devDependency**, usado solo en el test de integración, porque la
afirmación que hay que sostener no es "guarda un número" sino "dos tenants
terminan con identidades Stellar distintas", y eso solo lo muestra la
derivación real.

---

### C-30 · El rechazo de PII en `external_ref` es una heurística declarada, no una garantía · `Vigente`
**Fecha:** 2026-09-10 (T38)

`assertOpaqueExternalRef` rechaza lo que parece un email, un RUT o un teléfono
inequívoco, además de espacios, comillas y ángulos.

**Motivo, dicho sin adornos.** Ningún chequeo sintáctico puede impedir que un
partner decidido mande datos personales — puede mandar el email en base64 y
pasa. Lo que sí atrapa es **el error honesto**: el integrador que cablea
`user.email` porque era el string único a mano. Ese error es común y este es
barato; la malicia es rara y esto no la detiene. El resto lo carga el contrato
con el partner, no el código.

**Una consecuencia de diseño que sale de tomarse esto en serio:** el error
**no** devuelve el valor rechazado en `details`. Repetir un email dentro de un
error que va a un log es exactamente la fuga que la función existe para
evitar. Devuelve el largo y una pista de qué mandar en su lugar.

Se rechaza a propósito una tentación: un string de puros dígitos **se acepta**.
Es muchísimo más frecuente que sea un id de usuario que un teléfono, y
rechazarlo rompería integraciones honestas para atrapar un caso que las reglas
del `+` y los separadores ya cubren.

---

### C-31 · El pool de conexiones es acotado y configurable · `Vigente`
**Fecha:** 2026-09-10 (T38)

`createDirectory` acepta `maxConnections`, y el test de integración usa pools
chicos.

**Motivo, encontrado corriendo el propio test y no leyendo documentación.** La
primera corrida del test de integración —ocho creaciones de tenant y ocho de
agente en paralelo— murió con `EADDRNOTAVAIL` (errno −49) después de 18
minutos: agotamiento de **puertos efímeros locales**, no del servidor. La base
del piloto es un session pooler de Supabase, cada conexión nueva paga un
handshake TLS completo, y `pg` abre una por consulta concurrente hasta llegar
a su `max`. Con el pool acotado las conexiones se reusan, que es a la vez más
rápido y estable.

Queda anotado para el hito de hardening (`G4`/`G11`): el mismo razonamiento
aplica a `createPostgresMandateVault`, que hoy no expone la opción.

---

### C-32 · Un error de `pg` lleva la contraseña adentro — nunca serializar el `cause` crudo · `Vigente`
**Fecha:** 2026-09-10 (T38)

**Hallazgo, no decisión de diseño.** Cuando vitest volcó el error de conexión
de la corrida fallida de `C-31`, el volcado incluía la contraseña de la base
en texto plano: `pg` guarda `connectionParameters` (usuario, host, y
**password**) dentro del objeto de error, y cualquier cosa que serialice ese
objeto la publica.

**Qué se verificó de nuestro lado.** El código de este paquete registra y
propaga solo `error.message`, nunca el objeto: `console.error` recibe el
mensaje, y `details.cause` es el mensaje, no el error. Lo mismo hace
`createPostgresMandateVault` (T33). Ninguno de los dos filtra hoy.

**Qué queda como riesgo latente y para dónde va.** `AgentPassError` conserva el
`cause` original, que es lo correcto para depurar. El riesgo es un
`JSON.stringify` sobre un error atrapado, o un logger que serialice el objeto
completo — algo que la superficie de API de F5 va a tener que hacer bien
desde el primer día. Se anota como requisito de F5/F8: **ningún log
estructurado serializa un error crudo**. No se cambia nada ahora.

---

### C-33 · Antes de F4, todo tenant comparte un único agente — modelado como una fila real, no como una ficción · `Vigente`
**Fecha:** 2026-09-10 (T39)

`@agentpey/directory` (T38) asume el mundo de F4: una identidad Stellar por
tenant, `directory_agents.address` único. Eso todavía no es cierto — todo
visitante sigue firmando con el único `AGENT_SECRET_KEY` compartido
(`C-16`/`C-20`, diferido a F4 a propósito). En vez de aflojar la unicidad que
el esquema protege, o inventar una segunda forma más laxa para este período
transicional, T39 representa la verdad tal cual es: existe **una sola** fila
de agente, compartida por todos los tenants, con una etiqueta que lo dice
explícitamente (`apps/web/src/shared-identity.ts`).

**Consecuencia que obligó a un cambio de esquema.** Con un solo `agentId`
compartido por todos los tenants, `agentId` deja de alcanzar para responder
"¿cuál es la credencial de **este** tenant?" — antes de este hito
`directory_credentials` no tenía columna `tenant_id`. Se agregó vía `alter
table` (T38 ya había creado la tabla, vacía, contra la base real), documentado
en `schema-sql.ts`. Post-F4, cuando cada tenant tenga su propio agente, la
columna sigue siendo correcta — deja de ser la única forma de resolver la
ambigüedad, no una que sobra.

**Por qué no reusar el `tenantIndex` de `@agentpey/tenancy` para esto.**
`deriveTenantKeypair` sigue sin cablearse (`C-16`); cablearlo es,
explícitamente, el trabajo de F4, no de F3. Bootstrapear una fila que ya
existe on-chain (`AGENT_SECRET_KEY` ya está anclado, ya tiene mandatos
firmados) con la maquinaria de derivación de F4 habría mezclado dos
migraciones en un solo hito.

**Alternativa descartada:** relajar `directory_agents.address unique` para
permitir que varios tenants apunten a la misma fila directamente (sin capa
de indirección). Se descartó porque esa unicidad es la garantía central del
esquema — que dos agentes nunca deriven la misma cuenta Stellar — y
relajarla para un caso transicional la debilitaría también para el caso
permanente que llega con F4.

---

### C-34 · La sesión clásica (sin wallet) no se persiste — sigue siendo efímera a propósito · `Vigente`
**Fecha:** 2026-09-10 (T39)

T39 solo agrega persistencia al camino de wallet conectada. El camino
clásico (la plataforma firma como su propio principal) sigue emitiendo
credencial y Mandato nuevos en cada "Iniciar sesión", exactamente como
antes.

**Motivo.** El requisito de F3 es que una wallet pueda volver desde otro
navegador y encontrar lo que ya firmó — eso exige una prueba de control
(la firma SEP-0053) que solo una wallet puede dar. El camino clásico no
tiene ese ancla: no hay "la misma persona volviendo", porque nadie probó
ser nadie. Persistirlo no compraría el objetivo de F3, solo agregaría
filas de un camino que la Fase 6 ya trata como demo.

**Alternativa descartada:** persistir también el camino clásico, usando
algún otro identificador (IP, fingerprint de navegador) como ancla. Se
descartó por no ser una prueba de identidad real — cualquier ancla así
sería más débil que lo que ya existe, y el objetivo del hito es
verificable, no aproximado.

---

### C-35 · La decisión de rehidratar es una función pura, separada de dónde se guarda el estado · `Vigente`
**Fecha:** 2026-09-10 (T39)

`decideRehydration()` (`apps/web/src/session-rehydration.ts`) no toca red, no
tiene reloj propio, no conoce Postgres. Recibe la credencial y los mandatos
que el llamador ya leyó y devuelve `"rehydrate"` o `"issue"`.

**Motivo.** Es la misma disciplina que `checkMandate`/`checkScope` ya siguen,
por la misma razón: la función que decide si algo se reusa o se emite de
nuevo es exactamente la que más conviene poder testear sin un servidor, sin
una base, sin testnet. Los ocho tests de `session-rehydration.test.ts` cubren
cada rama —sin nada que rehidratar, mandato expirado, mandato revocado,
credencial revocada de forma independiente, estado a medio escribir sin
credencial, agente no coincidente (la comparación que empieza a importar de
verdad recién con F4), más de un mandato activo a la vez— sin abrir una
conexión.

**Lo que esta función explícitamente no es: un punto de confianza.** Que un
mandato sea genuinamente válido —no revocado on-chain, no expirado, firmado
por quien dice— lo sigue decidiendo `checkMandate`/`checkScope` y el
verificador on-chain en el momento de la compra, exactamente igual que
antes de T39. Esta función solo decide si iniciar sesión se salta un
`issue()` + anclaje redundantes contra testnet. Una fila desactualizada acá
—revocada por otra vía, por ejemplo— no cuesta nada nuevo: el camino de
compra ya la rechaza, como siempre lo hizo.

**Alternativa descartada:** decidir la rehidratación dentro de
`startSession` directamente, sin extraerla. Se descartó porque es
exactamente el patrón que `C-18`/T36 ya identificó como el que falla en
producción — lógica pura viviendo dentro de una función que además hace
red, sin un solo test posible sin levantar todo alrededor.

---

### C-36 · El bootstrap de identidad compartida y del tenant de un visitante son idempotentes por búsqueda, no por bloqueo · `Vigente`
**Fecha:** 2026-09-10 (T39)

`ensureSharedAgentIdentity()` y `ensureVisitorTenant()`
(`apps/web/src/shared-identity.ts`) siguen el mismo patrón: buscar primero:
si existe, devolverlo; si no, crear, y si la creación falla (una carrera
real entre dos requests concurrentes la primera vez que algo se crea),
volver a buscar en vez de propagar el error de unicidad.

**Motivo.** Este piloto corre un solo proceso, pero ese proceso sirve
requests concurrentes — dos visitantes conectando su wallet al mismo tiempo,
la primera vez que existe cualquiera de estas filas, es un caso real, no
hipotético. Bloquear con una transacción explícita habría funcionado, pero
es más máquina de la que el problema necesita: la carrera ocurre como mucho
una vez por fila (agente compartido: una vez en la vida del despliegue;
tenant de un visitante: una vez por wallet), y perder esa carrera cuesta
exactamente una consulta extra, no un error.

**Verificado con tests, no solo argumentado.** Los cuatro tests de "recovers
when a concurrent call already created the row" simulan la pérdida de la
carrera haciendo que el paso de creación explote, y confirman que la
segunda búsqueda encuentra lo que el ganador creó.

---

### C-37 · Revocar actualiza el directorio antes de que una futura sesión pueda rehidratar el mandato muerto · `Vigente`
**Fecha:** 2026-09-10 (T39)

`/api/session/wallet-revoke-submit` llama `directory.revokeMandate(...)`
después de que la revocación on-chain se confirma.

**Motivo.** Sin esto, `listActiveMandates` seguiría devolviendo el mandato
revocado hasta que expirara por `validUntil` — `decideRehydration` lo
rehidrataría igual, y el primer intento de compra recién ahí fallaría
contra `checkMandate` (correcto, pero tarde: la sesión entera se arma
alrededor de un mandato que ya no sirve). Marcarlo en el directorio hace que
la siguiente vez que esa wallet inicie sesión, `decideRehydration` vea
`activeMandates.length === 0` y emita uno nuevo, encadenado por
`supersedesId` al que se revocó.

**Verificado end-to-end contra testnet real** (no solo en test): revocar,
después iniciar sesión de nuevo, confirmar que pide firma nueva
(`pending: "wallet-consent"`, no rehidratación), completar la renovación, y
consultar el directorio directamente para confirmar que el mandato nuevo
tiene `supersedesId` apuntando al revocado. Ver `evidencia/T39.md`.

---

### C-38 · La verificación de este hito se corrió contra testnet real, con firmas reales, no solo con tests · `Vigente`
**Fecha:** 2026-09-10 (T39)

Cuatro corridas manuales, con un script descartable (nunca commiteado) que
usó `ISSUER_SECRET_KEY` —ya fondeada y ya registrada— como wallet simulada,
firmando con SEP-0053 real y transacciones Stellar reales:

1. Conectar, firmar el Mandato, anclar — primera vez, emite de verdad.
2. Llamar `/api/session/start` una segunda vez, mismo proceso — rehidrata,
   mismos hashes.
3. **Matar el proceso del servidor y levantar uno nuevo** — sin ningún
   estado en memoria — y confirmar que rehidrata desde Postgres solo, con
   los mismos hashes exactos que antes de morir.
4. Una compra real, liquidada por `policy_rail`, ejecutada sobre una sesión
   que nunca pasó por `issue()` en este proceso — prueba que el documento
   rehidratado (reparseado desde `json`, no el objeto original en memoria)
   sigue siendo un `AgentPayMandate` válido para `checkMandate`/`checkScope`.
5. Revocar y confirmar que la sesión siguiente no rehidrata la muerta
   (`C-37`).

**Por qué un script descartable y no un test de integración commiteado.**
El patrón ya establecido por `C-18` (T36): las rutas HTTP de `apps/web` se
verifican contra testnet real, de punta a punta, no simuladas — un test que
mockeara `AgentPass`/Stellar para esto probaría los dobles, no el código.
Lo que sí quedó como test permanente es la lógica pura que gobierna la
decisión (`session-rehydration.test.ts`) y el bootstrap idempotente
(`shared-identity.test.ts`) — la misma división de responsabilidades que
T36 ya estableció.

---

### C-39 · F4 separa identidad de pago; el pago sigue compartido hasta F6 · `Vigente`
**Fecha:** 2026-09-10 (T40)

Antes de escribir código se leyó `apps/agent/src/agent.ts` y se confirmó:
`createAgent()` exige, fallando cerrado, que quien firma (`signer`) sea
exactamente la misma llave que el sujeto de la credencial — pero **nada**
exige que esa misma llave sea también quien paga. En `apps/web`, quién paga
(`signerSecret` en `executeBazaarPayment`, `ownerSecret` del `policy_rail`)
es un parámetro completamente separado del que arma la identidad del
agente. Esto no estaba documentado en ningún lado antes de este hito — se
encontró leyendo, no se asumió.

Con eso confirmado, se le presentaron al usuario tres formas de resolver
que cada tenant nuevo no puede pagar con una cuenta recién derivada sin
cargarle USDC a mano (`C-11`): fondear a mano cada tenant nuevo, adelantar
F6 (el rail por tenant) antes que F4, o **derivar y anclar la identidad de
cada tenant ahora, dejando el pago compartido hasta que F6 le dé a cada uno
su propio `policy_rail` fondeado**. El usuario eligió la tercera.

**Qué prueba este hito, con precisión.** Que cada tenant tiene una
identidad Stellar propia y verificable — su propia credencial, su propio
Mandato, ambos anclados con su propia firma. No prueba que cada tenant
gasta desde su propia cuenta: eso sigue pendiente, es F6, y la razón por la
que sigue pendiente está anotada, no escondida.

**Por qué la identidad no necesita fondeo, aunque el pago sí.** El agente
derivado firma dos cosas: nada on-chain directamente — es el sujeto de la
credencial (una dirección, sin transacción) y el firmante del intent de
compra (`apps/agent/src/intent/sign.ts`, un JWS EdDSA fuera de la cadena,
sin llamada de red). Ninguna de las dos necesita XLM ni USDC. Solo pagar
—mover el SEP-41 de verdad— necesita una cuenta real con saldo, y eso sigue
en la cuenta compartida. Esto es lo que hace posible separar las dos cosas
sin dejar a ningún tenant nuevo con una compra rota.

**Alternativa descartada:** mantener acopladas identidad y pago (como
estaban) y posponer F4 entero hasta que F6 esté listo. Se descartó porque
el modelo de identidad —la parte que `checkMandate`/`checkScope` verifican,
la parte auditable on-chain— es independiente de quién paga, y no había
motivo para bloquear una mitad real y ya construible detrás de la otra.

---

### C-40 · El seed maestro va en `.env.local`/variable de entorno del host, no en un gestor de secretos dedicado — todavía · `Vigente`, revisa `D1`
**Fecha:** 2026-09-10 (T40)

`D1` (T37) decía: "gestor de secretos (Doppler o Infisical) cuando se
cablee la derivación (F4), no antes." Al llegar a F4, se decidió no crear
esa cuenta.

**Motivo.** Crear una cuenta en un servicio de terceros es una acción que
este agente tiene prohibida por sus propias reglas de seguridad — pedirle
al usuario que la cree y conecte las credenciales habría convertido un
hito chico en uno que depende de trabajo manual externo, por un beneficio
que en testnet es marginal: el mismo `.env.local`/variable de entorno de
Render que ya protege `ADMIN_SECRET_KEY`, `ISSUER_SECRET_KEY` y
`AGENT_SECRET_KEY` es, en este momento, el nivel de protección
proporcional al riesgo real —fondos de testnet, presupuesto techo de $200
USD/mes (`P-6`)—. `MASTER_MNEMONIC` queda documentado en `.env.example`
con la misma disciplina que el resto: nunca en `.env.local` versionado,
nunca impreso en un log (se generó y se escribió directo al archivo sin
pasar por la salida de ninguna herramienta).

**Lo que esto no decide.** No cierra `D1` — antes de manejar fondos
reales, un gestor de secretos dedicado sigue siendo la recomendación, y
queda anotado como precondición de cualquier salto a producción, igual
que ya lo estaba.

**Alternativa descartada:** pedirle al usuario que cree la cuenta de
Doppler/Infisical él mismo, ahora, para no reabrir esta decisión más
adelante. Se descartó por ser trabajo manual desproporcionado al riesgo
actual del piloto.

---

### C-41 · La rehidratación de T39 necesitaba saber cuál es la identidad *vigente* del tenant, no solo que credencial y mandato coincidan entre sí · `Vigente`
**Fecha:** 2026-09-10 (T40)

**Hallazgo real, contra testnet, no anticipado al diseñar T39.** La primera
corrida de verificación de F4 contra el servidor real falló con
`SignerMismatch`: un tenant con una credencial persistida *antes* de F4
—cuyo sujeto era la cuenta compartida— intentó rehidratarse usando la
identidad *nueva*, recién derivada, de ese mismo tenant.
`decideRehydration` (T39) solo comparaba que la credencial y el mandato
coincidieran *entre sí* (`C-35`), lo cual seguía siendo cierto para ese
registro viejo — nunca comparaba contra cuál es la identidad que una
sesión nueva usaría *hoy*.

**La corrección.** `decideRehydration` recibe ahora `currentAgentId` — la
fila de `directory_agents` que `ensureTenantAgent` resolvería en este
mismo momento — y exige que la credencial y el mandato activo lo nombren a
él, no solo que se nombren entre sí. Un registro que coincide consigo
mismo pero no con la identidad vigente se trata exactamente igual que si
no hubiera ningún registro: se emite de nuevo, encadenado por
`supersedesId` al que quedó atrás. Dos tests nuevos cubren exactamente
este caso (`session-rehydration.test.ts`): coincidencia interna sin
coincidir con la identidad vigente, y una activa vieja descartada en favor
de una vigente entre varias.

**Por qué esto no es un bug de seguridad, aunque lo encontró un error real
de ejecución.** `createAgent()` lo atajó fallando cerrado — nunca se armó
una sesión con una firma que no correspondía a su propio sujeto. Lo que
esto corrige es la experiencia: sin el arreglo, cada tenant que existía
antes de F4 habría visto un error crudo en vez de una migración silenciosa
a su nueva identidad, la primera vez que volviera a conectar.

---

### C-42 · `render.yaml` reserva `MASTER_MNEMONIC`; el despliegue en sí queda fuera de este hito · `Vigente`
**Fecha:** 2026-09-10 (T40)

Se agregó `MASTER_MNEMONIC` a `render.yaml` (`sync: false`, sin valor) —
mismo patrón que `ADMIN_SECRET_KEY`/`DATABASE_URL`/`POLICY_RAIL_CONTRACT_ID`
en hitos anteriores. Verificado y cerrado únicamente contra el servidor de
desarrollo local y testnet real — el deploy de Render no se tocó, y sin la
variable configurada ahí, el sitio en producción seguirá con el
comportamiento de antes de T40 hasta que alguien complete ese paso
explícitamente.

**Motivo.** Mismo criterio que separó siempre "construir y verificar" de
"desplegar" en este proyecto (T31, T33, T35): un cambio de identidad que
toca el camino de "Iniciar sesión" de todo visitante merece confirmarse
localmente antes de tocar el sitio real, no en el mismo movimiento.

---

### C-43 · Paquete nuevo `@agentpey/partner-api` para el contrato congelado de `/v1` (T45) · `Vigente`
**Fecha:** 2026-09-10 (T45)

`PLATAFORMA-PARTNERS.md` § F5 pedía "esquemas zod nuevos (paquete a
definir)" antes de abrir T46-T50. Se decidió un paquete propio —no sumar
esto a `@agentpey/directory`— porque son responsabilidades distintas:
`directory` persiste, este paquete decide la forma de lo que cruza la red y
quién puede llamarlo. Ninguna de las dos cosas necesita saber de la otra
salvo por los tipos que ya expone (`Tenant`, `AgentInstance`, `MandateRecord`,
`ApiKey`).

**Qué contiene, exactamente lo que T45 pedía y nada más:** los DTOs
snake_case de `/v1` (tenants, agentes, mandatos de solo lectura,
`consent_sessions`) con sus funciones de mapeo desde los tipos internos de
`@agentpey/directory`; el contrato de autenticación (`Authorization: Bearer
ap_test_...`, reutilizando `Directory.authenticate()` que T38 ya construyó);
el enum de permisos de API key; la semántica exacta de idempotencia; y el
envelope de error/éxito. Cero rutas HTTP, cero cambios a `apps/web`.

**Verificado:** `git diff --stat d493d63..HEAD -- apps contracts` no
devuelve nada — ningún punto de autorización tocado. 42 tests nuevos (de
823), todos puros, sin red ni base de datos. `pnpm typecheck`/`pnpm build`
limpios.

**Alternativa descartada:** escribir los esquemas directamente dentro de
`apps/web` o de `@agentpey/directory`. Se descartó porque F5's tickets de
Codex (T46 OpenAPI, T47 SDK, T48 webhooks) necesitan importar estas formas
sin arrastrar ni un servidor HTTP ni una conexión a Postgres.

---

### C-44 · El permiso de API key se llama `ApiScope`, no `Scope` · `Vigente`
**Fecha:** 2026-09-10 (T45)

**Hallazgo al construir, no al planificar.** `@agentpass/core` ya exporta
`Scope`/`scopeSchema` para el scope de gasto de una credencial o mandato
(`actions`/`venues`/`assets`/`limits`) — un concepto central del proyecto
desde la Fase 2. El borrador inicial de este hito nombró igual al permiso de
una API key ("puede este key llamar esta ruta"), lo cual habría dejado dos
`Scope` completamente distintos, importables desde dos paquetes distintos,
en el mismo proyecto.

**La corrección.** Renombrado a `ApiScope`/`apiScopeSchema`/`API_SCOPES` en
`@agentpey/partner-api`, con un comentario en el propio archivo explicando
por qué. Ninguna colisión de imports es posible ahora — un lector que ve
`Scope` sabe que es gasto; uno que ve `ApiScope` sabe que es acceso a la API.

**Alternativa descartada:** mantener `Scope` en el paquete nuevo y confiar en
que el import con alias (`import { Scope as ApiScope }`) evite la confusión
en la práctica. Se descartó porque depende de que cada archivo que lo
importe recuerde hacerlo — el nombre correcto en el origen no depende de la
disciplina de cada consumidor.

---

### C-45 · La lista de permisos de `/v1` es más chica que la propuesta en `PLATAFORMA-PARTNERS.md` §2.7 · `Vigente`
**Fecha:** 2026-09-10 (T45)

§2.7 proponía `tenants:write`, `agents:write`, `consent:create`,
`mandates:read`, `mandates:revoke`, `payments:authorize`, `vault:read` —una
lista "mínima, separada por daño" pensada para toda la superficie eventual
de la plataforma, no solo para T45. Congelar esa lista completa ahora habría
dejado permisos que ninguna ruta existente o planeada en la tabla de F5
(T45-T50) revisa todavía.

**Lo que se congeló en su lugar:** `tenants:read`, `tenants:write`,
`agents:read`, `consent_sessions:read`, `consent_sessions:write`,
`mandates:read` — exactamente los que T45's alcance nombra (tenants,
agentes, `consent_sessions`, mandatos de solo lectura). Se renombró
`consent:create` a `consent_sessions:write`/`consent_sessions:read` por
consistencia interna (`recurso:acción` en todos los casos, no una excepción
para consentimiento).

**Motivo.** Un permiso que una API key puede pedir pero que ninguna ruta
real revisa es peor que no tenerlo: aparenta estar cableado y no lo está. Se
prefiere extender la lista, aditivamente, el día que un ticket construya la
ruta que ese permiso protegería (`mandates:revoke` con la ruta de
revocación, `payments:authorize` con lo que F7 defina, `vault:read` con el
panel de partner que F5 explícitamente deja fuera de alcance).

**Alternativa descartada:** congelar la lista completa de §2.7 ahora, como
"reservada para más adelante". Se descartó por la razón de arriba.

---

### C-46 · La idempotencia se congela como decisión pura, no como tabla · `Vigente`
**Fecha:** 2026-09-10 (T45)

T45 pedía "la semántica exacta de idempotencia", no su almacenamiento.
`resolveIdempotency` es una función pura que recibe un `lookup` inyectado
—de dónde sale `(partner_id, key) → respuesta` no lo decide este paquete— y
devuelve `"proceed"` o `"replay"`, o lanza `IdempotencyKeyConflict`/
`IdempotencyKeyRequired`. El mismo patrón que `checkMandate`/`checkScope`
del proyecto: la decisión se prueba sola, sin una base de datos real detrás.

**Detalle que sí quedó fijado, porque es observable desde afuera:** TTL de
24 horas (`PLATAFORMA-PARTNERS.md` §2.7), el hash del cuerpo se calcula
sobre una forma canónica (claves ordenadas recursivamente, arrays intactos)
para que `{a:1,b:2}` y `{b:2,a:1}` no se traten como cuerpos distintos, y un
registro vencido se trata exactamente como si no existiera —incluso si el
cuerpo de la repetición es distinto— en vez de devolver un conflicto contra
algo que ya expiró.

**Pendiente, a propósito:** dónde vive la tabla `(partner_id, key) →
respuesta` es una decisión de la ruta que la usa (T49 o un ticket sucesor),
no de este paquete.

---

### C-47 · `consent_sessions` es solo esquema en T45 — sin persistencia, con un prefijo de id provisional · `Vigente`
**Fecha:** 2026-09-10 (T45)

`@agentpey/directory` no tiene tabla de `consent_sessions` — T38 no la
construyó porque F3 resolvió el consentimiento con el flujo de wallet
conectada que ya existe, no con el flujo hospedado que F5 describe para
partners. T45 solo define la forma de la petición (`tenant_id`, un `grant`
que reutiliza `mandateGrantSchema` de `@agentpey/mandate` sin
redescribirlo) y de la respuesta (`id`, `status`, `consent_url`,
`mandate_id`, con los dos últimos nulos hasta que la sesión se completa).

**El prefijo `cns_`** se fijó en `consent-sessions.ts` replicando el
formato ULID-detrás-de-prefijo de `ids.ts` (mismo largo, mismo alfabeto
Crockford) sin que `@agentpey/directory` sepa nada de `consent_sessions`
todavía — es una convención documentada para que quien construya la
persistencia no tenga que decidir el formato del id además de todo lo
demás, no una tabla real.

**Hallazgo, no pedido explícitamente — brecha en la tabla de F5.** Ninguno
de los tickets T45-T50 nombra explícitamente "implementar los handlers de
`/v1`" (crear un tenant de verdad, completar un `consent_session` cuando la
wallet firma, etc.) — T49 solo describe el middleware de autenticación
("una api key revocada deja de poder llamar cualquier ruta"), y T50 asume
que para entonces "la API responde de verdad". Falta un ticket, o una
ampliación explícita del alcance de T49, que conecte este contrato con
`@agentpey/directory` y con el flujo hospedado de wallet-connect. Anotado
para el usuario antes de abrir T49 — no resuelto en este hito porque no era
su alcance.

---

### C-48 · La forma del evento de webhook se publica antes de tener nada que lo dispare · `Vigente`
**Fecha:** 2026-09-10 (post-T45)

T48 (webhooks, tabla de F5) dependía explícitamente de "la forma del evento
de webhook publicada por Claude" — sin eso, no había nada que delegar
todavía. Se agregó `webhooks.ts` a `@agentpey/partner-api`: los siete
nombres de evento de `PLATAFORMA-PARTNERS.md` §2.7, el sobre
(`id`/`type`/`created_at`/`data`), y el esquema de firma
(`AgentPay-Signature: t=<ms>,v1=<hmac>`, ventana de replay de cinco
minutos) — con `sign`/`verify` como funciones puras.

**Por qué `data` queda `z.record(unknown)` y no cuatro schemas tipados.**
Los eventos `mandate.*` sí podrían tipar `data` hoy contra
`mandateResourceSchema`; los `payment.*` no — F7 (comercio genérico)
todavía no diseña qué es un "pago" en `/v1`. Tipar cuatro de siete y dejar
tres sueltos habría sido peor contrato que dejar los siete iguales hasta
que el código que efectivamente emite cada uno decida su forma. T48 no
necesita el tipo de `data` para construir un worker de entrega con
reintentos — solo necesita el sobre y la firma.

**Qué sigue sin decidir, a propósito.** El *cuándo* se dispara cada evento
— qué código llama a "encolar este webhook" y en qué momento exacto — no
está acá. Esa decisión vive donde vive la lógica que la motiva (T49 o
después), nunca en el paquete de contrato ni en el worker de entrega de
Codex.

**Alternativa descartada:** esperar a T49 para publicar esto también, y
abrir T46/T47/T48 juntos recién entonces. Se descartó porque T46 y T47 ya
estaban listos para delegarse sin esto — atarlos a T49 solo por
conveniencia de agrupar hubiera demorado sin necesidad el trabajo que
Codex sí puede empezar hoy.

---

### C-49 · T49 se parte en dos: tenants/agentes/mandatos ahora, `consent_sessions` en un hito nuevo (T51) · `Vigente`
**Fecha:** 2026-09-10 (T49)

T49, tal como quedó descripto en la tabla de F5, solo hablaba del
middleware de autenticación — la brecha `C-47` ya había anotado que
faltaba un ticket para "implementar los handlers de verdad". Investigando
`apps/web` antes de escribir código aparecieron dos piezas más sin
ticket: no existe ninguna forma de crear un `Partner`/`ApiKey` hoy, y
`consent_sessions` no tiene tabla, ruta ni página hospedada — necesita
reutilizar el flujo de firma de wallet que ya existe
(`/api/session/wallet-consent`, `/api/session/wallet-anchor`), pero es
una pieza grande por sí sola.

**Decisión:** este hito (T49) resuelve la mitad de lectura/creación
simple —tenants, agentes, mandatos, más el script de bootstrap de
partner/API key—. `consent_sessions` (tabla, rutas, página hospedada)
queda para un hito nuevo, **T51**. `T50` (la guía/ejemplo de Codex) pasa a
depender de ambos, no solo de T49 — su criterio de "listo" en
`PLATAFORMA-PARTNERS.md` § F5 ("crea un tenant, abre un consentimiento y
consulta un mandato") no puede cumplirse sin `consent_sessions`.

**Motivo.** Cerrar todo junto habría sido un PR enorme y difícil de
revisar de una sola vez — exactamente lo que la regla de "un hito, una
revisión" de este proyecto busca evitar. Partiendo el trabajo, la mitad
más chica y menos riesgosa (lecturas, sin tabla nueva salvo idempotencia)
cierra y se revisa antes de abrir la mitad que sí toca el flujo de firma
de wallet.

**Alternativa descartada:** ampliar el alcance de T49 para incluir
`consent_sessions` completo. Descartada por el tamaño del PR resultante.

---

### C-50 · Tabla `directory_idempotency`, resolviendo lo que `C-46` dejó pendiente · `Vigente`
**Fecha:** 2026-09-10 (T49)

`C-46` (T45) congeló la semántica exacta de idempotencia como una función
pura (`resolveIdempotency`, en `@agentpey/partner-api`) sin decidir dónde
vive `(partner_id, key) → respuesta`. T49 lo resuelve: tabla nueva
`directory_idempotency` en `@agentpey/directory` (clave primaria
`(partner_id, key)`, `response_body` en `json` — mismo criterio que
`directory_mandates.document`, no hay hash calculado sobre el valor pero
tampoco hay motivo para que Postgres reordene claves de algo que solo se
reproduce tal cual), con dos métodos nuevos en el puerto
(`findIdempotentResponse`, `recordIdempotentResponse`). `apps/web`'s
`partner-routes.ts` pasa `directory.findIdempotentResponse` directo como
el `lookup` que `resolveIdempotency` pide — sin conversión, porque el
esquema de `IdempotencyRecord` en `@agentpey/directory` replica el de
`@agentpey/partner-api` campo por campo a propósito (`directory` no puede
depender de `partner-api` — la dependencia va al revés).

**`recordIdempotentResponse` es un upsert (`on conflict do update`), no un
insert puro.** Dos reintentos concurrentes de la misma key corriendo la
misma operación de negocio dos veces en paralelo no son un conflicto real
— son el mismo hecho lógico escrito dos veces. Fallar cerrado ahí (una
violación de unicidad cruda) habría sido peor experiencia que dejar
ganar a cualquiera de las dos escrituras, porque ambas escriben la misma
respuesta.

**Alternativa descartada:** guardar la idempotencia en el propio proceso
de `apps/web` (un `Map`, como el resto de las sesiones hoy). Descartada
por la misma razón que motivó `@agentpey/directory` entero (`G7`): un
restart pierde el registro, y una API key reintentando después de un
deploy volvería a crear el tenant.

---

### C-51 · `findMandateById` y `listMandates`, nuevos en `@agentpey/directory` · `Vigente`
**Fecha:** 2026-09-10 (T49)

`/v1/mandates/{id}` identifica un mandato por su `id` (`mdt_...`), no por
su `mandateHash` — el único lookup que existía (`findMandateByHash`) es
el que usa el registro on-chain, un concepto distinto. Y un partner
consultando el historial de un tenant quiere ver también los mandatos
revocados o expirados, no solo los activos que `listActiveMandates` ya
filtraba (ese método sigue exactamente igual, para lo que ya lo usa
`apps/web`). Ambos métodos son lecturas puras, aditivas, sin tocar el
esquema de la tabla ni ningún método existente.

---

### C-52 · `scripts/create-partner.ts`: crear un partner es un script de operador, no una ruta HTTP · `Vigente`
**Fecha:** 2026-09-10 (T49)

No existía ninguna forma de crear un `Partner` ni de emitir su primera
`ApiKey` — se confirmó buscando en todo el repo antes de diseñar T49.
`PLATAFORMA-PARTNERS.md` § F5 deja "panel de partner" explícitamente
fuera de alcance, así que exponer esto como una ruta HTTP habría sido
construir la mitad de una superficie de administración que nadie pidió
todavía, y que necesitaría su propia autenticación (distinta de la de
`/v1`, pensada para partners, no para el operador del proyecto). El
script sigue el mismo patrón que `scripts/bootstrap.ts` ya usa para
llaves Stellar: se corre a mano, una vez por partner, imprime el secreto
una sola vez y no lo guarda en ningún lado más que su hash en Postgres.
`--scopes` por defecto otorga la lista completa de `API_SCOPES` — no hay
manera de que un partner pida menos todavía, y limitarlo por defecto solo
generaría una vuelta manual de "che, dame más permisos" sin ganar nada en
seguridad real durante el piloto.

**Alternativa descartada:** una ruta `/admin/partners` gateada por
`ADMIN_SECRET_KEY` (el mismo patrón que ya protege el registro de
emisores on-chain). Descartada por ahora — es más superficie de la que
esta fase necesita, y puede agregarse después sin romper nada si alguna
vez hace falta crear partners sin acceso a la base de datos directamente.

---

### C-53 · Un tenant o mandato de otro partner responde `404`, nunca `403` · `Vigente`
**Fecha:** 2026-09-10 (T49)

`GET /v1/tenants/{id}`, `GET /v1/mandates/{id}` y las dos rutas
`?tenant_id=` resuelven primero el recurso y comparan su `partnerId`
contra el de la API key autenticada. Si no coincide, la respuesta es
`TenantNotFound`/`MandateNotFound` (`404`) — igual que un id que
directamente no existe — nunca `ScopeNotGranted` ni ningún código que
confirme "esto existe, pero no es tuyo". Mismo criterio que `InvalidApiKey`
ya aplica entre una key desconocida y una revocada (`C-44`, T45): decirle
a un partner "ese id es de otro" es información que no necesita para
integrar bien, y sí le sirve a alguien enumerando ids ajenos.

Verificado contra Postgres real, no solo en el test unitario: un segundo
partner de prueba, con su propia API key, recibió `404` al pedir el
tenant del primero.

---

### C-54 · La idempotencia cachea cualquier resultado de un intento ya autenticado, éxito o error · `Vigente`
**Fecha:** 2026-09-10 (T49)

`resolveIdempotency` (T45) no distingue "cachear solo éxitos" de "cachear
todo" — decide replay/conflicto por el hash del cuerpo, sin mirar qué
pasó la primera vez. T49 sigue esa misma línea: `respondOrCache` (en
`partner-routes.ts`) guarda el resultado de `POST /v1/tenants`
—cualquiera sea: un `201` nuevo, un `200` de `TenantAlreadyExists`
resuelto a nivel de negocio, o un error de validación— bajo la misma
`Idempotency-Key`. Lo único que queda
deliberadamente **fuera** de ese cacheo es el fallo de autenticación en
sí (`MissingApiKey`/`InvalidApiKey`/`ScopeNotGranted`): esos ocurren antes
de saber siquiera de qué partner se trata, así que no hay bajo qué
`partnerId` guardarlos.

**Por qué no seguir el criterio de "no cachear 4xx" que usan algunas APIs
públicas.** Habría exigido inventar una regla nueva —qué códigos "cuentan"
como que no pasó nada— que el contrato congelado en T45 no pedía y que
un partner integrando desde la documentación no puede adivinar sin leer
el código. La regla simple ("la misma llamada, exactamente, siempre
responde igual mientras la key no expire") es la que ya está escrita y
probada.

**Alternativa descartada:** cachear solo `2xx`. Descartada por lo de
arriba — y porque habría dejado sin resolver qué hacer con el `200` que
`POST /v1/tenants` devuelve cuando el `external_ref` ya existía (ese caso
sí se cachea, es un resultado válido de un intento completo).

---

### C-55 · `directory_consent_sessions`: `proposed_grant` en vez de `grant`, y dos ventanas de tiempo distintas · `Vigente`
**Fecha:** 2026-09-10 (T51)

Dos decisiones de la tabla nueva, encontradas escribiendo el SQL, no en el
diseño:

1. **La columna se llama `proposed_grant`, no `grant`.** `GRANT` es
   palabra reservada de SQL (el propio comando de privilegios de
   Postgres) — usarla sin comillas rompe cada sentencia que la toque.
   Ninguna herramienta ni test la hubiera atrapado hasta ejecutarse contra
   Postgres real. El nombre del campo en TypeScript sigue siendo `grant`
   (el mapeo de columnas ya traduce `snake_case` a `camelCase` en cada
   entidad de este paquete) — el cambio queda contenido en el SQL.
2. **`expires_at` (la ventana de la invitación) es un campo aparte de
   `valid_until` (la ventana del Mandato que resultaría de firmarla).**
   Confundirlos habría atado cuánto tiempo tiene Vinny para decidir si
   firma a cuánto tiempo dura el Mandato una vez firmado — dos cosas que
   un partner puede querer configurar de forma completamente
   independiente (una invitación de una hora para un Mandato de tres
   meses es el caso normal, no una excepción).

---

### C-56 · `session-documents.ts` gana un `grant` opcional, sin tocar el único call site que ya existía · `Vigente`
**Fecha:** 2026-09-10 (T51)

`buildSessionDocuments` (T36, protege el invariante `C-17`) pasaba
siempre `scope.scope` como el `grant` del Mandato — nunca soportó
`payTo`, aunque `@agentpey/mandate` lo tiene desde `M-14`. Un
`consent_session` necesita que el partner pueda proponer `payTo`.

**La corrección.** `SessionDocumentsParams` gana `grant?: MandateGrant`,
que por defecto es `scope.scope` — exactamente el valor que el único call
site de antes de T51 (`server.ts`'s `startSession`) ya usaba. Ese call
site no cambió una línea, y los seis tests que fijan el invariante
`C-17` tampoco. La credencial sigue recibiendo solo `scope.scope`
—`credentialSubject.scope` no puede expresar `payTo`, no es una
limitación nueva de T51— y el Mandato recibe el `grant` explícito cuando
se pasa uno.

**Alternativa descartada:** una función nueva y paralela
(`buildConsentSessionDocuments`) en vez de extender la existente.
Descartada porque habría duplicado exactamente la lógica que protege
`C-17` —derivar el `principal` una sola vez y usarlo en ambos
documentos— en dos lugares que tendrían que mantenerse de acuerdo para
siempre.

---

### C-57 · El flujo hospedado de consentimiento se autentica por el id de la invitación, sin API key · `Vigente`
**Fecha:** 2026-09-10 (T51)

`GET /api/consent/{id}` y las tres rutas de firma
(`wallet-verify`/`start`/`wallet-consent`/`wallet-anchor`) no piden
`Authorization`. Quien las llama es el **principal** (Vinny), no el
partner — no tiene, ni debería tener, una API key de `/v1`. El id del
`consent_session` (un ULID de 128 bits, la misma familia de ids que
`@agentpey/directory` ya usa para todo) es la capacidad que autoriza:
mismo modelo de confianza que un link de sobre de DocuSign, o el link de
recuperación de contraseña de cualquier producto — quien tiene el link
puede actuar, y el link es indistinguible de un ULID al azar. `apps/web`
nunca lista `consent_sessions`, así que no hay forma de enumerarlos.

**Riesgo real, y por qué se acepta.** Si el link se filtra (queda en un
log de un proxy, en un historial de navegador compartido) antes de que
Vinny lo use, quien lo tenga puede firmar el Mandato en su lugar. Esto es
exactamente el riesgo que cualquier magic link tiene, no uno nuevo de
este diseño — mitigado por la ventana corta de `expires_at` (1 hora,
`C-55`), no eliminado. Un `consent_session` ya completado se rechaza de
nuevo (`ConsentSessionAlreadyCompleted`), así que un link reusado después
de firmar no puede firmar una segunda vez.

**Alternativa descartada:** exigir que el partner también pase su API key
en la página hospedada (vía query param u otro mecanismo). Descartada
porque expondría el secreto de `/v1` en una URL que termina en el
navegador de un tercero — el propio principal, no un sistema del
partner — precisamente el tipo de exposición que `PLATAFORMA-PARTNERS.md`
§2.7 evita para las API keys en general.

---

### C-58 · Un Mandato de `consent_session` nunca encadena `supersedesId` · `Vigente`
**Fecha:** 2026-09-10 (T51)

El flujo de wallet-connect (T35/T39) sí encadena `supersedesId` porque
ahí "renovar sin crear un agente nuevo" es un requisito explícito del
producto (`G7`) — cada tenant tiene, en cualquier momento, como mucho un
Mandato activo, y volver a conectar debe encontrar ese Mandato, no
apilar uno nuevo. Un `consent_session` es distinto: un partner puede
legítimamente pedir varios consentimientos independientes para el mismo
tenant a lo largo del tiempo (un `perDay` para gastos chicos, otro
consentimiento aparte para una compra puntual más grande), y no hay
ninguna regla de producto que diga que el segundo reemplaza al primero.
T51 no impone esa relación — cada Mandato de `consent_session` es
independiente. Si un producto real necesita "esto reemplaza el anterior",
es una decisión de negocio para cuando exista un caso real, no algo para
adivinar acá.

---

### C-59 · `consent.html`, la página que consume estos endpoints, es un hito aparte (T52) y delegable · `Vigente`
**Fecha:** 2026-09-10 (T51)

T51 deja `/consent/{id}` respondiendo `404` (no hay archivo que
`serveStatic` pueda servir todavía) — a propósito. Todo el backend se
verificó de punta a punta contra Postgres y testnet reales con un script
descartable que firma como lo haría Freighter (misma técnica que
T39/T40), sin necesitar ningún navegador. La página que un humano
realmente ve —conectar wallet, mostrar el `grant`, disparar las mismas
llamadas que el script ya probó— no decide nada: es HTML/JS que llama a
endpoints ya estables, la misma descripción que ya calificó como
delegable a Codex la vista de historial de solo lectura de F3
(`PLATAFORMA-PARTNERS.md` § F3). Construirla ahora, en el mismo hito, sólo
habría hecho el PR más grande sin agregar riesgo real a revisar.

---

### C-60 · El registro de venues/assets reemplaza `mapAsset` hardcodeado, con `resolveJsonModule` para que "agregar un comercio" sea datos, no código · `Vigente`
**Fecha:** 2026-09-11 (T53)

F7 pedía que agregar un comercio nuevo no tocara ningún archivo `.ts`.
`bazaar.ts` (Fase 2/4) tenía el mapeo de assets hardcodeado directamente en
código — una función `mapAsset` con un único `if (code !== "USDC")` — así
que un segundo comercio x402 habría necesitado un archivo entero shaped
igual que `bazaar.ts`, con su propio `mapAsset` copiado y pegado.

**La solución.** `apps/agent/src/catalog/registry.ts` valida (zod,
`z.strictObject`) y le indexa un array de filas —una por venue, cada una
con su `slug`, `contractId`, `baseUrl` opcional y sus `assets` (`code` +
`issuer`)— fallando cerrado (`InvalidVenueRegistry`, código nuevo en
`AgentPassErrorCode`) ante un venue duplicado o un asset repetido dentro
del mismo venue, no solo ante una fila mal formada. `mapAssetCodeForVenue`/
`mapAssetIssuerForVenue` son los sucesores genéricos de `mapAsset`/
`mapAssetContract`: mismo fallo cerrado (`InvalidProduct` ante un código o
issuer que el venue no nombra), ahora sobre cualquier venue registrado, no
solo el bazaar. `venues.json` es la fila real de datos —el bazaar del
embajador, hoy el único venue— y agregar uno nuevo es agregar una fila ahí,
no escribir TypeScript.

**El adaptador HTTP también se generalizó.** `x402-catalog.ts` es
`bazaar.ts`'s antigua lógica de fetch (`GET /api/discovery/search`, el
`ServiceCard`, `getServiceRoute`) parametrizada por `{ venueId, registry,
baseUrl?, fetchImpl? }` en vez de estar atada a un venue. `bazaar.ts` queda
como una capa delgada de compatibilidad: sus constantes exportadas
(`BAZAAR_VENUE_ID`, `BAZAAR_USDC`, etc.) y `createBazaarCatalog`/
`mapAssetContract`/`getBazaarServiceRoute` sin cambiar su firma pública,
para que `scripts/demo.ts`, `payment/x402.ts` y `apps/web/src/server.ts`
no necesiten tocar una línea. `baseUrl` se mantiene como override explícito
opcional (no solo dato del registro) porque los tests y el deploy real
siguen necesitando apuntar a una URL distinta de la que trae `venues.json`.

**`resolveJsonModule`, nuevo en `apps/agent/tsconfig.json`.** `venues.json`
se importa con `import ... with { type: "json" }` (sintaxis de atributos de
importación que `NodeNext` + TS 5.9 exige) en vez de leerlo con
`node:fs` en tiempo de ejecución — la alternativa que el propio repo ya usa
en `scripts/demo.ts` para otros JSON. Se descartó esa alternativa porque
`apps/agent` se consume como paquete compilado (`dist/index.js`) desde
`scripts/` y `apps/web/src/server.ts`, no solo vía `tsx`: un `fs.readFileSync`
relativo a `import.meta.url` se rompe en `dist/` a menos que algo copie el
JSON ahí, y este repo no tiene ningún paso de copia de assets. Con
`resolveJsonModule`, `tsc -b` sí copia `venues.json` a `dist/catalog/` como
parte de la compilación normal — verificado importando el `dist/` compilado
directamente, no solo con `tsx`. Nota de proceso: `tsc -b` en modo de
referencias de proyecto no descubrió el JSON con el `include` original
(`"src/**/*"`, TS6307) aunque un `tsc` suelto sobre el mismo `tsconfig.json`
sí lo hacía — hizo falta agregar `"src/**/*.json"` explícito al `include`.

**Alternativa descartada:** un registro en Postgres (como
`@agentpey/directory`), para que el script de alta de comercio (T55)
escribiera contra una base real en vez de un archivo. Descartada porque
`apps/agent` es el agente CLI original (Fase 2–4), sin conexión a Postgres
—esa es la superficie de `apps/web`/Fase 6— y montar una dependencia nueva
a una base de datos solo para esta fase habría sido una superficie mucho
más grande que lo que F7 pedía resolver.

Documentación tocada: `PLATAFORMA-PARTNERS.md` (F7, T53 cerrado, T54–T56
renumerados desde el borrador original T51–T54, que colisionaba con los
números reales de F5), `BITACORA.md`. Archivos nuevos:
`apps/agent/src/catalog/registry.ts` (+ test, 13 casos),
`apps/agent/src/catalog/default-registry.ts`,
`apps/agent/src/catalog/x402-catalog.ts`,
`apps/agent/src/catalog/venues.json`. `bazaar.ts` reescrito como
compatibilidad; `bazaar.test.ts` sin cambios, 16/16 en verde. Código nuevo:
`InvalidVenueRegistry` en `packages/core/src/errors.ts`.

---

### C-61 · `policy_rail` gana un `principal` distinto del `owner`: la wallet retira y rota, la llave delegada solo gasta · `Vigente`
**Fecha:** 2026-09-11 (T57)

`G9` decía que `policy_rail` no tenía ninguna forma de sacar fondos ni de
cambiar quién autoriza pagos. Solo existían lectores de configuración y
`__check_auth`, que aprueba un pago con la firma de un único `owner` — en
el piloto, una llave de AgentPey. Si un cliente real fondeaba ese contrato,
no podía recuperar su plata: la única salida era un pago firmado por una
llave que no es suya. Bloqueante duro para F6 (cuenta pagadora por tenant)
y para cualquier conversación de mainnet.

**La decisión: dos autoridades separadas, no una sola con más permisos.**
`Config` gana un campo, `principal: Address` — la wallet del cliente,
fijada una sola vez en el constructor, igual que `owner`/`asset`/`per_tx`/
`per_day`/`valid_until`. Quién autoriza el gasto día a día (la llave
delegada del agente, `owner`, vía el `__check_auth` custom) queda separado
de quién tiene la última palabra sobre el contrato (la wallet del cliente,
`principal`, vía `Address::require_auth()` — el mecanismo nativo de
Soroban, el mismo que ya usa cada firma de wallet en este proyecto).
Consecuencia buscada: el agente nunca necesita ni ve la llave de la
wallet, y el cliente puede retirar su saldo o cortar la llave de gasto en
cualquier momento sin que AgentPey coopere.

**Dos funciones nuevas, y `__check_auth` no se tocó.** `withdraw(to,
amount)` exige `principal.require_auth()`, rechaza `amount <= 0` con
`InvalidWithdrawAmount` (código `9`, nuevo) e invoca `transfer` sobre el
asset del rail. Ese `transfer` **no** reentra a `__check_auth`: cuando el
propio contrato inicia la llamada, Soroban autoriza implícitamente un
`from == env.current_contract_address()`; `__check_auth` solo se dispara
cuando una transacción *externa* —el pago x402— le pide a este contrato que
autorice algo desde afuera. `set_owner(new_owner)` exige lo mismo y
reescribe el `Config` completo (es una sola entrada de storage).

**Ninguna de las dos respeta `valid_until`, a propósito.** Un rail vencido
es exactamente el que más necesita una salida; bloquear ahí sería recrear
`G9` con un temporizador en vez de para siempre. Por la misma razón
`withdraw` tampoco pasa por `per_tx`/`per_day`: esos límites acotan lo que
la *llave delegada* puede gastar, no lo que el dueño del dinero puede
recuperar. Verificado en la red real con un retiro de quince veces el
`per_tx` del rail (`evidencia/T57.md` §4.1).

**Sin chequeo de forma sobre `new_owner`.** Cualquier valor de 32 bytes es
una clave Ed25519 sintácticamente válida, y no hay nada acá que pueda
distinguir un error de tipeo de una clave cuyo secreto vive donde el
contrato no ve. Poner un owner que nadie puede firmar detiene los pagos,
que es un fallo estrictamente más seguro que el opuesto — y `withdraw`
sigue funcionando.

**Alternativa descartada:** hacer que `withdraw` y `set_owner` pasaran por
el mismo `__check_auth`/`owner` que ya existe, en vez de agregar un campo.
Descartada porque es justamente el problema que `G9` describe: quien
autoriza el gasto pasa a poder vaciar la cuenta, y el cliente que puso los
fondos no puede hacer nada sin esa llave. La separación es el punto, no un
detalle de implementación. **Segunda alternativa descartada:** un
`principal` mutable (una función `set_principal`). Descartada porque quien
pudiera llamarla se quedaría con los fondos; fijarlo en el constructor
significa que un rail mal apuntado se reemplaza desplegando otro, que es
barato, en vez de dejar abierta una puerta que no lo es.

**El rail compartido del piloto no se redesplegó.** Sigue con el
constructor viejo —sin `principal`, sin salida de fondos— hasta que se
decida migrarlo, que es una decisión aparte. Por eso `principal` es
`nullable` en `policyRailDeploymentSchema` (`scripts/lib/deployment.ts`):
es el único rail registrado que no tiene uno on-chain, y romper su lectura
habría roto todos los scripts que tocan `deployments/testnet.json` por un
rail que este hito no estaba cambiando.

Documentación tocada: `PLATAFORMA-PARTNERS.md` (fila `G9` marcada
resuelta; F6 gana su primer ticket real), `BITACORA.md`, `evidencia/T57.md`.
Archivos tocados: `contracts/policy-rail/src/lib.rs`,
`contracts/policy-rail/src/test.rs` (+11 tests, 21 → 32),
`scripts/deploy-policy-rail.ts` (`--principal <G...>`, requerido y sin
default), `scripts/lib/deployment.ts` y su test (+2).

---

### C-62 · El rail por tenant es solo para sesiones con wallet real; el camino clásico sigue en el rail compartido · `Vigente`
**Fecha:** 2026-09-11 (T58)

El plan de T58 asumía que "rail por tenant" reemplazaba enteramente al
rail compartido — incluido retirar `POLICY_RAIL_CONTRACT_ID` del todo.
Leyendo `server.ts` de cerca antes de escribir código apareció algo que
el plan no había separado: el camino **clásico** (sin conectar wallet,
`C-34`) también puede pedir pagar vía rail (`body.payer === "policy-rail"`
no distingue), pero su "principal" es la propia plataforma firmando por
sí misma (`principalAddress: issuer.publicKey()`) — una ficción de demo
para poder mostrar el flujo sin wallet, no un cliente real. Nunca pasa por
`ensureTenantAgent`, no tiene fila en `directory_agents`, no tiene wallet
real vinculada. Desplegar un contrato Soroban por cada visita sin wallet
no tendría dueño real a quien pertenecerle, y gastaría fondos de la
reserva en contratos que nadie puede después retirar de forma
significativa (el "principal" sería la propia plataforma).

**La decisión:** `ensureTenantPolicyRail` solo se invoca cuando la sesión
tiene una identidad de tenant real (`tenantAgentId` — viene de
`ensureTenantAgent`, F4/T40) y una wallet vinculada (`walletAddress`,
`directory.bindPrincipal`). El camino clásico sigue leyendo
`POLICY_RAIL_CONTRACT_ID` y pagando desde `AGENT_SECRET_KEY`, exactamente
como antes de este hito — `DemoSession.railContractId` pasa a documentarse
como "el rail compartido, camino clásico", no como el general.

Esto no reabre ni contradice ninguna decisión previa: es la misma línea
que `C-34` ya trazó para la identidad (el camino clásico no tiene una
propia, y no la necesita para lo que demuestra) aplicada ahora también al
pago, que es exactamente donde `C-39`/`C-40` ya decían que la separación
de F4 terminaba y donde empezaba el trabajo de F6.

**Alternativa descartada:** desplegar igual un rail para el camino
clásico, con `principal = issuer` (la propia plataforma). Descartada
porque no prueba nada que el rail compartido no probara ya, y multiplica
contratos Soroban reales (costo de rent, fees de despliegue) por cada
visitante sin wallet de la demo — exactamente el tipo de gasto que `C-21`
ya advierte evitar para identidades que no van a usarse de verdad.

Documentación tocada: `BITACORA.md` (T58), `evidencia/T58.md`. Archivos
tocados: `packages/directory/src/{schema-sql,entities,directory}.ts` (+
`directory.integration.test.ts`, +3 tests), `apps/web/src/tenant-rail.ts`
(nuevo) y su test, `apps/web/src/server.ts` (`buy()`, `finishSession`),
`render.yaml`, `.env.example`.

---

### C-63 · `G10` gana un tope de gasto, no una cola de aprobación — `C-15` sigue vigente · `Vigente`
**Fecha:** 2026-09-11

`G10` describía un riesgo real dejado a propósito sin resolver por `C-15`:
`ensureWalletIsRegisteredIssuer` paga, con la llave admin, el registro de
**cualquier** wallet que pruebe controlar su dirección — y probar eso es
gratis, cualquiera puede generar una wallet Stellar nueva sin pedirle nada
a nadie. Nada limitaba cuántas de esas escrituras reales el admin
terminaba pagando en una ventana de tiempo.

**Lo que el usuario pidió explícitamente:** un tope de gasto o
rate-limit, **no** todavía la cola de aprobación manual que `C-15` ya
había descartado por fricción — sin revertir esa decisión, acotarle el
costo.

**La decisión:** `apps/web/src/issuer-registration-limit.ts`, un contador
de ventana deslizante server-wide (no por wallet — una wallet nueva no
vuelve a pedir registro, así que limitar por dirección no frena a un
atacante que genera una dirección distinta por intento). Tope: **20
registros por hora**, elegido para cubrir con margen el tráfico real de
un piloto (un puñado de visitantes conectando su wallet, cada uno una
sola vez) mientras acota a un número conocido cuánto puede costarle a la
cuenta admin un script insistiendo contra `/api/wallet/verify`. Superado
el tope, `ensureWalletIsRegisteredIssuer` lanza
`IssuerRegistrationRateLimited` (código nuevo en `@agentpass/core`) antes
de llamar a `registerIssuer` — nunca después: consumir un cupo antes del
intento, no después de que resulte, es lo que evita que dos pedidos
concurrentes pasen juntos el chequeo y gasten uno de más.

**Por qué server-wide y no por wallet.** El costo que se protege es el de
la cuenta admin, no el de ninguna wallet en particular — una wallet ya
registrada nunca vuelve a tocar el contador (se corta antes, en
`issuerStatus`), así que el tope solo se gasta con registros *nuevos* de
verdad.

**Por qué en memoria, no en Postgres.** Mismo criterio ya aceptado para
`walletChallenges`/`pendingWalletSessions` (`G12`, pendiente para F8): a
esta escala (un piloto, no producción con más de una instancia), un
contador que se reinicia en un redeploy es una degradación aceptable, no
una vulnerabilidad — en el peor caso, un redeploy le da a un atacante una
ventana nueva completa, que es exactamente el mismo riesgo que ya existía
sin este hito, no uno nuevo. Pasarlo a Postgres es straightforward si F8
alguna vez lo pide, pero hacerlo ahora sería resolver un problema que
`G12` ya tiene en su lista, no uno que este hito necesite resolver de
nuevo.

**`C-15` no se tocó.** Sigue siendo la decisión vigente: una wallet que
prueba control de su dirección se registra sin aprobación manual. Este
hito no vuelve a preguntar esa pregunta — acota cuánto cuesta la
respuesta que `C-15` ya dio, nada más.

**Alternativa descartada:** limitar por dirección de wallet en vez de
server-wide. Descartada porque no protege nada: el costo lo paga el
registro en sí, no la repetición de un mismo registro, y una wallet no
puede pedir que la registren dos veces (el `if (existing.registered &&
existing.active) return` ya la corta antes de llegar al límite).
**Segunda alternativa descartada:** un tope de gasto medido en XLM en vez
de en cantidad de transacciones. Descartada por simplicidad — el fee de
`register_issuer` es esencialmente constante entre llamadas, así que
contar transacciones y contar XLM gastado dan prácticamente el mismo
límite real, y contar transacciones no depende de leer el fee de la red
en cada intento.

Documentación tocada: `PLATAFORMA-PARTNERS.md` (fila `G10`, marcada
mitigada, no resuelta del todo — sigue sin aprobación manual a
propósito). Archivos tocados: `packages/core/src/errors.ts`
(`IssuerRegistrationRateLimited`, código nuevo), `apps/web/src/issuer-registration-limit.ts`
(nuevo) y su test, `apps/web/src/server.ts` (`ensureWalletIsRegisteredIssuer`).

---

### C-64 · El rename a AgentPey (`P-11`) se ejecuta con tres exclusiones deliberadas · `Vigente`
**Fecha:** 2026-09-11

`P-11` dejó anotado que el rename real —repo, paquetes, servicio de
Render, landing, README, el string que la wallet firma— seguía sin
ejecutarse, a propósito, por su blast radius. Esta sesión lo ejecutó,
pero no de forma total: tres superficies se dejaron sin tocar,
deliberadamente, después de investigar el costo real de tocarlas.

**`@agentpass/*` no se renombra.** Es el nombre de la Fase 1 (el
`core`/`sdk`/`cli` de la credencial), no la marca comercial del proyecto
— la misma relación que `PolicyRail` o `MandateVault` tienen con
"AgentPay"/"AgentPey": un nombre de módulo, no de empresa. Confirmado con
el usuario antes de tocar nada.

**Los literales de protocolo horneados en documentos ya firmados no se
tocan.** `AGENTPAY_MANDATE_TYPE` (`"AgentPayMandate"`), `AGENTPAY_INTENT_TYPE`/`AGENTPAY_INTENT_FAMILY`,
y el header de webhook `agentpay-signature` son parte del esquema
zod/wire-format, no texto de marca — un Mandato o un `PurchaseIntent` que
ya se firmó y ancló en testnet real (F6 ya tiene tenants con mandatos
anclados de verdad, T58) tiene ese literal exacto adentro. Cambiar el
valor invalidaría la verificación de todo lo ya emitido, sin ningún
mecanismo de migración — y ninguno se pidió para este hito. Sí se
renombraron dos strings distintos, que **no** son literales de protocolo
sino texto legible que una wallet muestra al firmar y que se recalcula
desde cero en cada verificación (`challengeMessage` en
`wallet-session.ts`, la primera línea de `mandateChallengeMessage` en
`wallet-sign.ts`) — confirmado, antes de tocarlos, que ninguna firma ya
anclada depende de ese texto exacto.

**Las rutas `~/dev/AgentPay(-codex)` no se renombran.** Son carpetas
reales en el disco del usuario, documentadas en `CLAUDE.md`/`AGENTS.md`
como el protocolo de coordinación con Codex (`P-5`) — renombrar la
carpeta que esta misma sesión tiene abierta, o el worktree de Codex, es
una operación de filesystem con blast radius propio (un git worktree
activo, una sesión de Codex quizás corriendo) que no formaba parte de lo
acordado con el usuario para este hito.

**Qué sí se ejecutó, sin quedar pendiente:** el scope de npm completo
(`@agentpay/*` → `@agentpey/*`, confirmado que nunca se publicó nada),
todo el contenido y documentación viva, y el repo de GitHub
(`gh repo rename`, con el redirect de la URL vieja confirmado). El
servicio de Render queda con `render.yaml` actualizado pero sin
renombrarse de verdad — no por elección de diseño sino porque este
entorno no tiene credenciales de Render; es una acción de dashboard que
le toca al usuario, avisada explícitamente en el cierre del hito.

**Alternativa descartada:** renombrar también `@agentpass/*` y los
literales de protocolo "ya que estábamos". Descartada por el usuario
explícitamente al arrancar el hito — la primera habría sido pura
inconsistencia conceptual (mezclar el nombre de un módulo con el de la
marca), la segunda habría requerido diseñar una migración de
compatibilidad de esquema que nadie pidió y que agrega alcance no
solicitado a un hito que ya de por sí toca casi cien archivos.

Documentación tocada: `BITACORA.md` (este hito, sin numerar),
`evidencia/rename-agentpey.md`. Sin cambios en `PLATAFORMA-PARTNERS.md`
— este hito no cambia ningún entregable de la plataforma.

---

### C-65 · El rename tocó un comentario del contrato `policy_rail` y le cambió el hash del wasm — revertido · `Vigente`
**Fecha:** 2026-09-12

Al ejecutar `C-64`, el barrido de "AgentPay" → "AgentPey" en comentarios
de código incluyó `contracts/policy-rail/src/lib.rs` — dos palabras en un
comentario `///`, cero cambio de lógica. Antes de migrar el rail
compartido (ver más abajo) se descubrió que ese cambio, aunque puramente
cosmético, **cambia el hash del wasm compilado**: `8690d1f5…` (el que
T58 ya subió a testnet y usa para cada rail nuevo por tenant) pasó a
`ab73c14a…` con el comentario editado. Confirmado reconstruyendo el
fuente de antes de `C-64` (commit `a650dff`, T57) y comparando byte a
byte.

**La decisión:** revertir esas dos palabras a "AgentPay" en
`lib.rs` — el único lugar de todo el rename donde el texto de un
comentario es, en la práctica, parte del artefacto desplegado. Nada
más de `C-64` se revierte; esto es específico a los contratos Rust que
se compilan a wasm y se referencian por hash (`policy_rail`,
`agent_registry` no se tocó porque `C-64` nunca editó su fuente).

**Por qué importa, y por qué no es solo estética.** `tenant-rail.ts`
(T58) nunca reconstruye el contrato — instancia por hash ya subido
(`POLICY_RAIL_WASM_HASH`, "un wasm, muchas instancias"), así que no vio
ningún efecto. Pero `scripts/deploy-policy-rail.ts` sí reconstruye y
compara antes de reusar un rail existente (para no pisar un contrato
distinto por accidente) — con el hash cambiado, cualquier operación
futura contra el rail compartido lo habría marcado como "wasm distinto
al desplegado" por una razón que no tenía nada que ver con su
comportamiento. Dejar los dos hashes divergir también habría roto la
premisa de "un wasm, muchas instancias" que T58 documentó a propósito.

**Alternativa descartada:** reescribir el comentario con una palabra
neutra ("the platform") en vez de volver a "AgentPay". Descartada:
*cualquier* cambio de texto — no solo la palabra vieja — produce un
hash distinto, así que la única forma de mantener el hash ya subido y
en uso es no tocar esos bytes en absoluto. La marca en el nombre público
del proyecto no depende de un comentario en un archivo Rust que nadie
lee para entender qué es AgentPey.

Documentación tocada: este archivo, `evidencia/rename-agentpey.md`
(nota agregada). Verificado con `cargo test` (32/32 en verde) tras
revertir.

---

### C-66 · El rail compartido se migra al contrato de T57 — `withdraw`/`set_owner` habilitados, `ADMIN_PUBLIC_KEY` como principal · `Vigente`
**Fecha:** 2026-09-12

`C-61`/T57 le agregó a `policy_rail` la capacidad de que el `principal`
retire el saldo o rote la llave que gasta — pero el rail **compartido**
del piloto (el que usa el camino clásico, sin wallet, `C-34`/`C-62`) se
había desplegado en T31, **antes** de T57. Sin migrarlo, ese contrato
seguía sin `principal` — cualquier fondo que entrara ahí no podía salir
nunca, exactamente el problema que `G9` describía, sin resolver en el
único rail que efectivamente recibe tráfico real hoy.

**La decisión, a pedido explícito del usuario:** redesplegar el rail
compartido desde el wasm actual (`8690d1f5…`, el mismo que usan los
rails por tenant de T58 — "un wasm, muchas instancias" se mantiene
exacto), con `owner = AGENT_SECRET_KEY` (sin cambios, sigue siendo quien
firma cada compra) y `principal = ADMIN_PUBLIC_KEY` — la identidad
operadora que ya existe en este proyecto (la misma que registra
emisores), elegida por el usuario en vez de generar una clave nueva.

**Qué pasó con el saldo del rail viejo.** Se abandona.
`CCGAGRLVERK2A6PVQNU6YY62ANWNSFO32DM6OMFLRNLVHYJBLLON4G3I` sigue
existiendo on-chain con lo que tenía (montos simbólicos de testnet) —
sin `principal`, nunca hubo forma de sacarlo de ahí, ni antes ni ahora;
migrar no lo libera retroactivamente. El rail nuevo
(`CANSQJH7KPQTBUXPA42BBWZGZRKLWQZUFVF3SLQOUWKHEX4L3JP7YEDA`) arrancó
fondeado con 0.05 USDC desde la cuenta del agente, igual que
`scripts/deploy-policy-rail.ts` ya hacía en T22/T31.

**Verificado, no solo desplegado:** `pnpm run demo:pay-real --
--payer=policy-rail` corrió de punta a punta contra testnet real después
de la migración — reto 402 real del bazaar, reconciliado contra lo
firmado, pagado por el contrato nuevo
(`3915b0510231e9b2332b7356f2d980706e8561a020b5d4da5ac7581fb5545087`,
`settled: true`). La capacidad de retiro/rotación en sí no se volvió a
probar en esta instancia específica porque es el mismo wasm que T57 ya
probó en vivo (retiro y rotación firmados por el principal, rechazo por
un firmante ajeno) — repetirlo acá no habría probado nada distinto.

**Qué falta, a propósito:** actualizar `POLICY_RAIL_CONTRACT_ID` en el
dashboard de Render (o dejar que el redeploy automático desde
`render.yaml` lo aplique — el valor ya no es secreto, está commiteado)
y confirmarlo contra el sitio real, igual que se hizo con
`MASTER_MNEMONIC`.

**Alternativa descartada:** mover el saldo del rail viejo antes de
abandonarlo. Imposible por diseño — es exactamente la limitación que
esta migración corrige, no algo que se pudiera sortear para el rail
viejo específicamente.

Documentación tocada: `BITACORA.md` (este hito). Archivos tocados:
`contracts/policy-rail/src/lib.rs` (revertido, ver `C-65`),
`deployments/testnet.json`, `render.yaml`, `.env.local` (no
commiteado).

---

### C-67 · T61: `spentOn` lee Postgres en vivo, y `append` serializa `seq` con un advisory lock — no solo un caché más fresco · `Vigente`
**Fecha:** 2026-09-12

`G4` (`PLATAFORMA-PARTNERS.md` § F8) describía el problema como un caché
desactualizado: `postgres-vault.ts` calculaba `spentOn()` desde un mapa
`totals` construido una sola vez, al arrancar el proceso — con dos
instancias, el `perDay` del camino de cuenta clásica se podía exceder
porque cada una vivía ciega a lo que la otra ya había escrito.

**La corrección de `spentOn` (el alcance original del ticket):** se
eliminó el mapa `totals` por completo. Cada llamada a `spentOn` ahora
hace una consulta SQL en vivo (`sum` de los montos `granted` de ese
`subject`/`currency`/día) contra la tabla real. `checkDailyLimit`
(`apps/agent`) no se tocó — sigue siendo la misma función pura,
solo cambia de dónde viene el número que recibe, exactamente lo que el
ticket pedía.

**Un segundo bug, encontrado escribiendo el test, no por inspección.**
El primer test de concurrencia (dos instancias vivas a la vez, no
reconstruidas en secuencia) hizo caer la suite con
`duplicate key value violates unique constraint "vault_records_pkey"`.
Causa: `append()` calculaba `seq` desde `records.length` — el arreglo
**local** de esta instancia, no una fuente compartida. Dos instancias
escribiendo la cadena del mismo tenant calculaban ambas `seq = 0` y
chocaban contra la clave primaria de la tabla. Esto es un bug distinto
de `G4` (afecta la escritura, no la lectura) pero bloquea exactamente lo
que `G4` necesita para funcionar de verdad: si dos procesos nunca pueden
escribir concurrentemente sin reventar, arreglar solo la lectura no
alcanza para "dos procesos compitiendo, el segundo rechazado
correctamente" — el segundo terminaría crasheando, no rechazado.

**La corrección, con el visto bueno explícito del usuario para ampliar
el alcance de T61:** `append()` ahora abre una transacción, toma
`pg_advisory_xact_lock(hashtext(tenantId))` —un lock del lado de
Postgres, no de este proceso ni de este pool de conexiones—, lee el
`seq`/`hash` reales de la cola de la cadena **dentro** de esa
transacción, y recién ahí inserta. Cualquier otro escritor (este proceso
u otro cualquiera) que pida el mismo lock espera hasta que la
transacción anterior haga `commit` o `rollback` — el lock se libera solo
en esos dos casos, nunca se puede quedar tomado para siempre. Se
eliminó la cola de promesas en memoria (`writeQueue`) que antes solo
serializaba dentro de un proceso — el lock de Postgres hace ese trabajo
mejor, y a través de procesos.

**Verificado, no solo argumentado:** 8 tests de integración contra
Postgres real (`postgres-vault.integration.test.ts`), tres nuevos —
una instancia ya viva viendo el gasto de otra sin reconstruirse, dos
instancias compitiendo por el mismo `perDay` con el segundo cálculo ya
reflejando el gasto del primero, y una escritura **verdaderamente
concurrente** (`Promise.all`, no secuencial) que antes del fix
reproducía el choque de `seq` y ahora deja la cadena completa e íntegra
(`verify()` en `ok: true`, dos `seq` distintos, `0` y `1`). Suite
completa del monorepo (`typecheck`/`build`/`test`) sin regresiones,
incluida la integración de `apps/status-dashboard` (lee esta misma
vault).

**Qué sigue igual, a propósito:** `list()`/`head()`/`verify()` de una
instancia siguen reflejando solo lo que esa instancia escribió o cargó
al construirse — no se vuelven "en vivo" como `spentOn`. Es una
limitación ya documentada desde T33 (el mismo comentario que describía
el límite de `writeQueue`) y fuera del alcance de `G4`, que es
específicamente sobre `perDay`. `hasRecorded`/`seenIntents` tiene el
mismo límite (deduplicación de `intentId` ciega entre procesos) y
tampoco se tocó — no es lo que este ticket pedía resolver.

**Alternativa descartada:** dejar el hallazgo del choque de `seq` para
un ticket aparte y cerrar T61 solo con la lectura en vivo. Se
consideró, se le mostró la evidencia al usuario (el crash real, no una
sospecha) antes de decidir, y el usuario pidió explícitamente ampliar
T61 en vez de partirlo — el argumento de peso: sin esto, el propio
criterio de "listo" de T61 (dos procesos compitiendo, el segundo
rechazado) no se podía cumplir, solo aparentar cumplirse hasta que
alguien de verdad hiciera correr dos procesos a la vez.

Documentación tocada: `PLATAFORMA-PARTNERS.md` (fila `T61` cerrada),
`BITACORA.md` (nuevo hito, primero de F8). Archivos tocados:
`packages/vault/src/postgres-vault.ts`,
`packages/vault/src/postgres-vault.integration.test.ts` (+3 tests).

---

### C-68 · T64/T66: `atomically()` cierra la carrera de decisión que T61 dejó abierta — `perDay` aguanta procesos separados de verdad · `Vigente`
**Fecha:** 2026-09-12

T64 (Codex, PR #20) construyó `scripts/loadtest-perday.ts`: cuatro
procesos de Node reales y separados, cada uno con su propia conexión a
Postgres, compitiendo por el mismo `tenantId`/`subject`/día contra la
vault real. Corrida real, pegada tal cual salió, sin ocultar el
resultado (como el prompt de delegación pedía explícitamente si esto
pasaba):

```
processes: 4    attempts: 12    accepted: 4    rejected: 8
recorded total: 12.0000000 USDC   reference limit: 10.0000000 USDC
within limit: NO      chain intact: yes      worker counts: consistent
```

El `perDay` de referencia se excedió — 12.00 contra 10.00 — con la
cadena de hashes íntegra y ningún proceso caído. Codex identificó
correctamente que esto era evidencia de un hueco en T61, no un fallo
del harness, y no avanzó a T65 como el propio prompt de delegación le
pedía en ese caso exacto.

**Revisado y confirmado de forma independiente**, en un worktree
aislado (`/tmp/agentpay-pr20-review`, descartado al terminar):
`typecheck`/`build`/`test` limpios, sin filas `loadtest-*` sobrantes al
terminar (el harness limpia las suyas), y la misma corrida repetida
contra Postgres real reprodujo exactamente el mismo resultado —
`12.0000000` contra el límite de `10.0000000`. PR #20 mergeado
(`gh pr merge --merge`).

**La causa raíz, no solo el síntoma.** `C-67` (T61) cerró la carrera de
**escritura**: `append()` ahora sirve `seq`/`prevHash` reales dentro de
un `pg_advisory_xact_lock` por `tenantId`, así que dos procesos nunca
más chocan al insertar. Pero la decisión de negocio —¿este gasto entra
en el `perDay`?— vive un nivel más arriba, en
`apps/agent/src/policy/policy-rail.ts`, dentro de `createLocalPolicyRail`.
Esa función serializa `authorise()` con una cola de promesas **en
memoria, por sujeto** — construida en T19 (`M-15`), con el límite ya
escrito en su propio comentario desde entonces: "la serialización es
una cadena de promesas, así que sostiene dentro de este proceso y en
ningún otro lado... esto tiene que volverse una transacción de base de
datos o un lock distribuido". F8/T61 nunca tocó esa función — arregló
un bug real y distinto (la colisión de `seq`), no el que `M-15` ya
había anotado como pendiente. El harness de T64, que habla directo con
la vault (como pedía su propio alcance, sin levantar `apps/web`), midió
exactamente ese gap: cuatro procesos leyendo `spentOn()` antes de que
ninguno escribiera, los cuatro decidiendo "dentro del límite", los
cuatro grabando.

**La corrección (T66, mía — enforcement de `perDay`, no delegable):**
`SpendLedger` (`apps/agent/src/ledger/spend-ledger.ts`) y `MandateVault`
(`packages/vault/src/vault.ts`) ganan un método nuevo, **opcional**:
`atomically(subject, work)`, donde `work` recibe su propia terna
`spentOn`/`hasRecorded`/`record` — ya no la del ledger completo — con
la garantía de que las tres corren dentro de una sola sección crítica.
`createLocalPolicyRail` ahora prefiere `ledger.atomically` cuando existe
y cae de vuelta a la cola de promesas original cuando no
(`apps/agent/src/policy/policy-rail.ts`, `criticalSection`) — la vault
en memoria y la de archivo no ganaron nada nuevo: ninguna puede
sobrevivir a más de un proceso de todos modos, así que la cola en
memoria sigue siendo exactamente lo que ya eran. Solo
`createPostgresMandateVault` implementa la versión real: abre una
transacción, toma el mismo `pg_advisory_xact_lock(tenantId)` que
`append()` ya usaba, y dentro de esa transacción entrega versiones de
`spentOn`/`hasRecorded`/`record` atadas al mismo cliente — la lectura,
la decisión del llamador, y la escritura ya no pueden intercalarse con
las de otro proceso, porque el segundo bloquea en el lock hasta que el
primero hace `commit`.

**Un hallazgo lateral, cerrado con el mismo lock:** `hasRecorded`
(deduplicación por `intentId`) tenía el mismo tipo de hueco que
`spentOn` tenía antes de `C-67` — `seenIntents` se construye una sola
vez, al crear la instancia, así que un `intentId` grabado por otro
proceso después de ese momento era invisible. `C-67` lo dejó anotado
explícitamente como fuera de su alcance. La versión con lock de
`hasRecorded` ahora consulta Postgres en vivo (igual que `spentOn`), y
de paso el `hasRecorded`/`record` de fuera de una sección crítica
también pasaron a usar esa misma consulta en vivo en vez de
`seenIntents` — mismo patrón que `G4`, mismo arreglo.

**Verificado en cuatro niveles, no solo con un test unitario:**

1. Nuevo test de integración contra Postgres real
   (`postgres-vault.integration.test.ts`): dos instancias, `Promise.all`,
   compitiendo de verdad por un límite de 6.00 con intentos de 5.00 cada
   una — nunca ambas graban, la cadena queda íntegra.
2. Los 29 tests existentes de `policy-rail.test.ts` (incluidos los de
   concurrencia de `M-15`) pasan sin ningún cambio — el diseño con
   fallback preserva el comportamiento exacto de la cola en memoria
   cuando el ledger no ofrece `atomically`.
3. Suite completa del monorepo (`typecheck`/`build`/`test`) sin
   regresiones.
4. **El mismo harness de T64, con un modo nuevo.**
   `scripts/loadtest-perday.ts` ahora acepta `--atomic`: en vez de que
   cada worker llame `spentOn`/`record` sueltos, llama
   `vault.atomically()`. Tres corridas reales, procesos separados de
   verdad, mismo resultado repetido:

   ```
   processes: 4    attempts: 12    accepted: 3    rejected: 9
   recorded total: 9.0000000 USDC   reference limit: 10.0000000 USDC
   within limit: yes      chain intact: yes      worker counts: consistent
   ```

   El modo original (`racy`, default) se dejó intacto y sigue
   reproduciendo el hallazgo de T64 sin cambios — sirve como prueba de
   regresión de que el problema seguiría ahí si `atomically` se dejara
   de usar.

**Un bug de la propia herramienta, encontrado construyendo la
verificación — no del fix.** El primer intento de `--atomic` se colgó y
el proceso terminó saliendo solo, en silencio, con código 0 y sin
imprimir nada: el modo atómico no tiene el intercambio
decisión/commit que mantenía a los workers al mismo ritmo entre rondas,
así que un worker rápido podía terminar sus tres rondas y salir del
todo antes de que el coordinador llegara a registrar un listener de
`"exit"` sobre ese proceso — y Node solo entrega un evento a los
listeners que ya estaban puestos cuando el evento ocurrió. Sin nada más
manteniendo vivo el bucle de eventos, el proceso completo se apagó solo,
abandonando a mitad de camino la función que todavía esperaba ese
listener. Arreglado consultando `exitCode` — que sí queda grabado de
forma confiable por un listener puesto al lanzar cada proceso — en vez
de intentar escuchar el evento tarde. Encontrado y arreglado antes de
tomar ninguna corrida como evidencia válida.

**Alternativa descartada:** hacer `atomically` obligatorio en el puerto
`SpendLedger`, forzando a la vault en memoria y a la de archivo a
implementarlo también. Se descartó: ninguna de las dos puede ofrecer
una garantía real entre procesos (no tienen almacenamiento compartido),
así que forzar una implementación ahí sería una promesa falsa —
opcional-con-fallback deja explícito que solo un backend compartido
(Postgres) puede cumplir la garantía fuerte, sin tocar ningún test
existente que construye un `SpendLedger` a mano.

Documentación tocada: `PLATAFORMA-PARTNERS.md` (fila `T64` con la
corrida real, fila `T66` nueva), `BITACORA.md`. Archivos tocados:
`apps/agent/src/ledger/spend-ledger.ts`,
`apps/agent/src/policy/policy-rail.ts`, `packages/vault/src/vault.ts`,
`packages/vault/src/postgres-vault.ts`,
`packages/vault/src/postgres-vault.integration.test.ts` (+1 test),
`scripts/loadtest-perday.ts` (modo `--atomic` + arreglo de
`waitForExit`).

---

### C-69 · T67: `Registry` deja de necesitar la misma instancia entre `prepare*` y `submitSigned` — `G12`, primer hito · `Vigente`
**Fecha:** 2026-09-12

`G12` (mencionado en el alcance de F8, nunca desglosado en un ticket)
es el mismo problema que `G4` tenía, aplicado al flujo de conexión de
wallet: si el piloto corre más de una instancia de `apps/web`, un
visitante puede empezar `/api/wallet/challenge` en una y que
`/api/wallet/verify` caiga en otra que nunca vio el nonce.

**Investigado antes de escribir nada, con el visto bueno explícito del
usuario para tocar Fase 1 si hacía falta.** El plan original que el
usuario aprobó era "Postgres + cifrado" para los campos que parecían
secretos en `PendingWalletSession`. Rastreando de dónde salen esos
campos (`server.ts`, función `startSession`), encontré que ninguno es
en realidad un secreto por-sesión:

- `issuerSecret`/`paymentSecret` son literalmente
  `ISSUER_SECRET_KEY`/`AGENT_SECRET_KEY` leídos de `env` — los mismos
  siempre, no algo que la sesión posea.
- `agentKeypair` se re-deriva de forma determinística vía
  `ensureTenantAgent(masterMnemonic, sessionId)` — el propio código ya
  lo re-deriva así en la rama "rehydrate" de `startSession`.

Ninguno necesita cifrado ni persistencia: se pueden volver a
leer/derivar en cada request. Se lo mostré al usuario antes de seguir
(no se cambió el plan aprobado en silencio) y confirmó ampliar el
alcance a lo que de verdad bloqueaba G12.

**El bloqueante real, encontrado leyendo `Registry` (`packages/sdk`,
Fase 1) a fondo.** `prepareAnchor`/`prepareRevoke` guardaban la
transacción Soroban ya armada y simulada (`AssembledCall`) en un `Map`
interno de la instancia (`pendingWrites`), para que `submitSigned` la
usara dos requests HTTP después. Ese objeto no es serializable a una
fila de Postgres sin reescribir buena parte del SDK de Stellar. Leyendo
`AssembledTransaction.sign()` del propio `@stellar/stellar-sdk`
(`assembled_transaction.js:515-535`), confirmé que esa instancia
original **no hace falta** para firmar y enviar: el método descarta
todo lo que acaba de simular en el momento en que el callback de firma
devuelve su propio `signedTxXdr` (exactamente lo que este código ya
hace), y reconstruye la transacción a enviar enteramente desde ese
string. Alcanza con volver a simular la misma llamada (`anchor`/
`revoke` con los mismos parámetros — datos públicos, chicos) para
obtener un `AssembledCall` fresco sobre el que llamar `signAndSend`
exactamente igual que antes.

**El cambio.** `Registry` gana un puerto opcional,
`PendingWriteStore` (`save`/`take`), con una implementación en memoria
por defecto **idéntica a la de antes** — todo llamador que no pase
nada (`apps/agent`, scripts, `packages/cli`) sigue funcionando exacto
igual, cero cambio de comportamiento. `prepareAnchor`/`prepareRevoke`
ahora guardan los parámetros de la llamada (`PendingWrite`, un tipo
discriminado por `kind: "anchor" | "revoke"`), no el objeto armado.
`submitSigned` lee esos parámetros, vuelve a simular la llamada exacta,
y llama `signAndSend` sobre el resultado fresco — la misma línea que
antes, solo que sobre una instancia recién construida. `createAgentPass`
gana un segundo parámetro opcional, `{ pendingWriteStore }`, para que
`apps/web` pueda inyectar una implementación compartida (Postgres,
T68) sin que ningún llamador existente note el cambio.

**Verificado contra testnet real, no solo con tests unitarios — esto
toca Fase 1.** Suite completa de `packages/sdk`/`packages/mandate`
(la que usa `RegistryAccess` a través de su propio fake, sin cambios)
sin regresiones. Dos tests nuevos contra testnet real
(`pending-write.integration.test.ts`): `prepareRevoke` en una
instancia de `AgentPass`, `submitSigned` en **otra instancia distinta**
que comparte solo el `PendingWriteStore` — funciona, revoca de verdad;
lo mismo para `prepareAnchor` (el camino que el flujo real de wallet
usa). Un tercer test confirma que un `requestId` que nadie preparó se
rechaza igual que antes.

**Dos mutaciones deliberadas, no solo argumentadas:**
1. Invertir qué rama de `submitSigned` re-simula (`anchor` vs
   `revoke`) — el propio *type-checker* la rechaza: el tipo
   discriminado de `PendingWrite` hace que esa rama ni siquiera
   compile con los campos equivocados. Una garantía más fuerte que un
   test en tiempo de ejecución.
2. Intercambiar `subject`/`credentialHash` al guardar el `PendingWrite`
   de un `anchor` — compila (los dos son strings), pero la corrida
   real contra testnet la atrapó: `credentialHashToBytes` rechaza la
   dirección Stellar que terminó en el campo equivocado
   (`ConfigError`, "a credential hash must be 64 lowercase hex
   characters"). Revertida después de confirmar la falla.

**Qué NO cambió, a propósito:** `anchor()`/`revoke()`/`issue()`/
`verify()` normales (el camino sin wallet, con un `Keypair` real) —
solo el camino de dos fases. `checkMandate`/`checkScope`/
`checkDailyLimit`/`PolicyRail` — nada de esto se tocó. El contrato
`policy_rail` (Soroban) no depende de nada de esto.

**Alternativa descartada:** cifrar `issuerSecret`/`paymentSecret`/
`agentKeypair` para poder persistirlos tal cual, siguiendo el plan
original aprobado. Descartada con evidencia (de dónde sale cada campo,
mostrado arriba) antes de escribir ninguna primitiva de cifrado nueva
— habría sido una complejidad real para guardar datos que ni siquiera
son secretos por-sesión.

Documentación tocada: `BITACORA.md` (nuevo hito T67). Archivos
tocados: `packages/sdk/src/registry.ts`, `packages/sdk/src/index.ts`,
`packages/sdk/src/pending-write.integration.test.ts` (nuevo, 3 tests).

Pendiente: T68 (`apps/web`: `PendingWriteStore` sobre Postgres +
`agentpass` reconstruido por request), T69 (los otros tres stores en
memoria — `walletChallenges`/`pendingWalletSessions`/
`pendingConsentSessions`/`walletAddressBySession` — a Postgres, ya sin
nada secreto que perder). Plan completo en
`/Users/vicentewolde/.claude/plans/encapsulated-bubbling-phoenix.md`.

---

### C-70 · T68: el `PendingWriteStore` de T67 llega a `apps/web`, sobre Postgres — `G12`, segundo hito · `Vigente`
**Fecha:** 2026-09-12

T67 (`C-69`) le dio a `Registry` (`packages/sdk`) un puerto opcional
para no depender de la misma instancia entre `prepareAnchor`/
`prepareRevoke` y `submitSigned`. Este hito lo conecta de verdad en
`apps/web`: una implementación de ese puerto sobre Postgres, y los
cuatro puntos del flujo de wallet que antes leían `pending.agentpass`
ahora construyen un `AgentPass` nuevo en cada request.

**El módulo nuevo**, `apps/web/src/pending-write-store.ts`: mismo
patrón que `@agentpey/vault`'s `createPostgresMandateVault` — un
`Pool`, la misma postura de TLS que T62 (`POSTGRES_CA_CERT` opcional),
una tabla (`sdk_pending_writes`), errores logueados con `logError`
(T63) y relanzados como `ConfigError` tipado. `take` es un único
`delete ... returning`, no un `select` seguido de un `delete`: dos
llamadas a `submitSigned` con el mismo `requestId` al mismo tiempo no
deben poder leer la misma fila las dos — la propia sentencia SQL es la
garantía de un solo uso, no algo que un llamador tenga que coordinar.

**El cableado en `server.ts`.** `createWalletAgentPass(env)`, una
función nueva, construye un `AgentPass` fresco con el store de
Postgres inyectado — usada en los cuatro lugares que antes leían
`pending.agentpass`: `/api/session/wallet-consent`,
`/api/session/wallet-anchor`, `/api/consent/{id}/wallet-consent`,
`/api/consent/{id}/wallet-anchor`. Como ningún llamador vuelve a leer
`agentpass` de la sesión pendiente, se sacó el campo de
`PendingWalletSession`/`PendingConsentSession` — no quedó ahí sin usar,
esperando a T69.

**Verificado en tres niveles, el último contra el servidor real:**
1. Cuatro tests de integración nuevos contra Postgres real
   (`pending-write-store.integration.test.ts`): guardar desde una
   instancia del store, leer desde **otra instancia distinta** — la
   misma prueba que T67 hizo a nivel `Registry`, ahora a nivel de la
   implementación real que `apps/web` usa.
2. Suite completa del monorepo sin regresiones (112 tests de
   `apps/web`, sin cambios de comportamiento en ningún otro paquete).
3. **Corrida real de punta a punta contra el servidor real.** Un
   script temporal (borrado después, mismo criterio que
   `t22-fee-probe.ts`) hizo de wallet de verdad — Keypair generado,
   fondeado por Friendbot, firmando el desafío SEP-0053 y la
   transacción de anclaje exactamente como lo haría Freighter — y
   recorrió las cinco llamadas HTTP reales del flujo completo:
   `/api/wallet/challenge` → `/api/wallet/verify` →
   `/api/session/start` → `/api/session/wallet-consent` →
   `/api/session/wallet-anchor`. Terminó con un Mandato anclado de
   verdad en testnet, `agentStatus: "Active"`. Confirmado también que
   la fila del `PendingWriteStore` se borró sola al consumirse — cero
   filas sobrantes en Postgres al terminar.

**Un hallazgo real, no relacionado con G12, encontrado revisando el
propio arnés de verificación.** `apps/web/vitest.config.ts` (la suite
"offline", `pnpm test`) no tenía el `exclude` de
`src/**/*.integration.test.ts` que `packages/vault` y
`apps/status-dashboard` sí tienen — así que al agregar el primer test
de integración de `apps/web`, `pnpm test` empezó a correrlo también, y
habría fallado en cualquier entorno sin `DATABASE_URL` (por ejemplo,
CI, si alguna vez existe). Corregido agregando el mismo `exclude` que
ya usan los otros dos paquetes — no era parte del alcance de T68, pero
apareció mientras se verificaba, y dejarlo así habría sido un problema
real para la próxima persona que corriera `pnpm test` sin `.env.local`.

**Qué NO cambió, a propósito.** Este hito no toca todavía
`walletChallenges`/`pendingWalletSessions`/`pendingConsentSessions`/
`walletAddressBySession` — esos cuatro siguen en memoria, en
`ExpiringStore`s de proceso, exactamente como antes. Eso es T69: con
`agentpass` ya fuera de la ecuación, lo único que falta es que esos
datos (ya confirmado que ninguno es secreto — `C-69`) crucen también a
Postgres.

Documentación tocada: `BITACORA.md` (nuevo hito). Archivos tocados:
`apps/web/src/pending-write-store.ts` (nuevo),
`apps/web/src/pending-write-store.integration.test.ts` (nuevo, 4
tests), `apps/web/src/server.ts`, `apps/web/vitest.config.ts` (fix del
`exclude`), `apps/web/vitest.integration.config.ts` (nuevo),
`apps/web/package.json` (`pg`/`@types/pg`, script `test:integration`).

Pendiente: T69 — los otros cuatro stores en memoria del flujo de
wallet, a Postgres. Plan completo en
`/Users/vicentewolde/.claude/plans/encapsulated-bubbling-phoenix.md`.

---

### C-71 · T69: los últimos cuatro stores en memoria del flujo de wallet, a Postgres — `G12` cerrado · `Vigente`
**Fecha:** 2026-09-12

Tercer y último hito de `G12`. `T67` (`C-69`) resolvió el bloqueante
real de Fase 1 (`Registry.pendingWrites`); `T68` (`C-70`) conectó esa
capacidad en `apps/web` para el anclaje de wallet. Quedaban cuatro
stores en memoria, todos en `server.ts`/`wallet-session.ts`, sin
ningún bloqueante nuevo que investigar — `C-69` ya había confirmado
que ninguno de los tres campos que parecían secretos en
`PendingWalletSession` (`issuerSecret`, `paymentSecret`,
`agentKeypair`) necesitaba viajar por Postgres:

- `walletChallenges` (`ExpiringStore<true>`, T34) — los nonces de un
  solo uso del desafío de wallet.
- `pendingWalletSessions`/`pendingConsentSessions` (`ExpiringStore`,
  T35/T51) — el estado de la sesión a mitad de camino entre las tres
  requests que una firma de wallet necesita.
- `walletAddressBySession`/`walletAddressByConsentSession` (`Map`
  plano, sin TTL) — la wallet detrás de cada sesión, una vez verificada.

**El cambio.** Módulo nuevo, `apps/web/src/wallet-session-store.ts`:
cinco tablas, mismo patrón que `pending-write-store.ts` (T68) — un
`Pool`, la postura de TLS de T62, errores por `logError` (T63). Cada
fila que sale de Postgres se valida con zod
(`agentPassCredentialSchema`/`agentPayMandateSchema`/
`credentialRequestSchema`, las mismas que el resto del proyecto ya usa
para esto) antes de devolverse — mismo criterio que
`@agentpey/directory` aplica a sus propias filas, no un cast a ciegas.

`PendingWalletSessionPayload`/`PendingConsentSessionPayload` (los
tipos que ahora viven en este módulo, reemplazando las interfaces
locales de `server.ts`) **no tienen** `issuerSecret`/`paymentSecret`/
`agentKeypair` — se recalculan en cada request desde `env`/
`masterMnemonic`, igual que la rama "rehydrate" ya hacía. Un
simplificación de paso: `PendingWalletSession.supersedes` (el
`MandateRecord` completo) pasó a `supersedesId` (solo el campo que
`wallet-anchor` realmente lee) — evita tener que pensar en cómo
serializar un registro completo con fechas por un solo id.

`walletChallenges.set/take` → `issueChallenge`/`takeChallenge`
(`take` es un único `delete ... returning`, no un `select` seguido de
un `delete` — dos `submitSigned`/`wallet-verify` con el mismo nonce al
mismo tiempo no deben poder leer la misma fila los dos).
`pendingWalletSessions.peek/set/delete` → `get`/`set`/`delete`
asíncronos; la mutación en el lugar que hacía `pending.signature = x`
pasa a `updatePendingWalletSession(id, {signature, requestId})`, un
`update ... set payload = payload || $2::jsonb`.

**Un hallazgo real, encontrado leyendo el propio código antes de
migrarlo, no algo que hiciera falta investigar de nuevo.** El
`wallet-anchor` de la sesión clásica ya recalculaba `tenantAgent`
(`ensureTenantAgent`) para otro propósito (resolver el `agentId` de
`recordCredential`) — su `.keypair` es exactamente lo que
`pending.agentKeypair` guardaba. No hizo falta ninguna llamada nueva,
solo reusar el valor que el handler ya calculaba.

**Verificado en cuatro niveles:**

1. 11 tests de integración nuevos contra Postgres real
   (`wallet-session-store.integration.test.ts`): cada método, guardado
   en una instancia del store y leído desde **otra instancia
   distinta** — la misma prueba que T67/T68 hicieron en sus capas.
2. Suite completa del monorepo sin regresiones (`ExpiringStore`, ya sin
   ningún llamador en código de producción, se borró junto con sus 10
   tests propios — dejarla habría sido código muerto sostenido solo
   por su propia suite).
3. **Corrida real de punta a punta contra el servidor real, los tres
   flujos completos**, no solo el de wallet: clásico (sin wallet),
   wallet-connect (challenge → verify → start → wallet-consent →
   wallet-anchor, **más una reconexión** con la misma wallet que
   confirma que `walletAddressBySession` sobrevive y rehidrata), y
   consent-session hospedado (creación de partner y tenant reales vía
   `/v1`, `wallet-verify` → `start` → `wallet-consent` →
   `wallet-anchor`, terminando con la invitación en `"completed"` y un
   Mandato anclado de verdad). Un script temporal (borrado después)
   condujo los tres. Filas de prueba en `wallet_address_by_session`
   (la única tabla sin TTL) borradas a mano al terminar — las demás no
   dejaron nada, por diseño.
4. `pnpm typecheck`/`build` limpios en cada paso.

**De paso, corregido: dos filas de `PLATAFORMA-PARTNERS.md` que
seguían diciendo "sin resolver" mucho después de estarlo.** `G4`
seguía marcada "hoy mitigado por correr una sola instancia" pese a que
T61/T66 (mismo día) ya la habían resuelto de verdad — nunca se
actualizó esa fila específica al cerrar F8. Corregidas las dos (`G4` y
`G12`) al mismo tiempo, con el mismo criterio `✅ Resuelto` que `G9`/
`G10` ya usan.

**Qué NO cambió, a propósito.** `checkMandate`/`checkScope`/
`checkDailyLimit`/`PolicyRail` — nada de esto se tocó en ninguno de los
tres hitos de `G12`. `sessions` (el `Map` de sesiones ya terminadas,
con la instancia viva de `Agent`) queda tal cual — es un problema
distinto (contiene objetos no serializables por diseño, como `Registry`
lo hacía antes de T67) y no es lo que `G12` pedía cerrar.

Documentación tocada: `PLATAFORMA-PARTNERS.md` (filas `G4`/`G12`
marcadas resueltas, nota de F8 actualizada), `BITACORA.md` (nuevo
hito, `G12` completo). Archivos tocados:
`apps/web/src/wallet-session-store.ts` (nuevo),
`apps/web/src/wallet-session-store.integration.test.ts` (nuevo, 11
tests), `apps/web/src/server.ts`, `apps/web/src/wallet-session.ts`
(`ExpiringStore` borrado), `apps/web/src/wallet-session.test.ts` (sus
10 tests borrados con él).

Pendiente: nada de `G12` — los tres hitos (T67, T68, T69) cierran la
brecha completa. Sigue sin ticket, a propósito: métricas, alertas,
política de retención (mencionadas en el alcance original de F8, nunca
desglosadas). `agentpey.com`/Custom Domains en Render sigue pendiente,
sin apuro.

---

### C-72 · T70: un temporizador dentro del propio proceso barre las filas vencidas, no un cron aparte · `Vigente`
**Fecha:** 2026-09-12

`G12` (T67–T69) dejó anotado, sin ticket, que ninguna de las tablas
efímeras del flujo de wallet borraba de verdad una fila vencida — cada
lectura ya filtra por `expires_at > now()`, pero una fila que nunca se
volvió a leer (un desafío sin responder, una sesión abandonada a mitad
de camino) se queda en la tabla para siempre. Con el visto bueno
explícito del usuario ("agregar limpieza activa ahora"), este hito lo
cierra.

**La decisión: un `setInterval` de 15 minutos dentro del propio proceso
de `apps/web`, no un servicio de cron de Render aparte.** Alternativa
descartada: un Render Cron Job separado que invoque un script de
limpieza. Se descartó porque habría sido infraestructura nueva a
configurar y mantener (y en el plan gratuito actual, `render.yaml` no
tiene ningún servicio de ese tipo hoy — agregarlo es un compromiso de
plataforma, no una línea de código), mientras que el servidor ya corre
sin parar y ya es dueño de los dos `Pool` de Postgres que hace falta
tocar. Un temporizador interno reutiliza esa conexión ya abierta sin
ningún proceso, dependencia ni configuración nueva. Si el piloto algún
día corre más de una instancia (el mismo escenario de `G12`), varios
barridos concurrentes no chocan: cada `delete ... where expires_at <=
now()` es idempotente en sí mismo.

**Por qué 15 minutos y no algo más corto o más largo.** El TTL más
largo del flujo hoy es 10 minutos (`PENDING_WALLET_SESSION_TTL_MS`,
`PENDING_WRITE_TTL_MS` en `packages/sdk`); 15 minutos deja como máximo
un ciclo extra de filas ya vencidas pero todavía no barridas, sin
agregar un `delete` al camino caliente de cada request de conectar
wallet (que es lo que habría pasado si se podara en cada `save`, como
sí hace barato el `Map` en memoria que este mismo patrón ya usa en
`packages/sdk`).

**Por qué el método nuevo no se agregó al puerto compartido
`PendingWriteStore` (`@agentpass/sdk`, Fase 1).** Ese puerto ya tiene
una implementación en memoria por defecto (`createInMemoryPendingWriteStore`)
que poda entradas vencidas en cada `save`/`take` — barato para un
`Map`, sin necesitar ningún método de barrido separado. Agregarle
`sweepExpired()` al puerto habría forzado a esa implementación a
declarar un método que no le hace falta, solo para que la
implementación de Postgres de `apps/web` lo tuviera. Se definió en
cambio un tipo local en `apps/web/src/pending-write-store.ts`
(`PostgresPendingWriteStore`, que extiende el puerto) — el método
nuevo vive solo donde hace falta, sin tocar `packages/sdk` para nada.
`wallet-session-store.ts` no tuvo este problema: su interfaz
(`WalletSessionStore`) ya es local a `apps/web`, sin ninguna
implementación alternativa que respetar.

**Qué NO se tocó, a propósito.** `wallet_address_by_session`/
`wallet_address_by_consent_session` — sin `expires_at` por diseño
desde `C-71`, el barrido nunca las toca. `checkMandate`/`checkScope`/
`checkDailyLimit`/`PolicyRail` — nada de esto tiene relación con
retención de sesiones de wallet.

**Verificado en cuatro niveles:** tests de integración nuevos contra
Postgres real en los dos módulos (confirman contra la tabla cruda que
la fila vencida desaparece, la viva y la sin-TTL sobreviven); suite
completa del monorepo sin regresiones; los 17 tests de integración de
`apps/web` (12 + 5, incluyendo los dos nuevos); y el servidor real
arrancado con `pnpm --filter @agentpey/web run dev`, respondiendo
`200` en `/` con el temporizador ya cableado desde el arranque.

Documentación tocada: `BITACORA.md` (nuevo hito T70),
`PLATAFORMA-PARTNERS.md` (nota de F8). Archivos tocados:
`apps/web/src/wallet-session-store.ts`,
`apps/web/src/wallet-session-store.integration.test.ts`,
`apps/web/src/pending-write-store.ts`,
`apps/web/src/pending-write-store.integration.test.ts`,
`apps/web/src/server.ts`.

---

### C-73 · T71: el panel de métricas reutiliza el cálculo real, nunca lo duplica; el saldo de rail queda inyectado · `Vigente`
**Fecha:** 2026-09-12

El usuario pidió el panel completo de métricas/alertas (no la
alternativa más chica de "solo alertar por saldo bajo de rail" que se
había ofrecido): uso de `perDay` cerca del límite, rechazos recientes,
saldo de `policy_rail`, agregados al `status-dashboard` (T59) existente.

**La decisión de fondo: cada número que el panel muestra se calcula
exactamente como el camino de autorización real lo calcula, nunca con
su propia copia de la lógica.** `readPerDayUsage()` llama
`vault.spentOn(subject, currency, hoy)` — la misma función que
`PolicyRail.authorise()` (`apps/agent/src/policy/policy-rail.ts`) usa
antes de decidir si un gasto entra en el límite diario — en vez de
sumar montos del historial del vault a mano. Reimplementar esa suma en
el dashboard habría sido una segunda fuente de verdad que podía
divergir de la real (por ejemplo, si `checkDailyLimit`/`spentOn`
cambiara su regla de qué cuenta como "hoy" en UTC) sin que nada lo
detectara — el panel mentiría con confianza. La única lectura nueva de
verdad que el `VaultReader`/`StatusDirectory` del dashboard ganaron es
exactamente esa: `spentOn` (ya existía en `MandateVault`, solo faltaba
exponerse en la interfaz de solo lectura) y `listAgents` (ya existía en
`Directory`, mismo caso).

**Por qué el Mandato activo se re-valida con `agentPayMandateSchema` en
vez de asumir que `document` ya es válido.** `@agentpey/directory`
guarda `document` como un `z.record(z.string(), z.unknown())` a
propósito (`entities.ts`: "storing a signed document and judging one
are different jobs") — nunca depende de `@agentpey/mandate`. El
dashboard sí necesita leer `credentialSubject.grant.limits`, así que
tiene que volver a validar en ese borde, mismo criterio que
`wallet-session-store.ts` ya aplica a sus propias filas de Postgres. Un
documento que no parsea (el caso más común en los tests: fixtures
viejas con `{ version: 1 }`) hace que `readPerDayUsage` devuelva
`undefined` — "no hay nada que medir" — en vez de romper la página
entera.

**Por qué el saldo de rail es una función inyectada
(`readBalance: (railContractId: string) => Promise<string>`), no una
llamada directa a `@stellar/stellar-sdk` dentro de `status.ts`.** Mismo
seam que `vaultFactory` ya establece para Postgres: `status.ts` es
lógica pura, testeable con dobles simples en memoria, sin abrir una
conexión real a nada. La implementación real
(`apps/status-dashboard/src/rail-balance.ts`, nuevo) es la única pieza
que sabe qué es Stellar — una simulación `balance()` SEP-41 sobre el
contrato SAC de USDC, la misma llamada que
`scripts/check-rail-balances.ts` (T60) ya hacía como script de
operador. Verificada con una corrida real contra el rail compartido de
testnet (`POLICY_RAIL_CONTRACT_ID` de `render.yaml`,
`CANSQJH7KPQTBUXPA42BBWZGZRKLWQZUFVF3SLQOUWKHEX4L3JP7YEDA`): devolvió
el saldo real, `0.0490000`.

**Umbrales elegidos, con su motivo:** `PERDAY_WARNING_RATIO = 0.8` —
80% del límite diario, para avisar con margen de una compra más antes
del corte, no en el corte mismo (mismo espíritu que `LOW_USDC_WARNING`
ya aplicaba al saldo de rail desde T60, reusado tal cual acá, no
reinventado).

**Alternativa descartada:** el alcance mínimo que se había ofrecido
como opción ("solo conectar `check-rail-balances.ts` a un aviso real,
saltear `perDay`/rechazos"). El usuario eligió explícitamente el panel
completo — el saldo de rail por sí solo no contestaba las otras dos
preguntas operativas (¿un tenant está por chocar con su límite? ¿qué
se le rechazó y por qué?) que sí importan para acompañar un piloto
externo (F9).

Documentación tocada: `BITACORA.md` (nuevo hito T71),
`PLATAFORMA-PARTNERS.md` (nota de F8). Archivos tocados:
`apps/status-dashboard/src/status.ts`,
`apps/status-dashboard/src/status.test.ts` (nuevo),
`apps/status-dashboard/src/rail-balance.ts` (nuevo),
`apps/status-dashboard/src/server.ts`,
`apps/status-dashboard/src/server.test.ts`,
`apps/status-dashboard/src/server.integration.test.ts`,
`apps/status-dashboard/package.json`.

---

---

### C-74 · F9 deja de ser "incorporar un partner real" y pasa a ser un piloto con plataforma y comercio propios · `Vigente`
**Fecha:** 2026-09-12 · **Confirmada por el usuario**

`PLATAFORMA-PARTNERS.md` § F9 definió esta fase, desde su borrador de
T37, como "incorporar al partner real, mediar el piloto". Eso quedó
bloqueado desde T69: al usuario se le preguntó dos veces quién era el
partner y las dos veces contestó que no lo tenía decidido.

**El brief del 2026-09-12 resolvió el bloqueo cambiando la premisa en
vez de respondiéndola.** No hay partner externo: el proyecto construye
la plataforma de agentes (**RealOps Agent**) y el comercio
(**SignalDesk**) para probar una integración parecida a una real, y
poder mostrársela después a partners y comercios potenciales. El
criterio de éxito son los diez casos de aceptación del brief § 7 —
camino feliz de dos productos más los rechazos guiados — no una métrica
de volumen, por la misma razón que `C-24` ya había fijado para el
piloto interno: en testnet sin usuarios reales el volumen se infla sin
probar nada.

**Qué se descartó.** Esperar al bazaar del embajador o a un equipo de
hackathon. Ambos seguían siendo candidatos razonables, pero ninguno
estaba comprometido, y el riesgo que `PLATAFORMA-PARTNERS.md` § F9 ya
anotaba —"que el partner desaparezca"— es precisamente el que convierte
un piloto en una espera indefinida. Construir las dos puntas cuesta más
trabajo y compra independencia total del calendario de un tercero.

**Qué NO cambia.** SignalDesk es un comercio nuevo con proceso, claves
y dominio propios, no una máscara del bazaar existente. Y sigue en pie
que nada de esta fase toca `checkMandate`, `scope.limits`/`perDay` ni
los contratos Soroban salvo por lo que `C-75` registra explícitamente.

---

### C-75 · El permiso por producto vive en el grant firmado (`grant.products`), no en `scopeSchema` ni en la plataforma · `Vigente`
**Fecha:** 2026-09-12 · **Decisión del usuario: "quiero que sí incluya permiso por producto"**

Al leer el código para escribir `PILOTO-F9.md` apareció un hueco que la
documentación no registraba: **no había forma de firmar un permiso por
producto.** `scopeSchema` (`packages/core/src/credential.ts`) es un
`z.strictObject` con `actions`, `venues`, `assets` y `limits`, y
`checkScope` comprueba una única acción fija (`intent:create`). Un
Mandato podía decir "puede gastar hasta X en SignalDesk en USDC", nunca
"puede comprar el informe XLM/USDC".

Eso importaba porque el brief pide que la persona ajuste el
producto/servicio entre sus permisos. Mostrarlo como permiso firmado
cuando en realidad lo haría cumplir RealOps habría sido mentir sobre lo
que la firma cubre — y RealOps es exactamente la parte en la que el
diseño decidió no confiar (`PILOTO-F9.md` § 1.2).

**Se le ofrecieron tres salidas al usuario y eligió tener el permiso de
verdad.** T73 lo implementa así:

- `mandateGrantSchema` gana `products?: string[]`, **opcional**, copiando
  campo por campo el precedente de `payTo` (`M-14`): ausente significa
  *sin verificar*, no *prohibido*, así que todo Mandato firmado antes de
  hoy sigue significando exactamente lo que significaba; presente pero
  vacío no permite ningún producto, siguiendo la regla `B-1` de
  `venues`/`assets`.
- `checkMandate` gana el chequeo 5, entre venue y asset, y el código
  tipado `MandateProductNotAllowed`. Compara contra
  `intent.purchase.productId`, que el intent firmado ya llevaba desde
  T9 — no hace falta ningún dato nuevo, y `B-19` se mantiene intacto:
  no entra prosa del comercio a la decisión.

**Por qué en el grant y no en `scopeSchema`.** Una lista de productos
permitidos es el principal acotando su propio consentimiento — "podés
gastar en este comercio, pero solo en esto" — que es literalmente para
lo que existe un grant. Meterlo en `scopeSchema` habría cambiado la
forma de **toda credencial ya emitida** y la comparación
credencial↔mandato de `M-4`, para modelar algo que la creencia del
emisor sobre un agente no expresa.

**Alternativa descartada:** un `action` por producto
(`purchase:market-report`). Reutilizaba un campo ya firmado, pero
obligaba igual a cambiar `checkScope`, y degradaba el significado de
`actions` —"qué clase de cosa puede hacer este agente"— a una lista de
compras.

**Alternativa descartada:** dejarlo del lado de RealOps con una etiqueta
honesta en la UI. Era gratis y no mentía, pero deja el permiso que más
naturalmente entiende una persona ("solo esto") como el único que no
está protegido criptográficamente.

---

### C-76 · Las tres rutas de ejecución se congelan antes de implementarse, y responden `501` mientras tanto · `Vigente`
**Fecha:** 2026-09-12

`/v1` llevaba a un partner hasta el Mandato firmado y ahí se detenía:
no existía ninguna ruta capaz de ejecutar una compra ni de leer qué
pasó. T73 agrega tres —`POST /v1/purchases`, `GET /v1/purchases/{id}`,
`GET /v1/tenants/{id}/activity`— y tres permisos —`payments:authorize`,
`payments:read`, `vault:read`— **con todo cableado salvo la ejecución.**

Autenticación, scope, propiedad del tenant, validación del cuerpo e
idempotencia funcionan de verdad desde hoy; lo único que falta es la
parte que mueve plata, y lo dice con `NotImplemented` → **`501`, no
`404`**. Un `404` le diría a un integrador que el endpoint no existe ni
va a existir; un `501` dice que existe, que su petición estaba bien
formada, y que todavía no puede actuar.

**Por qué congelar antes de implementar.** Los chequeos contra los que
un integrador escribe su código —¿mi key puede gastar?, ¿este tenant es
mío?, ¿mi `Idempotency-Key` se respeta?— son justamente los que no
pueden cambiarle debajo después. Y es la puerta que `CLAUDE.md` §
"Coordinación con Codex" exige: nada de F9 se delega hasta que este
contrato esté mergeado.

**Detalle que parecía menor y no lo es:** el `501` **no** se guarda
contra la clave de idempotencia. Cachearlo haría que la misma clave
siguiera devolviendo `501` después de que T75 hiciera funcionar la
ruta — un contrato envenenado por su propio placeholder. Hay un test
que lo prueba reusando la clave con otro cuerpo: si estuviera cacheado
devolvería `409`.

**Por qué tres permisos y no uno.** Misma separación de daño que el
conjunto original de T45: una key que *lee* el historial de gasto de un
tenant no tiene por qué poder *gastar*, y la integración abrumadoramente
más común —un panel— solo necesita las lecturas. `mandates:revoke`
sigue sin existir: revocar es una acción firmada por la wallet del
principal, no algo que la API key de un partner pueda disparar por él.

---

### C-77 · Periplo se usa para descubrir, nunca para autorizar · `Vigente`
**Fecha:** 2026-09-12 · **URL aportada por el usuario**

El brief nombraba a Periplo como candidato a catálogo x402 público y
pedía validarlo antes de elegirlo. La primera búsqueda no lo encontró
(ni en web abierta, ni en `stellar/x402-stellar`, ni en la
documentación oficial de x402 en Stellar), y `PILOTO-F9.md` § 4.3 lo
registró como no verificable. **El usuario aportó el repositorio
(`github.com/Eras256/Periplo`) y con eso se pudo verificar contra el
servicio vivo**, no solo contra su README:

- Está desplegado en `https://periplo-testnet.fly.dev`, `stellar:testnet`
  únicamente.
- `GET /supported` declara `scheme: exact`, `network: stellar:testnet`,
  la extensión `bazaar`, y comisiones patrocinadas.
- `GET /discovery/resources` y `GET /discovery/search?query=` devuelven
  un catálogo real, con `payTo`, `asset` y `amount` por recurso. El
  `asset` que cotiza es `CBIELTK6…`, **el mismo SAC de USDC testnet que
  este proyecto ya usa**.
- Es facilitador además de catálogo, y cataloga automáticamente al
  liquidar un pago que lleve la extensión `bazaar` — es decir,
  SignalDesk puede quedar listado por haber vendido, sin registro
  aparte.

**La decisión: se adopta para descubrir y se le niega toda autoridad.**
Un candidato que Periplo devuelve y `venues.json` no conoce se rechaza
antes de pedir siquiera la factura; y el precio que Periplo declara se
descarta, porque el único precio que vale es el de la factura 402 del
comercio, comparada contra el Mandato en `reconcileTerms`.

Esto no es prudencia abstracta. El catálogo, leído hoy, tiene tres
entradas: una es una fila de prueba de integración
(`periplo-phase2-test.example`, `accepts: []`). Un catálogo público
real contiene basura, entradas de terceros y, eventualmente, entradas
maliciosas — exactamente el escenario que el brief § 3.4 pedía
resolver, verificado en vivo en vez de supuesto.

**Alternativa que sigue en pie como respaldo:** el índice propio sobre
`venues.json` (`AgentPeyDiscovery`, T78). Periplo es un servicio de un
tercero y puede caerse el día de la prueba externa; el caso de
aceptación 9 ("catálogo caído, sin intento de pago") deja de ser
hipotético por eso mismo.

---

### C-78 · T74: el runner de compra sale de la sesión-cookie, y sale *sin* llevarse ninguna decisión con él · `Vigente`
**Fecha:** 2026-09-12

Hasta T74, el único código de este repo capaz de ejecutar una compra era
`buy()` en `apps/web/src/server.ts`: tomaba una `DemoSession` guardada en
memoria detrás de una cookie, y podía comprar exactamente un producto
(`PAYABLE_PRODUCT_ID`, un ítem fijo del bazaar) en una URL con tres
parámetros hardcodeados (`ROUTE_PARAMS`). Todas las capas de autorización que
F9 necesita ya estaban ahí y ya eran correctas; lo que faltaba era cualquier
forma de llegar a ellas sin ser un navegador con esa cookie.

**La decisión de fondo: `tenant-purchase.ts` mueve el *llegar* y no mueve
nada más.** Las capas se llaman en el mismo orden, por las mismas funciones,
con los mismos argumentos que tienen desde T21:
`create_purchase_intent` (que corre `checkScope` + `checkMandate` + `perDay`
vía `PolicyRail`), después el desafío 402 con `reconcileTerms`, después el
pago con `PolicyRail` otra vez y los límites del propio contrato encima.
El módulo no decide nada. Está escrito en su docstring con esas palabras:
si alguna línea de ese archivo parece estar tomando una decisión de
autorización, eso es el bug.

**Qué sí cambia, y por qué tenía que cambiar.**

- **El venue ya no es una constante.** Se resuelve contra `venues.json`, y un
  venue que el registro no conoce se rechaza con `VenueNotRegistered`
  **antes de hacerle una sola llamada de red**. El orden importa: un
  comercio que un catálogo público anuncie y el registro no conozca ni
  siquiera se entera de que se preguntó por él. Es `C-77` hecho código.
- **El precio ya no viene de ningún lado más que del comercio.** Ni del
  llamador, ni del catálogo. Se re-pide y se compara contra el Mandato
  firmado.
- **La ruta pagada sale del catálogo del comercio**, no de `ROUTE_PARAMS`. Y
  si esa ruta declara un input obligatorio que la compra no cubre, se rechaza
  con `RouteParamMissing` en vez de armar una URL con un hueco: el comercio
  pidió un parámetro, y mandárselo vacío es adivinar.
- **El scope sale de la credencial de ese tenant**, no de `examples/scope.json`.
  `buy()` leía el archivo del repo, lo cual daba igual cuando toda sesión era
  la misma demo; por tenant no da igual. Y se parsea con
  `agentPassCredentialSchema`, no se castea.
- **El `principal` del rail sale del Mandato firmado**, no de una fila. El
  registro guarda un `principalId` (`prc_…`) y el contrato necesita una
  dirección Stellar; el `issuer` del documento es esa dirección en forma de
  DID, y es el valor que el principal mismo firmó. Derivar la custodia de
  algo menos que el documento firmado significaría que una fila mal escrita
  en Postgres puede entregarle el derecho de retiro a otra cuenta (`C-61`,
  T57).

**Rechazos como valor, fallas como excepción.** "Tu Mandato no permite esto"
y "Postgres no responde" no pueden llegarle al llamador vestidos igual: lo
primero es una respuesta, lo segundo es una caída. Solo un `AgentPassError`
tipado se convierte en rechazo; cualquier otra cosa sigue viaje hacia arriba.
Hay un test que lo fija lanzando un `TypeError` desde el directorio y
exigiendo que salga como `TypeError`.

**Dos defectos que encontraron los tests mientras se escribía esto**, ambos
míos, ambos de este mismo hito:

1. `baseUrlForVenue` **lanza** para un venue que no tiene, y solo devuelve
   `undefined` para uno registrado sin URL. La primera versión solo
   contemplaba el `undefined`, así que un venue desconocido salía como
   excepción en vez de como rechazo — justo la distinción que el párrafo
   anterior define. Lo encontró el test del slug registrado apareado con
   otro contract id.
2. Elegir el Mandato con `find(...) ?? activeMandates[0]` podía tomar el
   Mandato de **otro agente del mismo tenant**. `checkMandate` lo habría
   atajado una capa después con `MandateAgentMismatch`, así que no era un
   agujero — pero un camino de compra no debe entregarle a la capa de
   enforcement un documento que ya sabe que es el equivocado y confiar. Ahora
   rechaza explícitamente.

**Lo que NO hizo T74, a propósito:** borrar `buy()`. El camino clásico sin
wallet (`C-34`) no tiene tenant en el directorio, así que el módulo nuevo no
puede servirlo. Quedan dos plomerías hacia el mismo pago — pero **una sola
capa de enforcement**: las dos pasan por `checkMandate`, así que el permiso
por producto de `C-75` rige en ambas. Retirar la demo cuando el flujo de F9
funcione es trabajo posterior, anotado y sin construir.

---

### C-79 · T75: la compra se persiste, el rechazo también, y la ruta no sabe nada de Stellar · `Vigente`
**Fecha:** 2026-09-12

T75 conecta `POST /v1/purchases` y `GET /v1/purchases/{id}` al módulo de
T74. Tres decisiones que valen más que el cableado.

**1. Un rechazo es una fila, no una ausencia.** `directory_purchases`
(versión 6 del esquema) guarda las compras rechazadas igual que las
liquidadas. La alternativa —guardar solo éxitos— haría que "¿por qué mi
agente no compró esto?" fuera incontestable, que es justamente la pregunta
que un sistema así más necesita poder responder. Y no duplica el vault: el
vault registra decisiones sobre *intents* (Fase 5), esta tabla registra
*pedidos* de un partner. Difieren exactamente donde importa — un pedido
rechazado antes de que exista ningún intent (un venue no registrado, un
tenant sin Mandato) no deja registro en el vault, y esos son precisamente los
rechazos que un integrador necesita ver.

`agent_id` es nullable por lo mismo: un rechazo puede ocurrir antes de que se
resuelva el agente del tenant, e inventarle un id sería mentir.

**2. La ruta no sabe nada de Stellar, y eso es deliberado.** `partner-routes.ts`
recibe la ejecución como un puerto inyectado (`ExecutePurchase`), no como un
import. Todo lo que la implementación real necesita —semilla maestra, llave
de la reserva, cliente RPC, Postgres— vive del otro lado de esa única
función, y nada de eso se filtra a la capa de ruteo. Es la misma costura que
el archivo ya usaba para `Directory` desde T49, y es lo que permite que las
once pruebas de esta ruta corran sin servidor HTTP, sin Postgres y sin red.

**3. `201` para las dos salidas, y la idempotencia guarda las dos.** Un
Mandato diciendo que no es el sistema funcionando; reportarlo como `4xx`
archivaría "tu consentimiento no cubre esto" junto a "tu JSON está mal
formado". Y a diferencia del `501` de T73 —que explícitamente **no** se
cacheaba, para no envenenar la clave— la respuesta real sí se guarda contra
la clave de idempotencia: repetir la clave devuelve la misma compra sin
volver a comprar, con un test que cuenta las llamadas al puerto para
probarlo.

**Dos ajustes al contrato congelado en T73**, los dos aditivos y los dos
descubiertos al cablear:

- **`route_params` se agrega al cuerpo del pedido.** La ruta pagada de un
  comercio puede declarar inputs obligatorios (el bazaar los tiene:
  `pair`, `amount`, `side`) y la petición no tenía forma de aportarlos. No es
  una entrada para nada que decida: rellenan una URL que el comercio mismo
  publicó, y el precio que vuelve se reconcilia contra el Mandato igual que
  siempre.
- **`delivery.delivery_id` pasa a ser nullable.** La forma congelada asumía
  que todo comercio emite un identificador de entrega, y el comercio de
  referencia que este repo ya usa simplemente devuelve el cuerpo del recurso.
  SignalDesk sí emitirá uno; un comercio que no lo haga no está roto por eso,
  y fingir lo contrario convertiría el campo en una mentira en vez de en una
  garantía.

`GET /v1/tenants/{id}/activity` **sigue congelada en `501`**: necesita el uso
de `perDay`, el saldo del rail y los rechazos del vault, que hoy se calculan
dentro de `apps/status-dashboard` y hay que compartir sin duplicar (`C-73`).
Pasa a ser su propio hito, T76, y el resto del plan de `PILOTO-F9.md` § 9
corre un número.

---

### C-80 · Los números del piloto: 1 USDC por tenant, límites del rail 0.30/0.60, precios 0.25 y 0.10 · `Vigente` en precios, tope y alerta; el fondeo (3 USDC, `C-131`) y los límites del rail (3.00/3.00, `C-133`) cambiaron el 2026-09-23
**Fecha:** 2026-09-12 · **Decidido por el usuario**

`PILOTO-F9.md` § 12.2 dejó anotado que los tres números —cuánto se fondea
cada rail, qué límites lleva grabados, y cuánto cuestan los productos— no se
podían decidir por separado: `tenant-rail.ts` desplegaba cada rail con
`per_tx = 0.002` y `per_day = 0.01` USDC, así que 1 USDC por tenant era
inusable (cien días para gastarlo) y ningún producto podía costar más de
0.002.

**Decidido:**

| | |
|---|---|
| Fondeo por tenant | 1 USDC |
| Tope por transacción del rail | 0.30 USDC |
| Tope diario del rail | 0.60 USDC |
| Informe de mercado | 0.25 USDC |
| Paquete de créditos de IA | 0.10 USDC |
| Tope de tenants patrocinados | 20 |
| Alerta de la reserva | quedando para 5 |

Con esos números, **una segunda compra del informe supera el tope diario sin
que haya que esperar ni inventar nada** — el caso de aceptación 4 del brief
se vuelve realizable dentro de una misma sesión de prueba, que es la razón
por la que se eligieron así y no redondos.

**La restricción operativa que el usuario aportó, y por qué no aprieta.** El
usuario puede fondear la reserva con 20 USDC testnet una vez por día. La
cuenta de reserva (`GAK6E5E7L63ZY…`, confirmada como la misma que usa Render)
tiene hoy 39.484 USDC. La aritmética del piloto:

- Un recorrido completo gasta 0.35 USDC (informe + créditos). **Ese dinero no
  se pierde: va a SignalDesk, que también construye el proyecto**, así que se
  puede barrer de vuelta a la reserva. Queda anotado como tarea operativa de
  T77.
- Lo que sí se va para siempre es lo que queda **sin gastar en el rail del
  visitante**: unos 0.65 USDC por tenant. Y se va por diseño, no por descuido
  — desde `C-61` (T57) solo la wallet del principal puede retirar de su
  propio rail, y que nosotros no podamos recuperarlo es exactamente la
  garantía que hace que el rail valga algo.
- 20 tenants × 0.65 = **13 USDC de drenaje real para todo el piloto**. El
  saldo actual cubre unos 60 tenants sin refondear, y 20 USDC por día
  sostienen unos 30 tenants diarios. **El tope de 20 tenants se agota mucho
  antes que los fondos.**

**Un rail ya desplegado no cambia de límites.** Los topes se graban en el
contrato al construirlo, así que los rails de tenants de prueba creados en
T58 conservan `0.002`/`0.01`. No hay que migrarlos: son tenants de prueba, y
los del piloto se desplegarán con los números nuevos.

Las constantes se cambian en **T77**, junto con los controles de la reserva
(precheck de saldo, tope de patrocinio, y el arreglo del doble fondeo de
`PILOTO-F9.md` § 13.2), porque son el mismo tema y el mismo archivo.

---

### C-81 · T76: los tres números del panel se comparten, no se reimplementan — nace `@agentpey/activity` · `Vigente`
**Fecha:** 2026-09-12

`GET /v1/tenants/{id}/activity` necesitaba exactamente los tres números que
`apps/status-dashboard` (T71) ya calculaba: uso de `perDay`, rechazos
recientes y saldo del `policy_rail`. Escribirlos de nuevo del lado de `/v1`
habría sido la violación literal de `C-73` — "un número sobre gasto sale del
cálculo que la autorización misma hace, nunca de una segunda suma".

**La decisión: `readPerDayUsage`, `recentRefusals`, `readRailBalances`, sus
puertos y sus dos umbrales se mudan a `packages/activity`, y las dos apps
importan de ahí.** No es una copia con otro nombre: el archivo del dashboard
quedó re-exportando desde el paquete, así que su servidor y sus nueve tests
siguen corriendo sobre el mismo código sin un solo cambio de comportamiento.
`readPerDayUsage` sigue llamando el mismo `vault.spentOn()` que
`PolicyRail.authorise()` llama antes de decidir; la cadena entera —
enforcement, panel interno y vista del usuario — tiene ahora una sola
implementación.

**Los puertos también se comparten, y eso importa por seguridad, no por
prolijidad.** `ActivityDirectory` y `VaultReader` no tienen ningún método de
escritura. Una sola definición significa que una ruta del panel y una ruta de
`/v1` no pueden recibir poderes distintos por descuido — `StatusDirectory`
pasó a ser un alias del tipo del paquete.

**`readRailUsdcBalance` se movió a `apps/agent`, no al paquete nuevo.** Lee
Stellar y necesita dos cosas que viven ahí (`BAZAAR_USDC_ISSUER` y
`fromScaledAmount`); meterlo en un paquete habría obligado a que un paquete
dependiera de una app, que es la inversión de capas al revés, o a duplicar el
formateo de montos, que es peor cerca de dinero. Ahora vive al lado de lo que
lee y las dos apps importan la misma función.

**Alternativa descartada:** que `apps/web` llamara `vault.spentOn()` por su
cuenta y armara la proyección. No habría duplicado la *suma*, pero sí el
umbral del 80% y la regla de qué Mandato cuenta como activo — dos reglas que
dos pantallas pueden empezar a contestar distinto, que es justo el modo de
falla que `C-73` describe.

---

### C-82 · T77: el rail se persiste antes de fondearse, y el fondeo se reclama una sola vez · `Vigente`
**Fecha:** 2026-09-12

El arreglo del defecto que `PILOTO-F9.md` § 13.2 encontró al leer el código
para escribir la propuesta.

**El defecto.** `ensureTenantPolicyRail` hacía: desplegar → fondear →
persistir. Si el proceso moría entre fondear y persistir, la próxima compra
no encontraba rail, desplegaba otro y **lo volvía a fondear**: la reserva
pagaba dos veces y el primer contrato quedaba con la plata y sin ninguna fila
apuntándole. Y lo mismo pasaba **sin ninguna caída**, con dos primeras
compras concurrentes: `setAgentPolicyRail` resuelve la carrera por la *fila*
—es un `update ... where policy_rail_contract_id is null`, primero gana— pero
para cuando resuelve, las dos ya habían fondeado un rail cada una.

Con 1 USDC testnet por tenant es simbólico. Con fondos reales sería un
incidente, y del tipo que no se detecta hasta auditar saldos.

**El arreglo: desplegar → persistir → reclamar → fondear.**

- **Persistir antes de fondear** invierte cuál es el peor caso. Si el proceso
  muere ahora, lo que queda huérfano es un contrato **vacío** que costó unos
  stroops de fee, no un contrato con el USDC de la reserva adentro.
- **`claimRailFunding(agentId)`** es un `update ... set policy_rail_funded_at
  = now() where policy_rail_contract_id is not null and policy_rail_funded_at
  is null`: la reclamación *es* la escritura condicional, sin ninguna ventana
  entre leer y escribir por la que dos procesos puedan pasar. Exactamente uno
  recibe `true`.
- **`releaseRailFunding`** deshace la reclamación si la transferencia falla,
  para que el próximo intento reintente en vez de dejar un rail desplegado y
  vacío para siempre.
- **Un rail ya desplegado pero sin fondear se fondea en la llamada
  siguiente**, no se redespliega. Ese estado —que antes era invisible— es
  justo lo que dejaba una caída a mitad de camino, y antes de T77 solo se
  descubría cuando una compra fallaba contra un saldo vacío sin explicación.

**Por qué la columna y no leer el saldo on-chain.** Decidir "¿hay que
fondear?" mirando el balance del rail parece más simple y es incorrecto: un
rail que gastó legítimamente hasta cero es indistinguible de uno que nunca se
fondeó, y recargarlo sería patrocinar al mismo tenant dos veces. El estado
"se fondeó alguna vez" es un hecho del sistema, no de la cadena.

**Nota honesta sobre los rails anteriores.** Los rails desplegados antes de
T77 (los de prueba de T58) tienen `policy_rail_funded_at` en `null`, así que
**no cuentan contra el tope de 20**. No se hace backfill a propósito: un
`update` idempotente en el SQL de esquema que marcara como fondeado todo rail
con contrato correría en cada arranque, y marcaría como fondeado un rail que
legítimamente estuviera esperando su transferencia. Que unos pocos tenants de
prueba no cuenten es un error de conteo inofensivo; marcar como fondeado algo
que no lo está no lo es.

---

### C-83 · T77: la reserva se chequea antes de gastar un fee, y se muestra donde se decide · `Vigente`
**Fecha:** 2026-09-12

Dos controles nuevos sobre el crédito patrocinado, y una regla sobre dónde
viven sus números.

**El pre-chequeo corre antes de desplegar nada.** `requireSponsoredCredit`
refuza con `SponsoredCreditExhausted` antes del Friendbot, antes del deploy y
antes de cualquier fee, por dos condiciones **deliberadamente separadas**:

- el **tope** de 20 tenants patrocinados está alcanzado — que es una decisión
  (`C-80`);
- la **reserva** no alcanza para un tenant más — que es un hecho.

No se colapsan en un solo error porque los remedios son opuestos: subir el
tope, o fondear la cuenta. Un operador que lee el rechazo necesita saber
cuál de las dos lo paró, y el `details` lo dice con la palabra `remedy`.

**Los números viven en `@agentpey/activity`, no junto al deploy.** Mismo
criterio que `C-81` aplicó a `perDay`: el chequeo que *refuza* patrocinar y
el panel que *muestra* cuánto queda tienen que coincidir, y dos copias de
"veinte" son dos números que pueden separarse justo en la situación donde
equivocarse cuesta plata. `SPONSORED_FUNDING_PER_TENANT`,
`MAX_SPONSORED_RAILS` y `SPONSORED_RAILS_WARNING_HEADROOM` están en el
paquete compartido; `tenant-rail.ts` los importa.

**La reserva entra al panel, y se muestra aunque no haya tenant elegido.** Es
del piloto, no de un tenant, y un operador no debería tener que elegir a
alguien para enterarse de que la canilla está seca. `remaining` es el menor
entre lo que permite el tope y lo que la reserva puede pagar, así que una
reserva llena con el tope alcanzado se lee como cero y no como abundancia.

**El panel se configura con la dirección pública, nunca con el secreto.**
`RESERVE_ADDRESS` es una variable nueva, separada de `AGENT_SECRET_KEY` a
propósito: una superficie de solo lectura no debe necesitar una llave capaz
de firmar. Lo mismo vale para `pnpm run check:sponsored-credit`, el script de
operador equivalente.

**Pendiente anotado, sin construir:** un barrido que devuelva a la reserva el
USDC que SignalDesk acumule. El dinero que un tenant gasta no se pierde —va a
un comercio que también construye el proyecto— pero recuperarlo necesita que
SignalDesk exista primero.

---

### C-84 · T78: Periplo necesita su propio adaptador, y un candidato no lleva precio · `Vigente`
**Fecha:** 2026-09-12

**Por qué un adaptador nuevo y no un parámetro.** `createX402Catalog`
(F7) lee el feed propio de un comercio: `{ ok, results: [{ resource: { id,
name, payment: { asset, amount, destination }, routeTemplate } }] }` — un
vendedor describiendo *sus* productos, con ids y rutas pagas. Periplo
contesta la forma Bazaar de x402: `{ x402Version, items | resources: [{
resource, accepts: [{ asset, payTo, amount, scheme, network }],
description, extensions }] }` — un índice de **URLs** de muchos comercios,
sin id de producto y sin nombre en ninguna parte. No hay bandera que
convierta una en la otra; fingir que sí habría dado un parser que entiende
la mitad de cada una. Son dos protocolos, y son dos módulos:
`periplo-catalog.ts` junto a `x402-catalog.ts`.

**Un candidato no lleva precio. Ni `payTo`, ni `asset`.** No "precio
estimado", no un campo con nombre prudente: no existe el campo. `C-77` ya
decía que el precio del catálogo se descarta y que el único que vale es el
de la factura 402 pedida por AgentPey. La diferencia es que ahora eso no
depende de que alguien se acuerde: un valor que nunca se carga no puede
ser comparado contra un Mandato por un refactor bienintencionado dos
meses después. Verificado por prueba, no por lectura: el JSON de un
candidato construido sobre la fila real de Periplo no contiene el monto,
ni la cuenta cobradora, ni el contrato del activo.

**Lo único para lo que se leen los `accepts` es para descartar.** Una fila
sin oferta en `stellar:testnet` bajo el esquema `exact` no es candidata.
Esa sola regla descarta `periplo-phase2-test.example` —la fila de prueba
de integración con `accepts: []` que está viva en el catálogo público hoy—
sin ningún caso especial escrito para ella. Y cada fila se parsea sola: una
malformada se saltea, no voltea la búsqueda. La basura en un índice público
no es hipótesis y su forma no se puede prever.

**Alternativa descartada:** agregarle a `createX402Catalog` un modo
`"bazaar"`. Habría metido dos protocolos en un archivo que hoy está en el
camino de pago (`tenant-purchase.ts` lo usa para pedir la factura), y
tocar ese archivo para una función de descubrimiento es exactamente el
tipo de cambio indirecto que `CLAUDE.md` § 5 del protocolo con Codex
manda mirar con lupa. Se prefirió un módulo nuevo que el camino de pago no
importa.

---

### C-85 · T78: que un candidato sea pagable lo decide el registro, y lo hace cumplir el tipo · `Vigente`
**Fecha:** 2026-09-12

`ServiceCandidate` es una unión discriminada, no un objeto con una
bandera: un `UnregisteredCandidate` **no tiene campo `venueId` para leer**.
Código que quiera comprar algo no puede llegar a un venue sin antes
estrechar por `registered === true`, y ese `true` lo pone un solo lugar
—`toCandidate`— comparando el **origen** de la URL del candidato contra el
`baseUrl` de una fila de `venues.json`. No hay chequeo que olvidar, porque
no hay nada que olvidar: el valor que se necesita no existe hasta que el
chequeo corrió.

**Origen, no prefijo.** Un comercio registrado en
`https://shop.example/api` no puede ser matcheado por
`https://shop.example.attacker.test/api`. Comparar prefijos de strings es
la forma habitual de cometer ese error; hay prueba dedicada, más otras para
esquema distinto, puerto distinto, URL relativa, `data:` y credenciales
embebidas en el host.

**Los candidatos no registrados se muestran, no se ocultan.** Filtrarlos en
silencio habría sido más simple y peor: que el catálogo público liste
comercios que AgentPey no paga es el hecho central del diseño, y una
persona que lo ve entiende dónde está la frontera. La corrida real contra
Periplo lo deja a la vista — sus dos filas vivas y válidas salen las dos
como `unregistered → not payable`.

**Periplo indexa URLs, así que el comercio dice cuál es el producto.**
`resolvePayableService` toma un candidato registrado y le pregunta al
comercio —no al catálogo— qué producto vive en esa URL, matcheando contra
sus propias rutas pagas. Un candidato que ya trae un `productId` igual se
verifica contra ese feed en vez de creerle. Y la ambigüedad refuza: dos
rutas del mismo comercio resolviendo a una URL es un comercio que este
código no puede leer sin adivinar, y adivinar es contra lo que `ids.ts`
argumenta en todo su docstring.

**Alternativa descartada:** una sola forma de candidato con
`registered: boolean`. Es lo mismo hasta el día en que alguien lee
`candidate.venueId!` y el compilador no tiene nada que objetar.

---

### C-86 · T78: el índice propio nombra el venue, y "nadie contestó" no es "no hay nada" · `Vigente`
**Fecha:** 2026-09-12

**Una desviación deliberada del plan.** `PILOTO-F9.md` § 4.3 proponía que
`GET /discovery/search` sirviera la forma `ServiceCard`, "que
`createX402Catalog` ya sabe leer". Implementarlo mostró por qué está mal:
una `ServiceCard` **no tiene campo que nombre el venue**, porque el feed de
un comercio no lo necesita —es todo el mismo comercio—. Este índice cruza
todos los venues registrados, así que en esa forma un consumidor no podría
saber de quién es el producto que está mirando, y el venue es justamente lo
único que un candidato tiene que llevar. Sirve la forma de candidato, con
`venue` en cada fila y `registered` dicho en vez de implicado. La decisión
de § 4.3 queda superada en ese punto y solo en ese punto: la regla que la
rodea —el catálogo no es fuente de permiso— no cambia.

**Una lista vacía y "nadie contestó" son hechos distintos, y se reportan
distinto.** Si todos los venues registrados fallan, el índice tira
`CatalogUnavailable` y la ruta responde `503`; una búsqueda que corrió bien
y no encontró nada responde `200` con cero resultados. Colapsarlos habría
sido cómodo y habría hecho que una caída se le muestre a una persona como
"no hay nada a la venta", que es la frase que la lleva a la acción
equivocada. Es el caso de aceptación 9 del brief: catálogo caído, **sin
intento de pago**, y con un mensaje que se entiende.

**Un venue caído no tapa a los demás.** `Promise.allSettled` por venue, el
que falla se saltea y se loguea; solo el fracaso de todos es fatal.

**Dicho en voz alta: un índice propio no prueba descubrimiento abierto.**
Prueba el mecanismo —una instrucción se vuelve consulta, una consulta se
vuelve candidatos, y un candidato se vuelve compra solo después de que el
registro, la credencial y el Mandato opinaron—. Lo abierto lo aporta
Periplo; esto aporta que la prueba externa sobreviva a que Periplo se
caiga. Decirlo vale más que la apariencia de lo contrario.

**La ruta pública es de solo lectura y no es superficie nueva de ataque.**
No escribe, no guarda secreto, y todo lo que puede emitir ya es público:
`venues.json` está en el repositorio. Lo que sí hace es llamar hacia
afuera, así que eso está acotado: timeout duro por venue
(`fetchWithTimeout`, 5 s), caché corta compartida entre llamadas (30 s),
tope de resultados, y una consulta validada en largo y en caracteres de
control **antes** de entrar en ninguna URL.

**Anotado, sin construir:** `createX402Catalog` sigue sin timeout, y está
en el camino de pago. Cambiar cuándo se rinde una llamada ahí cambia
comportamiento de pago, y este hito no tenía por qué hacerlo. Queda como
deuda con nombre.

---

### C-87 · T79: un venue puede identificarse con una cuenta (`G…`), no solo con un contrato — `B-3` se amplía · `Vigente`
**Fecha:** 2026-09-12 · **Decidido por el usuario**

`B-3` (Fase 2, T9) fijó que un `venueId` es `<slug>:<contract id>` y validó el
segundo tramo con `StrKey.isValidContract`. Era correcto: todo venue que el
proyecto conocía era un bazaar Soroban. **SignalDesk no es un contrato y nunca
lo va a ser** — es un comercio HTTP —, así que sin tocar esto no podía entrar
en `venues.json` y AgentPey no le podía pagar.

Antes de proponer nada se verificó una cosa en el código: **el `contractId` de
un venue nunca se usa para llamar a un contrato.** No hay una sola invocación
on-chain que lo tome. Es un identificador que se compara byte a byte dentro
del `scope`/`grant` firmado, y nada más.

**La decisión (del usuario, entre tres opciones): el segundo tramo puede ser
un contrato (`C…`) o una cuenta clásica (`G…`).** Para un comercio HTTP la
identidad que de verdad es infalsificable es **la cuenta en la que cobra** —
el mismo valor que `reconcileTerms` ya compara contra la factura 402 y que
`TermsPayeeNotAllowed` refuza. La identidad de SignalDesk queda
`signaldesk:GB4D4PLL…GYOOF`.

La ampliación es **aditiva y no afloja nada**: todo `venueId` que parseaba
antes parsea a lo mismo, la comparación sigue byte a byte, y cualquier cosa
que no sea una de las dos formas se sigue rechazando con `InvalidVenueId`
(hay pruebas para una cuenta truncada, un contrato truncado y una semilla
secreta `S…`). Es exactamente el razonamiento que `parseAssetId` aplica a los
emisores desde T9, y que `B-3` ya justificaba con esas palabras: aceptar las
dos formas evita que la respuesta a una pregunta abierta obligue a rediseñar
el tipo.

**El campo se renombró a `address`, y eso no es cosmético.**
`ParsedVenueId.contractId` y la columna `contractId` de `venues.json` pasan a
`address`, con `addressKind: "account" | "contract"`. Un campo llamado
`contractId` conteniendo un `G…` es una mentira silenciosa adentro de un
identificador de autorización, que es el peor lugar para tener una.

**Costo real, dicho de frente:** si SignalDesk rota su cuenta cobradora,
cambia su `venueId`, y los Mandatos ya firmados que la nombran dejan de
matchear. Es el precio de que la identidad sea la cuenta. `signaldesk-setup`
se niega a reemplazar claves existentes justamente por eso.

**Alternativa descartada:** desplegar un contrato Soroban solo para que
SignalDesk tuviera un `C…`. No toca nada de autorización y `B-3` quedaba
intacto, pero **nada verifica que el comercio controle ese contrato**, así que
no habría agregado ninguna garantía: un identificador que *parece* un ancla
on-chain sin serlo. Se prefirió la forma que al menos coincide con un valor
que el sistema sí verifica en cada pago.

---

### C-88 · T79: SignalDesk es un comercio, no un módulo de AgentPey · `Vigente`
**Fecha:** 2026-09-12

`apps/signaldesk` tiene **claves propias** (`SIGNALDESK_SECRET_KEY`,
`SIGNALDESK_FACILITATOR_SECRET`, nunca intercambiables con `AGENT_SECRET_KEY`),
**proceso propio** (su propio servicio en `render.yaml`), **tablas propias**
(`signaldesk_*`), y no importa nada de la plataforma de pagos salvo helpers
neutros de `@agentpass/core`.

**Por qué importa tanto:** si el comercio al que AgentPey le paga pudiera
meterse en la autorización de AgentPey, el piloto no probaría nada — sería
circular. El brief lo dice y esta es la forma de cumplirlo que se puede
verificar leyendo los imports, no confiando en una intención.

Eso obligó a mover dos cosas a `@agentpass/core` en vez de duplicarlas o
importarlas mal:

- **`ulid`** vivía en `@agentpey/directory`, donde acuña la identidad de cada
  partner y tenant. SignalDesk necesita numerar sus entregas y **no puede
  depender de la base de datos de tenants de la plataforma** para hacerlo. El
  directorio lo re-exporta, así que ningún importador cambió.
- **`canonicalJson`** vivía privado dentro de `wallet-sign.ts`. El recibo de
  SignalDesk necesita la misma garantía de "los mismos bytes" y dos copias de
  esa función son dos definiciones de lo mismo que coinciden hasta que alguien
  cambia una. Es `C-73` aplicado otra vez.

**Nota operativa honesta:** en el piloto los dos servicios apuntan a la misma
instancia de Postgres, porque Render da una. Bases separadas es un cambio de
despliegue, no de código — nada en `apps/signaldesk` toca una tabla fuera del
prefijo `signaldesk_`.

---

### C-89 · T79: el recibo lo firma el comercio, y se verifica sin AgentPey · `Vigente`
**Fecha:** 2026-09-12

Cada entrega produce un recibo con `delivery_id`, producto, comprador, los
términos **liquidados** (monto, activo, `payTo`, tomados de la respuesta de
liquidación y no de lo que pidió el request), la transacción Stellar, el
**hash de los bytes exactos entregados** y la fecha. Se canonicaliza, se
hashea, y **el hash se firma con la clave de SignalDesk**.

**Un recibo que solo es creíble porque AgentPey lo repite no es evidencia, es
un dicho.** Cualquiera con la clave **pública** del comercio puede bajar el
artefacto, hashearlo, reconstruir el recibo y verificar la firma, sin ningún
servicio de AgentPey, sin API key, y sin confiar en este repositorio.

Tres detalles que no son de forma:

- **`artifact_hash` va adentro del cuerpo firmado.** Sin eso, un comercio
  podría firmar un recibo verdadero y servir un archivo distinto.
- **Se recomputa el hash antes de mirar la firma**, así "esto fue alterado" y
  "esto no lo firmaron ellos" quedan distinguibles en vez de colapsar en un
  "inválido" genérico.
- **El artefacto es determinista a partir del `delivery_id`**, así que el hash
  es una propiedad de la entrega y no del momento en que se volvió a renderizar
  — que es lo único que hace verificable el recibo más tarde.

**Y la entrega ocurre después de liquidar, nunca antes.** El orden de
`handlePaidRoute` es la garantía entera: exigir el header de pago, comprobar
que la carga nombra *estos* términos para *esta* URL, verificar contra la red,
liquidar, y recién entonces renderizar algo. Además, **una transacción
liquidada entrega una sola vez**: `recordDelivery` está indexada por la
transacción, así que un reintento devuelve la entrega ya pagada en vez de
acuñar un segundo artefacto — el caso de aceptación 8, del lado del comercio.

**Los créditos son un entitlement, no un activo.** No hay operación de
transferencia en el servicio: ni ruta, ni método en `SignalDeskStore`, ni
sentencia SQL. Es estructural, no una política — un crédito transferible sería
una emisión, y eso está del otro lado de la línea que este proyecto mantiene
cerrada. Hay dos pruebas que fallarían si alguien la agregara.

---

### C-90 · T79: `pnpm typecheck` no cubría `apps/status-dashboard`, y tapaba errores reales · `Vigente`
**Fecha:** 2026-09-12

Encontrado al sumar una cuarta app: **`apps/status-dashboard` no estaba en las
referencias del `tsconfig.json` raíz**, así que `tsc -b` nunca lo compiló.
Vitest transpila sin chequear tipos, de modo que sus pruebas pasaban en verde
mientras el paquete acumulaba errores de tipo reales — la mayoría introducidos
en T77, que tocó `status.ts` y `server.ts`.

Qué tapaba, en concreto:

- `export type { VaultReaderFactory } from …` **re-exporta sin traer el nombre
  al scope local**, y el archivo lo usaba como anotación. Solo tipos: sin
  efecto en runtime.
- `StatusDashboardDependencies.directory` estaba declarado como
  `StatusDirectory`, que no tiene `countFundedRails`, mientras
  `readSponsoredCreditStatus` sí lo exige. **No rompía producción** —el objeto
  real es un `Directory` completo y sí lo tiene— pero el tipo mentía, y un
  doble de prueba tipado así habría explotado.
- Tres fixtures con valores que la unión nunca tuvo (`onchainState:
  "anchored"`) o campos faltantes (`policyRailFundedAt`).

**Se arregló el guardarraíl primero y los errores después**, en ese orden: la
línea que faltaba en `tsconfig.json` es la causa, y los tres errores son lo que
la causa dejó entrar. Sumar SignalDesk sin cerrar esto habría significado
agregar una cuarta app a un `typecheck` que ya estaba mintiendo sobre su
cobertura.

---

### C-91 · T80: RealOps no puede autorizar nada, y eso es estructural · `Vigente`
**Fecha:** 2026-09-12

`apps/realops` **no tiene ninguna clave Stellar**. No firma, no ancla, no ve un
Mandato, y desde T81 su único credencial va a ser una API key de `/v1`, que le
compra exactamente un poder: **preguntar**.

Es la regla `PILOTO-F9.md` § 1.2 —"RealOps pide, AgentPey decide"— hecha
propiedad del código y no promesa de documento. Un RealOps comprometido puede
pedir compras que serán rechazadas, y nada más.

Dos consecuencias que se hicieron explícitas en el diseño:

- **El navegador nunca manda un `tenant_id`.** La cookie de sesión resuelve a
  una cuenta, la cuenta resuelve a sus propios agentes, y ningún handler lee de
  la entrada a quién pertenece un dato. No es una validación que se pueda
  olvidar: no hay nada que validar, porque no entra.
- **El agente de otra persona es `404`, nunca `403`.** Misma postura que `/v1`
  toma desde T49, y por la misma razón: un `403` confirma que el id existe.

---

### C-92 · T80: el correo vive solo en RealOps, y la referencia es aleatoria, no un hash · `Vigente`
**Fecha:** 2026-09-12

AgentPey conoce a una cuenta de RealOps como `rop_<ulid>` **aleatorio**.

**Por qué no un hash del correo**, que era la opción cómoda: un hash de un
email sigue siendo un identificador *de esa persona*, y con un diccionario de
direcciones comunes se revierte en segundos. Un id aleatorio no se puede
revertir porque nunca codificó nada. `external-ref.ts` (T49) ya rechaza un
`external_ref` con forma de correo, RUT o teléfono; F9 no necesita construir
esa defensa, necesita **no tener nada personal que mandar**.

**El enlace mágico se guarda hasheado, nunca tal cual**, con el mismo criterio
que `directory_api_keys`: leer la tabla no alcanza para entrar. Dura 15 minutos,
sirve una vez, y **la redención es la escritura** —un `update` condicional con
`used_at is null` en el `where`—, no una lectura seguida de una escritura. Dos
clics sobre el mismo enlace no pueden ganar los dos; es la ventana que `C-82`
cerró en el fondeo, aplicada acá.

**Los tres rechazos del enlace se mantienen distintos** (no existe / venció / ya
se usó) porque significan cosas distintas para quien lo tiene en la mano.
Colapsarlos en "enlace inválido" es cómo un piloto genera una pregunta de
soporte que no puede responder.

**Borrar la cuenta borra el correo, el alias y las sesiones — y no borra el
Mandato ni el vault**, y la página lo dice con todas las letras: son evidencia
firmada y anclada en una cadena pública, y borrarlos rompería la cadena de
hashes que es el producto entero. Esa tensión es real y se exhibe en vez de
esconderse.

**Sin proveedor de correo, el enlace se muestra en pantalla** — y la página dice
que en ese modo **no se está verificando** que la dirección sea de quien la
escribió. No es un bypass para un tercero (solo lo ve el navegador que mandó el
formulario), pero tampoco es prueba de posesión, y decir lo contrario sería la
clase de exageración silenciosa que este proyecto no hace. Con `RESEND_API_KEY`
configurada, se verifica.

---

### C-93 · T80: la pantalla de revisión muestra el grant literal, con quién hace cumplir cada permiso · `Vigente`
**Fecha:** 2026-09-12

`translatePermissions` es una función pura y probada que convierte lo que la
persona marcó en el `MandateGrant` que se va a firmar. La pantalla renderiza
**ese objeto**, en JSON, sin parafrasearlo.

**Por qué no un resumen amable:** la persona está por firmar ese objeto exacto.
Si la traducción viviera dentro de una plantilla, la pantalla y la petición
podrían separarse, y la separación sería invisible justamente porque las dos se
verían bien. Una función lo construye, la pantalla muestra lo construido, y T81
manda lo mismo.

**Y cada control lleva quién lo hace cumplir**, porque la diferencia entre
*firmado*, *on-chain* y *RealOps* es la diferencia entre una garantía y una
promesa:

| Marca | Qué significa |
|---|---|
| `firmado` | AgentPey lo verifica contra el Mandato firmado |
| `on-chain` | además lo revalida el contrato `policy_rail`, así que la red rechaza aunque todo lo de arriba fallara |
| `RealOps` | es solo de esta plataforma y no cambia lo que el agente puede hacer |

Una UI que los mostrara igual estaría reclamando garantías que el sistema no da.
Hoy exactamente un control es `RealOps` (el nombre del agente) y lo dice.

**La ventana de vigencia se calcula del reloj, nunca de la entrada.** Una
validez que el navegador pudiera elegir es una validez que un atacante podría
elegir.

---

### C-94 · T80: la interpretación no adivina, y por eso puede ser reemplazada por un LLM sin cambiar nada · `Vigente`
**Fecha:** 2026-09-12

`interpretInstruction` reconoce dos familias de instrucción y **rechaza en vez
de adivinar**: lo que no entiende vuelve como `InstructionNotUnderstood` y la
página ofrece los dos productos como botones, sin preseleccionar ninguno.

Adivinar es exactamente lo que un agente con permiso de gastar no puede hacer:
una suposición equivocada acá es una compra real de lo que no se pidió, que no
devuelve nadie.

**Esta es la capa que tiene permitido equivocarse.** La frontera de confianza
(`PILOTO-F9.md` § 4.1) pasa justo después: interpretar y descubrir son de
RealOps, decidir y ejecutar son de AgentPey. Un error acá puede elegir el
producto equivocado; no puede otorgar un venue, un activo ni un monto que el
Mandato no permita ya. Por eso un LLM podría reemplazar este archivo entero sin
cambiar una sola garantía — que era la pregunta del brief § 5.

**Un defecto encontrado por un test, no leyendo:** el vocabulario matcheaba
palabras exactas, así que `"informes"` en plural no se reconocía. Ahora matchea
raíces por prefijo, con las palabras de dos letras (`ia`, `ai`) en coincidencia
exacta — una regla de prefijo sobre esas reclamaría media lengua, y un
vocabulario que matchea de más deja de rechazar, que es el mismo fallo que uno
que matchea de menos.

---

### C-95 · T81: la URL de retorno es una lista blanca por partner, validada al crear la sesión · `Vigente`
**Fecha:** 2026-09-12

La última fila del modelo de amenazas de `PILOTO-F9.md` § 8 que seguía sin
construir (fila 8, redirección abierta).

**Por qué importa más de lo que parece.** Una consent session termina con una
redirección. Si el partner pudiera nombrar cualquier destino, la URL de consent
se convierte en una **redirección abierta alojada en el dominio de AgentPey** —
el lugar más creíble posible para tener una, porque es exactamente adonde a la
persona se le dijo que fuera a firmar.

**La regla: el origen de la URL de retorno tiene que ser uno que el partner
registró de antemano.** No un patrón, no un prefijo, no un sufijo: un **origen**
comparado exacto. Es la misma regla que `resolveCandidateVenue` aplica a un
venue (`C-85`) y por la misma razón — una comparación por prefijo es cómo
`https://realops.example.attacker.test` termina aceptado como
`https://realops.example`. Hay pruebas dedicadas para cuatro señuelos distintos
de host parecido, para el truco de meter el host permitido en las credenciales
(`https://realops.example@attacker.test`), para esquema y puerto distintos, y
para `javascript:` y `data:`.

**Se valida al crear la sesión, no al redirigir.** Dos razones, y la segunda
pesa más: el integrador se entera mientras integra, con un error tipado
(`ReturnUrlNotAllowed`, `400`), en vez de que una persona lo descubra a mitad de
una firma; y como nada sin validar se escribe nunca, lo que renderiza la
redirección puede confiar en el valor guardado sin volver a derivar la lista.

**La lista empieza vacía y una lista vacía no permite nada** — la lectura
fail-closed de `B-1` otra vez. En concreto: todo partner que existía antes de
T81 queda, correctamente, sin poder redirigir a ningún lado hasta que alguien
registre un origen a propósito.

**Se registra con un script de operador**, no por API: un partner que pudiera
editar su propia lista blanca por la red derrotaría el propósito de tenerla.
`pnpm run partner:return-origins` **reemplaza** en vez de agregar — una lista
que solo crece es una de la que nadie puede sacar una entrada, y sacar un origen
comprometido tiene que ser posible.

**La página de consent nunca lee el retorno de su propia URL.** Lo lee de la
sesión, donde se escribió ya validado. Una página que tomara su redirección de
su propio query string sería exactamente la redirección abierta que esto
previene.

Esquema versión 8: `directory_partners.return_origins text[] default '{}'` y
`directory_consent_sessions.return_url text`.

---

### C-96 · T81: RealOps pasa el grant, no lo reconstruye · `Vigente`
**Fecha:** 2026-09-12

`apps/realops/src/agentpey.ts` es todo lo que RealOps puede hacerle al sistema
de pagos: **cuatro llamadas**, todas de pedir (crear tenant, crear consent
session, leerla, listar mandatos). No hay ninguna clave en ese archivo que
pudiera otorgar algo. Leerlo es la forma más rápida de comprobar la afirmación
sobre la que se apoya el piloto.

**El grant que se manda es el que `translatePermissions` construyó y la
pantalla mostró.** No se recalcula acá. Una segunda construcción sería una
segunda cosa que puede separarse de la primera, y la prueba lo fija: toma el
HTML que vio la persona y exige que cada valor del grant enviado aparezca en
esa página.

**La invitación se indexa por agente** (`Idempotency-Key: consent-<agentId>`),
así que un doble clic reutiliza la invitación en vez de acuñar una segunda para
el mismo permiso.

**El retorno no le cree al navegador.** Cuando la persona vuelve, RealOps le
pregunta a AgentPey qué pasó con la sesión, y encuentra esa sesión desde el
agente *de esa cuenta*, nunca desde un parámetro. Un `mandate_id` solo se
guarda si AgentPey dice que la sesión se completó.

**Dos errores propios, encontrados leyendo las rutas reales en vez de
asumirlas:** el cliente tenía un camino de "ya existe → leer de vuelta" para el
tenant que no hacía falta (`POST /v1/tenants` ya responde `200` con el tenant
existente) y apuntaba a `/v1/tenants/{id}/mandates`, que no existe — los
mandatos se listan con `GET /v1/mandates?tenant_id=`. Los dos habrían fallado
recién contra el servidor real.

**Y un tercero, encontrado por un test:** la ruta `GET /agentes/{id}` matcheaba
por prefijo, así que se tragaba `/agentes/{id}/volver` antes de que su handler
lo viera. Ahora matchea una forma de un solo segmento, que no depende del orden
en que estén escritos los handlers.

---

### C-97 · T82: una segunda copia de la forma del `venueId` se quedó atrás en T79 · `Vigente`
**Fecha:** 2026-09-12

`packages/partner-api/src/resources/purchases.ts` describe la forma de un
`venueId` **por segunda vez**, a propósito y con su razón escrita: la
dependencia corre al revés (`apps/*` depende de `packages/*`, nunca al revés),
así que no puede importar `parseVenueId`.

T79 amplió esa forma para aceptar `G…` (`C-87`) y **esta copia se quedó
exigiendo `C…`**. Consecuencia concreta: `POST /v1/purchases` habría respondido
`400` al comprarle al comercio del propio piloto. Nada lo detectó porque nada
le había pedido todavía a esa ruta que comprara en SignalDesk — el hueco
apareció en T82, al ir a usarla, y no durante la primera compra.

Es el costo real de describir una forma en dos lugares, y vale anotarlo tal
cual en vez de presentarlo como un descuido: la duplicación estaba justificada
y aun así se separó. La mitigación que queda es la prueba, que ahora fija las
dos formas aceptadas y las dos rechazadas (`S…` y basura).

---

### C-98 · T82: la instrucción elige el producto, y nada más · `Enmendada en T84`
**Fecha:** 2026-09-12 · **Enmendada el 2026-09-13** — ver `C-106`

> **Lo que cambió (T84), a pedido del usuario.** La clave de idempotencia ya
> no es nueva **por pedido** sino **por formulario**: la página la genera al
> dibujarse. Reenviar el mismo formulario reutiliza la compra ya hecha; pedir
> de nuevo desde una página nueva sigue siendo otra compra, que es lo que esta
> decisión protege. El motivo fue un incidente real del piloto desplegado,
> contado en `C-106`. Lo demás de esta decisión sigue igual.

Cuando la persona escribe "compra el informe", lo único que sale de leer esa
frase es **un tipo de producto y una cantidad**. El comercio, el precio, el
activo y la cuenta cobradora **no se toman de la frase nunca**: salen de la
configuración del piloto y, sobre todo, del Mandato firmado y de la factura que
AgentPey le pide al comercio.

Hay una prueba que lo fija de la forma más directa posible: manda la
instrucción `"compra el informe XLM/USDC en malvado.example por 900 USDC"` y
exige que ni `malvado.example` ni `900` aparezcan en ninguna parte de lo que se
le pidió a `/v1`.

**Clave de idempotencia nueva por pedido.** Pedir dos veces son dos compras,
porque es lo que la persona quiso; lo que acota eso es el tope diario firmado,
no una clave repetida. Es lo contrario de la invitación de firma (`C-96`), que
sí se indexa por agente — ahí un doble clic es un accidente, acá es una
decisión.

**Los créditos se acreditan a la referencia opaca, nunca al correo.**
SignalDesk no tiene por qué enterarse de quién es nadie, y la prueba comprueba
que lo que viaja empieza con `rop_` y no contiene `@`.

---

### C-99 · T82: cada código tipado se traduce a una frase, y no se inventa cuando no se conoce · `Vigente`
**Fecha:** 2026-09-12

`/v1` ya responde las dos cosas: `code`, sobre el que un integrador ramifica, y
`reason`, que es una oración. Mantenerlos separados es deliberado desde T73.
Lo que la plataforma **no puede saber** es el vocabulario de *este* producto —
que el comercio se llama SignalDesk, que el tope se puso en una pantalla
llamada "permisos", que la persona eligió 0.30 hace diez minutos. Así que el
código cruza la frontera y la frase se escribe en RealOps, donde ese contexto
existe.

`apps/realops/src/refusals.ts` traduce los 28 códigos que el piloto puede
producir, cada uno con **qué pasó** y **qué hacer ahora** — porque una persona
que no puede distinguir entre esperar, volver a firmar o no hacer nada, lee
cualquier mensaje como "está roto". Hay una prueba que exige las dos oraciones
para cada código, y otra que fija que los trece códigos que nombran los casos
de aceptación del brief § 7 estén cubiertos.

**Y no inventa.** Un código que la tabla no conoce cae al `reason` de la
plataforma, tal cual, con el código al lado. El brief pide que todo rechazo
deje "un mensaje comprensible"; un mensaje comprensible y **equivocado** es
peor que uno áspero y verdadero.

**En pantalla se muestran los dos**: la oración para la persona, el código
debajo para quien tenga que depurarlo. No uno en lugar del otro.

---

### C-100 · T82: la revocación no se delega, y por eso RealOps no la tiene · `Vigente`
**Fecha:** 2026-09-12

`packages/partner-api/src/scopes.ts` deja `mandates:revoke` **fuera** de la
lista de scopes desde T45, con la razón escrita: revocar es un acto firmado por
la wallet que el principal hace él mismo, no algo que la API key de un partner
pueda disparar en su nombre.

Eso se respetó: el cliente de RealOps tiene cinco llamadas y ninguna revoca.
La consecuencia es que **la revocación necesita una página hospedada en
AgentPey**, con su propia firma de wallet, y eso es un hito aparte (T83) y no
un botón que se pueda agregar acá.

Se registra como decisión y no como pendiente suelto porque la tentación
—darle a RealOps un scope de revocación para simplificar— es exactamente el
tipo de atajo que haría que el piloto dejara de probar lo que dice probar.

---

### C-101 · T83: la revocación es una página hospedada, y la autoridad está en el contrato · `Vigente`
**Fecha:** 2026-09-12

`GET /revocar/{mandateId}` en el dominio de AgentPey, con la wallet del
principal. No es una ruta de `/v1` y no puede serlo: `mandates:revoke` está
fuera de la lista de scopes desde T45, y `C-100` explicó por qué.

**Dónde vive la autoridad, dicho sin adornos: no en este código.** El contrato
del registry rechaza una transacción de revocación que no venga firmada por la
dirección que ancló el Mandato. Eso es el enforcement, on-chain, y nada de
`apps/web/src/revocation.ts` puede debilitarlo. Lo que el módulo agrega es un
**rechazo mejor**: comprueba la wallet conectada contra el principal guardado
*antes* de preparar nada, así alguien que abre el link equivocado lee "esa no es
la wallet" en vez de firmar una transacción que falla con un error de Soroban.

**Divulgación mínima antes de la prueba.** Un id de Mandato se comparte con el
partner que lo creó, así que es un secreto más débil que un id de consent
session. Antes de que la wallet se pruebe, la página sabe **solo** si el permiso
sigue activo y hasta cuándo. El grant —los límites, el comercio, el producto— se
muestra después. Quien tenga un id suelto no aprende cuánto podía gastar nadie.
Hay una prueba que lo fija comprobando que el JSON público no contiene ni el
monto ni el nombre del comercio.

**Los tres rechazos de la prueba de wallet se mantienen distintos**: desafío ya
usado (un tropiezo operativo), firma que no corresponde (un cliente roto), y
wallet equivocada (una persona en la cuenta equivocada) — y solo el último tiene
una acción asociada. Pero **"wallet desconocida" y "wallet equivocada" se
colapsan a propósito** en el mismo código: distinguirlas le diría a un extraño
si una dirección es conocida por el sistema, que no es suyo de saber.

**Prueba y preparación en una sola llamada.** Verificar la wallet y preparar la
transacción pasan juntos, así no hay estado que guardar entre los dos pasos; lo
único replayable sería el desafío, y se consume una vez, **antes** de mirar la
firma — un desafío que sobreviviera a un chequeo fallido podría reusarse contra
otro Mandato.

**El submit no vuelve a pedir prueba de wallet, y no hace falta.** Lo que se
envía es una transacción firmada por el principal, y el contrato la rechaza si
no lo es. Pedir una segunda prueba agregaría un paso sin agregar una garantía.

**Un Mandato ya revocado o vencido se refuza en vez de revocarse otra vez.**
Reescribir cuesta un fee y no cambia nada; y pedirle a alguien que firme una
transacción que no le compra nada es hacerle perder el tiempo.

**El link de vuelta de esta página solo acepta una ruta relativa.** Una URL
absoluta desde el query string sería exactamente la redirección abierta que
`C-95` existe para prevenir, y esta página no la reintroduce por la puerta de
atrás.

---

### C-102 · T84: lo que cruza un borde tiene exactamente la forma del esquema que lo recibe · `Vigente`
**Fecha:** 2026-09-13

Dos defectos del mismo tipo, los dos encontrados corriendo el recorrido real
contra los servicios desplegados, y ninguno por una prueba:

- **RealOps mandaba la vigencia dentro del grant.** `ProposedGrant` lleva
  `validFrom`/`validUntil` adentro porque la pantalla de revisión los muestra
  junto a lo que se firma; `mandateGrantSchema` es estricto y no los conoce, y
  la vigencia viaja como campo hermano (`valid_until`). Toda firma desde el
  RealOps desplegado respondía `InvalidArguments`. Se quitan antes de mandar.
- **La credencial heredaba `products`.** `startConsentSession` armaba el
  `scope` de la credencial quitando **solo** `payTo` del grant. T73 agregó
  `products` (`C-75`) y ese lugar no se actualizó; `scopeSchema` también es
  estricto, así que toda firma de un grant con producto terminaba en
  `InvalidCredential`.

**La decisión: lo que un grant agrega sobre `scopeSchema` se quita en un solo
lugar.** `grantToScope` vive en `@agentpey/mandate`, junto al esquema que
define esos campos extra. Si mañana el grant gana un tercer campo opcional, hay
un lugar para actualizar y no uno por cada código que arme una credencial.

**Por qué ninguna prueba lo vio.** Las pruebas de RealOps usaban un cliente de
AgentPey falso que nunca construía el cuerpo HTTP, y ninguna prueba de la web
emitía una credencial desde un grant con producto. Las dos pruebas nuevas
fallan si vuelve a pasar: una captura el cuerpo real que sale del cliente, la
otra valida contra `scopeSchema` lo que devuelve `grantToScope`.

**Alternativa descartada:** hacer `scopeSchema` permisivo (`passthrough`). Habría
arreglado el síntoma aflojando justamente el esquema que protege qué afirma una
credencial firmada.

---

### C-103 · T84: RealOps propone `intent:create`, copiado del contrato publicado y fijado por una prueba · `Vigente`
**Fecha:** 2026-09-13

RealOps proponía `actions: ["purchase"]`, un nombre inventado en su propio
archivo. `checkScope` y `checkMandate` exigen una sola acción fija,
`INTENT_CREATE_ACTION = "intent:create"`, que la guía pública de partners ya
documentaba. **Toda compra de todo Mandato firmado desde F9 se habría
rechazado**, con `ScopeActionNotAllowed` o `MandateActionNotAllowed` según qué
capa mirara primero.

**RealOps sigue copiando el valor en vez de importarlo.** Es un partner y
construye desde el contrato publicado, no desde `apps/agent` (el mismo
criterio de `C-75`). Lo que cambia es que la copia está fijada por una prueba
sobre el valor literal: las pruebas existentes comparaban la constante contra
sí misma, y por eso nunca vieron que estaba mal.

**Un Mandato firmado con la acción vieja no se corrige.** Está anclado; el
camino es contratar un agente nuevo y volver a firmar.

---

### C-104 · T84: todo pool de Postgres escucha `error`; los tiempos de espera no se tocan de pasada · `Vigente`
**Fecha:** 2026-09-13

Ninguno de los seis `pg.Pool` del repo escuchaba el evento `error`. `pg` emite
por ahí una conexión ociosa que el servidor corta, y en Node un `error` sin
oyente mata el proceso. El pooler de Supabase corta conexiones ociosas: la web
se caía, Render la reiniciaba (cerca de un minuto en plan Free), y quien pedía
algo en esa ventana recibía la página de error de Render o esperaba hasta
rendirse.

**Primero se diagnosticó mal**, como arranque en frío del plan Free. La
hipótesis cayó cuando falló con los tres servicios recién despertados, y la
causa se confirmó reproduciéndola contra la base real: sin oyente el proceso
termina con `Unhandled 'error' event`; con oyente registra el error, sigue vivo
y la próxima consulta abre otra conexión.

**La decisión: cada pool registra `error` con el logger que ya usa su archivo,
y nada más.** No cambia la respuesta de ningún pedido.

**Descartado a propósito:** ajustar `connectionTimeoutMillis`,
`idleTimeoutMillis` o el tamaño de los pools en el mismo cambio. Cambiaría
cuándo se rinde una llamada en el camino de pago, que es la clase de cambio que
`C-86` dice que no se hace de pasada.

---

### C-105 · T84: un pool de vault por proceso y base; compartirlo no cambia el enforcement · `Vigente`
**Fecha:** 2026-09-13 · **Decidido por el usuario, entre tres opciones**

"Mis servicios" tardaba **73 s** para un tenant con Mandato y rail, contra 0,4 s
para uno vacío, y RealOps espera 15. Cada `createPostgresMandateVault` abría su
propio `Pool` y nadie lo cerraba; la web arma un vault por pedido (dos por
lectura de actividad, uno por compra), y las conexiones se apilaban contra el
pooler compartido por los tres servicios. Medido contra la base del piloto:
tres vaults dejaban cuatro conexiones ociosas más, a unos 2 s cada una.

**La decisión: un pool por proceso y por base, compartido por todos los vaults,
con la tabla creada una vez.** Medido igual después: el segundo y el tercer
vault tardan unos 0,2 s y no queda conexión colgada.

**Por qué no cambia el control del tope diario.** `withOwnLock` toma el lock
consultivo dentro de una transacción, sobre un cliente pedido solo para esa
sección. Dos vaults, del mismo tenant o no, siguen usando dos conexiones y
siguen serializando sobre el lock de la base, igual que con dos pools. Y nada
dentro del trabajo de `atomically` pide un segundo cliente mientras el lock
está tomado: `LocalPolicyRail.authorise()` usa solo el cliente bloqueado, y
`withVault` registra un rechazo después de que la sección terminó. Un pedido
anidado es lo único que podría hacer que un pool compartido y acotado se
esperara a sí mismo, y no hay ninguno. Los nueve tests de integración contra
Supabase pasan, incluidas las dos carreras del tope diario (T61, T66).

**Dos detalles que no son de forma.** La clave del pool incluye el certificado
de la base: un pool abierto con TLS verificado no puede servir a uno que no
verifica, ni al revés. Y una inicialización fallida no queda guardada: el
próximo vault lo vuelve a intentar en vez de heredar un pool roto por toda la
vida del proceso.

**Alternativas descartadas:** cerrar el pool al terminar cada pedido (corta la
fuga pero cada lectura sigue pagando ~2 s de conexión) y darle más tiempo a
RealOps (tapa el síntoma y deja la fuga).

**Nota de honestidad:** la primera versión de este cambio metió un byte nulo
literal en el código fuente, como separador de la clave. Funcionaba, pero Git
pasó a tratar el archivo como binario, y así los cambios del vault quedaban
imposibles de revisar. Se corrigió en el mismo hito, con la clave armada en
JSON.

---

### C-106 · T84: la compra tiene su propio tiempo de espera, un timeout no es "no se pudo hablar", y la clave es por formulario · `Vigente`
**Fecha:** 2026-09-13 · **Decidido por el usuario** · Enmienda `C-98`

**El incidente.** En el piloto desplegado, RealOps le mostró a la persona "no
se pudo hablar con AgentPey" después de cada compra, mientras el directorio
guardaba cuatro compras **liquidadas**, cada una verificable en la red. RealOps
esperaba 15 s; la primera compra de un tenant despliega y fondea su rail, pide
la factura, paga y espera la liquidación, y eso tardó entre 20 y 40 s. AgentPey
no se detiene cuando quien pidió corta, así que el pago terminaba igual. Y con
una clave de idempotencia nueva por pedido (`C-98`), **un reintento habría
pagado otra vez**.

**La decisión, en tres partes que van juntas:**

1. **La compra tiene su propio tiempo de espera, 120 s.** Las demás llamadas
   siguen en 15 s.
2. **Un timeout se reporta distinto de "no hay conexión"** (`timedOut` en los
   detalles del error), y la página dice la verdad: la compra puede haberse
   completado, y hay que revisar "Mis servicios" antes de volver a pedirla.
3. **Una clave por formulario, no por intento.** El formulario, y también los
   dos botones de respaldo, llevan un uuid generado al dibujar la página.
   Reenviar el mismo formulario le devuelve la compra que AgentPey ya hizo;
   pedir de nuevo desde una página nueva sigue siendo otra compra. Un
   formulario sin clave, de una página guardada de antes, cae a una clave
   nueva, que es el comportamiento anterior; y una clave que no es uuid se
   ignora, porque viene del navegador y termina adentro de un header.

**Por qué no alcanzaba solo con subir el tiempo.** Una espera larga baja la
probabilidad del error, pero no cambia qué pasa cuando igual se agota: la
persona vuelve a apretar y paga dos veces. La clave por formulario es lo que
hace inofensivo ese reintento.

**Alternativa descartada:** una clave fija por agente, como la invitación de
firma (`C-96`). Haría que pedir el informe dos veces a propósito devolviera
siempre la primera compra, justo lo que `C-98` quería evitar.

**Mismo hito, arreglo de dato:** `pay_to` guardaba `receipt.payer`, que es quién
pagó (el rail del tenant), en vez del cobrador. El dinero había ido a la cuenta
correcta; el registro decía otra cosa. `BazaarPaymentReceipt` ahora lleva el
`payTo` que `reconcileTerms` comparó contra el Mandato antes de firmar. Las
compras anteriores al arreglo conservan el dato viejo: no se reescribe el
historial.

---

### C-107 · T84: la entrega se lee del cuerpo del comercio, campo por campo, y el enlace no sale del origen pagado · `Vigente`
**Fecha:** 2026-09-13

En "Mis servicios", toda entrega de SignalDesk aparecía sin número de entrega,
sin recibo, y con "Ver lo que compraste" apuntando a la ruta paga x402, que
responde `402` y le pide a la persona que pague de nuevo. SignalDesk sí mandaba
los tres datos: la ruta de compra guarda `{ resource_url, resource }`, y
`toPurchaseResource` los buscaba en el nivel de arriba en vez de adentro de
`resource`.

**La decisión: cada dato de la entrega sale del cuerpo del comercio, validado
por separado, y un dato mal formado queda en `null`.** El cuerpo es de un
tercero, y un solo campo roto no puede hacer que falle la lectura entera de la
actividad de un tenant. Se lee al momento de responder: no hay migración, y las
compras ya hechas se ven bien sin tocarlas.

**El enlace tiene una regla más.** Tiene que ser `http(s)`, sin credenciales
embebidas, y del **mismo origen** que la ruta que se pagó. Un comercio puede
mandar a quien le compró a sus propias entregas; no puede usar un enlace que
RealOps muestra como "lo que compraste" para mandarla a otro sitio. Hay pruebas
para otro dominio, un dominio que empieza igual, `javascript:`, y los dos trucos
de credenciales en el host.

**La ruta paga ya no se usa como enlace de respaldo.** Para un comercio que no
manda `artifact_url` el enlace queda en `null`: esa ruta no puede entregar nada
sin un segundo pago, y ofrecerla como "lo que compraste" era la falla misma.
Sigue en pie `C-79`: un comercio que no manda estos datos no está roto.

**Anotado, sin construir:** después del despliegue la persona siguió viendo el
`402` en una pestaña vieja. RealOps no manda `Cache-Control`, así que el
navegador puede mostrar una copia anterior de una página con datos de la
persona. Propuesto `no-store`, a decidir.

---

### C-108 · T85: la suite de aceptación hace de persona contra lo desplegado, y lo que no puede forzar lo declara · `Vigente`
**Fecha:** 2026-09-13 · **Enfoque aprobado por el usuario antes de construirlo**

`scripts/f9-acceptance.ts` (`pnpm run acceptance:f9`) recorre los casos 2 a 10
del brief § 7 contra los tres servicios de Render, no contra copias locales:
`venues.json` resuelve SignalDesk por su origen público exacto, y T84 mostró que
los defectos que importan viven en los bordes entre servicios, justo donde las
pruebas usan dobles.

**Hace de persona, no de partner.** Todo lo que haría una persona pasa por las
páginas de RealOps (entrar, contratar, firmar, pedir, leer "Mis servicios") y
por las mismas rutas de consentimiento y revocación que llaman `consent.html` y
`revocar.html`. Una `Keypair` de testnet creada en cada corrida reemplaza a
Freighter: firma SEP-53 y firma las transacciones. La key del partner de RealOps
se usa directamente **solo** para lo que representa a una plataforma pidiendo lo
que no debe: otro comercio, otro producto, un Mandato ya vencido. Es la regla
"RealOps pide, AgentPey decide", ejercida desde el lado que pide.

**Lo que no prueba, dicho en la propia evidencia.** No corre el JavaScript de
las páginas; corre las rutas que ese JavaScript llama. Esa mitad la cubren el
recorrido del usuario con Freighter en T84 y la prueba con una persona externa
de `PILOTO-F9.md` § 10.

**Lo no forzable se reporta como `declarado`, nunca como aprobado.** Una
factura con otro precio, otro activo u otro `payTo`, y un catálogo caído,
necesitarían un interruptor de falla dentro de servicios públicos, descartado en
T84. Cada uno cita los tests que lo cubren.

**Tres decisiones del usuario, tomadas junto con el enfoque:**

1. **Credencial revocada:** no existe un camino de producto para revocar la
   credencial de un tenant (`directory.revokeCredential` no tiene quien la
   llame). La suite la revoca on-chain con el CLI de la Fase 1 y la clave del
   emisor, como lo haría un operador, y lo declara así.
2. **Rail sin saldo:** la wallet dueña del permiso retira el saldo de su propio
   rail **a la reserva** (`withdraw`, T57). No hace falta trustline y el crédito
   patrocinado vuelve.
3. **Mandato vencido por dos caminos:** por `/v1`, con vigencia de minutos, en
   la misma corrida; y desde RealOps, cuyo mínimo es un día, con
   `--phase=day2`. Esa fase se niega a correr antes de que el Mandato venza,
   sin tocar ningún servicio.

**Las claves de las wallets de prueba no se escriben en ningún lado.** Por eso
la corrida vacía sus rails antes de terminar (`C-112`). La evidencia cruda va a
`.f9-acceptance/` (no versionado), con los secretos redactados, y se pasa a
mano a `evidencia/T85.md`.

**Alternativas descartadas:** automatizar Freighter en un navegador (no se
puede sin instalar la extensión y aprobar a mano cada firma) y correr la suite
contra servicios locales (no habría visto ninguno de los defectos de `C-109` y
`C-110`).

---

### C-109 · T85: los créditos se acreditan a la referencia opaca que manda la plataforma, y SignalDesk la acepta · `Vigente`
**Fecha:** 2026-09-13 · **Decidido por el usuario (D1)**

**El defecto, encontrado por la suite en producción.** Los créditos de IA no se
podían comprar desde RealOps. `C-98` hace que RealOps acredite la compra a
`rop_<ulid>`, la referencia con que AgentPey conoce a la persona, justamente
para no mandar nada personal. El `accountSchema` de SignalDesk (T79) aceptaba
solo una dirección `G…`, así que cada pedido de créditos recibía un `400` antes
de que el comercio cotizara. Las dos decisiones chocaban, y ninguna prueba lo
veía: la de RealOps fijaba `rop_` y la de SignalDesk usaba una `G…`.

**La decisión: SignalDesk acepta como titular una dirección Stellar o una
referencia opaca `<prefijo>_<ulid>`.** `C-98` queda intacta.

**Alternativa descartada:** que RealOps mande la dirección de la wallet de la
persona. Le daría al comercio un identificador estable de esa wallet, que es
exactamente lo que `C-98` le niega. Y RealOps ni siquiera la conoce.

**Sigue cerrado a propósito:** un ULID no tiene `@`, espacios ni texto libre,
así que un correo o un nombre no pasan por referencia. Hay una prueba para el
correo y otra para algo que empieza con `rop_` sin ser un ULID.

---

### C-110 · T85: se pide la factura antes de desplegar el rail, y un comercio que rechaza no es un comercio caído · `Vigente`
**Fecha:** 2026-09-13 · **Decidido por el usuario (D2)** · toca el flujo de fondos (`P-10`)

**Lo que pasó.** Cuando SignalDesk rechazó el pedido de créditos, a la persona
se le dijo "No se pudo hablar con el comercio. Puede estar caído", que es falso
y que invitaba a reintentar algo que iba a fallar siempre. Y el rechazo llegó
**después** de que se desplegara y fondeara con 1 USDC el rail patrocinado del
tenant, para una compra que nunca iba a cotizarse.

**La decisión, en dos partes:**

1. **Un `4xx` distinto de `402` en la ruta paga es `MerchantRejectedRequest`**,
   con el status y el comienzo del cuerpo del comercio. `NetworkError` queda
   para lo que de verdad es de red: no hay respuesta, o llega un status que no
   es `402` ni `4xx`. RealOps tiene frase propia para el código nuevo.
2. **`tenant-purchase` le pide la factura al comercio (`requestPaymentChallenge`)
   antes de tocar el rail.** No se autoriza ni se firma nada en ese paso: la
   factura se vuelve a pedir y se concilia contra el Mandato en el paso de pago,
   igual que antes.

**Lo que no cambia:** el orden de las capas de autorización de `C-78`. Esto
agrega una lectura antes de gastar; no mueve ninguna decisión.

**Alternativa descartada:** pasar la respuesta ya pedida al paso de pago para
no pedirla dos veces. Habría cambiado la firma de `executeBazaarPayment`, que es
el camino de pago, para ahorrar un `GET` sin efectos.

---

### C-111 · T85: el Mandato se elige por producto, y cuando no hay uno activo se dice por qué · `Vigente`
**Fecha:** 2026-09-13 · **Decidido por el usuario (D3 y D5)**

La suite encontró tres defectos en el mismo lugar: cómo `tenant-purchase` pasa
de "este tenant" a "este Mandato".

- **Una cuenta con los dos agentes nunca compraba con el segundo.** Un tenant
  tiene un solo agente AgentPey (`ensureTenantAgent`), y RealOps firma un
  Mandato por producto. La compra tomaba el primer Mandato activo, así que los
  créditos se pedían con el Mandato del informe y se rechazaban con
  `MandateProductNotAllowed`.
- **Revocado y vencido decían "no hay Mandato".** `listActiveMandates` descarta
  esas filas antes de que alguien pueda decir por qué, así que la persona leía
  `MandateNotFound` y la frase cruda en inglés.
- **Una credencial revocada decía `UnknownTool`.** `createAgent` no lanza ante
  una credencial revocada on-chain: le retiene la herramienta de compra y
  guarda el motivo. La compra ignoraba ese motivo y llamaba igual a la
  herramienta que no estaba.

**La decisión:**

- **Se usa el Mandato activo más nuevo que nombra el producto.** Si ninguno lo
  nombra, se pasa igual uno activo, para que el rechazo lo dé `checkMandate` con
  su propio código. Este módulo **elige, no decide**: nunca convierte "ningún
  Mandato cubre ese producto" en un rechazo propio.
- **Sin Mandato activo, el historial del agente dice cuál de las tres pasó:**
  `MandateRevoked`, `MandateExpired` o `MandateNotYetValid`. `MandateNotFound`
  queda para cuando de verdad no hay nada firmado.
- **Se lee en voz alta el motivo que `createAgent` ya guardaba.** La herramienta
  sigue retenida exactamente igual; solo cambia qué se le dice a la persona.

**Por qué ninguna prueba lo vio.** Los tests de `tenant-purchase` le daban al
agente un único Mandato y nunca miraban qué pasa con uno que dejó de estar
activo. Ahora hay pruebas para las tres cosas.

**Alternativa descartada:** crear un agente AgentPey por agente de RealOps.
Habría cambiado la identidad de tenant de T40 y la custodia del rail, para
arreglar lo que es una elección entre filas.

---

### C-112 · T85: la suite vacía sus rails antes de terminar, y el caso de rail vacío falla si nunca llegó a pagar · `Vigente`
**Fecha:** 2026-09-13 · **Decidido por el usuario (D6)**

La primera corrida dejó **0.75 USDC de testnet varados** en el rail de una
persona de prueba, porque la clave de su wallet se descartó al terminar, y
`withdraw` solo lo puede firmar el principal. La decisión: antes de cerrar, la
suite retira a la reserva el saldo de cada rail que creó, firmado por su
principal mientras la clave todavía existe. No se guarda ninguna clave para
hacerlo después.

**Y un chequeo que hacía falta.** El caso 8b de la primera corrida pareció
funcionar, pero nunca llegó al pago: el comercio había rechazado el pedido
antes, por el defecto de `C-109`. Ahora el caso falla si el rechazo vino del
comercio antes de cotizar y no del pago con el rail vacío.

---

### C-113 · T85: el gasto de una intención que no se pagó sigue contando, y liberarlo queda para un hito aparte · `Superada`
**Fecha:** 2026-09-13 · **Decidido por el usuario** · **superada en T92 por `C-124`** y por la enmienda `M-23`

**Lo que encontró la suite.** Dos intentos de compra que no se pagaron subieron
el gasto del día de 0.10 a 0.20. `LocalPolicyRail.authorise()` registra el gasto
**al autorizar la intención** y nada lo libera si el pago no ocurre.

**No es un descuido: es `M-15`.** La decisión de la Fase 3 dice que se registra
al autorizar y no al pagar, porque contar de más una compra que no ocurrió deja
todo cerrado y contar de menos no. Al proponer el arreglo (D4) se dijo que no
había decisión escrita; era un error, y se corrigió antes de construir nada.

**La decisión: por ahora, no se cambia.** Liberar el gasto solo cuando el pago
nunca llegó a firmarse sería compatible con el motivo de `M-15`, pero toca el
enforcement de `perDay` y el vault. MandateVault es una cadena de hashes a la
que solo se agrega, así que "liberar" es un asiento nuevo dentro del mismo lock,
no un borrado. Merece un hito propio con su revisión, no ir de pasada al final
de T85.

**Lo que mitiga mientras tanto:** con `C-110`, un comercio que rechaza el pedido
falla en la consulta previa, antes de gastar el rail. El gasto de la intención
se sigue registrando igual, porque se autoriza antes de esa consulta. El chequeo
"el gasto del día no cuenta un pago que no ocurrió" del caso 8b va a seguir
fallando, y así queda documentado.

**Construido en T92 (2026-09-19).** Las dos mitades que esta entrada dejó
anotadas —liberar el gasto y el código propio para el rail vacío— están en
`C-124`, y la enmienda a `M-15` que hacía falta, en
[fase-3/DECISIONES.md § M-23](../fase-3-policyrail-mandato/DECISIONES.md). El
chequeo 8b de la suite de aceptación, que esta entrada dejó documentado como
"va a seguir fallando", pasa a ser exigible.

**En el mismo hito, decidido por el usuario: el rail vacío.** En la segunda
corrida, una compra con el rail sin saldo no pagó ni entregó nada, que es lo
correcto. Pero el rechazo llegó como `NetworkError` ("simulating the transfer
from policy_rail failed"), y RealOps le dijo a la persona "No se pudo hablar con
el comercio. Puede estar caído". El caso 8 del brief pide un mensaje
comprensible. Un código propio para "el rail no tiene saldo" toca el mismo
camino de pago del rail que liberar el gasto, así que van juntos.

---

### C-114 · T86: los tres servicios del piloto pasan a uno solo, sin dejar de ser tres procesos · `Vigente`
**Fecha:** 2026-09-14 · **Decidido por el usuario** (un servicio, un plan Starter, `agentpey.com`) · el diseño del gateway, de Claude Code

**El problema.** El piloto corría en tres servicios de Render en plan Free:
`agentpay-web`, `agentpey-realops` y `agentpey-signaldesk`. Tener los tres sin
arranque en frío en una demo costaba tres planes Starter.

**La decisión del usuario:** comprar `agentpey.com` (en Vercel Domains), servir
las tres apps bajo ese dominio (`agentpey.com`, `realops.agentpey.com`,
`signaldesk.agentpey.com`) y pagar **un solo** Starter.

**Cómo se hace sin perder `C-88`.** La credibilidad de SignalDesk como comercio
depende de que no tenga ninguna clave de AgentPey: claves, proceso y tablas
propios. Juntar las tres apps en un proceso habría roto eso en la práctica,
aunque ningún código importara del otro lado. Por eso existe
`@agentpey/gateway` (`apps/gateway`):

- **Tres procesos de verdad.** El gateway arranca `apps/web`, `apps/realops` y
  `apps/signaldesk` como procesos hijo, cada uno en su puerto interno, y recién
  abre el puerto público cuando los tres responden.
- **Cada hijo recibe solo sus variables.** Render le da un único juego de
  variables a un servicio, así que todos los secretos llegan al gateway.
  `hosts.ts` (`envKeys`) dice cuáles recibe cada app y `env-filter.ts` copia
  solo esas. SignalDesk no ve `AGENT_SECRET_KEY` ni `MASTER_MNEMONIC`, y las
  otras dos no ven `SIGNALDESK_SECRET_KEY`. Una variable que se agrega en
  Render y no en `envKeys` no le llega a ninguna app.
- **Ruteo por `Host`, exacto.** Un mapa fijo de dominio a app. Un dominio que no
  está en el mapa recibe `404`, nunca "el más parecido": un chequeo por prefijo
  (`realops.`) lo pasaría `realops.atacante.example`. Es el mismo error que
  `C-109` cerró en el titular de los créditos.
- **El `Host` original viaja sin cambios** (`proxy.ts`), así que `apps/web`
  sigue deduciendo su propio origen del pedido, igual que antes.
- **Si un hijo muere, se cae el servicio entero** y Render lo reinicia. No hay
  un reintento propio: sería una segunda política de reinicio, además de la de
  Render.

**Alternativas descartadas por el usuario:**
- **Vercel como host.** No calza con servidores Node de proceso largo: las tres
  apps guardan estado en memoria entre pedidos y se ejecutan como scripts, no
  como funciones.
- **Un Starter y dos Free.** Dos de las tres apps seguirían arrancando en frío
  en una demo.

**Alternativa descartada en el diseño:** importar las tres apps en un solo
proceso. Sus `server.ts` son scripts que se ejecutan al cargarse (`await` de
nivel superior, `listen` como efecto), no funciones que se puedan llamar tres
veces. Y un solo proceso tendría un solo `process.env` con todos los secretos.

---

### C-115 · T86: `agentpey.com` es el dominio canónico, y el servicio no tiene health check · `Vigente`
**Fecha:** 2026-09-14 · **Decidido por el usuario** (sin `www`) · lo demás, verificado en producción

- **`agentpey.com` sirve; `www.agentpey.com` redirige a `agentpey.com`.** Es el
  nombre que usa toda la documentación. La primera vez Render emparejó los dos
  al revés: `agentpey.com` redirigía a `www`, y el gateway, que no conoce `www`,
  respondía `404`. El usuario decidió sacar el `www` en lugar de agregarlo al
  mapa del gateway. Sacarlo se llevó el par entero, y al volver a agregar
  `agentpey.com` Render propuso la dirección correcta. `www` no está en el mapa
  del gateway porque nunca llega hasta él.
- **DNS en Vercel:** `A @ 216.24.57.1` y tres `CNAME` (`www`, `realops`,
  `signaldesk`) a `agentpey.onrender.com`.
- **Sin `healthCheckPath`.** El chequeo de Render no llega con ninguno de los
  tres dominios, y el gateway contesta `404` a un dominio desconocido: un health
  check haría fallar cada deploy con las tres apps funcionando. Render igual
  detecta el puerto abierto.
- **RealOps llama a AgentPey por su dirección pública** (`AGENTPEY_BASE_URL =
  https://agentpey.com`), no por `127.0.0.1:4101`. AgentPey arma los enlaces de
  firma con el `Host` con que lo llaman, y un enlace a una dirección interna no
  le sirve a la persona que lo recibe.

**Alternativa descartada por el usuario:** dejar `www.agentpey.com` como
canónico y agregarlo al mapa del gateway. Habría contradicho el nombre que usa
toda la documentación del piloto.

---

### C-116 · T86: la mudanza convive con los servicios viejos hasta que corra el día 2 de T85 · `Enmendada` (ver al final)
**Fecha:** 2026-09-14 · **Decidido por el usuario** (cada cambio en producción, confirmado antes de hacerlo)

El día 2 de T85 corre contra los tres servicios viejos y no puede correr antes
del 2026-09-15 a las 01:29 UTC. Por eso lo viejo y lo nuevo conviven, sobre la
misma base de datos:

- **El servicio `AgentPey` despliega desde `cc/t86-single-service-gateway`**, y
  los tres viejos, desde `main`. La rama no se mergea antes del día 2.
- **`venues.json` resuelve SignalDesk en `signaldesk.agentpey.com` solo en la
  rama.** Un venue se resuelve por origen: sin este cambio, la primera compra
  por los dominios nuevos se pagó al SignalDesk viejo. El id del venue
  (`signaldesk:GB4D…`) no cambió, así que los Mandatos ya firmados siguen
  nombrando el mismo comercio.
- **El partner de RealOps tiene los dos orígenes de retorno:**
  `https://agentpey-realops.onrender.com` y `https://realops.agentpey.com`. Sin
  el nuevo, firmar desde `realops.agentpey.com` falla y RealOps muestra un
  `502`. El viejo se saca cuando se den de baja los servicios viejos.
- **`render.yaml` describe el servicio único** (`name: AgentPey`, igual que en
  el panel), con los tres dominios y exactamente las variables de `envKeys`.
  Comprobado leyendo el archivo contra `APP_TARGETS`: no falta ninguna, no sobra
  ninguna, no hay repetidas.
- **El merge necesita su propia revisión.** El Blueprint `AgentPey` de Render
  administra los tres servicios viejos y **se sincroniza solo desde `main`**.
  Mergear dispararía una sincronización. Render nunca borra un servicio al
  sincronizar, así que los tres viejos quedarían sin administrar, pero seguirían
  andando. Lo que no se sabe es si el Blueprint adopta el servicio `AgentPey`
  creado a mano o crea otro, que se cobraría aparte. Antes de mergear: apagar el
  Auto Sync, mergear, y sincronizar a mano mirando lo que propone Render.
- **`scripts/f9-acceptance.ts` sigue apuntando por defecto a los servicios
  viejos**, a propósito, hasta que corra el día 2. Para probar lo nuevo se usan
  `F9_WEB_URL`, `F9_REALOPS_URL` y `F9_SIGNALDESK_URL` en `.env.local`, y se
  sacan al terminar.

**Alternativa descartada:** pasar todo de una vez, apuntando `main` y los
servicios viejos a los dominios nuevos. El día 2 habría corrido contra otro
despliegue que el del día 1, y T85 habría medido la mudanza, no el producto.

**Enmienda, 2026-09-14, decidida por el usuario.** El usuario preguntó si hacía
falta esperar, porque al día siguiente muestra el piloto en una reunión con
Stellar y quería todo limpio antes. **No hacía falta.** El día 2 no depende de
los servicios viejos: la cuenta de la persona F, su agente y su Mandato están en
la base compartida, y la suite entra a RealOps y consulta AgentPey por `/v1` en
cualquier despliegue. Lo único que no se puede adelantar es el vencimiento del
Mandato. El código que prueba el día 2 es el mismo; el motivo de la
"alternativa descartada" de arriba era más fuerte de lo necesario, y así se le
dijo al usuario antes de que decidiera.

Lo que se hizo el mismo día, con autorización del usuario para cada paso:

- **Auto Sync del Blueprint `AgentPey`: `No`.** Antes de mergear, para que el
  merge no dispare ninguna sincronización.
- **Los tres servicios viejos, borrados** (`agentpey-web`, `agentpey-realops`,
  `agentpey-signaldesk`). Render advierte que un servicio de un Blueprint puede
  recrearse en una sincronización. Con Auto Sync apagado, y con `render.yaml` en
  `main` describiendo solo `AgentPey`, una sincronización ya no los nombra.
- **El origen `https://agentpey-realops.onrender.com` salió** de los orígenes de
  retorno del partner de RealOps. Queda solo `https://realops.agentpey.com`.
- **T86 mergeado a `main`** (fast-forward) y **el servicio `AgentPey` despliega
  desde `main`**. La rama `cc/t86-single-service-gateway` se borró.
- **`scripts/f9-acceptance.ts` y `apps/realops/src/server.ts` usan por defecto
  los dominios nuevos.** El día 2 corre sin `F9_*_URL`.

Queda como estaba: el Blueprint sigue conectado, sin sincronizar.

**Actualización, 2026-09-14, por el usuario:** el Blueprint `AgentPey` quedó
desconectado. Ningún servicio se borró por eso; `AgentPey` sigue desplegando
desde `main`.

---

### C-117 · T86: una sola identidad visual para las tres apps, la landing en `agentpey.com` y la demo en `/sign` · `Vigente`
**Fecha:** 2026-09-14 · **Decidido por el usuario** (identidad única, landing en la raíz, una ruta aparte para la demo) · la ruta `/sign`, sugerida por el usuario

**El pedido.** Para la reunión con Stellar, el usuario pidió que las tres
páginas se vean bien y con la misma experiencia. RealOps y SignalDesk tenían un
estilo propio, oscuro con el tema del sistema, y AgentPey tenía otro, claro y
editorial. `agentpey.com` abría la demo de la Fase 4 en vez de la landing.

**Lo que se le planteó antes de decidir.** Las tres apps son, dentro del piloto,
tres empresas distintas, y la página de firma de AgentPey le pide a la persona
que desconfíe de un Mandato pedido en el dominio de RealOps. Si las tres se ven
iguales, esa diferencia deja de verse; la frase de advertencia y el dominio en
la barra siguen ahí. El usuario eligió igual una identidad única.

**La decisión:**

- **Una sola identidad: la de AgentPey.** Papel, tinta, acento verde,
  Instrument Serif para títulos e Inter para el texto, igual que
  `consent.html` y `landing.html`. RealOps (`apps/realops/src/pages.ts`) y el
  catálogo de SignalDesk (`apps/signaldesk/src/page.ts`) la copian. **Se copia,
  no se importa:** las apps no comparten código, y un paquete de estilos común
  no aportaba nada para tres archivos. Cada página conserva su nombre en la
  barra superior.
- **`/` es la landing y la demo con wallet pasó a `/sign`.** `/landing` sigue
  respondiendo, para que no se rompan los enlaces ya compartidos.
- **Las entregas de SignalDesk no se tocaron, a propósito.** El informe y el
  comprobante de créditos se renderizan de forma determinista, y su hash va
  dentro del recibo firmado. Cambiarles el HTML haría que ninguna entrega pasada
  coincida con su recibo. Se probó y se revirtió antes de commitear.
- **`revocar.html`** usaba `.top`, pensado para una fila, con el título y el
  texto adentro, y se veían uno al lado del otro. Ahora tiene la misma barra y
  cabecera que `consent.html`.

**Alternativa descartada por el usuario:** el mismo sistema con marcas
distintas (nombre, logotipo y color de acento propios por app). Mantenía visible
que son tres empresas.

**Alternativa descartada en la implementación:** un paquete común de estilos.
Agregaba una dependencia de build a dos apps que hoy no comparten nada, para
evitar duplicar unas cien líneas de CSS.

**Enmienda, 2026-09-14, decidida por el usuario:** `/sign` deja de existir y la
demo con wallet pasa a `/consent`. Ver `C-118`.

---

### C-118 · T87: el piloto en inglés y español, con el logo de AgentPey, y la demo en `/consent` · `Vigente`
**Fecha:** 2026-09-14 · **Decidido por el usuario** (todo el pedido, antes de la reunión con Stellar) · la forma del cambio de idioma, de Claude Code

**El pedido.** Para la reunión con Stellar, el usuario pidió:

- el logo de AgentPey junto al nombre en todas las páginas, y el ícono en la
  pestaña del navegador;
- que `/sign` no exista, que `agentpey.com` sea la landing y que `/consent` sea
  donde se firman los Mandatos, con "Watch it pay, live" llevando a `/consent`;
- todas las páginas en inglés y español, inglés por defecto;
- en la landing, enlaces a RealOps y SignalDesk;
- el aviso "Piloto sobre Stellar testnet. No hay dinero real en juego…" de
  RealOps reemplazado por la insignia de la landing, con el punto verde;
- RealOps y SignalDesk con el mismo ancho que `agentpey.com`;
- el español neutro latinoamericano, no rioplatense, y ningún "—" en los textos.

**Lo que se le preguntó antes de construir:**

1. **Qué muestra `/consent` sin id.** `/consent/{id}` ya era la página de firma a
   la que manda RealOps. El usuario eligió que `/consent` exacto sea la demo con
   wallet que estaba en `/sign`, y que `/consent/{id}` quede igual.
2. **La insignia tenía un "—"** ("Stellar Testnet — live"). El usuario eligió
   "Stellar Testnet · live" / "Stellar Testnet · en vivo".

**La decisión:**

- **Rutas de `apps/web`:** `/` y `/landing` → landing; `/consent` → demo;
  `/consent/{id}` → firma hospedada; `/revocar/{id}` → revocación. `/sign`
  responde `404`, como cualquier ruta desconocida.
- **Una barra superior copiada en las tres apps:** ícono de AgentPey + nombre,
  enlaces a las otras dos apps, EN/ES y GitHub. La landing no lleva el lema junto
  al nombre porque, con sus cinco anclas, la barra no entraba en una fila.
- **El favicon va dentro de cada página** (SVG y PNG de 32 px como `data:`). Así
  no hace falta una ruta de archivos nueva en ninguna de las tres apps, y
  RealOps y SignalDesk no dependen del dominio de AgentPey para su ícono.
- **Las dos lenguas viajan en cada página** (`<span data-tr="en|es">`) y un
  script previo al pintado muestra la elegida. La elección es una cookie
  `agentpey_lang` con `domain=agentpey.com`, así que se recuerda entre los tres
  subdominios. **El servidor nunca elige idioma:** la misma URL devuelve los
  mismos bytes para todos, y RealOps no gana estado nuevo.
- **RealOps:** los textos que cruzan módulos pasan a ser `{ en, es }`
  (`copy.ts`): las frases de rechazo (`refusals.ts`), las etiquetas de permisos
  (`permissions.ts`) y los errores de `app.ts`. `interpretInstruction` devuelve
  el motivo como clave (`details.problem`) y la página lo pone en palabras.
  **Entiende también instrucciones en inglés** ("buy the XLM/USDC market
  report"), porque la página por defecto está en inglés. Es la capa que puede
  equivocarse (`PILOTO-F9.md` § 4.1): ampliar su vocabulario no toca ninguna
  autorización.
- **SignalDesk:** el catálogo tiene textos propios en los dos idiomas. `PRODUCTS`
  no cambia, porque su nombre y descripción son los del `ServiceCard` y el `402`.
  Las entregas siguen sin tocarse (`C-117`).
- **La suite de aceptación lee marcas estables, no frases:** `data-magic-link`
  para el enlace de entrada y `data-mandate-id` para el Mandato guardado. La
  frase de un rechazo se busca en los dos idiomas.

**El aviso de piloto de RealOps pasa a ser solo "testnet". Decidido por el
usuario.** `PILOTO-F9.md` § 1.3 (decisión del usuario, § 12) pedía en toda página
de RealOps un aviso de piloto: testnet, sin dinero real, datos de prueba, y el
proyecto puede borrarlos. La insignia dice lo primero y no lo demás. Se le
propuso conservar el resto de la frase en el pie. El usuario decidió que decir
testnet alcanza, así que queda solo la insignia. **Esto enmienda § 1.3 de
`PILOTO-F9.md`** en ese punto.

**Orden obligatorio para el día 2 de T85.** Las marcas nuevas cambian lo que la
suite lee de RealOps. El día 2 tiene que correr con el código y el despliegue
alineados. El usuario pidió mergear primero, así que corre **después** de que
este despliegue esté en producción, nunca en medio.

**Alternativas descartadas:**
- **Elegir el idioma en el servidor** (cookie o `Accept-Language`). RealOps
  tendría que leer la cookie en cada página, y una página cacheada podría volver
  en el idioma de otra persona.
- **Traducir con un diccionario en JavaScript en todas las páginas.** Una página
  de RealOps sin JavaScript quedaría sin texto. Con los dos idiomas en el HTML,
  sin JavaScript se lee en inglés.
- **Servir el logo como archivo** (`/brand/…`). Habría que agregar tipos MIME y
  una ruta en `apps/web`, y RealOps y SignalDesk dependerían de otro dominio para
  su ícono.

---

### C-119 · T88: sin proveedor de correo, RealOps deja entrar directo; y el piloto usa el ancho de la pantalla · `Vigente`
**Fecha:** 2026-09-15 · **Decidido por el usuario** (entrar directo, diseño) · la forma, de Claude Code

**El pedido.** Después de mirar el piloto desplegado en un Mac de 13 pulgadas, el
usuario pidió: entrar a RealOps con correo y nombre sin pasar por "Revisa tu
correo", porque agrega fricción; páginas más anchas, con fintual.cl como
referencia; pies de página de RealOps y SignalDesk que ocupen el ancho; tarjetas
del mismo tamaño y alineadas; el lema junto al logo con mayúscula inicial; sin
"Entrar" en el centro de la barra de RealOps; y el nombre del agente con
mayúscula.

**Entrar directo, solo mientras no haya proveedor de correo.** Sin
`RESEND_API_KEY`, `POST /entrar` abre la sesión y lleva a "Mis agentes". Con un
proveedor configurado vuelve el enlace de un solo uso por correo, sin cambios.

- **No baja la seguridad que había.** El modo sin correo mostraba el enlace en
  pantalla a quien escribiera la dirección: tampoco comprobaba que el correo
  fuera suyo, y la página ya lo decía. Saltarse esa página solo quita un clic.
  La página de entrada lo sigue diciendo ("el piloto todavía no confirma el
  correo").
- **Lo que sí implica, dicho al usuario:** quien sepa el correo de una cuenta
  entra a esa cuenta, ve sus agentes y compras, y puede pedir compras dentro de
  lo que el Mandato ya firmado permite. No puede firmar, revocar ni pagar fuera
  de ese Mandato: eso sigue ocurriendo en AgentPey, con la wallet. Antes de abrir
  el piloto a personas externas conviene configurar el correo.
- **El correo es la cuenta.** Entrar de nuevo con un correo conocido lleva a la
  misma cuenta, y el nombre escrito esa vez no reemplaza al primero. Fijado por un
  test.
- **Enmienda `PILOTO-F9.md` § 1.3** en "enlace mágico: un solo uso, 15 minutos"
  para el modo sin correo.
- **La suite de aceptación** entra con el mismo `POST` y verifica la redirección
  a `/agentes`. Se quitó el chequeo "el enlace de entrada no sirve dos veces" del
  caso 10, que sin enlace no tiene objeto. La regla sigue probada en los tests del
  modo con correo.

**El diseño:**

- **Ancho:** contenedor de hasta 1320 px con márgenes `clamp(20px, 4vw, 56px)`,
  unos 1208 px de contenido a 1470 px, igual que fintual.cl. Los párrafos llegan
  hasta ~80 caracteres; más que eso cuesta leer.
- **Tarjetas:** rejillas de columnas iguales (`auto-fill`), cada tarjeta estira a
  la altura de la fila y deja su acción abajo. El mínimo de columna es
  `min(340px, 100%)`, así que en un teléfono no desborda.
- **Pies:** en RealOps, una fila con el texto y enlaces a AgentPey, SignalDesk y
  GitHub. En SignalDesk, una fila por nota, con el título a la izquierda y el
  texto a lo ancho.
- **Lema:** "Payment infrastructure for agents" / "Infraestructura de pagos para
  agentes", "Agent platform" / "Plataforma de agentes", "x402 merchant" /
  "Comercio x402" (en inglés "x402" va en minúscula porque así se escribe el
  protocolo), "Live demo" / "Demo en vivo". Separado del nombre por una línea
  fina. Vuelve a la landing, que ahora tiene lugar.
- **Nombres escritos por la persona** (agente, alias) se muestran con mayúscula
  inicial. Lo guardado y lo enviado a AgentPey no cambia.

**Alternativas descartadas:**
- **Quitar también el enlace cuando hay correo configurado.** Dejaría a RealOps
  sin forma de comprobar la dirección el día que se abra a externos.
- **Actualizar el nombre al entrar con un correo conocido.** Cualquiera que
  escriba ese correo podría renombrar la cuenta de otra persona.
- **Párrafos a todo el ancho.** A 1208 px una línea pasa de 150 caracteres.

---

### C-120 · T89: rechazos que se entienden, montos y horas legibles, y el botón en vivo va a RealOps · `Vigente`
**Fecha:** 2026-09-15 · **Decidido por el usuario** (botón, demo, montos, hora local, rechazos, elegir el agente) · la forma, de Claude Code

**El pedido.** Montos con a lo más tres decimales; horas en la zona de quien
mira y no en UTC; rechazos que se entiendan al leerlos, con una tabla de los
códigos y lo que significan; que "Watch it pay, live" lleve a algo de AgentPey
donde se vean las firmas, porque la demo de `/consent` ya no servía; y saber qué
agente compra cuando hay dos iguales.

**Lo que se encontró antes de construir:**

1. **Rechazos en producción.** Consulta de solo lectura a `directory_purchases`
   (sin imprimir la conexión): 14 códigos distintos. Tres no tenían frase
   (`ScopeActionNotAllowed`, `MandateActionNotAllowed`, `UnknownTool`), así que la
   persona leía el motivo en inglés de la plataforma junto al código.
2. **Dos agentes del mismo tipo.** RealOps registra el agente firmado más viejo,
   pero AgentPey paga con el Mandato activo **más nuevo** que nombra el producto
   (`selectMandateFor`, `C-111`), porque los dos agentes de una cuenta comparten
   tenant. Los límites que aplican son los del más nuevo, y nada deja elegir.
3. **Las páginas de firma de AgentPey** (`/consent/{id}`, `/revocar/{id}`) solo
   abren con una invitación que crea RealOps: no hay una página pública fija
   donde ver una firma.

**Decisiones del usuario, tomadas con esas opciones a la vista:**

- **"Watch it pay, live" y "Open the live pilot" van a `realops.agentpey.com`**,
  donde se contrata un agente y su Mandato se firma en AgentPey con Freighter.
  **La demo de la Fase 4 se quita:** `apps/web/public/index.html` se borra, y
  `/consent` y `/sign` responden `404`. Esto enmienda `C-118` en la ruta de la
  demo. Las rutas `/api/session/*` que usaba la demo siguen en `server.ts` sin
  página que las llame; quitarlas queda anotado.
- **Elegir qué agente compra es un hito propio (T90), no construido:** RealOps
  deja elegir el agente y `POST /v1/purchases` acepta un Mandato opcional, que
  AgentPey usa solo para elegir la fila; `checkMandate` y los límites firmados
  siguen decidiendo. Cambia el contrato congelado de `/v1` (T73) y el punto
  donde AgentPey elige el Mandato, así que va con su propia revisión.

**La forma:**

- **Rechazos.** `refusals.ts` agrupa las frases por la capa que dice que no
  (registro y catálogo, credencial, Mandato, intención, factura, dinero y red) y
  cubre todos los códigos que puede devolver una compra: 56, antes 31.
  **Enmienda `C-99`** en el caso de un código desconocido: en lugar de mostrar el
  motivo en inglés como si fuera la explicación, se dice que la página todavía no
  sabe explicarlo, y el motivo queda como detalle técnico. El código se muestra
  en letra chica como "código técnico". `NetworkError` deja de decir "puede estar
  caído el comercio" y dice lo que puede ser: comercio, red o contrato sin saldo.
  El código propio para el rail vacío sigue en `C-113`.
- **Tabla de códigos:** `CODIGOS-DE-RECHAZO.md`, generada desde `refusals.ts`
  con `pnpm run docs:refusal-codes`. Un test falla si el archivo no coincide con
  el código.
- **Montos en RealOps:** entre dos y tres decimales (`0.5000000` → `0.50`,
  `0.1234567` → `0.123`), solo al mostrar. **No en `/consent/{id}` ni en
  `/revocar/{id}`**, ni en el permiso literal de RealOps: ahí se muestra lo que
  se firma, y redondearlo haría que la pantalla dijera otra cosa que el
  documento.
- **Hora local.** RealOps escribe el momento en un `<time datetime>` con UTC de
  respaldo, y el script de la página lo reescribe con la zona del navegador y su
  abreviatura (por ejemplo "GMT-3"). `/consent/{id}` y `/revocar/{id}` ya usaban
  la hora del navegador; ahora muestran también la zona. **Con campos
  explícitos:** `toLocaleString` lanza un error si `timeZoneName` va junto con
  `dateStyle`, y en `/consent/{id}` eso habría cortado la carga de la invitación.
  Se encontró en la revisión visual, antes de commitear, y lo fija un test.

**Alternativas descartadas:**
- **Una página pública nueva con firmas recientes.** Útil, pero pide una ruta
  nueva y decidir qué datos se muestran sin exponer a nadie; no llegaba a la
  reunión.
- **Detectar la zona horaria en el servidor.** El servidor no sabe dónde está
  quien mira. El navegador sí.
- **Quitar el código técnico de la vista.** Es lo que alguien de soporte o una
  integración necesita para saber qué pasó; queda, pero chico y con su nombre.
- **Un agente por tipo, o solo mostrar cuál compra.** Resolvían la confusión sin
  dejar elegir, que es lo que el usuario pidió.

**Nota de la sesión.** Para diagnosticar la demo se llamó una vez a
`POST https://agentpey.com/api/session/start` en producción. Eso emitió y ancló en
testnet una credencial y un Mandato de demo, lo mismo que apretar "Start
session". Se le dijo al usuario.

---

### C-121 · T90: la persona elige qué agente compra, y `mandate_id` elige el Mandato sin autorizar nada · `Vigente`
**Fecha:** 2026-09-15 · **Decidido por el usuario** (elegir el agente, en `C-120`; y las siete preguntas del diseño) · la forma, de Claude Code

**El problema, verificado en T89.** En RealOps una cuenta puede contratar dos
agentes del mismo tipo, cada uno con su Mandato, y los dos comparten el tenant de
AgentPey. RealOps tomaba el agente firmado más viejo y armaba con él la clave de
idempotencia. AgentPey pagaba con el Mandato activo más nuevo que nombra el
producto (`selectMandateFor`, `C-111`). `POST /v1/purchases` no tenía forma de
nombrar ninguno.

**Lo que encontré antes de construir, y se le dijo al usuario:**

1. **Elegir el Mandato no separa el gasto del día.** `perDay` se cuenta por agente
   de AgentPey (`spentOn(intent.agent)`, `policy-rail.ts`), y un tenant tiene uno.
   El `perDay` del Mandato elegido se compara con todo lo que el agente gastó hoy,
   por cualquiera de sus Mandatos. El rail también es uno por tenant, con su
   `per_day` on-chain fijo.
2. **La tarjeta "Hoy llevas gastado" de RealOps** muestra el Mandato activo más
   nuevo del tenant, de cualquier producto (`activeMandate`,
   `packages/activity`).
3. **El SDK de partners no tiene compras**, y la guía terminaba en el Mandato.

**Decisiones del usuario, con esas opciones a la vista:**

| # | Pregunta | Decisión |
|---|---|---|
| 1 | ¿`mandate_id` en la respuesta, con su columna? | Sí |
| 2 | ¿`404 MandateNotFound` o un código nuevo? | Reusar `MandateNotFound` |
| 3 | ¿Cómo elige la persona? | Una página "¿Qué agente lo compra?" después de interpretar la frase |
| 4 | ¿Clave de idempotencia? | `buy-${request_key}`, por formulario y sin el agente (lo recomendado; el diseño de T89 decía "con ese agente") |
| 5 | ¿RealOps manda `mandate_id` siempre? | Sí, también con un solo agente |
| 6 | ¿Guía y SDK? | Sección de compras en la guía; el SDK sin compras por ahora |
| 7 | ¿Aviso del gasto compartido? | Sí, en la página de elección |

**La forma:**

- **Contrato de `/v1` (enmienda aditiva de T73).** `POST /v1/purchases` acepta
  `mandate_id` opcional (`mdt_…`); `null` o mal formado es `400`. Sin él, nada
  cambia. `PurchaseResource` gana `mandate_id` nullable: el Mandato por el que pasó
  la compra, nombrado o elegido. Columna `directory_purchases.mandate_id`, esquema
  del directorio versión 9; las filas viejas quedan en `null`.
- **Primera cerradura, en la ruta.** Después de `requireOwnedTenant`,
  `requireMandateOfTenant` exige que el Mandato sea **de ese tenant**, no solo del
  partner. No existe, es de otro partner o es de otro tenant del mismo partner: el
  mismo `404` con el mismo cuerpo, que solo repite el id recibido. No se llama al
  puerto de compra ni se escribe fila. Un tenant ajeno sigue siendo
  `TenantNotFound` antes de mirar el Mandato.
- **Segunda cerradura, en el módulo.** `resolveNamedMandate` busca solo en
  `listMandates(tenantId)` y además exige `tenantId` y `agentId` en la fila. Sin
  respaldo nunca: revocado, vencido o sin empezar se rechaza con `MandateRevoked`,
  `MandateExpired` o `MandateNotYetValid` aunque otro Mandato activo cubra la
  compra. La ventana es la de `listActiveMandates`, con los dos bordes incluidos.
  Un id ajeno no se escribe como "usado": el rechazo lleva `mandate_id: null`.
- **Todo lo demás, igual (`B-25`).** `mandateSourceFrom`, la verificación
  on-chain de `createAgent`, `withheldBecause`, `checkScope`, `checkMandate` (con
  productos y agente), `perDay` en su sección crítica, `max_total`,
  `reconcileTerms` y los límites del rail. Un Mandato nombrado que no cubre el
  producto lo rechaza `checkMandate` con `MandateProductNotAllowed`. **Enmienda
  `C-111`** solo en esto: con `mandate_id`, `selectMandateFor` no participa.
- **RealOps.** Después de interpretar, los candidatos son los agentes de esa
  cuenta del tipo pedido con Mandato firmado. Con uno, se compra directo. Con más
  de uno y sin `agent_id`, se muestra la página de elección, que reenvía la misma
  frase (o el mismo botón de producto), la misma `request_key` y el `agent_id`
  elegido. Un `agent_id` que no está entre los candidatos (de otra cuenta, de otro
  tipo, sin firmar) es `400` sin llamar a AgentPey. Siempre se manda el
  `mandate_id` del agente que compra.
- **Idempotencia (enmienda de lo propuesto en T89, no de `C-98`).** La clave es
  `buy-${request_key}`. Elegir otro agente desde el mismo formulario manda la
  misma clave con otro cuerpo, AgentPey responde `409 IdempotencyKeyConflict` y
  RealOps dice "Ya pediste esto con otro agente". Con la clave por agente, ese
  formulario habría hecho dos compras; es lo que `C-98`, enmendada en T84, quiere
  evitar.
- **En pantalla.** Las entregas y los rechazos de "Mis servicios" dicen qué
  agente compró, leído del `mandate_id` que devuelve AgentPey. La página de
  elección avisa que el gasto del día se suma entre los agentes.
- **Guía.** `examples/cloudops-partner-integration.md` gana § 7 "Pedir una
  compra"; errores pasa a § 8.

**Lo que no cambia, a propósito, y queda escrito:**

- **El gasto del día es del agente, no del Mandato.** Fijado por un test nuevo en
  `policy-rail.test.ts`. Separarlo pediría un agente de AgentPey por agente de
  RealOps: la alternativa que `C-111` descartó.
- **El rail tiene el `principal` del primer Mandato que pagó.**
  `ensureTenantPolicyRail` devuelve el rail existente sin mirar
  `principalAddress` (`tenant-rail.ts:271-279`). Si dos agentes de una cuenta
  se firmaran con wallets distintas, retiraría la del primero. Pasaba igual antes
  de T90; no se tocó.
- **La tarjeta de gasto** sigue mostrando el Mandato activo más nuevo del tenant.

**Alternativas descartadas:**

- **`agent_id` de AgentPey en el cuerpo.** Hay un agente por tenant: no distingue
  nada.
- **Una referencia al agente de RealOps.** AgentPey no conoce esos agentes;
  pediría una tabla de mapeo.
- **Un agente de AgentPey por agente de RealOps.** Separaría el gasto, pero cambia
  la identidad y la custodia del rail (`C-111`).
- **`POST /v1/mandates/{id}/purchases`.** Otra ruta y otra forma de contrato para
  lo mismo.
- **Un código nuevo para el Mandato ajeno.** `MandateNotFound` ya es lo que
  responde `GET /v1/mandates/{id}`; el `201` refused `MandateNotFound` ("nada
  firmado") se distingue por el status.
- **Selector dentro del formulario, o "agente preferido" en Mis agentes.** El tipo
  se sabe recién al interpretar la frase; y un preferido agrega estado que nadie
  pidió.
- **Clave por agente.** Ver arriba.

**Anotado sin construir:** compras en `@agentpey/partner-sdk`; una tarjeta de
gasto por agente.

`AGENTS.md` sin cambios: T90 no cambia qué es delegable. `POST /v1/purchases` y la
elección del Mandato ya estaban fuera del alcance de Codex.

---

### C-122 · Pregunta abierta: MPP en modo Session cambiaría dónde se autoriza el gasto · `Pendiente`
**Fecha:** 2026-09-16 · anotada por Claude Code al comparar con la skill oficial `stellar/agentic-payments` · sin construir

**De dónde sale.** La skill oficial de la SDF (`stellar-dev-skill`, instalada en
`~/.agents/skills/agentic-payments/`) cubre tres formas de pago de agentes: x402,
MPP Charge y MPP Session. AgentPey solo usa x402 `exact`: una transacción por
compra, y `PolicyRail.authorise()` decide compra por compra, antes de firmar.

**Qué cambia con Session.** El cliente deposita USDC una vez en un contrato de
canal, firma compromisos **acumulados fuera de la cadena** por cada pedido, y el
comercio cierra el canal con una sola transacción al final. Consecuencias para el
modelo actual:

1. **Nada pasa por la cadena entre el depósito y el cierre.** El `__check_auth` de
   `policy_rail` (T22, T31) vería el depósito, no cada pedido: `perTx` y `perDay`
   on-chain dejarían de describir el gasto real.
2. **El depósito pasa a ser el tope efectivo.** Lo que el agente puede perder es
   lo depositado, no lo que diga `perDay`.
3. **`reconcileTerms` y `SpendLedger` tendrían que correr sobre cada compromiso
   firmado**, y el monto de cada uno es acumulado, no el de la compra. El ledger
   anotaría la diferencia entre compromisos, no el monto del 402.
4. **Revocar un Mandato no retira lo depositado.** Cortar el consentimiento
   detiene los compromisos nuevos; el comercio puede cerrar con el último firmado.

**Qué se decide hoy.** Nada. Ningún comercio del piloto (bazaar, SignalDesk) usa
MPP, y la regla 5 de `CLAUDE.md` dice anotar y no construir. Si un comercio real
lo pide, esta entrada es el punto de partida del diseño, no la respuesta.

**Alternativas, para cuando toque:** (a) no soportar Session y rechazar el reto
con un código propio; (b) autorizar el depósito como una compra con tope, y tratar
cada compromiso como consumo de ese tope; (c) autorizar cada compromiso y limitar
el depósito a `perTx`. Ninguna está evaluada.

`AGENTS.md` sin cambios: es una pregunta de autorización y flujo de fondos, que ya
queda en Claude Code (`P-10`).

---

### C-123 · Un Mandato nuevo creado por la API pública tiene que nombrar a quién se le paga · `Vigente`
**Fecha:** 2026-09-16 · anotada por Claude Code como pregunta abierta · **decidido por el usuario el mismo día: opción 2**

**El hecho, verificado en el código.** `reconcileTerms`
(`apps/agent/src/policy/terms.ts:144`) compara el `payTo` del reto 402 contra
`grant.payTo` **solo si el Mandato trae la lista** (`G-10`). Sin lista, el chequeo
se saltea y la compra puede pagarle a cualquier cuenta, siempre que venue, asset y
monto coincidan con el intent.

- **RealOps** siempre manda `payTo` (`proposedGrantSchema`,
  `apps/realops/src/permissions.ts:47`, `min(1)`).
- **`POST /v1/consent_sessions`** no lo exige: en `docs/api/openapi.yaml` el
  `grant` requiere `actions`, `venues`, `assets` y `limits`, y `payTo` es opcional.
  Un partner que no sea RealOps puede crear un Mandato sin `payTo`.

**Por qué importa ahora.** La skill oficial trata `payTo` como el dato más
delicado del reto 402: es la cuenta que cobra. `venue` es un nombre que AgentPey
compara consigo mismo, no una cuenta en la cadena; un comercio comprometido, o una
respuesta 402 alterada, puede cambiar `payTo` sin cambiar nada de lo que hoy se
compara.

**Lo que `G-10` ya dijo y sigue valiendo.** Hacerlo opcional fue deliberado:
`M-14` pidió no fingir un chequeo sin algo firmado contra qué comparar. Esta
entrada no dice que `G-10` esté mal; pregunta si, **para Mandatos emitidos por la
API pública**, la lista debería ser obligatoria.

**Opciones:**

1. **Dejarlo como está.** Opcional; la guía de partners recomienda mandarlo.
2. **Obligatorio en `/v1/consent_sessions`**, opcional en el esquema del documento.
   Los Mandatos existentes sin `payTo` siguen verificando igual. Cambio aditivo
   del lado de la validación, pero rompe a un partner que hoy no lo manda (no hay
   ninguno fuera de RealOps).
3. **Sin lista, rechazar en `reconcileTerms`** con un código propio. Cambia `G-10`
   y afecta Mandatos ya firmados; por la regla 2 no se toca sin decisión explícita.

**Recomendación de Claude Code:** la opción 2, por ser la que cierra el hueco para
Mandatos nuevos sin cambiar el significado de los ya firmados.

**Decisión del usuario (2026-09-16): opción 2.** `payTo` pasa a ser obligatorio,
con al menos una cuenta, en el `grant` de `POST /v1/consent_sessions`. El esquema
del documento (`mandateGrantSchema`) y `reconcileTerms` no cambian: un Mandato ya
firmado sin `payTo` sigue verificando igual. Implementado en T91
(`proposedGrantSchema` en `packages/partner-api/src/resources/consent-sessions.ts`).
Una sesión pendiente creada antes del despliegue sin `payTo` todavía se puede
firmar: se valida con el esquema del documento, y vence sola.

`AGENTS.md` sin cambios: autorización y contrato de `/v1` ya quedan en Claude Code.

---

### C-124 · T92: se libera el gasto de una compra que nunca llegó a la red, y un rail sin saldo lo dice · `Vigente`
**Fecha:** 2026-09-19 · **Hito:** T92 · **Decidido por el usuario** (las tres preguntas del diseño) · cierra `C-113`

Esto construye lo que `C-113` dejó anotado en T85, con las dos mitades que esa
entrada dijo que iban juntas "porque tocan el mismo camino del rail".

#### La mitad 1: liberar el gasto

**El defecto, medido.** En la segunda corrida de la suite de aceptación, dos
intentos de compra que no se pagaron subieron el gasto del día de 0.10 a 0.20.
El cupo diario de la persona quedaba consumido hasta la medianoche UTC por
compras que no ocurrieron.

**La frontera, que es toda la decisión.** El `fetch` que lleva el header de
pago firmado, en `executeBazaarPayment`
(`apps/agent/src/payment/x402.ts`). Antes de esa línea nada firmado salió del
proceso y el gasto se libera; esa línea y todo lo posterior es ambiguo y
**nunca** se libera. La amplitud de la enmienda a `M-15` y el mecanismo que la
hace cumplir (`details.paymentSent` + `mayHaveBeenPaid()`, que falla cerrado
ante cualquier error sin marcar) están en
[fase-3/DECISIONES.md § M-23](../fase-3-policyrail-mandato/DECISIONES.md).

**En el vault: un cuarto tipo de asiento, `released`.** La cadena es
append-only, así que liberar **resta con un asiento nuevo**; la concesión que
deshace sigue en la cadena y `verify()` sigue dando `ok`. Tres reglas que
salieron del diseño, cada una con su test:

- **El asiento lleva el día de su concesión, nunca el de la liberación.** Un
  gasto registrado a las 23:59 UTC y liberado a las 00:01 restaría de un día al
  que nunca sumó, rompiendo dos días de una sola vez.
- **Idempotente.** Liberar dos veces libera una.
- **Cerrada ante lo que no corresponde.** Liberar una intención sin concesión
  da `SpendNotRecorded`; liberar una con asiento `anchored` —un pago que
  liquidó en la cadena— da `SpendAlreadySettled`. Nunca silencio.

**Un caché que había que sacar.** `hasRecordedVia` (vault de Postgres) cortaba
en un `Set` en memoria antes de consultar. Con liberaciones esa respuesta queda
vieja incluso dentro de un solo proceso, y el efecto habría sido regalar
presupuesto de forma permanente. Se eliminó: es la misma clase de caché
obsoleto que `G4` ya había sacado de `spentOn`.

**Dónde se libera, y dónde no.** En `apps/web/src/tenant-purchase.ts` los pasos
5b a 7 (tope del partner, ruta del producto, la consulta previa al comercio de
`C-110`, desplegar/fondear el rail) son todos anteriores a la frontera y
liberan directo. Solo el paso 8 pregunta. El helper `releaseUnpaidSpend`
**nunca lanza**: corre mientras un rechazo ya va en camino, y una liberación
que falla no puede convertir ese rechazo en una caída ni tapar el motivo real —
se loguea y el gasto queda contado, que es el comportamiento anterior a T92.
Los otros dos llamadores de `executeBazaarPayment` (el camino clásico de
`server.ts` y la tool `execute_payment`) reciben el mismo tratamiento.

#### La mitad 2: el rail sin saldo lo dice

**El defecto.** Un rail sin USDC fallaba en la simulación de la transferencia y
salía como `NetworkError`, y RealOps le decía a la persona "No se pudo hablar
con el comercio. Puede estar caído" — ni cierto ni accionable. El caso 8 del
brief pide un mensaje comprensible.

**Código propio `RailInsufficientFunds`, por las dos puntas** (el usuario eligió
ambos mecanismos):

1. **Consulta previa**, en el paso 7b de `tenant-purchase.ts`, donde ya se leen
   saldos para la reserva: se rechaza antes de intentar nada. Misma postura que
   la consulta previa de `C-110`.
2. **Respaldo**, en `assertSimulationUsable`: cuando la simulación falla igual
   —la ventana entre el chequeo y la transferencia—, se lee el saldo una vez más
   y, si está corto, se lanza el código propio en lugar de `NetworkError`.

**Por qué se lee el saldo y no se parsea el error.** `simulation.error` es la
representación del host Soroban de lo que haya lanzado el contrato del asset;
para el Stellar Asset Contract, "saldo insuficiente" es un `Error(Contract, #N)`
opaco cuya numeración es del token, no nuestra. Leer el saldo contesta la
pregunta que la persona realmente tiene, y no se desactualiza contra un
contrato que no controlamos.

**Dos detalles de la consulta previa:** `readUsdcBalance` lee USDC y solo USDC,
así que el paso 7b se saltea para una compra cotizada en otro asset en vez de
comparar contra el saldo del asset equivocado — ese camino lo cubre el respaldo,
que sí consulta el asset que nombró el reto 402. Y un saldo que no se puede leer
no es un rechazo: el pago sigue y falla, o no, por sus propios medios.

**La frase**, en los dos idiomas, dice además que la compra no cuenta contra el
límite diario — que ahora es cierto, por la mitad 1.

#### Lo que no se tocó

`checkMandate`, `checkScope`, `reconcileTerms`, la aritmética de
`checkDailyLimit` y el contrato `policy_rail` en Stellar quedan igual. Un
Mandato ya firmado verifica exactamente como antes.

`SpendNotRecorded` y `SpendAlreadySettled` no tienen frase en RealOps a
propósito: son errores internos del camino de liberación, que `releaseUnpaidSpend`
se traga y loguea. Una persona no debería poder verlos nunca.

**Sin cambios en `AGENTS.md`:** autorización y flujo de fondos ya quedan en
Claude Code (`P-10`).

---

### C-125 · T93: preguntar si una compra se permitiría es una ruta aparte, no un campo de la que paga · `Vigente`
**Fecha:** 2026-09-20 · **Hito:** T93 · **La forma (ruta aparte) la decidió el usuario**, sobre una propuesta inicial distinta

**El problema.** Hasta acá, la única forma de saber si una compra se permitiría
era intentarla. Y una compra autorizada **reserva presupuesto** (`M-15`): la
pregunta le costaba plata a la persona. T92 lo suavizó —un intento que no pagó
devuelve el cupo— pero no lo elimina. Además, un candidato a partner no podía
ver al enforcement decidir sin wallet, sin Freighter y sin USDC de testnet.

**Lo que se construyó.** `POST /v1/purchases/preview` corre **todos** los
chequeos de una compra real —registro de venues, `checkScope`, `checkMandate`
incluida la lista de productos de `C-75`, y los dos límites diarios contra el
gasto real de hoy— y no reserva, no firma y no paga.

#### La decisión de forma: ruta aparte, no `dry_run`

La propuesta original de Claude Code era un campo `dry_run` en
`POST /v1/purchases`. Al mirar el código se propuso lo contrario y **el usuario
eligió la ruta aparte**, por la dirección en que fallan las dos:

- Con un flag, un partner cuyo `dry_run` se pierde —un bug, un default malo, un
  campo que no viajó— **hace una compra real**. Llamar a una URL que no tiene
  ningún camino de código hacia un pago no puede hacer eso, diga lo que diga el
  cuerpo. Hay un test que lo fija: el puerto que paga nunca se toca.
- La previa no crea nada, así que no necesita `Idempotency-Key`. Exigirlo sería
  ceremonia sin invariante detrás.
- La respuesta tiene otra forma. Meterla en `PurchaseResource` habría
  significado un id de compra que a veces es `null`.

#### Permiso propio: `payments:preview`

No implicado por `payments:authorize`, y la lista sigue plana. El motivo es el
mismo que `scopes.ts` ya tenía escrito para separar `payments:read` de
`payments:authorize`: un panel que solo le muestra a alguien por qué una compra
se rechazaría no tiene por qué cargar con el poder de gastarle la plata. Y al
revés: una key que puede gastar no queda habilitada a preguntar sin que alguien
se lo conceda.

**Consecuencia operativa:** la key de partner que ya existe en producción **no
tiene** este scope, porque se emitió antes. La ruta le responde `403
ScopeNotGranted` hasta que se emita una key nueva. `pnpm run partner:create` ya
otorga todos los scopes por defecto, así que una key nueva lo trae sola.

#### Que no pueda gastar es un tipo, no una regla

`LocalPolicyRail` se refactorizó en dos piezas: `decide()`, que contiene todos
los chequeos y recibe **solo la mitad de lectura** del ledger
(`Pick<LockedSpendLedger, "spentOn" | "hasRecorded">`), y `authorise()`, que
llama a `decide()` y **después** registra. `preview()` llama al mismo
`decide()`. No podría registrar un gasto aunque alguien agregara la línea: es
un error de compilación, no una disciplina que recordar. Y las dos llegan al
mismo veredicto por el mismo código — una segunda implementación de "¿esto se
permitiría?" sería una segunda cosa que mantener en sincronía con
`checkMandate`.

Por el mismo motivo se extrajo `resolveTenantPurchaseContext` en
`apps/web`: dos copias de "qué Mandato aplica a este producto" es exactamente
la forma que tuvo `B-25`, y una previa que resolviera otro Mandato que la
compra sería peor que no tener previa — sería segura y equivocada.

#### Fuera de la sección crítica, a propósito

`preview` **no** toma el lock del tenant. Solo lee, y una previa
explícitamente no es una promesa: para cuando alguien actúe sobre ella, otra
compra del mismo agente puede haberse llevado el cupo que vio. Tomar el lock
para decir eso haría que el panel de un partner se encolara detrás de —y
frenara— las compras que sí mueven dinero.

#### Los dos límites, dichos en el payload

- **`reconciled` es `z.literal(false)`**, no un booleano. Una previa no pide la
  factura 402, así que no compara precio, asset ni `payTo` contra el Mandato
  firmado — la misma distinción que `M-14` ya hace. La compra real sí lo hace y
  puede rechazar ahí después de que la previa dijo que sí. Que el esquema no
  **pueda** decir `true` es la forma de que nadie lo prometa por error.
- **`would_settle`**, en condicional y no `allowed`, para que el campo mismo
  siga recordando que no se reservó nada.

**Una previa no se registra como compra**, ni en el directorio ni en el vault
(`withVault` la reenvía sin anotar). El vault es el registro de decisiones que
ocurrieron; llenarlo de hipotéticas dejaría "¿cuántas veces rechazaron a este
agente?" sin respuesta.

**En el SDK:** `previewPurchase` existe; `createPurchase` sigue sin existir, y
eso no cambió acá. El SDK cubre la mitad segura y la que falta sigue anotada
como pendiente, no como una postura de que un partner solo deba previsualizar.

**Alternativa descartada:** aceptar `route_params`. Rellenan la URL paga del
comercio y una previa nunca construye una. Un `route_params` mal armado hace
fallar la compra real con `RouteParamMissing` y la previa no lo va a anticipar
— queda dicho acá y en la guía, en vez de fingir que sí.

`AGENTS.md` sin cambios: autorización y contrato de `/v1` ya quedan en Claude
Code (`P-10`).

---

### C-126 · T94: los webhooks salen de verdad, con outbox en el mismo statement y una política de URL propia · `Vigente`
**Fecha:** 2026-09-20 · **Hito:** T94 · **Pedido por el usuario** (tercera de las tres propuestas aprobadas)

**El hueco.** `@agentpey/webhooks` (T48, Codex PR #8) sabía firmar y entregar un
evento desde el día que se escribió, y **nunca lo llamó nadie**: ningún
`package.json` de `apps/` ni de `packages/` lo declaraba como dependencia.
`webhooks.ts` tenía siete nombres de evento congelados y la firma HMAC. No
había dónde registrar una URL ni nada que creara un evento. Un partner que
quería saber que el principal firmó, o que una compra liquidó, solo podía hacer
polling.

#### El outbox va en el mismo statement, no en una transacción

`directory_webhook_deliveries` se escribe **dentro del mismo `insert`/`update`**
que el cambio que describe, con un CTE (`with inserted as (...) insert into
directory_webhook_deliveries select ... from inserted`). Postgres corre un
statement solo de forma atómica, así que:

- un evento no puede existir para un cambio que no se confirmó, y
- un cambio no puede confirmarse sin su evento.

**Alternativa descartada: envolver los tres métodos en una transacción.** El
directorio nunca tuvo plumbing de transacciones —cada método es un `pool.query`
suelto— y agregarlo para esto habría sido maquinaria nueva en el camino que
escribe Mandatos y compras. El CTE da la misma garantía sin tocar esa forma.

**Un beneficio que salió gratis:** el `revoked_at is null` de `revokeMandate`
ya hacía idempotente la revocación, y como el evento se abre desde la fila
*actualizada*, una segunda revocación no actualiza nada y por lo tanto no encola
un segundo evento. No hubo que escribir nada para eso.

**Una fila por (evento, endpoint), no por evento.** El endpoint roto de un
partner no puede frenar la entrega a otro suyo, y cada destino lleva su propia
cuenta de intentos y su propio backoff. La clave es `<event id>:<endpoint id>`,
única por construcción: un duplicado sería una violación de clave primaria en
vez de una segunda entrega. Y como el `select` recorre los endpoints
suscriptos, un partner sin ninguno no inserta nada — el outbox solo tiene
trabajo con destino.

#### Los eventos son delgados, a propósito

Un evento lleva los ids de lo que cambió y nada más; el partner lee el recurso
por `/v1` con su propia key. Dos motivos, en ese orden de peso:

1. **Una entrega que se desvía filtra identificadores y nada más** — nunca los
   términos de un Mandato ni la URL de una entrega. Un evento delgado no puede
   revelar más de lo que ese partner ya puede consultar.
2. Lo que el partner lee es el recurso **actual**, no lo que era cierto cuando
   el evento se encoló.

#### Solo se suscribe a lo que algo emite

T45 congeló siete nombres. Cuatro tienen ahora exactamente una escritura que
los dispara. `DELIVERABLE_WEBHOOK_EVENT_TYPES` es ese subconjunto, y el esquema
de registro valida contra él: pedir `mandate.expiring` da `400`. Es la misma
regla que `scopes.ts` ya aplicaba a los permisos — una suscripción que nunca
puede dispararse es peor que ninguna, porque parece cableada, y alguien
construiría un recordatorio de renovación sobre un mensaje que este sistema no
tiene código para mandar.

`payment.authorized` queda afuera por un motivo distinto y más interesante: el
momento que describiría es real (`PolicyRail.authorise` concediendo), pero pasa
a mitad de la compra, antes de reconciliar la factura del comercio — anunciaría
compras que después se rechazan en el 402. Queda sin poder suscribirse hasta
que haya un motivo para quererlo, en vez de cablearse a la línea más plausible.

#### La política de URL: la primera vez que un tercero elige el destino

Hasta ahora, cada pedido saliente iba a una dirección que **AgentPey** eligió:
un RPC de Stellar, un venue de `venues.json`. Un webhook invierte eso, y
apuntado hacia adentro es SSRF — con blancos que el despliegue alcanza y la
internet no: `169.254.169.254` (metadata de la nube), los procesos hermanos en
`127.0.0.1` que arranca el gateway (`C-114`), el host de Postgres.

`webhook-url.ts` es lista blanca de forma y lista negra de destino: solo
`https`, sin credenciales, sin puerto propio, un host y no una IP literal. **Y
se chequea dos veces, siendo la segunda la que cuenta:** el registro revisa lo
que se ve en el string, y **cada entrega vuelve a resolver el host** y rechaza
si las direcciones que contesta caen en rangos que la internet pública no
rutea. Un chequeo solo al registrar lo derrota un nombre que hoy resuelve a
`1.2.3.4` y a `127.0.0.1` cuando el evento sale — el host es del partner y lo
reapunta cuando quiere.

**Lo que esto no cierra, dicho en voz alta:** entre la resolución y la conexión
que hace `fetch`, el nombre puede resolverse otra vez y contestar distinto —
DNS rebinding clásico. Cerrarlo requiere fijar la conexión a la dirección
chequeada, que el `fetch` de Node no expone. Lo que **sí** está mitigado es la
versión barata del mismo ataque: `redirect: "error"` en la entrega, así que
contestar desde una dirección pública y después redirigir a la metadata no
funciona. Un nombre que pasó a resolver hacia adentro se trata como permanente,
no como falla transitoria: reintentarlo dos horas serían dos horas de este
proceso sondeando su propia red.

#### El secreto se guarda en claro, y eso es forzado

`directory_api_keys` guarda un hash porque una API key solo se **compara**. Un
secreto de webhook se usa para **firmar** cada entrega, así que este proceso
tiene que poder leerlo. La consecuencia queda escrita en el propio esquema:
cualquier cosa que pueda leer esa tabla puede falsificar un webhook a ese
partner. Es inherente a los webhooks con HMAC, no algo que este diseño pudiera
evitar. Viaja una sola vez, en la respuesta que lo crea; todo `GET` posterior
lo devuelve en `null`.

#### Dos permisos, no uno

`webhooks:write` y `webhooks:read`, separados. Registrar un endpoint es lo
único que un partner puede hacer que apunte la red de **este** proceso a algún
lado; listar endpoints es inofensivo. Juntarlos significaría que una key que
solo necesita mostrar la configuración carga con ese poder.

**Consecuencia operativa, igual que en T93:** la key de partner que ya existe
en producción no tiene ninguno de los dos, así que la ruta le responde `403`
hasta que se emita una nueva.

#### El drenaje

Un barrido cada 30 segundos, no cada 15 minutos como el de retención (`T70`):
un webhook que llega un cuarto de hora después de la compra que describe no es
un webhook, es un polling lento. `claimDueWebhookDeliveries` reclama y lee en
un solo statement con `for update skip locked` y arrienda cada fila dos
minutos, así que dos instancias de Render drenan la misma tabla sin que ninguna
sepa de la otra, y una caída a mitad de entrega cuesta un ciclo de reintento en
vez de una fila trabada.

**Un intento por pasada**, no los cinco que `deliverWebhook` sabe hacer: esos
reintentos viven en memoria y bloquean, así que un reinicio los pierde y cinco
endpoints lentos se frenan entre sí. El estado de reintento vive en la fila.
Para eso `deliverWebhook` ganó `retryable`: con un intento por pasada, el
llamador necesita saber si el fallo fue un `4xx` (el endpoint leyó y dijo que
no) o un `5xx`/timeout (vale otra pasada). Backoff de 1, 3, 9, 27, 81 y 135
minutos, hasta seis intentos.

**`gave_up_at` en vez de borrar la fila:** "lo intentamos y paramos" es un hecho
distinto de "nunca pasó nada", y un operador que investiga por qué un partner
no se enteró de una compra necesita poder distinguirlos.

`AGENTS.md` sin cambios: sigue siendo autorización y contrato de `/v1`, que ya
quedan en Claude Code (`P-10`).

---

### C-127 · T95: `/v1` cuenta los pedidos por API key, y el nivel sale del permiso · `Vigente`
**Fecha:** 2026-09-20 · **Hito:** T95 · **Decidido por el usuario:** los números (120/min y 10/min) y la política de falla (cerrado en las costosas, abierto en el resto)

**El hueco.** `perDay` limita lo que un Mandato puede gastar. Nada limitaba
cuántas veces un partner podía *pedir*. Un bucle en la integración de un tercero
llamando a `POST /v1/purchases` habría gastado el USDC de testnet del rail
compartido, una transacción de Stellar por vez, en una sola instancia Starter,
hasta que algo se acabara. Y desde T94 hay una ruta que hace que este proceso se
conecte hacia afuera.

#### Dentro de la autenticación, para que no se pueda esquivar

El contador vive en `authorizeRequest`, después de autenticar y de chequear el
permiso, y entra como un puerto inyectado igual que `authenticate`. En
`apps/web`, las 14 rutas de `/v1` pasan por un único helper `authorize()` que
siempre lo pasa, así que **no hay ruta que autentique sin ser contada**: una
nueva escrita copiando cualquiera de las existentes hereda el límite. Un test
recorre las 14 y falla si alguna no se cuenta.

**El orden importa, en dos sentidos:**
- *Después* del chequeo de permiso: un pedido que la key no tiene permitido
  recibe `403` y **no se cuenta**, así que un partner corrigiendo un error de
  permisos no quema presupuesto encontrándolo.
- *Después* de autenticar, necesariamente: el conteo es por key, y una key
  desconocida no tiene id contra el cual contar.

#### El nivel sale del permiso, no de una lista de rutas

Las rutas que exigen `payments:authorize`, `consent_sessions:write` o
`webhooks:write` —las que gastan, crean una invitación firmable, o apuntan la
red de este proceso a algún lado— van al balde apretado (10/min). El resto, al
general (120/min). Derivarlo del permiso significa que una ruta agregada después
no puede quedar en el nivel equivocado porque alguien se olvidó de listarla: su
nivel es lo que diga el permiso que ya tiene que nombrar. `payments:preview`
(T93) queda en el general, porque no gasta nada.

#### Ventana fija en Postgres, con un solo upsert

`insert ... on conflict do update set count = count + 1 returning count` sobre la
clave primaria `(api_key_id, tier, window_start)`. Postgres serializa las dos
ramas en la clave, así que dos procesos contando a la vez obtienen números
distintos y correctos — sin lock consultivo y sin el hueco de leer-y-escribir
donde `perDay` se excedió en F8 (T64).

**El costo de la ventana fija, dicho:** justo en el borde entre dos minutos, una
key puede gastar los dos presupuestos seguidos, así que una ráfaga de hasta el
doble puede entrar en poco tiempo. Para un freno contra abuso en un piloto
alcanza; no es un medidor preciso.

**Alternativa descartada: token bucket.** Más suave, y necesita más estado por
key y una lectura del último relleno — más código en el camino de cada pedido,
para una precisión que este uso no pide.

**Sin clave foránea a `directory_api_keys`, a propósito:** la tabla se escribe
en cada pedido autenticado y no la lee nadie más que su propio upsert, y una key
revocada a mitad de la ventana no debe convertir su próximo pedido en una
violación de restricción en vez del `401` que le corresponde.

#### Cuando el contador mismo falla

Decidido por el usuario: **cerrado en las rutas costosas, abierto en el resto.**
Una compra no pasa sin contarse, porque es la ruta que mueve plata
(`RateLimiterUnavailable`, `503` — condición temporal nuestra, que el cliente
debería reintentar, no un error de su pedido). Una lectura sí pasa: un limitador
roto no debería tumbar todo `/v1`. En la práctica casi nunca pasa sola, porque
el contador vive en la misma base que `authenticate` acaba de leer; pero "casi
nunca" no es una política.

#### La respuesta

`429 RateLimited` con `Retry-After` y `RateLimit-Limit`/`-Remaining`/`-Reset`
**solo en el `429`**, no en cada respuesta. Emitirlos siempre habría obligado a
sacar el conteo de `authorizeRequest` a través de cada handler; el encabezado
que un cliente necesita para frenar bien es `Retry-After`, y llega justo cuando
hace falta. `Retry-After` nunca es `0`: se redondea para arriba, para no invitar
a reintentar dentro de la misma ventana.

**RealOps**, el único partner real, traduce un `429` en la compra a una frase que
dice **que no se compró nada** y cuándo volver a pedirlo. Es seguro decirlo —a
diferencia del timeout de `C-107`— porque el conteo pasa antes de cualquier otra
cosa: un `429` significa que la compra nunca se intentó.

**Limpieza:** las ventanas de más de una hora entran al barrido de retención de
T70. Una hora y no un minuto, para que un reloj que se desfasa entre instancias
nunca barra una ventana en la que alguien todavía está contando.

#### Fuera de este hito, nombrado

**Limitar por IP los pedidos *sin* autenticar.** Una avalancha de keys inválidas
igual le pega a la base en cada `authenticate`. Detrás del proxy de Render, la
IP llega en `X-Forwarded-For`, que se puede falsificar si no se confía
exactamente en el salto correcto — es un problema propio, no un agregado a
este.

`AGENTS.md` sin cambios: contrato de `/v1` y superficie de seguridad (`P-10`).

---

### C-128 · T96: comprar del bazaar es un agente nuevo con su propio Mandato, no un permiso ampliado · `Vigente`
**Fecha:** 2026-09-22 · **Hito:** T96 · **Decidido por el usuario:** que sea un agente nuevo; que el mandato liste los product ids uno por uno; que los `route_params` sean de RealOps y no vayan firmados; el nombre `bazaar_shopper`; y que la pantalla marque con un preflight lo que el comercio no está cobrando

**El muro.** Un agente contratado en `realops.agentpey.com` sólo podía comprar
las dos cosas de SignalDesk, y la causa no era la interfaz: era el grant.
`PILOT_VENUE_ID` cableaba RealOps a un solo comercio, `translatePermissions`
firmaba `venues: [targets.venueId]` con ese único venue, y la compra mandaba
`venue: config.targets.venueId`. Aunque la página hubiera mostrado más
productos, AgentPey los habría rechazado — **y habría hecho bien**. El muro
estaba en el lugar correcto; lo que estaba mal era que fuera invisible.

#### Un agente nuevo, y ningún Mandato firmado se toca

El bazaar entra como un `agentKind` propio, `bazaar_shopper`, con su propio
grant y su propia firma. **No se re-firma nada.** La alternativa —ampliar el
mandato existente para que nombrara los dos comercios— se descartó por dos
razones: obligaría a re-firmar permisos que ya están en cadena, y borraría
justamente lo que el piloto quiere mostrar, que son dos agentes con dos poderes
distintos y visiblemente distintos.

Por eso `PilotTargets` dejó de ser un registro plano (un venue, un asset, una
cuenta de cobro, y sólo los productos variando) y pasó a ser **una fila por
`agentKind`**: venue, asset, cuentas de cobro y productos, cada uno el suyo.
Esa forma vieja era la causa estructural del muro.

#### Los product ids van uno por uno, y eso es lo que hace la pantalla

`checkMandate` salta el chequeo de producto cuando el grant no trae `products`
(paso 5, herencia de `M-14`), así que omitirlo habría dado permiso por venue
entero. Se eligió listarlos: `["swap-risk-quote", "ai-video-scriptwriter"]`,
comparados byte a byte.

**Lo que se pierde, dicho:** un recurso que el bazaar publique mañana no es
comprable hasta firmar un permiso nuevo. Eso es deliberado. Es exactamente lo
que la pantalla de catálogo tiene para mostrar — la tarjeta sale marcada *fuera
del permiso* y al abrirla aparece el objeto literal que habría que firmar, con
la misma marca de quién hace cumplir cada control que usa la pantalla de
revisión. Un permiso por venue habría dejado a esa pantalla sin nada que decir.

**Alternativa descartada:** listar sólo `swap-risk-quote`, el único que hoy
funciona. Se descartó porque el diff que la pantalla ofrece firmar prometería
algo que, firmado, igual fallaría en el 402.

#### Los `route_params` son de RealOps, sin firmar, y por qué eso no abre un hueco

El par, el monto, el tono y la duración viajan como `route_params` y **no van en
el mandato**. La pregunta que había que contestar antes era si un `amount` en
los parámetros puede convertirse en el monto del pago. **No puede, y se
verificó contra el 402 real**, no por lectura: el mismo recurso del bazaar
cotiza `10000` stroops (0,001 USDC) con `amount=100` y con `amount=999999`. El
parámetro queda atado a la factura por `inputHash`, pero el precio lo fija el
comercio. El monto que se paga sale del 402 del propio comercio y lo vuelve a
comparar `reconcileTerms` contra el `perTx` firmado.

Los parámetros eligen **qué te entregan**, no **cuánto se paga**: caen a la
izquierda de la frontera de `PILOTO-F9.md` § 4.1, donde equivocarse no cuesta
plata. Lo peor que puede hacer un parámetro equivocado es comprar la cosa
equivocada, dentro de límites que alguien firmó.

Aun así el formulario no es un túnel: un parámetro que el comercio no declaró se
descarta en vez de reenviarse, y los que RealOps se reserva —el `account` de la
ruta de créditos, que es la referencia opaca del tenant— se escriben **después**
de los del formulario, así que un navegador no puede acreditarle a otra persona.

**Alternativa descartada:** firmar los valores admitidos en el grant. Cerraría
del todo la puerta, pero convertiría el mandato en una lista de combinaciones
—un par, un tono, una duración— y obligaría a re-firmar por cada consulta nueva.

#### El asset id: verificado contra el 402, no copiado de `venues.json`

`bazaar.ts` advierte que el asset id del bazaar no es el mismo objeto que el del
mock aunque sea el mismo activo, y tiene razón — pero contrasta el bazaar con el
**mock**, cuyo USDC es un issuer clásico `G…`. Contra SignalDesk no hay
divergencia. El 402 vivo del bazaar nombra
`CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA`, el mismo SAC que
`venues.json` ya le da a las dos filas. `ids.ts` compara byte a byte, así que
esto se verificó antes de que entrara a un grant que alguien firma.

Lo que sí cambia es `payTo`: el bazaar **no es un solo vendedor**. Cada recurso
cobra a su propia cuenta (`GDVR2KDK…RMCQ` y `GBYXQUSY…62LB`), y ninguna es la
dirección del venue. Por eso `PilotTarget.payTo` es una lista y no una cuenta:
con T91 (`C-123`) `payTo` es obligatorio al crear un consentimiento por `/v1`, y
una lista incompleta o equivocada dejaría al comercio redirigir el dinero.

#### El preflight, y el error que encontró la propia pantalla

Un recurso listado no es un recurso que el comercio esté cobrando:
`ai-video-scriptwriter` anuncia `/api/script`, que responde **404** en los dos
hosts del bazaar. Así que la tarjeta se marca, con un pedido de lectura que no
paga nada.

La primera versión del preflight **llenaba los parámetros de la ruta con valores
inventados**, y el bazaar contestó `400 INVALID_QUOTE_INPUT`: valida antes de
cotizar. Resultado — una tienda abierta se veía cerrada, justo en la pantalla
construida para distinguir esas dos cosas. Lo encontró la pantalla misma, no un
test. La corrección no fue adivinar mejores valores (adivinar por la persona qué
quiere comprar es lo único que este piloto no hace) sino **preguntar por la ruta
pelada, sin llenar un solo parámetro**: `/api/x402/swap-risk` responde `400`
(la sirve, validando) y `/api/script` responde `404` (no la sirve). Un `5xx` o
un fallo de red es `unknown`, que no es lo mismo que una negativa y la pantalla
lo dice distinto.

#### El vocabulario se amplió, y una frase que antes se aceptaba ahora se rechaza

`interpretInstruction` pasó de dos familias a un diccionario cerrado de cuatro
productos, y sigue devolviendo `InstructionNotRecognised` ante lo que no
reconoce o ante una frase que nombra más de uno.

**Un cambio de conducta que hay que decir en voz alta:** `ia` y `ai` sueltos ya
no significan créditos. El bazaar vende un scriptwriter de video **con IA**, así
que un `ai` pelado nombra dos productos, y nombrar dos es no nombrar ninguno.
"compra IA" ahora vuelve como `no_product`. Es un estrechamiento deliberado —
rechazar en vez de adivinar entre dos comercios— y ninguna frase de las que los
tests ya cubrían dejó de funcionar, porque todas dicen créditos, credits o pack.

#### Lo que la pantalla tiene prohibido afirmar

El contraste de cada tarjeta sale de lo que **RealOps mismo propuso y vio
firmar** (`translatePermissions`, la misma función pura que dibuja la pantalla
de revisión, para que no puedan divergir). No es una segunda opinión sobre
autorización y la copia lo dice: AgentPey decide en el momento de la compra,
contra el Mandato, y sigue rechazando un permiso vencido o revocado, un límite
diario ya gastado, o una factura que no cuadra. *Dentro del permiso* significa
que el permiso firmado nombra ese comercio y ese producto, y nada más que eso.

**Pendiente anotado, sin construir:** `POST /v1/purchases/preview` (T93,
`C-125`) contestaría esa pregunta mejor, porque la contestaría AgentPey y no
RealOps. No se usó todavía porque exige una API key con `payments:preview`, que
aún no se emitió (es del usuario, `P-10`), y porque consumiría cupo de tasa por
cada tarjeta dibujada.

---

### C-129 · T97: rotar la clave de `/v1` es emitir otra para el mismo partner, nunca crear un partner nuevo · `Vigente`
**Fecha:** 2026-09-22 · **Hito:** T97 · La forma, de Claude Code; correr el script y cargar el secreto queda del usuario (`P-10`)

**El problema.** T93, T94 y T95 agregaron tres permisos a la lista congelada
(`payments:preview`, `webhooks:read`, `webhooks:write`). La lista es **plana a
propósito**: `payments:authorize` no implica `payments:preview` (`C-125`). La
clave que RealOps usa en producción se emitió el 2026-09-13, antes de que esos
permisos existieran, así que tiene 9 de 12 y recibe `403` en las rutas nuevas.
El código está mergeado y probado; nadie lo puede llamar.

**La trampa que había que nombrar.** La bitácora venía diciendo "hace falta una
API key nueva; `pnpm run partner:create` ya otorga todos los scopes". Eso es
cierto y a la vez peligroso: `partner:create` **crea un partner nuevo**, y los
tenants están namespaceados por partner — el id se deriva de él
(`newTenantId(partnerId)`). Apuntar RealOps a la clave de un partner nuevo
dejaría a cada cuenta existente sin su tenant, sin sus agentes y sin sus
Mandatos firmados: seguirían en cadena y en el vault, bajo el partner viejo,
invisibles para la aplicación. En un piloto que se muestra a gente, eso no es
un detalle operativo, es perder la demo.

**La decisión.** Un script aparte, `pnpm run partner:key`, que emite una clave
para el partner **que ya existe**. `issueApiKey` siempre aceptó un `partnerId`;
lo que faltaba era exponerlo sin obligar a crear un partner primero.

#### Tres modos, y por qué el primero es el que más sirve

- **Sin argumentos: diagnóstico.** Lee la clave de `.env.local`, la autentica
  con el mismo `authenticate` de tiempo constante que usa `/v1`, y dice a qué
  partner pertenece, qué permisos tiene, cuáles le faltan y qué ruta desbloquea
  cada uno. Es la respuesta a "¿por qué no me anda esto?", que es la pregunta
  que se hace de verdad.
- **`--issue`:** emite la clave nueva para ese mismo partner.
- **`--revoke apk_… --yes`:** revoca una vieja, después.

#### El partner se descubre desde la clave desplegada, no se pregunta

No hay `listPartners()` en el `Directory` y este hito no lo agrega. No hace
falta: un operador sabe qué está desplegado, no qué es un `ptn_…`, y la clave
desplegada es la respuesta autoritativa a "qué partner es esta instalación".
El secreto se lee de `.env.local` y **nunca se imprime**; se usa sólo para
resolver el `partnerId`. Tampoco se toma por argumento, para que no quede en el
historial del shell.

#### Emitir y revocar son dos comandos a propósito

Entre uno y otro hay que desplegar y verificar. Un script que revocara la clave
vieja al emitir la nueva dejaría producción caída durante todo el despliegue,
cada vez. El solapamiento **es** la rotación, no un descuido.

Revocar es lo único destructivo acá, así que: exige `--yes`, exige el id
explícito, y **rechaza revocar la clave que está en `.env.local`** — revocar la
credencial que esta instalación está usando nunca es la intención, y un error de
tipeo que lo hiciera tumbaría producción.

**Alternativa descartada:** agregar los permisos que faltan a la clave
existente, en vez de emitir otra. Se descartó porque los permisos de una clave
emitida son parte de lo que se autenticó: mutarlos en la base cambia
retroactivamente lo que una credencial ya entregada puede hacer, sin que quede
rastro de cuándo ni de qué tenía antes. Emitir y revocar deja las dos filas.

**Sigue siendo del usuario (`P-10`):** correr el script contra la base de
producción, guardar el secreto —se imprime una sola vez— y cargarlo en Render.
Claude Code construye el mecanismo; las llaves son del usuario. Si Claude Code
pudiera emitirse credenciales de producción solo, "RealOps pide, AgentPey
decide" sería una frase y no una propiedad.

---

### C-130 · Vitrinee es cómo un comercio real se suma a AgentPey: entra como venue de `F7`, y la compatibilidad la pone Vitrinee · `Pendiente`
**Fecha:** 2026-09-23 · **Hito:** T98 (decisión); la integración, desde T99 · Del usuario la dirección; de Claude Code la forma

**El papel.** AgentPey es el **comprador** con reglas: identidad, Mandato,
`policy_rail`, vault. Hasta hoy compraba en comercios x402 de servicios digitales
(el bazaar del embajador, SignalDesk). Vitrinee, fusionada en `P-12`, es la
**puerta del vendedor**: convierte una tienda de e-commerce real (Jumpseller hoy)
en un comercio x402 con catálogo legible por máquina, pedido real en la
plataforma y recibo firmado y anclado. Juntas, una compra de un agente de
AgentPey deja **evidencia de los dos lados**: el vault prueba que el comprador
estaba autorizado, y el recibo de Vitrinee prueba que el vendedor vendió.

**La frase correcta, porque la intuitiva está mal.** La API de partners `/v1`
es del lado comprador (`tenants`, `agents`, `mandates`, `consent-sessions`,
`purchases`): un partner es una empresa cuyos usuarios tienen agentes. **Una
tienda no se conecta por `/v1`.** Lo que se demuestra es:

> Una tienda Jumpseller real se vuelve comprable por agentes **sin código de
> ningún lado**: la tienda solo le entrega sus credenciales de API a Vitrinee,
> y AgentPey la agrega como comercio con una fila en `venues.json` (`F7`, sin
> tocar ningún `.ts`). Un partner llama a `POST /v1/purchases` y el agente
> compra un producto físico de verdad.

Así quedan demostradas las dos promesas de "sin código propio" a la vez: la del
partner, que se integra por API, y la del comercio, que se agrega por
configuración.

**Por qué la compatibilidad va del lado de Vitrinee.** Hoy el comprador de
AgentPey **no puede** pagarle a Vitrinee. Hay tres incompatibilidades,
verificadas leyendo el código de los dos lados:

1. **Discovery.** `apps/agent/src/catalog/x402-catalog.ts` lee
   `GET /api/discovery/search` en formato `ServiceCard` del stellar-bazaar.
   Vitrinee expone `/discovery/resources` en el formato de `@x402/extensions`
   (`VT-17`).
2. **Método.** `requestPaymentChallenge` (`apps/agent/src/payment/x402.ts`) pide
   el 402 con un `GET` sin body. El checkout de Vitrinee es `POST` con JSON.
3. **Pagador `C…`.** AgentPey paga desde un `policy_rail`, una cuenta contrato.
   El recibo de Vitrinee valida `payerAccount` solo como `G…`
   (`packages/vitrinee-core/src/receipt.ts`). El pago se liquidaría y **después**
   fallaría la firma del recibo: el peor momento posible para fallar.

Arreglarlas en AgentPey rompería la promesa de `F7` para este comercio: habría
que escribir un adaptador de catálogo y un camino de pago nuevos. Arreglarlas en
Vitrinee la mantiene, y además le sirven a cualquier cliente x402: un checkout
por `GET` es lo que usan casi todos los ejemplos de x402, y aceptar un pagador
`C…` le sirve a cualquier smart account.

**La dirección de despacho.** Un pedido físico la necesita y el comprador de
AgentPey compraba servicios digitales. El camino ya existe: el `ServiceCard`
declara sus `input`, RealOps arma con ellos un formulario por producto y los
manda como `route_params` (T96). Vitrinee tiene que declarar `quantity`, nombre,
dirección, ciudad y región como `input` de su `ServiceCard`.

**Plan, un hito cada uno, parando al cierre de cada uno (regla 1):**

- **T99** · Compatibilidad en Vitrinee: `/api/discovery/search` en formato
  `ServiceCard` con sus `input`, checkout también por `GET` con `route_params`, y
  pagador `C…` aceptado de punta a punta. Antes de escribir código, probar contra
  el facilitator que un settlement desde un `policy_rail` a Vitrinee funciona.
- **T100** · Vitrinee como venue: fila en `venues.json` con
  `scripts/register-venue.ts`, y un `agentKind` en RealOps con su grant (venue,
  productos, `payTo` del merchant). Toca la forma del grant firmado: se queda en
  Claude Code (`P-10`, precedente `B-25`).
- **T101** · Compra real de punta a punta desde `POST /v1/purchases` hasta el
  panel de Jumpseller. Dependía de que el usuario pagara el plan de Jumpseller
  (`VT-21`). **Pagado el 2026-09-23** (plan `basic`, `subscribed`); verificado
  que `POST /orders.json` ya no responde `403` sino que valida el pedido.
- **T102** · Deploy de Vitrinee desde el `render.yaml` de AgentPey, y recién
  entonces archivar el repo viejo (`P-12`). Ojo: las apps del piloto corren en
  **un solo** servicio de Render con un único juego de secretos, y
  `apps/gateway/src/hosts.ts` (`envKeys`) y `env-filter.ts` deciden qué claves
  recibe cada una (`C-88`, `C-114`). La llave de firma de recibos de Vitrinee no
  puede quedar al alcance de otra app, ni al revés. Decidir si Vitrinee entra a
  ese servicio o va en uno propio es parte del hito.

**Avance, 2026-09-23 (T99, sin mergear).** Las tres incompatibilidades quedaron
resueltas del lado de Vitrinee, sin tocar AgentPey (`VT-22`, `VT-23`,
`VT-24`), y el settlement desde un `policy_rail` se probó contra el facilitator
antes de escribir código. Apareció un **cuarto** punto de quiebre que esta
decisión no listaba: el check de settlement de la verificación del recibo, que
no reconocía el débito de una cuenta contrato en Horizon. Quedaron tres puntos
abiertos para el usuario, anotados en la bitácora (bloque T99): la dirección de
despacho en la URL llegaba al facilitator (resuelto el mismo día con `VT-25`,
a pedido del usuario), el crédito de un rail de tenant no alcanza para los
precios reales, y `quantity` viaja dos veces. El plan de esta decisión no
cambia.

**Ajuste, 2026-09-23 (T100).** El deploy vivo de Vitrinee
(`vitrinee-gateway.onrender.com`) sale del repo viejo y no tiene la
compatibilidad de T99, así que la compra real de T101 no puede hacerse contra
él. El orden pasa a **T100 → T102 → T101**, y archivar el repo viejo se vuelve
un ticket aparte, bloqueado por T101. Dónde se despliega y en qué URL quedó
decidido en `C-134`. El resto del plan no cambia.

**Alternativa descartada: presentar Vitrinee y AgentPey como dos proyectos.** El
formulario del hackathon pide un solo repo. Además, cada mitad sola cuenta media
historia: AgentPey sin comercio real compra servicios de prueba, y Vitrinee sin
AgentPey vende a un script de 40 líneas sin reglas de gasto.

---

### C-131 · El crédito patrocinado por tenant sube de 1 a 3 USDC · `Vigente`
**Fecha:** 2026-09-23 · **Hito:** después de T99 · **Pedido por el usuario**

`SPONSORED_FUNDING_PER_TENANT` pasa de `1.0000000` a `3.0000000`
(`packages/activity/src/index.ts`). Es lo único que cambia de `C-80`: el tope
de 20 tenants, la alerta con 5 de margen, los precios de SignalDesk y los
límites grabados en el rail siguen igual.

**Motivo.** T99 mostró que el producto más barato de la tienda Jumpseller real
cuesta 1,0421053 USDC (990 CLP a 950), más que el crédito entero de un
tenant. El usuario pidió más holgura. 3 USDC alcanza para dos packs de stickers
con margen.

**Por qué 3 y no más.** La reserva tenía 30,484 USDC y ya había patrocinado 13
de 20 rails el 2026-09-23. Los 7 cupos que quedan a 3 USDC son 21 USDC: caben en
el saldo actual sin refondear. Lo que sobra en un rail no vuelve (`C-61`), así
que cada USDC de más por tenant es drenaje real de la reserva.

**Qué no cambia sola.** Un rail ya desplegado conserva lo que recibió. Y el
crédito **no alcanza para comprarle a Vitrinee mientras el rail tenga
`perTx` 0,30**: el contrato rechaza cualquier pago mayor, tenga el saldo que
tenga. Eso queda propuesto al usuario, no decidido (bitácora, bloque T99).

**Alternativa descartada:** 5 USDC. Más holgura, pero 7 × 5 = 35 USDC supera la
reserva de hoy, y el precheck de `tenant-rail.ts` empezaría a negar patrocinio
antes del tope.

---

### C-132 · La `quantity` de la ruta es la de la compra: AgentPey la completa, y rechaza una distinta · `Vigente`
**Fecha:** 2026-09-23 · **Hito:** después de T99 · Recomendación de Claude Code, aceptada por el usuario

Cuando la ruta paga de un comercio declara un `input` llamado `quantity` (como
la de Vitrinee, `VT-24`), `executeTenantPurchase` lo llena con la `quantity`
de la compra, la que firma el intent (`withPurchaseQuantity` en
`apps/web/src/tenant-purchase.ts`). Si el que llama también manda
`route_params.quantity`, tiene que ser el mismo número; si no, la compra se
rechaza con el código nuevo **`RouteParamConflict`**, antes de pedirle nada al
comercio y devolviendo el gasto reservado. Una ruta sin `quantity` queda
exactamente como la mandó el que llama.

**Motivo.** La cantidad viajaba dos veces, y si diferían el comercio cotizaba
otro total y `reconcileTerms` rechazaba antes de firmar: sin perder plata, pero
con un error que no nombraba ninguno de los dos números. Arreglarlo en AgentPey
y no en RealOps lo cubre para cualquier partner que llame a
`POST /v1/purchases`, que es por donde compra T101.

**Por qué rechazar y no sobrescribir.** Quien escribió `quantity: 2` en la ruta
y `1` en la compra quería decir algo. Pagar una unidad mientras cree que compró
dos es justo la sorpresa que esto evita.

**Lo que queda para T100.** El formulario de RealOps arma un campo por cada
`input`, así que va a pedir `quantity` aparte, y hoy RealOps compra siempre 1
desde el catálogo. En T100, cuando se agregue el `agentKind` de Vitrinee, RealOps
tiene que tomar la cantidad de la compra de ese campo, o no mostrarlo. Hasta
entonces, un 2 en ese campo se rechaza con `RouteParamConflict`, y RealOps lo
explica en los dos idiomas.

**La vista previa no cambia.** No recibe `route_params` por decisión (`C-125`).

**Alternativa descartada:** que RealOps llene la de la ruta con la de la compra,
que era la primera recomendación en T99. Dejaba igual de expuesto a cualquier
partner que llame a la API directo.

---

### C-133 · Los límites grabados en cada rail de tenant suben a 3,00 por compra y 3,00 por día · `Superada` por `C-137` en los números (25,00/25,00); el razonamiento sigue
**Fecha:** 2026-09-23 · **Hito:** después de T99 · Opción (a) propuesta por Claude Code, elegida por el usuario

`PER_TX` y `PER_DAY` de `apps/web/src/tenant-rail.ts` pasan de `0.30`/`0.60`
(`C-80`) a `3.00`/`3.00`: los mismos 3 USDC del crédito patrocinado (`C-131`).
Se graban en el contrato al desplegar cada rail, así que solo valen para los
rails nuevos.

**Motivo.** Con `0.30` por compra, el contrato rechazaba cualquier pago a
Vitrinee, tuviera el rail el saldo que tuviera: el producto más barato de la
tienda real cuesta 1,0421053 USDC. Subir el crédito sin esto no servía.

**Por qué no se rompe lo que dependía de `0.60`.** `C-80` eligió esos números
para que el caso de aceptación 4 (una segunda compra del informe supera el tope
diario) se pudiera alcanzar en una sesión. Esa prueba no depende del contrato:
`scripts/f9-acceptance.ts` espera `ScopeDailyLimitExceeded` o
`MandateDailyLimitExceeded`, rechazos del permiso firmado que ocurren antes de
firmar nada, y RealOps propone `0.30`/`0.60` en el Mandato por defecto. El
Mandato sigue siendo el límite que decide; el contrato es el respaldo que
garantiza que, pase lo que pase fuera de la red, un rail no mueve más que su
crédito del día.

**El costo, dicho en voz alta.** Para un tenant de SignalDesk con el Mandato por
defecto, el respaldo en la red queda diez veces más holgado que su permiso. Si
el control del lado de AgentPey fallara (el tipo de bug de `B-25`), la red ya no
lo atajaría a los `0.30`, sino a los `3.00`.

**Qué no cambia.** Los rails que ya existen conservan `0.30`/`0.60` y 1 USDC.
La compra de T101 necesita un tenant creado después de este cambio.

**Alternativa descartada, para después:** que cada rail nazca con los límites
del Mandato de su agente. El respaldo sería exactamente lo que la persona
firmó, pero toca custodia, es más trabajo del que entra antes del 29, y un rail
no sigue a un Mandato nuevo: habría que desplegar otro. Queda anotada como la
forma correcta a largo plazo.

---

### C-134 · Vitrinee entra al servicio único de Render, en `vitrinee.agentpey.com`, y el deploy va antes que la compra real · `Vigente`
**Fecha:** 2026-09-23 · **Hito:** T100 (decisión; la fila de `venues.json` ya la usa), se ejecuta en T102 · Del usuario; la forma, de Claude Code

**Qué se decide.** Tres cosas que `C-130` dejaba abiertas para T102:

1. **Dónde corre Vitrinee.** Como cuarto proceso del servicio único de Render
   del piloto (`apps/gateway`, `C-88`, `C-114`), no en un servicio propio. Un
   `AppTarget` más en `hosts.ts`, con su lista de `envKeys`: la llave de firma
   de recibos (`MERCHANT_SIGNING_SECRET`) y la clave del facilitator llegan
   solo al proceso de Vitrinee, y a ese proceso no llega ninguna llave de
   AgentPey (`AGENT_SECRET_KEY`, `MASTER_MNEMONIC`, `ISSUER_SECRET_KEY`), igual
   que hoy con SignalDesk.
2. **En qué URL.** `https://vitrinee.agentpey.com`, un dominio más del
   servicio Starter que ya se paga. **Corrección del mismo día:** Render sí
   cobra. El workspace incluye 2 dominios personalizados, ya estaban usados, y
   cada adicional cuesta 0,25 USD al mes (visto en el panel del servicio,
   2026-09-23). El registro DNS en Vercel no tiene costo. El usuario aprobó el
   cargo y el dominio se agregó ese mismo día; Render lo verificó contra el
   CNAME `vitrinee` → `agentpey.onrender.com`. La fila `vitrinee` de
   `venues.json` ya la nombra (T100), porque un venue se resuelve por origen y
   la fila tiene que decir la URL definitiva.
3. **En qué orden.** T102 (el deploy) antes que T101 (la compra real). El
   deploy vivo de hoy sale del repo viejo, rama `day-3`, y no tiene T99:
   `/api/discovery/search` responde 404, así que el comprador de AgentPey no
   puede pagarle. Archivar el repo viejo pasa a un ticket propio, bloqueado
   por T101, porque no se apaga un deploy que funciona hasta que el nuevo probó
   la compra.

**Motivo.** El usuario prefirió `vitrinee.agentpey.com` "si se puede gratis con
el mismo servicio que pago". No es gratis del todo (0,25 USD al mes por el
dominio, ver arriba; se le preguntó al usuario antes de agregarlo), pero el
servicio Starter ya está caliente, que es lo que un video necesita; un servicio
`free` aparte, como el de hoy, se duerme a los 15 minutos y arranca en frío. Y
la separación de llaves que `C-130` exigía ya existe en este servicio por
construcción: `env-filter.ts` copia a cada hijo solo los nombres de su lista.

**Lo que se cede, dicho en voz alta.** Vitrinee comparte contenedor con
AgentPey: el aislamiento es por variables de entorno de cada proceso, no por
máquina. Es el mismo nivel que SignalDesk aceptó en `C-88`, y para un piloto en
testnet alcanza; un comercio real en producción querría su propio servicio. Y
los pedidos de Vitrinee viven en un archivo JSON (`ORDERS_FILE`) que en Render
es efímero: un redeploy los pierde, igual que hoy. Pasarlos a Postgres queda
anotado, no entra antes del 29.

**Alternativa descartada: mantener el servicio `vitrinee-gateway` propio y
apuntarlo a este repo, con `vitrinee.agentpey.com` como dominio.** Aísla por
máquina y no toca `hosts.ts`, pero en plan `free` arranca en frío, y en Starter
sería un segundo plan pago: justo lo que T86 eliminó. Y obliga a mantener dos
juegos de secretos en dos servicios.

**Otra alternativa descartada: hacer T101 con AgentPey y Vitrinee corriendo
local y un túnel público.** Probaría la compra pero no el deploy, y la fila de
`venues.json` tendría que nombrar la URL del túnel, que no es la del video.

---

### C-135 · El kind de Vitrinee en RealOps: seis productos, 3,00/3,00 por defecto, y la cantidad es la de la compra · `Vigente`; el default pasó a 25,00/25,00 con `C-137`
**Fecha:** 2026-09-23 · **Hito:** T100 · Recomendación de Claude Code, aceptada por el usuario

**Qué se decide.** RealOps ofrece un cuarto `agentKind`, `vitrinee_shopper`
("Comprador de la tienda"), cuyo grant nombra el venue `vitrinee:GC5ZY7…`, los
**seis** ids de Jumpseller de la tienda, uno por uno, y la cuenta de cobro del
comercio como único `payTo`. Tres detalles con motivo propio:

1. **Los seis productos, no un subconjunto.** El catálogo de RealOps muestra la
   tienda entera y marca cada tarjeta contra el permiso firmado; un producto
   fuera de todo target se descarta en vez de dibujarse como prohibido para
   siempre. Con los seis en el grant, todos se ven, y los que el rail no puede
   pagar (todo menos los stickers, con 3 USDC) los rechaza el Mandato en el
   momento de comprar, que es la demostración correcta: el permiso decide, no la
   pantalla.
2. **3,00/3,00 por defecto para este kind**, en vez de los 0,30/0,60 de los
   otros tres. El producto más barato cuesta 1,0421053 USDC; con 0,30 el
   permiso no cubriría nada. Y 3,00 es lo que cada rail de tenant nuevo recibe y
   tiene grabado (`C-131`, `C-133`): proponer más sería proponer un Mandato que
   el propio rail no puede honrar. Sigue siendo un punto de partida que la
   persona cambia antes de firmar. Los otros kinds no cambian.
3. **La cantidad se lee como la de la compra.** Vitrinee declara `quantity`
   como `input` de su ruta y `C-132` hizo que AgentPey lo llene con la cantidad
   firmada y rechace una copia distinta. RealOps toma el campo del formulario
   (entero de 1 a 20, 1 si se deja vacío) como `quantity` de la compra y **no**
   lo manda en `route_params`. Un solo número, en el lugar que se firma. Los
   otros cuatro campos (nombre, dirección, ciudad, región) viajan como
   `route_params`, de la persona, igual que los del bazaar.

**Qué no cambia.** Ningún Mandato ya firmado: hay un kind nuevo, no uno
modificado. El lector del catálogo es el mismo del bazaar
(`createBazaarCatalog`), porque Vitrinee publica el mismo feed (`VT-24`); solo
cambia la URL.

**Ajuste, 2026-09-23, después del merge de T100, a pedido del usuario: las
frases escritas.** `interpretInstruction` reconoce los seis productos de la
tienda por lo que son, en los dos idiomas (polerón/hoodie, polera/t-shirt,
gorro/beanie, café/coffee, botella/bottle, sticker), nunca por la marca
("Cordillera" nombra dos productos). Una frase lleva a la tarjeta con la
cantidad que nombró (`/catalogo?producto=…&cantidad=…#…`) y no compra: la
dirección la pone la persona. Para que "compra un pack de stickers" se lea,
`pack` y `paquete` dejan de significar créditos por sí solos; las frases de
créditos siguen leyéndose porque dicen "créditos". Descartado: que la frase
compre directo con una dirección guardada, porque RealOps no guarda
direcciones y no debería empezar a hacerlo para esto.

**Alternativa descartada: no mostrar el campo de cantidad y comprar siempre
uno.** Más simple, pero el video quiere poder pedir dos packs de stickers, y un
campo que el comercio declara y RealOps esconde sería una decisión tomada por
la persona sin decírselo.

**Otra alternativa descartada: subir el default de los cuatro kinds a
3,00/3,00.** Los de SignalDesk y el bazaar compran cosas de 0,001 a 0,25 USDC;
proponerles diez veces más permiso del que necesitan iría contra lo que la
pantalla de revisión existe para mostrar.

---

### C-136 · Vitrinee en el gateway: variables con prefijo, arranque solo con sus secretos, y su caída no tumba al piloto · `Vigente`
**Fecha:** 2026-09-23 · **Hito:** T102 · La forma, de Claude Code, dentro de lo que el usuario decidió en `C-134`

**Qué se decide.** Tres reglas para el cuarto proceso del gateway
(`apps/gateway/src/hosts.ts`, `VITRINEE_TARGET`):

1. **Sus variables llevan prefijo `VITRINEE_` en Render**, y el gateway se las
   pasa al proceso de Vitrinee con el nombre que lee (`envAliases`:
   `MERCHANT_SIGNING_SECRET` ← `VITRINEE_MERCHANT_SIGNING_SECRET`). Vitrinee
   nació como servicio propio y lee nombres genéricos (`PORT`, `ADAPTER`,
   `PUBLIC_BASE_URL`, `FACILITATOR_URL`…). Un servicio de Render tiene un
   valor por nombre, y `PUBLIC_BASE_URL` ya es un nombre que `apps/web` puede
   leer. Con prefijo no hay choque posible, y el aislamiento se ve en el
   nombre: ningún `envKeys` de otra app nombra un `VITRINEE_`, y Vitrinee no
   recibe ningún nombre directo del contenedor, ni siquiera `DATABASE_URL`.
2. **Solo se arranca si están sus secretos** (`requiredEnv`: la cuenta de
   cobro, la llave de firma, la clave del facilitator y las credenciales de
   Jumpseller). Si falta uno, el gateway no la arranca y su dominio responde
   `503`. El blueprint puede llegar a producción antes que los secretos; sin
   esto, Vitrinee saldría al instante por configuración inválida, y por la
   regla de T86 eso reiniciaría el servicio entero en bucle.
3. **No es crítica** (`critical: false`). Si su proceso sale, su dominio
   responde `503` y AgentPey, RealOps y SignalDesk siguen sirviendo. La regla
   de T86 ("si un hijo cae, cae todo y Render reinicia") sigue igual para las
   tres apps del piloto: sin cualquiera de ellas el piloto no funciona. Sin la
   tienda, sí.

**Ajuste tras el primer deploy, mismo día.** El servicio `AgentPey` se creó a
mano en Render y **no sincroniza `render.yaml`**: los cuatro secretos llegaron
porque el usuario los cargó, pero ninguna de las variables públicas con valor
en el blueprint. El gateway no arrancó Vitrinee (`missing
VITRINEE_MERCHANT_STELLAR_ACCOUNT`) y el resto del piloto siguió en 200, que es
lo que la regla 2 existe para proteger. Con eso a la vista, `VITRINEE_ADAPTER`
pasa a ser obligatoria aunque no sea secreta: sin ella Vitrinee usa su tienda
simulada, y un deploy de producción vendiendo productos de mentira es peor que
uno que no arranca. El blueprint queda como documentación de lo que el panel
debe tener.

**Por qué no cambia el código de Vitrinee.** La traducción de nombres vive en
el gateway, que es el que sabe que comparte contenedor. Vitrinee sigue leyendo
`.env.vitrinee.local` en local, igual que antes, y su propio blueprint de
referencia (`render.vitrinee.yaml`) sigue siendo válido tal cual.

**Verificado en local** con las piezas reales del gateway (tabla de hosts,
filtro, supervisor y proxy): con los secretos, `vitrinee.agentpey.com` sirve
manifest, discovery y checkout, y el proceso no recibe ni el valor de
`AGENT_SECRET_KEY` ni ningún nombre `VITRINEE_`; sin la llave de firma, no se
arranca y el dominio responde `503` (`evidencia/T102.md`).

**Alternativa descartada: renombrar las variables en el código de Vitrinee.**
Resolvía el choque, pero rompía su `.env.vitrinee.example`, su blueprint propio
y su historia, para arreglar un problema que es del contenedor compartido.

**Otra alternativa descartada: mantener la regla de T86 también para
Vitrinee.** Un pedido que hiciera caer a la tienda tumbaría la demo entera, y
el orden de despliegue (blueprint antes que secretos) dejaría el piloto
reiniciándose hasta que alguien cargue las cuatro claves.

### C-137 · Los rails de tenant nuevos nacen con 25,00 por compra y 25,00 por día; el crédito patrocinado sigue en 3 · `Vigente`
**Fecha:** 2026-09-23 · **Hito:** preparación de T101 · **Decidido por el usuario** ("máximo unos 20" USDC para fondear), la forma de Claude Code

**Qué cambia.** `PER_TX`/`PER_DAY` de `apps/web/src/tenant-rail.ts` pasan de
`3,00`/`3,00` (`C-133`) a **`25,00`/`25,00`**, y el permiso que RealOps propone
por defecto al "Comprador de la tienda" también (`C-135`). El crédito
patrocinado por tenant **no cambia**: 3 USDC (`C-131`).

**Motivo.** Con 3,00 por compra, de la tienda real solo se podían comprar los
stickers. El usuario puede cargar como máximo unos 20 USDC al rail del tenant de
la demo: con los 3 patrocinados, ese rail tendría 23. Con 25 de límite, todo
producto menos el hoodie (36,83) cabe en una compra: la botella (21,04), la
polera (15,78), el gorro (13,67), el café (9,46) o los stickers.

**Por qué subir el límite y no el crédito.** Un rail no puede mover más de lo
que tiene. Para un tenant que vive del crédito patrocinado, 25 de límite no
cambia nada: 3 USDC sigue siendo todo lo que puede perder. Subir el crédito, en
cambio, drenaría la reserva por cada tenant, porque lo que un rail no gasta no
vuelve (`C-61`). Así, la plata extra va solo al rail que la necesita, cargada a
mano por el usuario.

**El costo, dicho en voz alta.** El respaldo en la red de un rail que alguien
fondee de más ya no ataja a los 3,00 sino a los 25,00. El Mandato sigue siendo
el límite que decide, y la prueba de aceptación del tope diario sigue
esperando rechazos del Mandato, no del contrato.

**Qué no cambia.** Los rails ya desplegados conservan lo que tienen. La compra
de T101 necesita un tenant creado **después** de que esto llegue a producción.

**Alternativa descartada: crédito de 20 por tenant.** 7 cupos × 20 = 140 USDC
de la reserva, para que la mayoría quede sin usar en rails de visitantes.
