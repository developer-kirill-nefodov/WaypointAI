export interface ActiveTurn {
  requestId: string;
  controller: AbortController;
}

export class ActiveTurnGate {
  #active: ActiveTurn | undefined;

  get current(): ActiveTurn | undefined {
    return this.#active;
  }

  tryAcquire(turn: ActiveTurn): boolean {
    if (this.#active) return false;
    this.#active = turn;
    return true;
  }

  release(turn: ActiveTurn): void {
    if (this.#active === turn) this.#active = undefined;
  }
}
