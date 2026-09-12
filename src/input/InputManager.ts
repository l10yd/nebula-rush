import { clamp } from '../utils/math.ts';
import type { InputAction } from '../data/types.ts';

/** A normalised, device-agnostic snapshot of the player's intent for one simulation step. */
export interface InputFrame {
  /** -1 brake/reverse … +1 throttle. */
  throttle: number;
  /** -1 left … +1 right. */
  steer: number;
  boost: boolean;
  drift: boolean;
  /** Edge-triggered: true for exactly one frame after activation. */
  abilityPressed: boolean;
  pausePressed: boolean;
  restartPressed: boolean;
}

export interface TouchState {
  active: boolean;
  steer: number;
  throttle: number;
  boost: boolean;
  drift: boolean;
  ability: boolean;
}

export type InputMode = 'game' | 'ui';

interface GamepadMap {
  steerAxis: number;
  throttleButton: number;
  brakeButton: number;
  boostButton: number;
  driftButton: number;
  abilityButton: number;
  pauseButton: number;
  dpad: { left: number; right: number; up: number; down: number };
}

const PAD: GamepadMap = {
  steerAxis: 0,
  throttleButton: 7,
  brakeButton: 6,
  boostButton: 0,
  driftButton: 1,
  abilityButton: 2,
  pauseButton: 9,
  dpad: { left: 14, right: 15, up: 12, down: 13 },
};

const DEADZONE = 0.16;
const MOUSE_STEER_WEIGHT = 0.42;
const MOUSE_STEER_DECAY = 4.2;

/**
 * Keyboard + mouse + gamepad + touch, resolved into a single intent each frame.
 * Keybindings are data-driven so they can be remapped from the settings screen.
 */
export class InputManager {
  private readonly held = new Set<string>();
  private readonly index = new Map<string, InputAction[]>();
  private mode: InputMode = 'ui';
  private mouseSteer = 0;
  private lastMouseX = 0;
  private mouseSteerTimer = 0;
  private mouseBoost = false;
  private mouseDrift = false;
  private padAbilityEdge = false;
  private padPauseEdge = false;
  private padIndex = -1;
  private abilityBuffer = false;
  private pauseBuffer = false;
  private restartBuffer = false;
  private rebindAction: InputAction | null = null;
  private rebindResolve: ((codes: string[] | null) => void) | null = null;
  readonly frame: InputFrame = { throttle: 0, steer: 0, boost: false, drift: false, abilityPressed: false, pausePressed: false, restartPressed: false };
  readonly touch: TouchState = { active: false, steer: 0, throttle: 0, boost: false, drift: false, ability: false };
  gamepadConnected = false;
  onGamepadChange: ((connected: boolean) => void) | null = null;

  private disposers: (() => void)[] = [];

  constructor(private target: HTMLElement = document.body) {}

  setBindings(map: Record<InputAction, string[]>): void {
    this.index.clear();
    this.codeIndex.clear();
    for (const action of Object.keys(map) as InputAction[]) {
      for (const code of map[action]) {
        const list = this.index.get(code);
        if (list) list.push(action);
        else this.index.set(code, [action]);
      }
    }
  }

  setMode(mode: InputMode): void {
    this.mode = mode;
    if (mode !== 'game') {
      this.held.clear();
      this.mouseBoost = false;
      this.mouseDrift = false;
    }
  }

  attach(): void {
    const kd = (e: KeyboardEvent) => this.onKeyDown(e);
    const ku = (e: KeyboardEvent) => this.onKeyUp(e);
    const blur = () => {
      this.held.clear();
      this.mouseBoost = false;
      this.mouseDrift = false;
    };
    const mm = (e: MouseEvent) => this.onMouseMove(e);
    const md = (e: MouseEvent) => this.onMouseDown(e);
    const mu = (e: MouseEvent) => this.onMouseUp(e);
    const gpC = () => this.syncGamepad();
    const gpD = () => this.syncGamepad();
    window.addEventListener('keydown', kd, { passive: false });
    window.addEventListener('keyup', ku);
    window.addEventListener('blur', blur);
    window.addEventListener('gamepadconnected', gpC);
    window.addEventListener('gamepaddisconnected', gpD);
    this.target.addEventListener('mousemove', mm);
    this.target.addEventListener('mousedown', md);
    window.addEventListener('mouseup', mu);
    window.addEventListener('contextmenu', this.onContext);
    this.disposers.push(() => {
      window.removeEventListener('keydown', kd);
      window.removeEventListener('keyup', ku);
      window.removeEventListener('blur', blur);
      window.removeEventListener('gamepadconnected', gpC);
      window.removeEventListener('gamepaddisconnected', gpD);
      this.target.removeEventListener('mousemove', mm);
      this.target.removeEventListener('mousedown', md);
      window.removeEventListener('mouseup', mu);
      window.removeEventListener('contextmenu', this.onContext);
    });
  }

