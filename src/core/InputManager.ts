export class InputManager {
  public keys = new Set<string>();
  public mouseDeltaX = 0;
  public mouseDeltaY = 0;
  public leftMouseDown = false;
  public rightMouseDown = false;
  public isPointerLocked = false;
  public sensitivity = 0.0022;

  private onKeyPressCallbacks = new Map<string, Array<() => void>>();
  private canLockChecker?: () => boolean;

  constructor(private domElement: HTMLElement) {
    window.addEventListener('keydown', this.handleKeyDown);
    window.addEventListener('keyup', this.handleKeyUp);
    window.addEventListener('mousemove', this.handleMouseMove);
    window.addEventListener('mousedown', this.handleMouseDown);
    window.addEventListener('mouseup', this.handleMouseUp);
    window.addEventListener('contextmenu', (e) => e.preventDefault());
    document.addEventListener('pointerlockchange', this.handlePointerLockChange);
    this.domElement.addEventListener('click', () => {
      if (!this.isPointerLocked && (!this.canLockChecker || this.canLockChecker())) {
        this.requestPointerLock();
      }
    });
  }

  public setCanLockChecker(fn: () => boolean): void {
    this.canLockChecker = fn;
  }

  public requestPointerLock(): void {
    try {
      if (document.pointerLockElement !== this.domElement) {
        const res = this.domElement.requestPointerLock?.() as unknown as Promise<void> | undefined;
        if (res && typeof res.catch === 'function') {
          res.catch(() => {});
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

  private handleKeyDown = (e: KeyboardEvent): void => {
    if (e.code === 'Tab') {
      e.preventDefault();
    }
    if (!this.keys.has(e.code)) {
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
    if (!this.isPointerLocked) return;
    this.mouseDeltaX += e.movementX * this.sensitivity;
    this.mouseDeltaY += e.movementY * this.sensitivity;
  };

  private handleMouseDown = (e: MouseEvent): void => {
    if (!this.isPointerLocked) return;
    if (e.button === 0) this.leftMouseDown = true;
    if (e.button === 2) this.rightMouseDown = true;
  };

  private handleMouseUp = (e: MouseEvent): void => {
    if (e.button === 0) this.leftMouseDown = false;
    if (e.button === 2) this.rightMouseDown = false;
  };

  private handlePointerLockChange = (): void => {
    this.isPointerLocked = document.pointerLockElement === this.domElement;
    if (!this.isPointerLocked) {
      this.leftMouseDown = false;
      this.rightMouseDown = false;
      this.keys.clear();
    }
  };
}
