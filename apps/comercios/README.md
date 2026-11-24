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

`base guia` also builds one page per brand that two or more public stores sell
(`agentpey.com/chile/marcas/<brand>`, `marcas.ts`): each store's cheapest
in-stock products of the brand with their price and date, ordered by lowest
price, and the same product side by side when two stores share its barcode.
After publishing, tell Bing and the other IndexNow engines about every page of
the live sitemap:

```bash
npx tsx src/cli.ts base indexnow
```

### Price search

`agentpey.com/chile/buscar?q=<words>` lists every in-stock product with a price
of the public stores (the same ones the guides may name) whose name or brand has
every word at the start of a word ("50ml" does not find "150ml"), cheapest
first, with its store and the date it was read
(`precios.ts`). Accents, capitals and "100 ml" against "100ml" do not matter, and
a product named only as a reference ("inspirado en Khamrah") is not a match.
`&formato=json` gives the same results to programs. Result pages ask not to be
indexed; the empty page is in the sitemap. `base guia` builds its rows and
`setup-postgres --guias` publishes them with the pages:

```bash
curl "https://agentpey.com/chile/buscar?q=khamrah%20100ml&formato=json"
```

### For AI assistants: llms.txt and a public MCP server

`agentpey.com/llms.txt` lists the guides, the brand pages, the price search and
its JSON, with the rules every page follows; `agentpey.com/robots.txt` points
crawlers to the guides' sitemap (the gateway sends both paths here). The price
search is also a public MCP server at `agentpey.com/chile/mcp` (`ias.ts`):
read-only, no account, stateless Streamable HTTP answering plain JSON, one tool,
`buscar_precios`. It is not AgentPey's paying MCP server (`apps/mcp`): it holds no
keys, records no clicks and links straight to each store. It shares the search's
limit of 300 searches per IP and hour.

```bash
curl -s -X POST https://agentpey.com/chile/mcp -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"buscar_precios","arguments":{"consulta":"khamrah 100 ml","max":5}}}'
```

### The same product across stores (pilot: Arabic perfumes)

`agentpey.com/chile/productos/<slug>` shows one perfume, concentration and size
with every public store's price, cheapest first (`productos.ts`). Titles match
only when their name words are identical once store filler is left out, so
Khamrah, Khamrah Qahwa and Khamrah Dukhan stay apart; decants, testers, sets
and body mists are out; a page needs three stores. `base guia` builds them and
`setup-postgres --guias` publishes them.

### Big stores, for comparison (perfume pages only)

Each perfume page also shows, in its own table, the price at big stores
(Paris, Lider, Hites; Ripley and Cruz Verde are listed but give nothing today,
and Falabella answers 403 to our agent). They never enter the pyme order, the
guides, the brand pages, the search or the page's JSON-LD offers. They are read
from their public product sitemaps, only the addresses that name the house,
every name word and the size of a perfume that already has a page, so run
`base guia` first:

```bash
COMERCIOS_DATA=~/agentes/datos-comercios/ npx tsx src/cli.ts base grandes
```

```bash
COMERCIOS_DATA=~/agentes/datos-comercios/ npx tsx src/cli.ts base grandes --tiendas gr-paris,gr-lider --max 300
```

`--max` caps the pages opened per store (600 by default). A reading with no
product, or with less than half the last one, keeps the last one. Then
`base guia` and `setup-postgres --solo-importar --guias` publish them.

### Stores from past editions of cyber.cl

The Internet Archive keeps cyber.cl's participant lists of past events. Save a
copy (`http://web.archive.org/web/<timestamp>id_/https://cyber.cl/`) and add
its stores, marked `cyber-anterior` (the guides say "ediciones anteriores de
cyber.cl"):

```bash
npx tsx src/cli.ts base cyber --archivo cyber-20241106233741.html cyber-20260606111449.html
```

### Who reads the guides

Each public page (`/chile...`, `/robots.txt`, `/llms.txt`) counts, per day,
the crawlers and assistants that read it and the people who arrive from an
assistant's answer (`visitas.ts`): "indexa" (OAI-SearchBot, Claude-SearchBot,
PerplexityBot, Bingbot, Googlebot), "entrena" (GPTBot, ClaudeBot…), "lee para
una persona" (ChatGPT-User, Claude-User, Perplexity-User: an assistant opened
the page to answer someone) and "persona desde una IA" (referrer or
`utm_source` from chatgpt.com, perplexity.ai, claude.ai, gemini…). No IP, no
user-agent string, no search words; counts by what each request says it is,
not verified. The server writes them every two minutes:

