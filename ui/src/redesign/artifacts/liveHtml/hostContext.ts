import {
  HOST_CONTEXT_VARIABLES,
  type HostContext,
  type HostContextVariable,
} from "../../../../../src/artifacts/bridge/protocol.ts";

const MAX_CSS = 200;

function cssValueOk(value: string): boolean {
  if (value.length === 0 || value.length > MAX_CSS) return false;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 32 || code === 127) return false;
  }
  return !value.includes("<") && !value.includes(">") && !value.includes("{") && !value.includes("}");
}

function shortText(value: string | undefined): value is string {
  if (!value || value.length === 0 || value.length > 64) return false;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 32 || code === 127) return false;
  }
  return true;
}

export function readLiveHtmlHostContext(container: HTMLElement | null): HostContext {
  const variables: Partial<Record<HostContextVariable, string>> = {};
  const style = getComputedStyle(document.documentElement);
  for (const name of HOST_CONTEXT_VARIABLES) {
    const value = style.getPropertyValue(name).trim();
    if (cssValueOk(value)) variables[name] = value;
  }
  const width = container ? Math.round(container.getBoundingClientRect().width) : 0;
  const context: HostContext = {
    theme: "dark",
    styles: { variables },
    displayMode: "inline",
    availableDisplayModes: ["inline"],
    containerDimensions: {},
    platform: "web",
  };
  if (Number.isFinite(width) && width >= 0 && width <= 100_000) context.containerDimensions.maxWidth = width;
  const locale = typeof navigator !== "undefined" ? navigator.language : undefined;
  if (shortText(locale)) context.locale = locale;
  let timeZone: string | undefined;
  try {
    timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    timeZone = undefined;
  }
  if (shortText(timeZone)) context.timeZone = timeZone;
  return context;
}
