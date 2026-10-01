# AP2 schemas, v0.2 (vendored test fixtures)

JSON Schemas of the Agent Payments Protocol, copied unmodified from
`code/sdk/schemas/ap2/` of https://github.com/google-agentic-commerce/AP2 at
commit `e1ea56db72a6385bce3e5c1112b3a56ce60acb43` (release `0.2.0`,
2026-04-28). Apache-2.0, see `LICENSE`. Copyright the AP2 Authors.

They exist so this package's tests can check its exported mandates against the
official schemas without touching the network (`../ap2-schemas.ts`). Nothing at
runtime reads them. Do not edit: to move to a newer AP2 version, vendor it next
to this folder.
