export class InputManager {
  public keys = new Set<string>();
  public mouseDeltaX = 0;
  public mouseDeltaY = 0;
  public leftMouseDown = false;
  public rightMouseDown = false;
  public isPointerLocked = false;
  /** True once pointer lock has worked at least once (so we know Esc means "pause"). */
  public hasEverLocked = false;
  public sensitivity = 0.0022;

  // Dual-input touch / drag fallback state
  public touchMoveX = 0;
  public touchMoveY = 0;
  public touchFireHeld = false;
  public touchAimHeld = false;
  private dragLooking = false;
  private lastDragX = 0;
  private lastDragY = 0;

  private onKeyPressCallbacks = new Map<string, Array<() => void>>();
  private lockChangeCallbacks: Array<(locked: boolean) => void> = [];
  private wheelCallbacks: Array<(dir: number) => void> = [];
  private canLockChecker?: () => boolean;
  private wheelCooldown = 0;

  constructor(private domElement: HTMLElement) {
    window.addEventListener('keydown', this.handleKeyDown);
    window.addEventListener('keyup', this.handleKeyUp);
    window.addEventListener('mousemove', this.handleMouseMove);
    window.addEventListener('mousedown', this.handleMouseDown);
    window.addEventListener('mouseup', this.handleMouseUp);
    window.addEventListener('wheel', this.handleWheel, { passive: true });
    window.addEventListener('blur', this.handleBlur);
    window.addEventListener('contextmenu', this.handleContextMenu);
    document.addEventListener('pointerlockchange', this.handlePointerLockChange);
    this.domElement.addEventListener('click', this.handleCanvasClick);
  }

  public dispose(): void {
    this.exitPointerLock();
    window.removeEventListener('keydown', this.handleKeyDown);
    window.removeEventListener('keyup', this.handleKeyUp);
    window.removeEventListener('mousemove', this.handleMouseMove);
    window.removeEventListener('mousedown', this.handleMouseDown);
    window.removeEventListener('mouseup', this.handleMouseUp);
    window.removeEventListener('wheel', this.handleWheel);
    window.removeEventListener('blur', this.handleBlur);
    window.removeEventListener('contextmenu', this.handleContextMenu);
    document.removeEventListener('pointerlockchange', this.handlePointerLockChange);
    this.domElement.removeEventListener('click', this.handleCanvasClick);
  }

  public setCanLockChecker(fn: () => boolean): void {
    this.canLockChecker = fn;
  }

  public onPointerLockChange(cb: (locked: boolean) => void): void {
    this.lockChangeCallbacks.push(cb);
  }

  public onWheel(cb: (dir: number) => void): void {
    this.wheelCallbacks.push(cb);
  }

  /** Triggers a registered key press programmatically (used by touch HUD buttons). */
  public triggerKeyPress(code: string): void {
    const cbs = this.onKeyPressCallbacks.get(code);
    if (cbs) for (const cb of cbs) cb();
  }

  /** Dual-input fire check: LMB (when locked), keyboard J / Enter, or touch fire button. */
  public isFireHeld(): boolean {
    return (this.isPointerLocked && this.leftMouseDown) || this.keys.has('KeyJ') || this.keys.has('Enter') || this.touchFireHeld;
  }

  /** Dual-input ADS aim check: RMB (when locked), keyboard K, or touch aim button. */
  public isAimHeld(): boolean {
    return (this.isPointerLocked && this.rightMouseDown) || this.keys.has('KeyK') || this.touchAimHeld;
  }

  public addLookDelta(dxPixels: number, dyPixels: number): void {
    this.mouseDeltaX += dxPixels * this.sensitivity * 1.4;
    this.mouseDeltaY += dyPixels * this.sensitivity * 1.4;
  }

  public requestPointerLock(): void {
    try {
      if (document.pointerLockElement !== this.domElement) {
        const req = this.domElement.requestPointerLock as unknown as (opts?: object) => Promise<void> | undefined;
        const res = req.call(this.domElement, { unadjustedMovement: true });
        if (res && typeof res.catch === 'function') {
          res.catch(() => {
            const plain = req.call(this.domElement);
            if (plain && typeof plain.catch === 'function') plain.catch(() => {});
          });
        }
      }
    } catch {
      // Ignore pointer lock errors in restricted iframes/headless browsers
    }
  }

