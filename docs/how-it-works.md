# How Baratilyo works

## Capture

`src/hook.js` runs in the page's MAIN world at `document_start`, so it patches
`fetch` and `XMLHttpRequest` before Facebook's bundles grab their own references.
Marketplace loads listings over GraphQL, so as you scroll, structured JSON goes
past — price, title, `creation_time`, seller, location — and the hook reads a copy.

The extractor is deliberately **path-independent**. Rather than reaching into
`data.viewer.marketplace_feed_stories.edges[].node.listing`, it walks the whole
response tree and picks up any object that *shapes* like a listing:

- an `id` of 6+ digits
- a price object with `amount` or `amount_with_offset`
- one of `marketplace_listing_title` / `custom_title` / `title`

That's `looksLikeListing()`. When Facebook reorganizes their Relay queries — and
they will — this keeps working. It also harvests the server-rendered JSON in the
initial page HTML, which covers the first screen before any XHR fires.

## Storage

IndexedDB, three stores: `listings`, `sellers`, `debug`. Every time a listing is
seen, its price is appended to a per-listing history if it changed. That history
is what makes price-drop detection free.

## Comps and scoring

Listings are grouped into **buckets** before being compared:

- Electronics get `brand|model|capacity` — `macbook|m2|512gb`, `nvidia|3070|x`.
  Brands come from a hardcoded list in `score.js`; model tokens are any token
  containing a digit.
- Everything else falls back to the three most informative tokens, sorted for
  stability: `gen|dresser-ikea-malm`.

Baseline is **median + MAD** (median absolute deviation), not mean and standard
deviation. One $1 troll listing or one delusional $999,999 listing would wreck a
mean; the median shrugs. Comps are also pre-filtered to drop anything 10× either
side of the median.

Scoring is **leave-one-out** — a listing's own price is removed from the comp set
before its baseline is computed, so a cheap listing can't drag down the very
number it's being judged against.

| Component | Max | Notes |
|---|---|---|
| Discount vs median | 75 | capped at 50% below |
| Comps confidence | 9 | scales with sample size |
| Freshness | 10 | ≤6h gets full marks |
| Price drop | 12 | vs first price seen, or FB's own strikethrough |
| Seller age | +6 / −10 | old account bonus, new account penalty |

Clamped to 0–100. A 27%-under listing posted an hour ago from a 2015 account
lands around 60, which is the default notification threshold.

## Seller age

Search results don't include the seller's join date, so it needs a second
request per listing. To keep that cheap and quiet:

- only listings that already look underpriced are ever checked
- one lookup every 14 seconds (configurable), jittered
- results are cached per seller ID, so a seller is only ever looked up once
- the fetch runs **in the page context** via a message to the content script, so
  cookies and headers are exactly what a normal browse would send
- max 2 attempts per listing, then it gives up

`extractJoinYear()` tries four patterns in order: the visible "Joined Facebook in
YYYY" text, a bare `"join_time":<unix>`, "Joined in YYYY", and a `join_time`
scoped to the seller's ID. If join years come back null across the board, add a
fifth pattern here.

## Debugging capture

On a Marketplace tab, in the console:

```js
window.addEventListener('message', e => e.data?.__dr && console.log(e.data.kind, e.data.payload));
```

Then scroll. You should see `listings` events with populated arrays. If you only
ever see `ready`, the hook is installed but the extractor isn't matching —
loosen whichever condition in `looksLikeListing()` corresponds to the field
Facebook renamed. That function is the single point of failure by design.

The background console is at `about:debugging` → the extension's card → **Inspect**.

## Tests

```bash
node test/hook.test.js
```

Runs `hook.js` in a stubbed browser environment against a synthetic Relay-shaped
payload. Covers both price shapes (`amount` and `amount_with_offset`), seller
join year, strikethrough pricing, and correctly ignoring non-listing objects that
happen to have an id and a price.

## Layout

```
manifest.json          MV3, Firefox 128+ (needs world:"MAIN" content scripts)
src/hook.js            page-world capture — the fragile part
src/content.js         bridge + in-page badges
src/background.js      ingest, scoring passes, enrichment queue, alerts
src/lib/score.js       pure functions, no DOM — unit testable in node
src/lib/db.js          IndexedDB wrapper
src/popup/             ranked list + settings
```
