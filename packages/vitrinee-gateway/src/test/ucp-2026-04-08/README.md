# UCP schemas, v2026-04-08 (vendored test fixtures)

JSON Schemas of the Universal Commerce Protocol, copied unmodified from
`source/schemas/` and `source/discovery/` of
https://github.com/Universal-Commerce-Protocol/ucp at tag `v2026-04-08`.
Apache-2.0, see `LICENSE`. Copyright the UCP Authors.

They exist so the gateway's tests can validate its UCP responses against the
official schemas without touching the network (`../ucp-schemas.ts`). Nothing
at runtime reads them. Do not edit: to move to a newer UCP version, vendor
that tag next to this folder (decision E-2 pins this one).
