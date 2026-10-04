import { AgentPassError } from "@agentpass/core";

/**
 * JSON Canonicalization Scheme, RFC 8785: what UCP's AP2 extension signs
 * (`ap2.merchant_authorization`, T134). Object members sorted by their names'
 * UTF-16 code units, no whitespace, and numbers and strings serialized the
 * way ECMAScript's `JSON.stringify` does, which is the serialization RFC 8785
 * adopts. Only I-JSON values: a non-finite number, a lone surrogate or
 * anything that is not JSON is refused rather than given a meaning.
 */
export function jcsCanonicalize(value: unknown): string {
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new AgentPassError("Ap2MandateInvalid", "JCS cannot canonicalize a non-finite number");
    return JSON.stringify(value);
  }
  if (typeof value === "string") {
    if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value)) {
      throw new AgentPassError("Ap2MandateInvalid", "JCS cannot canonicalize a string with a lone surrogate");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((element) => jcsCanonicalize(element)).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, member]) => member !== undefined);
    // Array.prototype.sort compares UTF-16 code units: the order RFC 8785 asks for.
    entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([name, member]) => `${jcsCanonicalize(name)}:${jcsCanonicalize(member)}`).join(",")}}`;
  }
  throw new AgentPassError("Ap2MandateInvalid", `JCS cannot canonicalize a ${typeof value}`);
}
