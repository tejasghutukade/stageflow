export const GUIDE_SECTIONS = [{ id: "chat", label: "Chat" }] as const;

export type GuideSectionId = (typeof GUIDE_SECTIONS)[number]["id"];

export function isGuideSection(section: string): section is GuideSectionId {
  return GUIDE_SECTIONS.some((item) => item.id === section);
}
