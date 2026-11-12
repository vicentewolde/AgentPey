/**
 * Where a store keeps the files of its disputes' claims (T184, `Y-3`).
 *
 * Apart from the order record on purpose: an order is read on every request and rewritten on every change, and a few
 * photos would make it megabytes. A file is kept only after its hash matched an entry of the claim the escrow seals,
 * so this store never holds anything a claim did not name; it is keyed by order and hash.
 */
export interface EvidenceFile {
  readonly mediaType: string;
  readonly bytes: Buffer;
}

export interface EvidenceStore {
  get(orderId: string, sha256: string): Promise<EvidenceFile | undefined>;
  /** Idempotent: the same order and hash are the same bytes. */
  put(orderId: string, sha256: string, file: EvidenceFile): Promise<void>;
}

/** The default for a single store run locally, and for tests: gone on restart. */
export class MemoryEvidenceStore implements EvidenceStore {
  private readonly files = new Map<string, EvidenceFile>();

  async get(orderId: string, sha256: string): Promise<EvidenceFile | undefined> {
    const file = this.files.get(`${orderId}\n${sha256}`);
    return file === undefined ? undefined : { mediaType: file.mediaType, bytes: Buffer.from(file.bytes) };
  }

  async put(orderId: string, sha256: string, file: EvidenceFile): Promise<void> {
    this.files.set(`${orderId}\n${sha256}`, { mediaType: file.mediaType, bytes: Buffer.from(file.bytes) });
  }
}
