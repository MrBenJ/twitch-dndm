/** The server's only source of time (spec 2a §6.1 step 2). */
export interface Clock {
  now(): number;
  /** Calls fn at (or soon after) `at`. Returns a function that cancels it. */
  setTimer(at: number, fn: () => void): () => void;
}

const MAX_DELAY = 2 ** 31 - 1;

export const realClock: Clock = {
  now: () => Date.now(),
  setTimer(at, fn) {
    let handle: ReturnType<typeof setTimeout>;
    const arm = () => {
      const d = at - Date.now();
      if (d <= 0) fn();
      else handle = setTimeout(arm, Math.min(d, MAX_DELAY));
    };
    handle = setTimeout(arm, Math.min(Math.max(0, at - Date.now()), MAX_DELAY));
    return () => clearTimeout(handle);
  },
};

interface FakeTimer { at: number; seq: number; fn: () => void }

/** A clock tests move by hand. `settle` waits for the work a fired timer started (usually `room.idle()`). */
export class FakeClock implements Clock {
  private t: number;
  private timers: FakeTimer[] = [];
  private seq = 0;

  constructor(start = 0) {
    this.t = start;
  }

  now(): number {
    return this.t;
  }

  setTimer(at: number, fn: () => void): () => void {
    const timer = { at, seq: this.seq++, fn };
    this.timers.push(timer);
    return () => { this.timers = this.timers.filter((x) => x !== timer); };
  }

  async advanceTo(target: number, settle: () => Promise<void> = async () => {}): Promise<void> {
    for (;;) {
      await settle();
      const due = this.timers.filter((x) => x.at <= target).sort((a, b) => a.at - b.at || a.seq - b.seq)[0];
      if (!due) break;
      this.timers = this.timers.filter((x) => x !== due);
      this.t = Math.max(this.t, due.at);
      due.fn();
    }
    this.t = Math.max(this.t, target);
    await settle();
  }

  advance(ms: number, settle?: () => Promise<void>): Promise<void> {
    return this.advanceTo(this.t + ms, settle);
  }
}
