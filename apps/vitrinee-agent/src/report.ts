/** How a verification reads on screen. Shared by the buy flow and `demo:verify`. */
import type { ReceiptVerification } from "@vitrinee/anchor";

const mark = (ok: boolean): string => (ok ? "✅" : "❌");

export function reportVerification(result: Pick<ReceiptVerification, "valid" | "hash" | "checks">, log: (line: string) => void): void {
  const { signature, anchored, settlement } = result.checks;
  log(`  hash         ${result.hash}`);
  log(`  ${mark(signature.ok)} firma      ${signature.ok ? `Ed25519 de ${signature.signer ?? "?"} (did:stellar del merchant)` : (signature.reason ?? "inválida")}`);
  log(
    `  ${mark(anchored.ok)} anclaje    ${
      anchored.ok && anchored.record !== undefined
        ? `receipt-registry ${anchored.registry ?? ""} · ledger ${anchored.record.ledger}`
        : (anchored.reason ?? "no anclado")
    }`,
  );
  log(`  ${mark(settlement.ok)} pago       ${settlement.ok ? `tx de settlement confirmada en Stellar · ledger ${settlement.ledger ?? "?"}` : (settlement.reason ?? "no confirmado")}`);
  log(`  ${result.valid ? "✅ RECIBO VÁLIDO" : "❌ RECIBO INVÁLIDO"}`);
}
