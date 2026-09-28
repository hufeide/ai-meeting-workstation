export class SingleFlight {
  private active = false;

  get isActive(): boolean {
    return this.active;
  }

  async run(task: () => Promise<void>): Promise<boolean> {
    if (this.active) return false;
    this.active = true;
    try {
      await task();
      return true;
    } finally {
      this.active = false;
    }
  }
}
