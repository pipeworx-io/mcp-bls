# BLS — Bureau of Labor Statistics

The U.S. Bureau of Labor Statistics's data warehouse. Employment, unemployment, wages, prices (CPI/PPI), productivity, occupational projections — the official US labor and price data. National, state, and metro level. Free with a registered API key.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1504+ live data sources.

## Why this matters for AI agents

Anything labor-market or inflation-related at the official level: BLS. Where FRED gives you headline series, BLS gives you the underlying detail (occupation-level, industry-level, MSA-level). Agents researching local economic conditions, sector wages, or specific CPI components reach BLS directly.

Three core flows:

**1. Look up a series.** "What's the metro Denver unemployment rate?" → `bls_search({query: "Denver unemployment"})` → series IDs. Then `bls_get_series({series_id})` for values.

**2. Latest value.** "What's national unemployment right now?" → `bls_latest({series_id: "LNS14000000"})` → most recent observation.

**3. Browse popular series.** "What does BLS publish?" → `bls_popular_series` → curated list of high-traffic IDs.

**4. Local-area unemployment by place name.** "What's the unemployment rate in Wake County, NC?" or "Cary, North Carolina" or "Fargo-Moorhead MSA" → `bls_local_unemployment({place, state?})`. This is the tool for LAUS (Local Area Unemployment Statistics) lookups by county / metro area / city — `bls_search`'s curated catalog has no local-area entries, and constructing a LAUS series ID by hand requires a place → BLS area-code crosswalk (~8,000 US counties/metros/cities) that isn't something to guess at. `bls_local_unemployment` resolves the name against that crosswalk itself (bundled from BLS's `la.area` reference file), returns candidates when the name is ambiguous, and falls back to the county — saying so explicitly — when a city is below the LAUS city-reporting threshold.

## Reading the response

`bls_get_series` returns each series **newest first** — the payload says so in
`observation_order`, so you don't have to infer the direction from the dates.
`count` is the number of points for that series, and BLS returns every point in
the requested year range, so it is never a total sitting beside a shorter list.

## Auth

BLS API requires a free key from https://www.bls.gov/developers/. Without it, calls are throttled to ~25/day per IP. With a key, it's 500/day. Pass via `_apiKey` per call.

## Series ID structure

BLS series IDs encode survey, area, sector, and data type. Examples:

| Series ID | What it is |
|---|---|
| `LNS14000000` | National unemployment rate (seasonally adjusted) |
| `CES0000000001` | Total nonfarm employment (national) |
| `CUUR0000SA0` | CPI all items, US city average, not seasonally adjusted |
| `LAUMT080000000000003` | Denver MSA unemployment rate |
| `WPSFD49207` | PPI for finished goods |

Don't try to construct national/state/industry IDs from scratch — use `bls_search` or
`bls_popular_series`. For LAUS local-area IDs (county/MSA/city) specifically, use
`bls_local_unemployment({place, state?})` — it resolves the place name to the correct
area code for you.

## Update cadence

| Data | Release timing |
|---|---|
| Employment situation (national + state) | First Friday of the month |
| CPI | Mid-month (around the 10th-15th) |
| PPI | Mid-month, day after CPI |
| Metro unemployment (LAUS) | ~3 weeks after the reference month |
| Productivity | Quarterly, ~5 weeks after quarter end |

Pipeworx caches BLS responses with TTLs aligned to release schedules.

## Common pitfalls

- **Seasonal adjustment.** Same series exists in seasonally-adjusted (SA) and not-seasonally-adjusted (NSA) variants. Check the series ID prefix (`LNS` = SA, `LNU` = NSA). Mixing them is the most common analyst error.
- **Annual averages vs monthly.** Some IDs return only annual data; others return monthly. Read the metadata before plotting trends.
- **State and metro coverage.** Not every series exists at every geography. Smaller metros have larger lags and more imputed values.
- **Inflation vs CPI.** "Inflation" usually means CPI year-over-year change. To get YoY, request 13 months and compute, or use FRED's `CPIAUCSL` with the `pc1` units transformation (which does it for you).

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "bls": {
      "url": "https://gateway.pipeworx.io/bls/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/bls/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1504+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Bls data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/bls_get_series \
  -H 'Content-Type: application/json' \
  -d '{"series_id":"LNS14000000"}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/bls_get_series`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.
