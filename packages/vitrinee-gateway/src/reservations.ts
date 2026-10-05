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

  /**
   * Holds every request, or none (T148): a checkout whose second product is
   * gone must not keep the first one held. Returns the product that could not
   * be held, or `null` when all were.
   */
  tryReserveAll(requests: readonly { productId: string; quantity: number; stock: number | null }[]): string | null {
    const held: { productId: string; quantity: number }[] = [];
    for (const request of requests) {
      if (!this.tryReserve(request.productId, request.quantity, request.stock)) {
        this.releaseAll(held);
        return request.productId;
      }
      held.push(request);
    }
    return null;
  }

  releaseAll(requests: readonly { productId: string; quantity: number }[]): void {
    for (const request of requests) this.release(request.productId, request.quantity);
  }
}
