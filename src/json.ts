// Strict JSON: refuses an object with the same key twice. JSON.parse quietly keeps the last
// value, so {"amount": 49, "amount": 4900} reads as 4900 here and maybe as 49 somewhere
// else. Model answers and gateway requests with a repeated key are refused instead.

export class DuplicateKeyError extends Error {
  constructor(readonly key: string) {
    super(`the key "${key}" appears twice in one object`);
  }
}

// The first key that appears twice in one object, or null. Expects valid JSON; on anything
// else it returns null and leaves the error to JSON.parse.
export function duplicateKey(text: string): string | null {
  const stack: (Set<string> | null)[] = []; // a Set per open object, null per open array
  let expectKey = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      if (j >= text.length) return null;
      const keys = stack.at(-1);
      if (expectKey && keys) {
        let key: string;
        try {
          key = JSON.parse(text.slice(i, j + 1));
        } catch {
          return null;
        }
        if (keys.has(key)) return key;
        keys.add(key);
      }
      expectKey = false;
      i = j;
    } else if (c === "{") {
      stack.push(new Set());
      expectKey = true;
    } else if (c === "[") {
      stack.push(null);
      expectKey = false;
    } else if (c === "}" || c === "]") {
      stack.pop();
      expectKey = false;
    } else if (c === ",") {
      expectKey = stack.at(-1) instanceof Set;
    }
  }
  return null;
}

// JSON.parse, but a repeated key throws DuplicateKeyError.
export function parseStrict(text: string): unknown {
  const value = JSON.parse(text);
  const dup = duplicateKey(text);
  if (dup !== null) throw new DuplicateKeyError(dup);
  return value;
}
