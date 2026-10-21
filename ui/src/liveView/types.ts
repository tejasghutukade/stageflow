export type LiveViewMode = "control" | "view";

export type MouseButton = "left" | "middle" | "right";

export type MouseInput = {
  type: "input_mouse";
  eventType: "mousePressed" | "mouseReleased" | "mouseMoved" | "mouseWheel";
  x: number;
  y: number;
  button?: MouseButton;
  clickCount?: number;
  deltaX?: number;
  deltaY?: number;
  modifiers?: number;
};

export type KeyboardInput = {
  type: "input_keyboard";
  eventType: "keyDown" | "keyUp" | "char";
  key?: string;
  code?: string;
  text?: string;
  windowsVirtualKeyCode?: number;
  modifiers?: number;
};

export type LiveViewInput = MouseInput | KeyboardInput;

export type ImageSize = { width: number; height: number };

export type ViewRect = { left: number; top: number; width: number; height: number };
