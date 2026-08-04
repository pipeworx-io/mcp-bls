# BLS — Bureau of Labor Statistics

The U.S. Bureau of Labor Statistics's data warehouse. Employment, unemployment, wages, prices (CPI/PPI), productivity, occupational projections — the official US labor and price data. National, state, and metro level. Free with a registered API key.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1394+ live data sources.

## Why this matters for AI agents

Anything labor-market or inflation-related at the official level: BLS. Where FRED gives you headline series, BLS gives you the underlying detail (occupation-level, industry-level, MSA-level). Agents researching local economic conditions, sector wages, or specific CPI components reach BLS directly.

Three core flows:

**1. Look up a series.** "What's the metro Denver unemployment rate?" → `bls_search({query: "Denver unemployment"})` → series IDs. Then `bls_get_series({series_id})` for values.

**2. Latest value.** "What's national unemployment right now?" → `bls_latest({series_id: "LNS14000000"})` → most recent observation.

**3. Browse popular series.** "What does BLS publish?" → `bls_popular_series` → curated list of high-traffic IDs.

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

Don't try to construct IDs from scratch — use `bls_search` or `bls_popular_series`.

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

Or connect to the full Pipeworx gateway for access to all 1394+ data sources:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English:

```
ask_pipeworx({ question: "your question about Bls data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