  public exitPointerLock(): void {
    if (document.pointerLockElement) {
      document.exitPointerLock?.();
    }
  }

  public onKeyPress(code: string, cb: () => void): void {
    const arr = this.onKeyPressCallbacks.get(code) ?? [];
    arr.push(cb);
    this.onKeyPressCallbacks.set(code, arr);
  }

  public consumeMouseDelta(): { dx: number; dy: number } {
    const dx = this.mouseDeltaX;
    const dy = this.mouseDeltaY;
    this.mouseDeltaX = 0;
    this.mouseDeltaY = 0;
    return { dx, dy };
  }

  public isDown(code: string): boolean {
    return this.keys.has(code);
  }

  private releaseAll(): void {
    this.keys.clear();
    this.leftMouseDown = false;
    this.rightMouseDown = false;
    this.dragLooking = false;
    this.touchFireHeld = false;
    this.touchAimHeld = false;
    this.touchMoveX = 0;
    this.touchMoveY = 0;
  }

  private handleBlur = (): void => this.releaseAll();
  private handleContextMenu = (e: MouseEvent): void => e.preventDefault();
  private handleCanvasClick = (): void => {
    if (!this.isPointerLocked && (!this.canLockChecker || this.canLockChecker())) {
      this.requestPointerLock();
    }
  };

  private handleKeyDown = (e: KeyboardEvent): void => {
    if (e.target instanceof HTMLInputElement) return;
    if (e.code === 'Tab' || e.code === 'Space') {
      e.preventDefault();
    }
    if (!this.keys.has(e.code) && !e.repeat) {
      const cbs = this.onKeyPressCallbacks.get(e.code);
      if (cbs) {
        for (const cb of cbs) cb();
      }
    }
    this.keys.add(e.code);
  };

  private handleKeyUp = (e: KeyboardEvent): void => {
    this.keys.delete(e.code);
  };

  private handleMouseMove = (e: MouseEvent): void => {
    if (this.isPointerLocked) {
      if (Math.abs(e.movementX) > 250 || Math.abs(e.movementY) > 250) return;
      this.mouseDeltaX += e.movementX * this.sensitivity;
      this.mouseDeltaY += e.movementY * this.sensitivity;
    } else if (this.dragLooking) {
      const dx = e.clientX - this.lastDragX;
      const dy = e.clientY - this.lastDragY;
      this.lastDragX = e.clientX;
      this.lastDragY = e.clientY;
      this.mouseDeltaX += dx * this.sensitivity * 1.4;
      this.mouseDeltaY += dy * this.sensitivity * 1.4;
    }
  };

  private handleMouseDown = (e: MouseEvent): void => {
    if (!this.isPointerLocked) {
      // Allow RMB drag-look fallback when pointer lock isn't engaged
      if (e.button === 2 && e.target === this.domElement && (!this.canLockChecker || this.canLockChecker())) {
        this.dragLooking = true;
        this.lastDragX = e.clientX;
        this.lastDragY = e.clientY;
      }
      return;
    }
    if (e.button === 0) this.leftMouseDown = true;
    if (e.button === 2) this.rightMouseDown = true;
  };

  private handleMouseUp = (e: MouseEvent): void => {
    if (e.button === 0) this.leftMouseDown = false;
    if (e.button === 2) {
      this.rightMouseDown = false;
      this.dragLooking = false;
    }
  };

  private handleWheel = (e: WheelEvent): void => {
    if (!this.isPointerLocked) return;
    const now = performance.now();
    if (now < this.wheelCooldown || Math.abs(e.deltaY) < 1) return;
    this.wheelCooldown = now + 90;
    const dir = Math.sign(e.deltaY);
    for (const cb of this.wheelCallbacks) cb(dir);
  };

  private handlePointerLockChange = (): void => {
    this.isPointerLocked = document.pointerLockElement === this.domElement;
    if (this.isPointerLocked) {
      this.hasEverLocked = true;
    } else {
      this.releaseAll();
    }
    for (const cb of this.lockChangeCallbacks) cb(this.isPointerLocked);
  };
}
