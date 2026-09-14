# CloudOps: integración con la Partner API de AgentPey

Esta guía integra a CloudOps con AgentPey testnet mediante HTTP. Se puede
seguir desde cualquier terminal con `curl`, `jq` y Node.js; después de recibir
la API key no requiere clonar ni modificar este repositorio.

La especificación de las rutas y sus esquemas está en
[`docs/api/openapi.yaml`](../docs/api/openapi.yaml). Todos los ejemplos usan
la API testnet y una API key que comienza con `ap_test_`.

## 1. Recibir una API key

La creación de partners no es una ruta HTTP: un operador de AgentPey ejecuta
una sola vez el siguiente comando en el checkout del servicio:

```sh
pnpm run partner:create -- --name "CloudOps"
```

El comando imprime el secreto una sola vez. CloudOps debe guardarlo en su
gestor de secretos y nunca enviarlo al principal ni incorporarlo en una URL,
un commit o un log. La key emitida por defecto incluye los scopes necesarios
para este recorrido: `tenants:read`, `tenants:write`, `agents:read`,
`consent_sessions:read`, `consent_sessions:write` y `mandates:read`.

Definí las variables de esta sesión. Reemplazá solo el valor de
`AGENTPAY_API_KEY` por el secreto recibido:

```sh
export AGENTPAY_BASE_URL="https://agentpey.com"
export AGENTPAY_API_KEY="ap_test_REPLACE_WITH_THE_SECRET_RECEIVED_ONCE"
export VALID_UNTIL="$(node -e 'console.log(new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString())')"
```

Para probar localmente, iniciá el servicio con `pnpm run web` y reemplazá la
primera variable por `http://localhost:3000`. El servidor debe tener una
`.env.local` real, incluida `DATABASE_URL`; configurá `PUBLIC_BASE_URL` si el
link de consentimiento se abre desde un origen público distinto.

## 2. Crear el tenant del principal

`external_ref` es el identificador opaco y estable de la persona en CloudOps,
no un correo ni otro dato personal. La misma referencia para el mismo partner
devuelve el tenant existente; la misma referencia de otro partner no comparte
datos. Guardá el `id` retornado como `TENANT_ID`.

```sh
export TENANT_IDEMPOTENCY_KEY="$(uuidgen)"
TENANT_JSON="$(curl --fail-with-body --silent --show-error \
  --request POST "$AGENTPAY_BASE_URL/v1/tenants" \
  --header "Authorization: Bearer $AGENTPAY_API_KEY" \
  --header "Idempotency-Key: $TENANT_IDEMPOTENCY_KEY" \
  --header "Content-Type: application/json" \
  --data '{"external_ref":"cloudops-user-001","label":"CloudOps test principal"}')"
printf '%s\n' "$TENANT_JSON" | jq .
export TENANT_ID="$(printf '%s' "$TENANT_JSON" | jq -er '.data.id')"
printf 'TENANT_ID=%s\n' "$TENANT_ID"
```

Una repetición de esa misma operación de red debe usar el mismo
`Idempotency-Key` y el mismo cuerpo. Durante 24 horas, AgentPey reproduce la
misma respuesta sin crear otro tenant. Para un nuevo intento lógico, generá
otra key. No reutilices una key con un cuerpo diferente.

## 3. Consultar los agentes del tenant

Un tenant recién creado puede no tener un agente todavía. La identidad del
agente se crea durante el consentimiento firmado, por lo que una lista vacía
antes de la firma es esperable.

```sh
curl --fail-with-body --silent --show-error \
  --request GET "$AGENTPAY_BASE_URL/v1/agents?tenant_id=$TENANT_ID" \
  --header "Authorization: Bearer $AGENTPAY_API_KEY" | jq .
```

## 4. Abrir un consentimiento con el grant propuesto

Este ejemplo permite crear intents de catálogo para un único venue y asset,
con límites de 50 USDC por transacción y 200 USDC por día. `payTo` restringe
el pago al account Stellar testnet mostrado; reemplazá cada valor del grant
por la política exacta que el principal debe revisar y firmar. Un arreglo
`payTo` vacío no permite ningún destinatario.

```sh
export CONSENT_IDEMPOTENCY_KEY="$(uuidgen)"
CONSENT_REQUEST="$(jq -cn \
  --arg tenant_id "$TENANT_ID" \
  --arg valid_until "$VALID_UNTIL" \
  '{
    tenant_id: $tenant_id,
    grant: {
      actions: ["catalog:read", "intent:create"],
      venues: ["mock-bazaar:CCL57L4ZQVQCGTQKGQMOAX7QDPEDW4LX2QSPBQMTMLB7BFQ7I3TM7F4A"],
      assets: ["USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5"],
      limits: {perTx: "50.0000000", perDay: "200.0000000", currency: "USDC"},
      payTo: ["GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5"]
    },
    valid_until: $valid_until
  }')"
CONSENT_JSON="$(curl --fail-with-body --silent --show-error \
  --request POST "$AGENTPAY_BASE_URL/v1/consent_sessions" \
  --header "Authorization: Bearer $AGENTPAY_API_KEY" \
  --header "Idempotency-Key: $CONSENT_IDEMPOTENCY_KEY" \
  --header "Content-Type: application/json" \
  --data "$CONSENT_REQUEST")"
printf '%s\n' "$CONSENT_JSON" | jq .
export CONSENT_ID="$(printf '%s' "$CONSENT_JSON" | jq -er '.data.id')"
export CONSENT_URL="$(printf '%s' "$CONSENT_JSON" | jq -er '.data.consent_url')"
printf 'CONSENT_ID=%s\nCONSENT_URL=%s\n' "$CONSENT_ID" "$CONSENT_URL"
```

