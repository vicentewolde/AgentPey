# @agentpey/comercios

Tools for Chilean online stores: catalogue readiness, AI-answer diagnosis, the
store panel. Publishing the panel is in [DEPLOY.md](DEPLOY.md).

Everything the commands read or write lives in `apps/comercios/data/`, which
is git-ignored: the repository is public, so store lists, catalogues, AI
answers, contact addresses and sheets never go into git.

## The store base

A base of Chilean online stores from the public participant lists of
blackfriday.cl and cyber.cl, with each store's public catalogue score, how
often ChatGPT and Claude name it for buyer questions of its rubro, who shows
up instead, and a one-screen sheet plus a draft email per store. Nothing is
ever sent.

Run from `apps/comercios`, in this order:

```bash
npx tsx src/cli.ts base lista
```

```bash
npx tsx src/cli.ts base cyber
```

```bash
npx tsx src/cli.ts base piloto
```

```bash
npx tsx src/cli.ts base ajustar
```

```bash
npx tsx src/cli.ts base contacto
```

```bash
npx tsx src/cli.ts base ingest --paralelo 24 --max 1500 --paginas 200
```

```bash
npx tsx src/cli.ts base diagnostico --n 5 --paralelo 3
```

```bash
npx tsx src/cli.ts base diagnostico --desde 2026-11-18T06:00 --repetir 2026-11-18 --paralelo 3
```

```bash
npx tsx src/cli.ts base fichas --desde 2026-11-18
```

- `lista` and `cyber` read the two public lists; `ajustar` applies the manual
  segments in `data/base/ajustes.json` (big brands, sites with no catalogue).
- `ingest` reads public catalogues with the polite fetcher (robots.txt, 1.2 s
  between pages of the same site) and skips stores already read.
- `diagnostico` uses the subscription (`claude -p`) and Codex CLI, never the
  paid API. It skips stores already answered since `--desde`, and stops at the
  plan's usage limit with what it saved; the same command resumes.
  `--repetir <ISO>` asks the same questions again for a second sample.
- `fichas` writes `data/base/comparacion.json`, `data/base/resumen.md`,
  `data/fichas-bf/<id>.html`, `<id>-correo.txt` and `indice.csv`.

## Public guides

"Online stores of <rubro> in Chile" pages for Vestuario y Calzado, Hogar y
Decoración and Salud y Belleza, built only from the catalogues the base has
already read: no catalogue is fetched and no AI is asked. Stores are ordered by
products with a published price (a public rule, written on the page), pilot-only
stores are left out, and there are no scores. Each guide is saved in the local
base (table `guias`) and previewed in `data/guias/<slug>.html`:

```bash
npx tsx src/cli.ts base guia
```

Publishing copies the guides to the panel's Postgres (only aggregates and public
facts travel, no catalogue rows). They are published on the main domain, one
folder per country: `agentpey.com/chile`, `agentpey.com/chile/<slug>` and
`agentpey.com/chile/sitemap.xml`. The gateway sends exactly those paths to this
app (`isGuidePath` in `apps/gateway/src/hosts.ts`); on `panel.agentpey.com` the
same paths redirect (301) to the main domain, so there is one address per page:

```bash
npx tsx scripts/setup-postgres.ts --env ~/agentes/AgentPay/.env.local --solo-importar --guias
```

The guide is an experiment, measured before and after publishing with the same
general questions of each rubro. `medir-guia` prints, per guide rubro, how many
answers cite agentpey.com (any subdomain) and which domains the answers link.
The repeat asks Claude exactly the questions answered from 2026-11-18 on, never
new ones, so the numbers compare (one repeat is 41 questions):

```bash
npx tsx src/cli.ts base medir-guia --desde 2026-11-18 --hasta 2026-11-19
```

```bash
npx tsx src/cli.ts base rubros --repetir 2026-11-18 --desde 2026-12-07 --solo "Vestuario y Calzado,Hogar y Decoración,Salud y Belleza"
```

```bash
npx tsx src/cli.ts base medir-guia --desde 2026-12-07
```

Tests (no network):

```bash
pnpm --filter @agentpey/comercios test
```
