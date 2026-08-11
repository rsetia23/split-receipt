import { authorize, makeDailyLimiter } from "./_shared.js";
import { ENGINES, ProviderError } from "./_providers.js";
import { assignSplit } from "./_assist.js";

export const config = { maxDuration: 30 };

const MAX_PEOPLE = 24;
const MAX_ITEMS = 200;
const MAX_INSTRUCTION = 2000;

const consume = makeDailyLimiter(Number(process.env.ASSIGN_DAILY_LIMIT || 500));

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Use POST." });
  }

  const auth = authorize(req);
  if (auth.error) return res.status(auth.status).json({ error: auth.error });

  if (!consume()) {
    return res.status(429).json({ error: "Daily limit reached. Assign by tapping names instead." });
  }

  const body = req.body || {};
  const engine = typeof body.engine === "string" && ENGINES[body.engine] ? body.engine : "claude";
  const people = (Array.isArray(body.people) ? body.people : []).map((n) => String(n).slice(0, 40));
  const items = Array.isArray(body.items) ? body.items : [];
  const instruction = typeof body.instruction === "string" ? body.instruction.trim() : "";

  if (!items.length) return res.status(400).json({ error: "Add some items first." });
  if (!instruction) return res.status(400).json({ error: "Say who had what." });
  if (people.length > MAX_PEOPLE || items.length > MAX_ITEMS) {
    return res.status(413).json({ error: "That's more people or items than this can handle." });
  }
  if (instruction.length > MAX_INSTRUCTION) {
    return res.status(413).json({ error: "That instruction is too long." });
  }

  try {
    const result = await assignSplit({ engine, keys: auth.keys, people, items, instruction });
    return res.status(200).json(result);
  } catch (err) {
    if (err instanceof ProviderError) {
      return res.status(err.status).json({ error: err.message });
    }
    const status = Number(err?.status) || 0;
    const detail = String(err?.message || err || "").slice(0, 400);
    console.error("[assign] engine=%s status=%s %s", engine, status || "?", detail);

    if (status === 401 || status === 403) {
      return res.status(503).json({ error: "The server's API key was rejected.", detail });
    }
    if (status === 429) {
      return res.status(429).json({ error: "Rate limited upstream. Try again in a moment.", detail });
    }
    return res.status(502).json({ error: "Couldn't reach the assistant. Assign by tapping names instead.", detail });
  }
}
