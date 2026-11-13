/**
 * Sealed evidence for a claim — T184, `Y-3`.
 *
 * A claim names each file it brings by its sha256, type, size and name; the file itself never goes on chain nor in the
 * claim. The claim is signed and its own sha256 is the escrow's `claim_hash`, so the 32 bytes on chain seal every file
 * the claim lists: a file changed afterwards no longer matches its entry.
 *
 * The store keeps the files of an order's claim and hands one out only on a read link signed by someone in that
 * dispute (the arbiter, the payout account, or the claimant) with their own Stellar key, for a few minutes. No shared
 * secret: the store checks the signature against the accounts the escrow and the claim name.
 *
 * Kept free of the arbiter's model client so the store can import it (`@agentpey/resolve/evidence`).
 */
import { createHash } from "node:crypto";

import { Keypair } from "@stellar/stellar-sdk";
import { z } from "zod";

/** What a claim may bring: photos and PDFs. Anything else is refused before it is hashed into a claim. */
export const EVIDENCE_MEDIA_TYPES = ["image/jpeg", "image/png", "image/webp", "application/pdf"] as const;
export type EvidenceMediaType = (typeof EVIDENCE_MEDIA_TYPES)[number];

/** A phone photo fits; a video does not. The store refuses a larger body before reading it whole. */
export const MAX_EVIDENCE_FILE_BYTES = 2 * 1024 * 1024;

/** How far ahead a read link may expire: long enough to download, short enough that a leaked link soon dies. */
export const EVIDENCE_READ_MAX_SECONDS = 15 * 60;

const EXTENSIONS: Readonly<Record<EvidenceMediaType, string>> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "application/pdf": "pdf" };

export const fileEvidenceSchema = z.strictObject({
  kind: z.literal("file"),
  /** sha256 of the file's bytes, lowercase hex: what seals it. */
  sha256: z.string().regex(/^[0-9a-f]{64}$/, "expected a lowercase hex sha256"),
  mediaType: z.enum(EVIDENCE_MEDIA_TYPES),
  bytes: z.number().int().min(1).max(MAX_EVIDENCE_FILE_BYTES),
  /** The claimant's own name for it, shown to people; never used as a path. */
  name: z.string().trim().min(1).max(200),
});
export type FileEvidence = z.infer<typeof fileEvidenceSchema>;

export function evidenceFileHash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** The type a file's first bytes say it is, or `null` for anything not allowed. The declared type must agree. */
export function sniffEvidenceType(bytes: Uint8Array): EvidenceMediaType | null {
  const b = Buffer.from(bytes.subarray(0, 12));
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (b.length >= 12 && b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  if (b.length >= 5 && b.subarray(0, 5).toString("latin1") === "%PDF-") return "application/pdf";
  return null;
}

export function evidenceExtension(mediaType: EvidenceMediaType): string {
  return EXTENSIONS[mediaType];
}

/** The entry a claim lists for these bytes. @returns null when the type is not allowed or the file is too large. */
export function fileEvidenceFor(bytes: Uint8Array, name: string): FileEvidence | null {
  const mediaType = sniffEvidenceType(bytes);
  if (mediaType === null || bytes.byteLength < 1 || bytes.byteLength > MAX_EVIDENCE_FILE_BYTES) return null;
  return fileEvidenceSchema.parse({ kind: "file", sha256: evidenceFileHash(bytes), mediaType, bytes: bytes.byteLength, name: name.trim().slice(0, 200) || "evidence" });
}

/**
 * How a file reaches a claim from a chat (T185): the evidence page hashes the file in the person's browser and shows
 * this code, the person pastes it into the chat, and `open_claim` turns it back into the claim's entry. The bytes never
 * pass through the chat or the model; the store later takes them only if they match the sealed entry.
 * `ap-evidence:v1:<sha256>:<media type>:<bytes>:<name>`; the name is last, so it may itself hold a colon.
 */
export const EVIDENCE_CODE_PREFIX = "ap-evidence:v1:";

export function evidenceCode(file: FileEvidence): string {
  return `${EVIDENCE_CODE_PREFIX}${file.sha256}:${file.mediaType}:${file.bytes}:${file.name}`;
}

export function isEvidenceCode(text: string): boolean {
  return text.trim().startsWith(EVIDENCE_CODE_PREFIX);
}

/** The claim's entry an evidence code names. @returns null for a code that does not read: never a guess. */
export function parseEvidenceCode(code: string): FileEvidence | null {
  const text = code.trim();
  if (!text.startsWith(EVIDENCE_CODE_PREFIX)) return null;
  const match = /^([0-9a-f]{64}):([a-z]+\/[a-z0-9.+-]+):([0-9]{1,9}):(.+)$/s.exec(text.slice(EVIDENCE_CODE_PREFIX.length));
  if (match === null) return null;
  const parsed = fileEvidenceSchema.safeParse({ kind: "file", sha256: match[1], mediaType: match[2], bytes: Number(match[3]), name: match[4] });
  return parsed.success ? parsed.data : null;
}

/** The files among a claim's evidence. */
export function claimFiles(evidence: readonly { readonly kind: string }[]): FileEvidence[] {
  return evidence.flatMap((item) => {
    const parsed = fileEvidenceSchema.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  });
}

export interface EvidenceRead {
  /** The escrow contract the dispute lives in: a link for one store never opens another's file. */
  readonly escrow: string;
  readonly orderId: string;
  readonly sha256: string;
  /** The `G...` account that signs the link. */
  readonly reader: string;
  /** Unix seconds. */
  readonly expiresAt: number;
}

/** The exact bytes a reader signs. Line-separated, with a version, so no field can run into another. */
export function evidenceReadMessage(read: EvidenceRead): Buffer {
  return Buffer.from(["agentresolve-evidence-read:v1", read.escrow, read.orderId, read.sha256, read.reader, String(read.expiresAt)].join("\n"), "utf8");
}

/** A read link's query: `reader`, `exp` and `sig` (hex Ed25519). */
export function signEvidenceRead(keypair: Keypair, read: Omit<EvidenceRead, "reader">): URLSearchParams {
  const full: EvidenceRead = { ...read, reader: keypair.publicKey() };
  return new URLSearchParams({ reader: full.reader, exp: String(full.expiresAt), sig: Buffer.from(keypair.sign(evidenceReadMessage(full))).toString("hex") });
}

/** Whether `sig` is the reader's signature over this read. Never throws: a malformed key or signature is `false`. */
export function verifyEvidenceRead(read: EvidenceRead, sigHex: string): boolean {
  if (!/^[0-9a-f]{128}$/.test(sigHex)) return false;
  try {
    return Keypair.fromPublicKey(read.reader).verify(evidenceReadMessage(read), Buffer.from(sigHex, "hex"));
  } catch {
    return false;
  }
}
