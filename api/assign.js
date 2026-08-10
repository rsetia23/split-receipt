import Anthropic from "@anthropic-ai/sdk";
import { authorize, makeDailyLimiter } from "./_shared.js";

export const config = { maxDuration: 30 };

const MODEL = "claude-haiku-4-5";
const MAX_PEOPLE = 24;
const MAX_NEW_PEOPLE = 16;
const MAX_ITEMS = 200;
const MAX_INSTRUCTION = 2000;

const consume = makeDailyLimiter(Number(process.env.ASSIGN_DAILY_LIMIT || 500));

const SYSTEM = `You work out who shared which items on a receipt, from a sentence describing the meal or shop.

You are given the people already known (possibly none), the items (by index, with who currently shares each), and an instruction. Return any people who need creating, and which items change hands.

People:
- If the instruction names someone not already known, add their name to "new_people" exactly once, spelled as the user spelled it.
- Never add someone who is already known, even if capitalised differently — reuse the existing spelling instead.
- "new_people" is only for people who genuinely appear in the instruction. Do not invent names to fill gaps.

Assignments:
- Refer to people by name in "assignments", using either an existing name or one you listed in "new_people". Never use a name that appears in neither.
- Only return an entry for an item whose sharers the instruction actually determines. Items it says nothing about keep what they have — leave them out entirely.
- "we all", "everyone", "shared", "split it" with no names means every person, including any you just created.
- Match items by meaning, not exact wording: "the seafood" matches "Grilled Shrimp Platter"; "drinks" may cover several lines.
- One phrase can cover several items ("we all had drinks" with three drink lines assigns all three).
- The instruction may correct what's already there ("actually Arjun skipped dessert"). Apply it as a change to the current state.
- If the instruction clearly refers to an item you cannot confidently identify, put that item's index in "unmatched", or explain in "note".
- Never guess. An item you are unsure about should be left out, not assigned. Leaving an item alone is recoverable; a wrong assignment silently moves money between people.
- "note" is one short sentence for the user, only when something needs saying — otherwise null.`;

function schemaFor(itemCount) {
  const itemIndices = Array.from({ length: itemCount }, (_, i) => i);
  return {
    type: "object",
    properties: {
      new_people: {
        type: "array",
        description: "Names of people to create, in the order first mentioned.",
        items: { type: "string" },
      },
      assignments: {
        type: "array",
        items: {
          type: "object",
          properties: {
            item: { type: "integer", enum: itemIndices },
            people: { type: "array", items: { type: "string" } },
          },
          required: ["item", "people"],
          additionalProperties: false,
        },
      },
      unmatched: { type: "array", items: { type: "integer", enum: itemIndices } },
      note: { anyOf: [{ type: "string" }, { type: "null" }] },
    },
    required: ["new_people", "assignments", "unmatched", "note"],
    additionalProperties: false,
  };
}

const key = (name) => String(name).trim().toLowerCase();

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

  const roster = people.length
    ? people.map((n) => `- ${n}`).join("\n")
    : "(nobody yet — create everyone the instruction names)";
  const lines = items
    .map((it, i) => {
      const shared = Array.isArray(it.shared) ? it.shared : [];
      const who = shared.length ? shared.join(", ") : "nobody";
      return `${i}: ${String(it.name || "Item").slice(0, 60)} — $${Number(it.price || 0).toFixed(2)} — currently: ${who}`;
    })
    .join("\n");

  try {
    if (!auth.keys.anthropic) {
      return res.status(503).json({ error: "The assistant isn't configured on this deployment." });
    }
    const client = new Anthropic({ apiKey: auth.keys.anthropic });
    const message = await client.messages.create({
      model: MODEL,
      max_tokens: 4096,
      system: SYSTEM,
      output_config: { format: { type: "json_schema", schema: schemaFor(items.length) } },
      messages: [
        {
          role: "user",
          content: `People already known:\n${roster}\n\nItems:\n${lines}\n\nInstruction:\n${instruction}`,
        },
      ],
    });

    if (message.stop_reason === "refusal") {
      return res.status(422).json({ error: "The model declined that request." });
    }

    const text = message.content.find((b) => b.type === "text")?.text;
    if (!text) return res.status(502).json({ error: "The model returned nothing readable." });

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return res.status(502).json({ error: "The model's response wasn't valid JSON." });
    }

    // Resolve every name the model used back to a real person. A name that
    // matches neither the roster nor a declared new person is dropped rather
    // than trusted — the preview then shows that item as unchanged.
    const known = new Map(people.map((n) => [key(n), n]));
    const newPeople = [];
    for (const raw of Array.isArray(parsed.new_people) ? parsed.new_people : []) {
      const name = String(raw || "").trim().slice(0, 40);
      if (!name) continue;
      if (known.has(key(name))) continue; // already exists, in any casing
      if (newPeople.length >= MAX_NEW_PEOPLE) break;
      known.set(key(name), name);
      newPeople.push(name);
    }

    const validItem = (i) => Number.isInteger(i) && i >= 0 && i < items.length;
    const dropped = new Set();

    const assignments = (Array.isArray(parsed.assignments) ? parsed.assignments : [])
      .filter((a) => a && validItem(a.item) && Array.isArray(a.people))
      .map((a) => {
        const resolved = [];
        for (const raw of a.people) {
          const name = known.get(key(raw));
          if (!name) { dropped.add(a.item); continue; }
          if (resolved.indexOf(name) === -1) resolved.push(name);
        }
        return { item: a.item, people: resolved };
      });

    const unmatched = new Set(
      (Array.isArray(parsed.unmatched) ? parsed.unmatched : []).filter(validItem),
    );
    dropped.forEach((i) => unmatched.add(i));

    return res.status(200).json({
      newPeople,
      assignments,
      unmatched: [...unmatched],
      note: typeof parsed.note === "string" && parsed.note.trim() ? parsed.note.trim() : null,
    });
  } catch (err) {
    const status = Number(err?.status) || 0;
    const detail = String(err?.message || err || "").slice(0, 400);
    console.error("[assign] status=%s %s", status || "?", detail);

    if (status === 401 || status === 403) {
      return res.status(503).json({ error: "The server's API key was rejected.", detail });
    }
    if (status === 429) {
      return res.status(429).json({ error: "Rate limited upstream. Try again in a moment.", detail });
    }
    return res.status(502).json({ error: "Couldn't reach the assistant. Assign by tapping names instead.", detail });
  }
}
