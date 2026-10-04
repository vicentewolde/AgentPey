# UCP schemas, v2026-08-25 (vendored test fixtures)

JSON Schemas of the Universal Commerce Protocol, copied unmodified from
`source/schemas/` of https://github.com/Universal-Commerce-Protocol/ucp at tag
`v2026-08-25` (commit `cd78fb38e819de77d9b527d110476eccb876f1bd`; the
`release/2026-08-25` branch has only documentation commits after it).
Apache-2.0, see `LICENSE`. Copyright the UCP Authors.

They exist so the gateway's tests can validate its UCP `2026-08-25` responses
against the official schemas without touching the network
(`../ucp-schemas.ts`, a validator of its own: the `$id`s are the same as in
`../ucp-2026-04-08` and must not mix). Nothing at runtime reads them. Do not
edit (T133, R-6).
