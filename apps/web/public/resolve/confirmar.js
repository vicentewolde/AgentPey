/**
 * What the buyer's confirmation page checks before it asks their wallet to sign (T185, `Y-1`).
 *
 * The store prepares the transaction, and the store is the party that gets paid when it lands. So the page reads the
 * XDR itself and hands it to the wallet only when it is exactly `confirm(order)` on the escrow the assistant's link
 * names, from the account that must sign, with one operation and a small fee. Anything else is refused here, before
 * the wallet sees it. Plain XDR reading, no library: only the fields this check needs, and any shape it does not
 * expect is a refusal.
 */
import { contractIdBytes, publicKeyBytes } from "./responder.js";

/** A `confirm` costs a few hundredths of a lumen (the rehearsal one: 23 625 stroops); refuse anything near a lumen. */
export const MAX_CONFIRM_FEE_STROOPS = 1_000_000;

const ENVELOPE_TYPE_TX = 2;
const KEY_TYPE_ED25519 = 0;
const PRECOND_NONE = 0;
const PRECOND_TIME = 1;
const MEMO_NONE = 0;
const INVOKE_HOST_FUNCTION = 24;
const HOST_FUNCTION_TYPE_INVOKE_CONTRACT = 0;
const SC_ADDRESS_TYPE_CONTRACT = 1;
const SCV_BYTES = 13;
const SOROBAN_CREDENTIALS_SOURCE_ACCOUNT = 0;

function reader(bytes) {
  let at = 0;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const need = (n) => {
    if (at + n > bytes.byteLength) throw new Error("short");
  };
  return {
    u32() { need(4); const v = view.getUint32(at); at += 4; return v; },
    i32() { need(4); const v = view.getInt32(at); at += 4; return v; },
    skip(n) { need(n); at += n; },
    fixed(n) { need(n); const v = bytes.slice(at, at + n); at += n; return v; },
    opaque(max) {
      const length = this.u32();
      if (length > max) throw new Error("long");
      const v = this.fixed(length);
      this.skip((4 - (length % 4)) % 4);
      return v;
    },
  };
}

function base64Bytes(text) {
  const binary = atob(String(text));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

function same(a, b) {
  return a !== null && b !== null && a.length === b.length && a.every((byte, i) => byte === b[i]);
}

/**
 * `null` when `xdr` is exactly the confirmation to sign; otherwise a short reason, for the page's log.
 * @param {string} xdr base64 TransactionEnvelope, as the store prepared it
 * @param {{ escrow: string, orderId: string, source: string }} expected
 */
export function checkConfirmXdr(xdr, expected) {
  const escrow = contractIdBytes(expected.escrow);
  const source = publicKeyBytes(expected.source);
  if (escrow === null || source === null) return "bad expectation";
  const order = new TextEncoder().encode(String(expected.orderId));
  try {
    const r = reader(base64Bytes(xdr));
    if (r.i32() !== ENVELOPE_TYPE_TX) return "not a plain transaction";
    if (r.i32() !== KEY_TYPE_ED25519 || !same(r.fixed(32), source)) return "another source account";
    if (r.u32() > MAX_CONFIRM_FEE_STROOPS) return "fee too high";
    r.skip(8); // sequence number
    const cond = r.i32();
    if (cond === PRECOND_TIME) r.skip(16);
    else if (cond !== PRECOND_NONE) return "unexpected preconditions";
    if (r.i32() !== MEMO_NONE) return "unexpected memo";
    if (r.u32() !== 1) return "not exactly one operation";
    if (r.u32() !== 0) return "the operation has its own source";
    if (r.i32() !== INVOKE_HOST_FUNCTION) return "not a contract call";
    if (r.i32() !== HOST_FUNCTION_TYPE_INVOKE_CONTRACT) return "not a contract call";
    if (r.i32() !== SC_ADDRESS_TYPE_CONTRACT || !same(r.fixed(32), escrow)) return "another contract";
    if (new TextDecoder().decode(r.opaque(32)) !== "confirm") return "not confirm";
    if (r.u32() !== 1) return "unexpected arguments";
    if (r.i32() !== SCV_BYTES || !same(r.opaque(256), order)) return "another order";
    const auth = r.u32();
    if (auth > 1) return "unexpected authorizations";
    if (auth === 1 && r.i32() !== SOROBAN_CREDENTIALS_SOURCE_ACCOUNT) return "an authorization other than the source account";
    return null;
  } catch (e) {
    return "unreadable transaction";
  }
}