  private readonly onContext = (e: Event) => {
    if (this.mode === 'game') e.preventDefault();
  };

  detach(): void {
    for (const d of this.disposers) d();
    this.disposers = [];
  }

  private onKeyDown(e: KeyboardEvent): void {
    if (this.rebindAction) {
      e.preventDefault();
      const resolve = this.rebindResolve;
      this.rebindAction = null;
      this.rebindResolve = null;
      // Escape cancels; any other key becomes the new binding for that action.
      if (resolve) resolve(e.code === 'Escape' ? null : [e.code]);
      return;
    }
    // Ignore autorepeat for edge-triggered actions.
    if (e.repeat) {
      if (this.held.has(e.code)) return;
    }
    this.held.add(e.code);
    const actions = this.index.get(e.code);
    if (!actions) return;
    if (this.mode === 'ui') {
      if (actions.includes('confirm')) this.confirmHandler?.();
      if (actions.includes('back')) this.backHandler?.();
      return;
    }
    if (actions.includes('boost') || actions.includes('drift') || actions.includes('ability') || actions.includes('pause') || actions.includes('restart')) {
      e.preventDefault();
    }
    if (actions.includes('ability')) this.abilityBuffer = true;
    if (actions.includes('pause')) this.pauseBuffer = true;
    if (actions.includes('restart')) this.restartBuffer = true;
  }

  private onKeyUp(e: KeyboardEvent): void {
    this.held.delete(e.code);
  }

  private onMouseMove(e: MouseEvent): void {
    if (this.mode !== 'game') {
      this.lastMouseX = e.clientX;
      return;
    }
    const dx = e.clientX - this.lastMouseX;
    this.lastMouseX = e.clientX;
    if (Math.abs(dx) > 0.5) {
      this.mouseSteer = clamp(this.mouseSteer + dx / 420, -MOUSE_STEER_WEIGHT, MOUSE_STEER_WEIGHT);
      this.mouseSteerTimer = 0.55;
    }
  }

  private onMouseDown(e: MouseEvent): void {
    if (this.mode !== 'game') return;
    if (e.button === 0) this.mouseBoost = true;
    if (e.button === 2) this.mouseDrift = true;
  }

  private onMouseUp(e: MouseEvent): void {
    if (e.button === 0) this.mouseBoost = false;
    if (e.button === 2) this.mouseDrift = false;
  }

  confirmHandler: (() => void) | null = null;
  backHandler: (() => void) | null = null;

  beginRebind(action: InputAction): Promise<string[] | null> {
    this.rebindAction = action;
    return new Promise((resolve) => {
      this.rebindResolve = resolve;
    });
  }

  cancelRebind(): void {
    this.rebindAction = null;
    this.rebindResolve?.(null);
    this.rebindResolve = null;
  }

  private syncGamepad(): void {
    const pads = navigator.getGamepads?.() ?? [];
    let found = -1;
    for (let i = 0; i < pads.length; i++) {
      // Prefer a standard gamepad; skip XR controllers, which have a different intent model.
      const pad = pads[i];
      if (pad && pad.mapping === 'standard') {
        found = i;
        break;
      }
      if (pad && found < 0) found = i;
    }
    const changed = (found >= 0) !== this.gamepadConnected;
    this.padIndex = found;
    this.gamepadConnected = found >= 0;
    if (changed) this.onGamepadChange?.(this.gamepadConnected);
  }

  private heldAction(action: InputAction): boolean {
    const codes = this.indexCodesFor(action);
    for (const code of codes) if (this.held.has(code)) return true;
    return false;
  }

  private axisFor(action: InputAction, negative: InputAction): number {
    let v = 0;
    if (this.heldAction(action)) v += 1;
    if (this.heldAction(negative)) v -= 1;
    return v;
  }

  private codeIndex = new Map<InputAction, string[]>();

