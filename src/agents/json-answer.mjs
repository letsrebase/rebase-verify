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

// The one repair: a comma before a closing `}` or `]` (outside strings) is dropped.
function withoutTrailingCommas(span) {
  let out = "";
  let inString = false;
  for (let i = 0; i < span.length; i++) {
    const ch = span[i];
    if (inString) {
      out += ch;
      if (ch === "\\") out += span[++i] ?? "";
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
      out += ch;
    } else if (ch === ",") {
      let j = i + 1;
      while (j < span.length && /\s/.test(span[j])) j++;
      if (span[j] !== "}" && span[j] !== "]") out += ch;
    } else out += ch;
  }
  return out;
}

const parseObject = (span) => {
  const value = JSON.parse(span);
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
};

export function firstJsonObject(text) {
  if (typeof text !== "string") throw new NoJsonError();
  for (let start = text.indexOf("{"); start >= 0; start = text.indexOf("{", start + 1)) {
    const end = balancedEnd(text, start);
    if (end < 0) continue;
    const span = text.slice(start, end + 1);
    for (const candidate of [span, withoutTrailingCommas(span)]) {
      try {
        const value = parseObject(candidate);
        if (value) return value;
      } catch {
        // not JSON as it stands; the second candidate drops trailing commas
      }
    }
    // A balanced span that is not JSON (prose braces) is skipped WHOLE,
    // so a broken outer object never yields one of its inner objects.
    start = end;
  }
  throw new NoJsonError();
}
