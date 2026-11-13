// SYNTHETIC FIXTURE — written for harness-visualizer; not production code.
export class BudgetExceeded extends Error {}

export class TokenBudget {
  private used = 0;
  constructor(private readonly limit: number) {}

  consume(tokens: number) {
    this.used += tokens;
    if (this.used > this.limit) {
      throw new BudgetExceeded(`token budget exceeded: ${this.used}/${this.limit}`);
    }
  }
}
