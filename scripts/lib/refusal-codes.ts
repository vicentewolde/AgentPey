/**
 * The refusal codes table the team reads, rendered from the same groups
 * RealOps shows people (`apps/realops/src/refusals.ts`).
 *
 * Generated rather than written by hand so it cannot drift: a test compares
 * the committed file with this output, and `pnpm run docs:refusal-codes`
 * rewrites it.
 */
import { REFUSAL_GROUPS } from "../../apps/realops/src/refusals.js";

export const REFUSAL_CODES_DOC = "docs/fase-6-agentguard-comercializacion/CODIGOS-DE-RECHAZO.md";

function cell(text: string): string {
  return text.replaceAll("|", "\\|").replaceAll("\n", " ");
}

export function renderRefusalCodesMarkdown(): string {
  const total = REFUSAL_GROUPS.reduce((sum, group) => sum + Object.keys(group.explanations).length, 0);
  const lines: string[] = [
    "# Códigos de rechazo: qué significa cada uno",
    "",
    "> Generado desde `apps/realops/src/refusals.ts` con `pnpm run docs:refusal-codes`.",
    "> No se edita a mano: un test falla si este archivo no coincide con el código.",
    "",
    "Cuando AgentPey rechaza una compra, responde con un **código** (por ejemplo",
    "`MandateDailyLimitExceeded`). El código es para quien integra: es estable y se",
    "puede usar en un programa. La persona no ve el código como explicación: RealOps",
    "lo traduce a las dos frases de esta tabla, en español o en inglés, y deja el",
    "código en letra chica como detalle técnico.",
    "",
    `Son ${total} códigos, agrupados por la capa que dice que no, en el orden en que`,
    "una compra pasa por ellas. Un código que no esté acá se muestra con una frase",
    "que dice que la página todavía no sabe explicarlo, y el motivo original queda",
    "como detalle técnico.",
    "",
  ];
  for (const group of REFUSAL_GROUPS) {
    lines.push(`## ${group.layer.es}`, "", "| Código | Qué ve la persona | Qué puede hacer |", "|---|---|---|");
    for (const [code, explained] of Object.entries(group.explanations)) {
      lines.push(`| \`${code}\` | ${cell(explained.what.es)} | ${cell(explained.next.es)} |`);
    }
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}