  private indexCodesFor(action: InputAction): string[] {
    let cached = this.codeIndex.get(action);
    if (!cached) {
      cached = [];
      for (const [code, actions] of this.index) if (actions.includes(action)) cached.push(code);
      this.codeIndex.set(action, cached);
    }
    return cached;
  }

  /** Polls every device and fills `frame`. Call once per simulation step. */
  update(dt: number): InputFrame {
    const f = this.frame;
    f.abilityPressed = false;
    f.pausePressed = false;
    f.restartPressed = false;
    if (this.mode !== 'game') {
      f.throttle = 0;
      f.steer = 0;
      f.boost = false;
      f.drift = false;
      return f;
    }

    let steer = this.axisFor('right', 'left');
    let throttle = this.axisFor('throttle', 'brake');
    let boost = this.heldAction('boost');
    let drift = this.heldAction('drift');

    if (this.mouseSteerTimer > 0) {
      this.mouseSteerTimer -= dt;
      steer = clamp(steer + this.mouseSteer, -1, 1);
    } else {
      this.mouseSteer = 0;
    }
    if (this.mouseSteerTimer <= 0) {
      this.mouseSteer -= this.mouseSteer * Math.min(1, dt * MOUSE_STEER_DECAY);
    }
    boost = boost || this.mouseBoost;
    drift = drift || this.mouseDrift;

    if (this.padIndex >= 0) {
      const pad = navigator.getGamepads?.()[this.padIndex];
      if (pad) {
        const axes = pad.axes;
        const ax = axes[PAD.steerAxis] ?? 0;
        if (Math.abs(ax) > DEADZONE) steer = clamp(steer + Math.sign(ax) * smoothPad(Math.abs(ax)), -1, 1);
        const up = pad.buttons[PAD.dpad.up]?.pressed;
        const down = pad.buttons[PAD.dpad.down]?.pressed;
        const left = pad.buttons[PAD.dpad.left]?.pressed;
        const right = pad.buttons[PAD.dpad.right]?.pressed;
        if (up) throttle = 1;
        if (down) throttle = -1;
        if (left) steer = -1;
        if (right) steer = 1;
        const rt = pad.buttons[PAD.throttleButton]?.value ?? 0;
        const lt = pad.buttons[PAD.brakeButton]?.value ?? 0;
        if (rt > DEADZONE) throttle = Math.max(throttle, (rt - DEADZONE) / (1 - DEADZONE));
        if (lt > DEADZONE) throttle = Math.min(throttle, -((lt - DEADZONE) / (1 - DEADZONE)));
        boost = boost || !!pad.buttons[PAD.boostButton]?.pressed;
        drift = drift || !!pad.buttons[PAD.driftButton]?.pressed;
        const ability = !!pad.buttons[PAD.abilityButton]?.pressed;
        if (ability && !this.padAbilityEdge) this.abilityBuffer = true;
        this.padAbilityEdge = ability;
        const pause = !!pad.buttons[PAD.pauseButton]?.pressed;
        if (pause && !this.padPauseEdge) this.pauseBuffer = true;
        this.padPauseEdge = pause;
      }
    }

    if (this.touch.active) {
      if (Math.abs(this.touch.steer) > 0.02) steer = clamp(steer + this.touch.steer, -1, 1);
      if (Math.abs(this.touch.throttle) > 0.02) throttle = clamp(throttle + this.touch.throttle, -1, 1);
      if (this.touch.boost) boost = true;
      if (this.touch.drift) drift = true;
      if (this.touch.ability) this.abilityBuffer = true;
    }

    f.steer = clamp(steer, -1, 1);
    f.throttle = clamp(throttle, -1, 1);
    f.boost = boost;
    f.drift = drift;
    f.abilityPressed = this.abilityBuffer;
    f.pausePressed = this.pauseBuffer;
    f.restartPressed = this.restartBuffer;
    this.abilityBuffer = false;
    this.pauseBuffer = false;
    this.restartBuffer = false;
    return f;
  }

  /** External systems (touch UI, debug keys) can inject edge actions. */
  press(action: 'ability' | 'pause' | 'restart'): void {
    if (action === 'ability') this.abilityBuffer = true;
    if (action === 'pause') this.pauseBuffer = true;
    if (action === 'restart') this.restartBuffer = true;
  }

  setTarget(el: HTMLElement): void {
    this.target = el;
  }
}

function smoothPad(v: number): number {
  const x = clamp((v - DEADZONE) / (1 - DEADZONE), 0, 1);
  return x * x * (3 - 2 * x);
}