La invitación queda en estado `pending` y su URL es
`$AGENTPAY_BASE_URL/consent/$CONSENT_ID`. Tiene una ventana de firma de una
hora, independiente de `valid_until`. Entregá exactamente `CONSENT_URL` al
principal por un canal apropiado.

## 5. Qué hace el principal

El principal abre `CONSENT_URL`, que sirve `/consent/{id}`. Antes de firmar,
debe comprobar todos los permisos del grant: acciones, venue, asset, límites
por transacción y día, moneda, vencimiento y cada cuenta `payTo`. Luego
conecta Freighter y firma primero el mandato y después su transacción de
anclaje en Stellar testnet. CloudOps no firma ni custodia la wallet del
principal.

## 6. Consultar el consentimiento y el mandato

Después de que el principal termine, consultá la sesión. Cuando `status` sea
`completed`, `mandate_id` deja de ser `null` y `consent_url` pasa a `null`.

```sh
SESSION_JSON="$(curl --fail-with-body --silent --show-error \
  --request GET "$AGENTPAY_BASE_URL/v1/consent_sessions/$CONSENT_ID" \
  --header "Authorization: Bearer $AGENTPAY_API_KEY")"
printf '%s\n' "$SESSION_JSON" | jq .
export CONSENT_STATUS="$(printf '%s' "$SESSION_JSON" | jq -er '.data.status')"
export MANDATE_ID="$(printf '%s' "$SESSION_JSON" | jq -er '.data.mandate_id // empty')"
printf 'CONSENT_STATUS=%s\nMANDATE_ID=%s\n' "$CONSENT_STATUS" "$MANDATE_ID"
```

Podés repetir el bloque anterior mientras `CONSENT_STATUS` sea `pending`.
Si es `expired` o `cancelled`, no reintentes la firma: abrí una sesión nueva
con una nueva `Idempotency-Key`. Si es `completed`, consultá el mandato:

```sh
curl --fail-with-body --silent --show-error \
  --request GET "$AGENTPAY_BASE_URL/v1/mandates/$MANDATE_ID" \
  --header "Authorization: Bearer $AGENTPAY_API_KEY" | jq .
```

Para leer todos los mandatos —activos, pendientes, vencidos o revocados— del
tenant:

```sh
curl --fail-with-body --silent --show-error \
  --request GET "$AGENTPAY_BASE_URL/v1/mandates?tenant_id=$TENANT_ID" \
  --header "Authorization: Bearer $AGENTPAY_API_KEY" | jq .
```

## 7. Errores y reintentos

Todas las respuestas de error usan este envelope:

```json
{"ok":false,"code":"ErrorCode","message":"human-readable explanation","details":{}}
```

| HTTP | `code` | Cuándo ocurre | Acción de CloudOps |
|---|---|---|---|
| 401 | `MissingApiKey` | Falta `Authorization`. | Enviá `Authorization: Bearer $AGENTPAY_API_KEY`. |
| 401 | `InvalidApiKey` | La key es malformada, desconocida o revocada. | No la reintentes; recuperá la key correcta o pedí una nueva al operador. |
| 403 | `ScopeNotGranted` | La key es válida pero no tiene el scope de la ruta. | Pedí una key con el scope indicado en `details.required`. |
| 400 | `IdempotencyKeyRequired` | Falta o está vacía la cabecera en un `POST`. | Generá y enviá una key no vacía. |
| 409 | `IdempotencyKeyConflict` | Se reutilizó una key dentro de 24 h con otro cuerpo. | Conservá el cuerpo original al reintentar; para otra operación generá otra key. |
| 400 | `InvalidArguments` | El JSON o un parámetro requerido no respeta el esquema. | Corregí el campo señalado; todos los objetos son estrictos. |
| 400 | `InvalidExternalRef` | `external_ref` no es opaco o contiene contenido no permitido. | Usá un identificador interno, estable y sin PII. |
| 404 | `TenantNotFound`, `MandateNotFound`, `ConsentSessionNotFound` | El recurso no existe o pertenece a otro partner. | Confirmá el ID; no se distingue una pertenencia ajena de una ausencia. |
| 410 | `ConsentSessionExpired` | El principal intenta iniciar o firmar una invitación vencida en el flujo público. | Creá una sesión nueva y entregá su nueva URL. En `GET /v1/consent_sessions/{id}` ese caso se expresa como `200` con `status: "expired"`. |
| 409 | `ConsentSessionAlreadyCompleted` | Se intenta firmar de nuevo una invitación ya completada. | Consultá la sesión y usá su `mandate_id`; no abras una segunda firma. |
| 404 | `NotFound` | Método o ruta `/v1` inexistente. | Usá las rutas de esta guía u OpenAPI. |
| 500 | `unknown` | Fallo inesperado del servicio. | Reintentá de forma acotada; si persiste, preservá `code`, `message` y la hora para soporte. |

`TenantAlreadyExists` y `PartnerNotFound` son códigos internos documentados
por el contrato. En esta integración no requieren un flujo especial: un
`POST /v1/tenants` repetido con la misma `external_ref` del partner devuelve
el recurso existente (`200`), y una key que ya no corresponde a un partner
responde `InvalidApiKey`. `AgentNotFound` no se expone como ruta individual:
`GET /v1/agents` devuelve la lista del tenant.

Una respuesta 4xx no se corrige reintentando ciegamente. Para un corte de
red o 5xx, reenviá el mismo `POST` con la misma `Idempotency-Key` y el mismo
cuerpo; eso permite que AgentPey devuelva el resultado original sin duplicar
el tenant o consentimiento.
