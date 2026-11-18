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

Tests (no network):

```bash
pnpm --filter @agentpey/comercios test
```
