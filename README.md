# Split

A receipt splitter. Assign each item to whoever actually shared it; tax, tip,
and any discount are then divided in proportion to what each person ordered,
rather than evenly.

Live at https://split.rahulsetia.me.

## How it's built

A static front end plus two small serverless functions on Vercel.

- `index.html`, `styles.css`, and `app.js`. `app.js` is an esbuild bundle of
  the ES modules in `js/`, committed so the folder deploys as-is with no build
  step on Vercel.
- `api/scan.js` reads a receipt photo with Gemini, and `api/assign.js` turns a
  sentence like "we all shared the fries, Arjun had the steak" into item
  assignments. Files prefixed with `_` are shared helpers that Vercel doesn't
  route.

```
npm install
npm test          # bundles js/ into app.js, then runs node --test
npm run deploy    # bundles, then deploys to Vercel production
```

Served statically, the front end works on its own: manual entry and offline
scanning need no server. The AI features need the `api/` functions, for
example via `npx vercel dev`.

## How the math works

Each item is split evenly among the people assigned to it. Everyone's subtotal
is the sum of their shares. A whole-check discount, then tax and tip, are
allocated by each person's fraction of the overall subtotal:

```
total[p] = subtotal[p] + (subtotal[p] / overall_subtotal) * (tax + tip - discount)
```

A discount can be entered as dollars or as a percentage of the subtotal, and is
capped at the subtotal — a coupon larger than the food is a typo, not a refund.
Percentage tax and tip are computed on the discounted subtotal, which is the
base the register charges tax on. To tip on the full pre-discount amount, switch
the tip field to `$`.

Per-person totals are rounded by largest remainder, so the individual shares
always sum to the exact bill total instead of drifting a cent.

Items assigned to nobody are excluded from the total and flagged in the UI,
so a data-entry mistake surfaces instead of silently vanishing.

## Reading a receipt

You crop the photo to the item list, then choose how to read it. Either way, a
scan never writes straight into the ledger: it proposes rows you confirm and
correct on a review sheet, and any tax, tip, or discount it found is offered as
a checkbox, never applied silently.

### Read with AI

The cropped image is sent to `/api/scan`, which asks Gemini (by default
`gemini-2.5-flash`) for the items plus any printed subtotal, discount, tax,
tip, and total, constrained to a JSON schema. The prompt asks for extended
line totals rather than unit prices, and for an unreadable price to be left
out rather than guessed.

Model availability is handled on the server:

- If the configured model has been retired, the server asks the key which
  models it can call and switches to a current Flash model.
- If a model is overloaded (503) or rate-limited (429), it retries once and
  then falls back to other models, giving up after about 20 seconds.

### Scan offline

The photo is preprocessed in-browser (downscale/upscale to a workable size,
grayscale, Otsu threshold) and read with tesseract.js, which is lazy-loaded
from a CDN on first use and cached afterward. **The image never leaves the
device.**

OCR on thermal paper is unreliable by nature, so expect to correct a few rows.
Where the receipt's printed subtotal is legible, the review sheet cross-checks
the parsed items against it and warns when they disagree, which catches most
misread prices.

The parser skips payment/auth/card noise, strips leading barcodes and trailing
`2 @ 1.99` quantity tails, and pulls tax, tip, and any coupon or discount line
out of the lines it ignores.

## Assigning items

Tap names on each item, or describe who had what. The sentence goes to
`/api/assign` along with the current people and items, and Gemini returns any
new people it names and which items change hands. Items the sentence says
nothing about keep their current sharers, and anything it can't confidently
match is reported back rather than guessed.

## Configuration

Set these as Vercel environment variables.

| Variable | Default | Purpose |
|---|---|---|
| `GEMINI_API_KEY` | — | Required for Read with AI and sentence assignment. |
| `GEMINI_MODEL` | `gemini-2.5-flash` | The first model tried. |
| `GEMINI_FALLBACK_MODELS` | `gemini-2.5-flash-lite,gemini-flash-latest` | Tried in order when a model is busy. |
| `SCAN_PASSWORD` | unset | If set, AI requests need this passphrase. The app asks once and remembers it on the device. |
| `SCAN_DAILY_LIMIT` | `200` | Scans per day, per warm server instance. |
| `ASSIGN_DAILY_LIMIT` | `500` | Assignment requests per day, per warm server instance. |

The daily limits are a backstop against a runaway client, not a billing
guarantee: serverless instances are short-lived and can run in parallel.

## State

The receipt persists to `localStorage` under `split.receipt.v2`, and the photo
under `split.photo.v2`. They're kept separate so a photo too large to store
can't cost you the receipt.

Nothing leaves the device unless you use Read with AI or sentence assignment.
Those send the cropped image, or the item list and your sentence, to this
site's server and on to Google's Gemini API.
