export type NotchWindowMode = "collapsed" | "expanded";

export interface NotchWindowGeometry {
  width: number;
  height: number;
  topInset: number;
  displayId?: string;
  hasPhysicalNotch?: boolean;
}

export interface NotchWindowController {
  expand(reason: string): Promise<void>;
  collapse(reason: string): Promise<void>;
  setGeometry?(geometry: Partial<NotchWindowGeometry>): Promise<void>;
}

export class MemoryNotchWindowController implements NotchWindowController {
  readonly events: Array<{ type: NotchWindowMode; reason: string }> = [];
  mode: NotchWindowMode = "collapsed";
  geometry: Partial<NotchWindowGeometry> = {};

  async expand(reason: string): Promise<void> {
    this.mode = "expanded";
    this.events.push({ type: "expanded", reason });
  }

  async collapse(reason: string): Promise<void> {
    this.mode = "collapsed";
    this.events.push({ type: "collapsed", reason });
  }

  async setGeometry(geometry: Partial<NotchWindowGeometry>): Promise<void> {
    this.geometry = { ...this.geometry, ...geometry };
  }
}
