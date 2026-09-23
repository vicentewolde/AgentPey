/**
 * Units held by paid checkouts that are still in flight. Two agents paying
 * for the last unit at once: the second is refused with 409 *before* its
 * payment settles, instead of paying for something already sold.
 */
export class Reservations {
  private readonly held = new Map<string, number>();

  reserved(productId: string): number {
    return this.held.get(productId) ?? 0;
  }

  /** Holds `quantity` if `stock - reserved` allows it. `null` stock means untracked. */
  tryReserve(productId: string, quantity: number, stock: number | null): boolean {
    if (stock !== null && stock - this.reserved(productId) < quantity) return false;
    this.held.set(productId, this.reserved(productId) + quantity);
    return true;
  }

  release(productId: string, quantity: number): void {
    const left = this.reserved(productId) - quantity;
    if (left > 0) this.held.set(productId, left);
    else this.held.delete(productId);
  }
}
