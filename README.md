# Split

A receipt splitter. Assign each item to whoever actually shared it; tax and tip
are then divided in proportion to what each person ordered, rather than evenly.

One self-contained `index.html` — no build step, no dependencies, no server.
Open the file directly or serve the folder statically.

## How the math works

Each item is split evenly among the people assigned to it. Everyone's subtotal
is the sum of their shares. Tax and tip are allocated by each person's fraction
of the overall subtotal:

```
total[p] = subtotal[p] + (subtotal[p] / overall_subtotal) * (tax + tip)
```

Per-person totals are rounded by largest remainder, so the individual shares
always sum to the exact bill total instead of drifting a cent.

Items assigned to nobody are excluded from the total and flagged in the UI,
so a data-entry mistake surfaces instead of silently vanishing.

## Receipt scanning

Optional. A photo is preprocessed in-browser (downscale/upscale to a workable
size, grayscale, Otsu threshold) and read with tesseract.js, which is lazy-loaded
from a CDN on first use and cached afterward. **The image never leaves the
device.**

OCR on thermal paper is unreliable by nature, so a scan never writes straight
into the ledger — it proposes rows you confirm and correct. Where the receipt's
printed subtotal is legible, the review sheet cross-checks the parsed items
against it and warns when they disagree, which catches most misread prices.

The parser skips payment/auth/card noise, strips leading barcodes and trailing
`2 @ 1.99` quantity tails, and pulls tax and tip out of the lines it ignores.

## State

Everything persists to `localStorage` under `split.receipt.v1`. There is no
backend and nothing is transmitted.
