import type { InputManager } from '../input/InputManager.ts';

/** Safari exposes orientation permission as a static that does not exist everywhere. */
type PermissionfulOrientation = typeof DeviceOrientationEvent & {
  requestPermission?: () => Promise<'granted' | 'denied'>;
};

/**
 * Tilt steering: turn the phone like a handlebar.
 *
 * It feeds the same touch intent the on-screen pads use, so the simulation cannot tell the
 * difference and the two can never fight. The dead zone matters more than the range here —
 * holding a phone at a desk is not a permanent left turn.
 */
export class TiltSteering {
  private handler: ((event: DeviceOrientationEvent) => void) | null = null;
  private baselineGamma = 0;
  private baselineBeta = 0;
  private calibrated = false;

  constructor(private readonly input: InputManager) {}

  get active(): boolean {
    return this.handler !== null;
  }

  /** Must be called from a user gesture on iOS; resolves false when permission is refused. */
  async enable(): Promise<boolean> {
    if (this.handler) return true;
    if (typeof window.DeviceOrientationEvent !== 'function') return false;
    const ctor = DeviceOrientationEvent as PermissionfulOrientation;
    if (typeof ctor.requestPermission === 'function') {
      try {
        if ((await ctor.requestPermission()) !== 'granted') return false;
      } catch {
        return false;
      }
    }
    this.calibrated = false;
    this.handler = (event) => this.onOrientation(event);
    window.addEventListener('deviceorientation', this.handler);
    return true;
  }

  disable(): void {
    if (!this.handler) return;
    window.removeEventListener('deviceorientation', this.handler);
    this.handler = null;
    this.calibrated = false;
    const touch = this.input.touch;
    touch.steer = 0;
    touch.throttle = 0;
  }

  private onOrientation(event: DeviceOrientationEvent): void {
    const gamma = event.gamma;
    const beta = event.beta;
    if (gamma === null || beta === null) return;
    if (!this.calibrated) {
      // Take whatever pose the player is holding as neutral, once, on the first real sample.
      this.baselineGamma = gamma;
      this.baselineBeta = beta;
      this.calibrated = true;
      return;
    }
    const touch = this.input.touch;
    const steer = (gamma - this.baselineGamma) / 28;
    const pitch = (beta - this.baselineBeta) / 24;
    touch.active = true;
    touch.steer = withinDeadZone(steer, 0.12);
    // Tilting the top of the phone away opens the throttle; pulling it back brakes.
    touch.throttle = withinDeadZone(-pitch, 0.2);
    this.baselineGamma += steer * 0.02;
    this.baselineBeta += -pitch * 0.02;
  }
}

function withinDeadZone(value: number, dead: number): number {
  const clamped = Math.max(-1, Math.min(1, value));
  if (Math.abs(clamped) < dead) return 0;
  // Re-normalise past the dead zone so motion resumes smoothly instead of snapping.
  const sign = Math.sign(clamped);
  return sign * Math.min(1, (Math.abs(clamped) - dead) / (1 - dead));
}
