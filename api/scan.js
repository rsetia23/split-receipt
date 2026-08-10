import { authorize, makeDailyLimiter } from "./_shared.js";
import { readReceipt, ENGINES, ReaderError } from "./_readers.js";

// Vision calls on a big receipt can take longer than the 10s default.
export const config = { maxDuration: 60 };

const MAX_IMAGE_BYTES = 4_000_000;
const consume = makeDailyLimiter(Number(process.env.SCAN_DAILY_LIMIT || 200));

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Use POST." });
  }

  const auth = authorize(req);
  if (auth.error) return res.status(auth.status).json({ error: auth.error });

  if (!consume()) {
    return res.status(429).json({
      error: "Daily scan limit reached. Try again tomorrow, or enter the items by hand.",
    });
  }

  const body = req.body || {};
  const engine = typeof body.engine === "string" && ENGINES[body.engine] ? body.engine : "claude";

  const image = typeof body.image === "string" ? body.image : "";
  const match = image.match(/^data:(image\/(?:jpeg|png|webp));base64,(.+)$/);
  if (!match) {
    return res.status(400).json({ error: "Send a base64 JPEG, PNG, or WebP data URL as `image`." });
  }
  if (match[2].length > MAX_IMAGE_BYTES) {
    return res.status(413).json({ error: "That image is too large. Crop tighter and try again." });
  }

  try {
    const result = await readReceipt({
      engine,
      keys: auth.keys,
      mediaType: match[1],
      data: match[2],
    });
    return res.status(200).json(result);
  } catch (err) {
    if (err instanceof ReaderError) {
      return res.status(err.status).json({ error: err.message });
    }
    const status = err?.status;
    if (status === 401 || status === 403) {
      return res.status(503).json({ error: "The server's API key was rejected." });
    }
    if (status === 429) {
      return res.status(429).json({ error: "Rate limited upstream. Try again in a moment." });
    }
    return res.status(502).json({ error: "Couldn't reach the reader. Try again, or scan offline." });
  }
}
