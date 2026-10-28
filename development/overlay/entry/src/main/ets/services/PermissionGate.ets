import { isLearningOrigin } from './NavigationPolicy';

export const AUDIO_RESOURCE: string = 'TYPE_AUDIO_CAPTURE';

class PendingDecision {
  private settled: boolean = false;
  private decide: (resources: string[]) => void;
  private isCurrent: () => boolean;

  constructor(decide: (resources: string[]) => void, isCurrent: () => boolean) {
    this.decide = decide;
    this.isCurrent = isCurrent;
  }

  finish(resources: string[]): void {
    if (!this.settled) {
      this.settled = true;
      this.decide(resources.length > 0 && this.isCurrent() ? resources : []);
    }
  }
}

class PermissionBatch {
  decisions: PendingDecision[] = [];

  finish(granted: boolean): void {
    for (const decision of this.decisions) { decision.finish(granted ? [AUDIO_RESOURCE] : []); }
    this.decisions = [];
  }
}

export class PermissionGate {
  private generation: number = 0;
  private denied: boolean = false;
  private pending: PermissionBatch | undefined = undefined;

  // Navigation, backgrounding, hiding a window, and destruction invalidate pending grants.
  invalidate(): void {
    this.generation++;
    this.denied = false;
    this.pending?.finish(false);
    this.pending = undefined;
  }

  async request(origin: string, resources: string[], askSystem: (allowPrompt: boolean) => Promise<boolean>,
    isCurrent: () => boolean, decide: (resources: string[]) => void): Promise<void> {
    if (!isCurrent() || !isLearningOrigin(origin) ||
      resources.indexOf(AUDIO_RESOURCE) < 0) {
      decide([]);
      return;
    }
    const decision = new PendingDecision(decide, isCurrent);
    // A page can request audio from several consumers at once. One OS decision serves them all.
    if (this.pending) {
      if (this.pending.decisions.length < 8) { this.pending.decisions.push(decision); }
      else { decision.finish([]); }
      return;
    }
    const generation = this.generation;
    const pending = new PermissionBatch();
    pending.decisions.push(decision);
    this.pending = pending;
    let granted = false;
    try {
      // After a denial, recheck current permission but do not reopen the OS dialog in a loop.
      granted = await askSystem(!this.denied);
    } catch {
      granted = false;
    }
    // A previous system dialog can outlive its document; never grant to its replacement.
    if (generation === this.generation && this.pending === pending) {
      this.denied = !granted;
      this.pending = undefined;
      pending.finish(granted);
    } else {
      pending.finish(false);
    }
  }
}
