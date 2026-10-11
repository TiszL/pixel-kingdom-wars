/** A scene-owned candidate, never a document click. The caller excludes HUD,
 * object, placement and layout gestures and cancels on multi-touch/OS release. */
export class EmptyTapGesture {
  private candidate: { id: number; x: number; y: number } | null = null;
  constructor(private readonly threshold: number) {}
  begin(id: number, x: number, y: number, eligible: boolean): void {
    this.candidate = eligible ? { id, x, y } : null;
  }
  move(id: number, x: number, y: number): void {
    const start = this.candidate;
    if (start && start.id === id && Math.abs(x - start.x) + Math.abs(y - start.y) > this.threshold) this.cancel();
  }
  end(id: number, x: number, y: number, eligible: boolean): boolean {
    this.move(id, x, y);
    const accepted = eligible && this.candidate?.id === id;
    this.cancel();
    return accepted;
  }
  cancel(): void { this.candidate = null; }
}
