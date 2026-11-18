// An agent answers in free text: the JSON may be fenced, or followed by
// chatter. Take the first balanced `{...}` that parses as an object.
export class NoJsonError extends Error {
  constructor(message = "no JSON object in the answer") {
    super(message);
    this.name = "NoJsonError";
  }
}

// End index (inclusive) of the balanced object starting at `start`, string-aware.
function balancedEnd(text, start) {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return i;
  }
  return -1;
}

export function firstJsonObject(text) {
  if (typeof text !== "string") throw new NoJsonError();
  for (let start = text.indexOf("{"); start >= 0; start = text.indexOf("{", start + 1)) {
    const end = balancedEnd(text, start);
    if (end < 0) continue;
    try {
      const value = JSON.parse(text.slice(start, end + 1));
      if (value && typeof value === "object" && !Array.isArray(value)) return value;
    } catch {
      // not JSON (prose braces): try the next opening brace
    }
  }
  throw new NoJsonError();
}