```bash
npx tsx scripts/visitas.ts --env ~/agentes/AgentPay/.env.local --desde 2026-11-22
```

### Night shift

Work that needs Claude runs at night with the subscription's spare usage
(`claude -p`, never the paid API): `scripts/noche.sh`, from the same checkout
as the weekly job, by the `agentpey-noche` user timer (04:00 Santiago, stopping at 09:00). Today its queue
has one task, `base politicas`: each public store's shipping, returns,
warranty and payment pages, structured by Claude with a quote for every claim
and saved as "propuesta" (nothing is published). Each store tried is recorded
in `policy_attempts`, so it is not retried for 30 days whatever the result.

It stops at the plan's usage limit (exit code 3: the rest waits for the next
night), at `NOCHE_HASTA` (HH:MM) or after `NOCHE_MAX` stores, and ends its log
(`$COMERCIOS_DATA/noche/<day>.log`) with how long it ran, how many Claude
calls it made per hour and why it stopped. Every session of the account shares
the plan's limit: while it runs, and until the window resets, other sessions
may hit the limit too. It does not start on Sunday before 02:30 (on Sunday at 04:00 it waits for the weekly job), and started
on a Saturday afternoon it stops at 23:50: the weekly job rewrites the price
table in one long transaction. It waits for a running weekly job instead of
starting next to it, does not hold `semanal.lock` itself (the weekly job would
skip its run), and retries a write while the database is busy. Pilot stores
are left out: their policy is served by the panel's MCP.

A first run by hand, with no stop hour, from a branch:

```bash
COMERCIOS_DATA=$HOME/agentes/datos-comercios NOCHE_NO_UPDATE=1 scripts/noche.sh
```

Every night, once on `origin/main`:

```bash
cp ~/agentes/AgentPay-worktrees/semanal/apps/comercios/scripts/systemd/agentpey-noche.* ~/.config/systemd/user/ && systemctl --user daemon-reload && systemctl --user enable --now agentpey-noche.timer
```

### Weekly refresh

Every Sunday night a systemd user timer re-reads every public catalogue,
rebuilds the guides and brand pages, publishes them and runs `indexnow`. A
re-read replaces a store's catalogue only when it looks complete
(`semanal.ts`): when it fails, or reads less than half of a catalogue of 20 or
more products, the previous reading and its date stay; the same smaller size
two weeks running is taken as the store's real size. Pages are built only with
readings up to 14 days old, so a page left up for a week never shows one older
than the 21 days every page promises (`freshReadAt` in `guia.ts`). Publishing
is refused when the stores across the guides, the brand pages or the search
rows would drop by more than 30% (`setup-postgres.ts --max-caida 30`). It uses no AI model.

The job runs whatever is on `origin/main` with the admin connection of
`.env.local`, so a change to `apps/comercios` runs there the next Sunday. A
change to `semanal.sh` takes effect from the following run, and the systemd
units copied to `~/.config/systemd/user/` are not updated by it: copy them again
after changing them.

The job runs from a checkout used only for it, which moves itself to
`origin/main` before each run, with the data outside any checkout
(`COMERCIOS_DATA`, honoured by the CLI and `setup-postgres.ts`). Once:

```bash
git worktree add --detach ~/agentes/AgentPay-worktrees/semanal origin/main
```

```bash
cd ~/agentes/AgentPay-worktrees/semanal && pnpm install --frozen-lockfile
```

```bash
cp ~/agentes/AgentPay-worktrees/semanal/apps/comercios/scripts/systemd/agentpey-semanal.* ~/.config/systemd/user/ && systemctl --user daemon-reload && systemctl --user enable --now agentpey-semanal.timer
```

Run it now, and read its log (one file per day in `$COMERCIOS_DATA/semanal/`):

```bash
systemctl --user start --no-block agentpey-semanal.service
```

```bash
journalctl --user -u agentpey-semanal.service -f
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
