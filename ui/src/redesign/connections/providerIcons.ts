import type { IconType } from "react-icons";
import { LuHash, LuMail, LuMessageCircle, LuPhone, LuPlug, LuSend } from "react-icons/lu";

/** Icons are presentation, so the console maps the host's icon key itself and falls back to a plug. */
const ICONS: Record<string, IconType> = {
  mail: LuMail,
  hash: LuHash,
  "message-circle": LuMessageCircle,
  phone: LuPhone,
  send: LuSend,
};

export function providerIcon(icon: string | undefined): IconType {
  return (icon && ICONS[icon]) || LuPlug;
}
