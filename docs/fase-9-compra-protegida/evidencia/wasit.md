# Wasit · prueba independiente del endpoint x402 de SignalDesk

> Evidencia para la postulación al SCF (#46, envío 6-nov). **No es una auditoría ni una certificación**: es una lista de
> chequeos de conformidad corrida por el builder, con Wasit 0.7.0, en Stellar testnet. Así lo pide Wasit y así debe
> citarse.

## Qué se probó

- **Herramienta:** Wasit 0.7.0 (`@wasit-dev/cli@0.7.0`), probador de conformidad de x402 y MPP, de código abierto
  (Apache-2.0), solo testnet. Sitio: <https://usewasit.dev>. Repo: <https://github.com/wasit-dev/wasit>.
- **Endpoint:** `GET https://signaldesk.agentpey.com/api/x402/market-brief?pair=XLM/USDC` (SignalDesk, el comercio
  piloto de x402 de AgentPey). Sin cuerpo ni cabecera. Red `stellar:testnet`. Precio 0,25 USDC.
- **Quién la corrió:** el usuario, en su computador, en una sesión en vivo con Dzakwan (Wasit), el 2026-10-26.
- **Pagador:** una billetera desechable creada con `wallet create --role x402 --fund` y borrada al terminar.

## Qué pasó

| Corrida | Resultado | Fuente |
|---|---|---|
| Solo lectura (`--read-only`), X402-01 a 05 | **5 PASS** | Salida de la terminal, abajo |
| Completa, X402-01 a 10 | **10 PASS** | Dicho por el usuario; la salida literal no se guardó |

Salida de la corrida de solo lectura (antes de la sesión):

```
(--read-only set: skipping payment checks)

PASS  X402-01  402 Response Status
      Server responded with 402 as required.
PASS  X402-02  Payment Header Present
      Payment header found.
PASS  X402-03  Header Payload Decodable
      Header decoded to valid JSON.
PASS  X402-04  Required Fields Present
      All required v2 fields present.
PASS  X402-05  Network Identifier Valid
      Network identifier "stellar:testnet" is valid.

5 passed.
```

## Prueba del pago, leída de la red (Horizon testnet)

Verificada el 2026-10-26 con una consulta a Horizon sobre las transacciones recibidas por la cuenta de SignalDesk: en
la mañana de ese día hay **una sola**, la del chequeo X402-06 (los chequeos de rechazo 07 a 10 no liquidan nada).

| Dato | Valor |
|---|---|
| Hora | 2026-10-26 12:33:37 UTC (09:33 en Santiago, UTC-3) |
| Ledger | 5398886 |
| Hash | `3b8bbad2345e7af149f13c3950667699d29222caca6ab2714f6abc9a70793083` |
| Enlace | <https://stellar.expert/explorer/testnet/tx/3b8bbad2345e7af149f13c3950667699d29222caca6ab2714f6abc9a70793083> |
| Pagador (billetera desechable) | `GCT4NPIWWSP6D4LJHTFGYPSTYWLNZ2IAR2KFA3WR7BGFM7IHT6PCCGHH` |
| Receptor (SignalDesk) | `GB4D4PLLFEIKZK6MDW42MZRQ5XMPC6QRJN4FFRODO6D3PRB3MDGGYOOF` |
| Monto | 0,2500000 USDC (el precio anunciado) |
| Operación | `invoke_host_function`, `transfer` del USDC de testnet; exitosa |

## Feedback publicado

- **Issue público:** <https://github.com/wasit-dev/Wasit/issues/21> («User feedback (SOW 2): AgentPey, x402 on Stellar
  testnet»), publicado con la cuenta `vicentewolde` el 2026-10-26 con el OK del usuario.
- **Lo que dice:** nada confuso; Wasit cumple una función buena y necesaria y se complementa con AgentPey (Wasit prueba el
  servidor y el pago; AgentPey limita lo que el agente comprador puede pagar); lo correría de nuevo antes de un
  lanzamiento; pide chequeos del lado del agente y soporte para pagadores que son billeteras-contrato con límites.
- **Consentimiento del usuario:** Wasit puede citar el issue y enlazarlo como evidencia, y puede nombrar a AgentPey. La
  redacción exacta sobre AgentPey la aprueba el usuario antes de que Wasit la use.

## Frase para la postulación

> «Ran Wasit 0.7.0's checks on a test endpoint of AgentPey (SignalDesk, x402 on Stellar testnet) on 2026-10-26: all
> checks passed, and the payment is verifiable on-chain.»

Antes de usarla, Dzakwan la revisa (acordado: cada parte envía a la otra su frase antes de nombrarla). No decir
«auditado» ni «certificado».

## Qué no cubre

- No prueba al **agente comprador** (`wasit serve`), solo al servidor. Es lo que el usuario le pidió a Wasit como
  siguiente paso. Wasit no sabe usar como pagador una billetera-contrato como el `policy_rail`, así que esa prueba
  queda sin hacer.
- La corrida usó SignalDesk en producción (testnet): dejó una entrega y un pago de 0,25 USDC en su base y en la red. No
  se verificó si aparecen en los contadores públicos (`/en-vivo`, `/api/live`).
- La salida literal de los diez chequeos no se guardó; el hash en la red sí.

## Pendiente

- [ ] Enviar a Dzakwan el issue y la frase, y pedirle el **informe escrito** de la corrida (salida de Wasit con versión y
  fecha, más su resumen de lo que corrió y no corrió). Redactado el 2026-10-27.
- [ ] Recibir y aprobar la frase de Wasit sobre AgentPey antes de que la use.
- [ ] Guardar su informe aquí cuando llegue.
