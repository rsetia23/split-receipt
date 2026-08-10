import Anthropic from "@anthropic-ai/sdk";
import { authorize, makeDailyLimiter } from "./_shared.js";

export const config = { maxDuration: 30 };

const MODEL = "claude-haiku-4-5";
const MAX_PEOPLE = 24;
const MAX_ITEMS = 200;
const MAX_INSTRUCTION = 2000;

const consume = makeDailyLimiter(Number(process.env.ASSIGN_DAILY_LIMIT || 500));

const SYSTEM = `You assign receipt line items to the people who shared them, based on a sentence describing who had what.

You are given the people (by index), the items (by index, with their current sharers), and an instruction. Return which items the instruction determines, and who shares each.

Rules:
- Only return an entry for an item whose sharers the instruction actually determines. Items the instruction says nothing about keep what they already have — leave them out entirely.
- "we all", "everyone", "shared", "split it" with no names means every person.
- Match items by meaning, not exact wording: "the seafood" matches "Grilled Shrimp Platter"; "drinks" may match several items.
- One phrase can cover several items ("we all had drinks" with three drink lines assigns all three).
- People may be named partially or informally. Match to the closest person, but only when it is unambiguous.
- The instruction may be a correction of the current state ("actually Arjun skipped dessert"). Apply it as a change to what's there now.
- If the instruction clearly refers to something you cannot confidently match to an item, list that item index in "unmatched" if you can identify it, and otherwise explain in "note".
- Never guess. An item you are unsure about should be left out, not assigned. Leaving an item alone is always recoverable; a wrong assignment silently moves money between people.
- "note" is one short sentence for the user only when something needs saying — otherwise null.`;

function schemaFor(peopleCount, itemCount) {
  const personIndices = Array.from({ length: peopleCount }, (_, i) => i);
  const itemIndices = Array.from({ length: itemCount }, (_, i) => i);
  return {
    type: "object",
    properties: {
      assignments: {
        type: "array",
        items: {
          type: "object",
          properties: {
            item: { type: "integer", enum: itemIndices },
            people: {
              type: "array",
              items: { type: "integer", enum: personIndices },
            },
          },
          required: ["item", "people"],
          additionalProperties: false,
        },
      },
      unmatched: { type: "array", items: { type: "integer", enum: itemIndices } },
      note: { anyOf: [{ type: "string" }, { type: "null" }] },
    },
    required: ["assignments", "unmatched", "note"],
    additionalProperties: false,
  };
}

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
  const people = Array.isArray(body.people) ? body.people : [];
  const items = Array.isArray(body.items) ? body.items : [];
  const instruction = typeof body.instruction === "string" ? body.instruction.trim() : "";

  if (!people.length || !items.length) {
    return res.status(400).json({ error: "Add people and items first." });
  }
  if (people.length > MAX_PEOPLE || items.length > MAX_ITEMS) {
    return res.status(413).json({ error: "That's more people or items than this can handle." });
  }
  if (!instruction) {
    return res.status(400).json({ error: "Say who had what." });
  }
  if (instruction.length > MAX_INSTRUCTION) {
    return res.status(413).json({ error: "That instruction is too long." });
  }

  const roster = people
    .map((name, i) => `${i}: ${String(name).slice(0, 40) || "Unnamed"}`)
    .join("\n");
  const lines = items
    .map((it, i) => {
      const shared = Array.isArray(it.shared) ? it.shared : [];
      const who = shared.length ? shared.join(",") : "nobody";
      return `${i}: ${String(it.name || "Item").slice(0, 60)} — $${Number(it.price || 0).toFixed(2)} — currently: ${who}`;
    })
    .join("\n");

  try {
    const client = new Anthropic({ apiKey: auth.apiKey });
    const message = await client.messages.create({
      model: MODEL,
      max_tokens: 4096,
      system: SYSTEM,
      output_config: { format: { type: "json_schema", schema: schemaFor(people.length, items.length) } },
      messages: [
        {
          role: "user",
          content:
            `People:\n${roster}\n\nItems:\n${lines}\n\nInstruction:\n${instruction}`,
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

    // Belt and braces: the schema already constrains indices to what exists,
    // but never trust generated output to address our data structures.
    const validItem = (i) => Number.isInteger(i) && i >= 0 && i < items.length;
    const validPerson = (i) => Number.isInteger(i) && i >= 0 && i < people.length;

    const assignments = (Array.isArray(parsed.assignments) ? parsed.assignments : [])
      .filter((a) => a && validItem(a.item) && Array.isArray(a.people))
      .map((a) => ({
        item: a.item,
        people: Array.from(new Set(a.people.filter(validPerson))),
      }));

    return res.status(200).json({
      assignments,
      unmatched: (Array.isArray(parsed.unmatched) ? parsed.unmatched : []).filter(validItem),
      note: typeof parsed.note === "string" && parsed.note.trim() ? parsed.note.trim() : null,
    });
  } catch (err) {
    const status = err?.status;
    if (status === 401) return res.status(503).json({ error: "The server's API key was rejected." });
    if (status === 429) return res.status(429).json({ error: "Rate limited upstream. Try again in a moment." });
    return res.status(502).json({ error: "Couldn't reach the assistant. Assign by tapping names instead." });
  }
}
