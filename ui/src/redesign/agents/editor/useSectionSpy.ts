import { useCallback, useRef, useState } from "react";
import { sectionDomId } from "../config/AgentDefinitionForm";
import type { SectionId } from "../model/definition";

/** Tracks which config section is at the top of a scroll container, and scrolls to one on demand. */
export function useSectionSpy(sections: Array<{ id: SectionId }>) {
  const [active, setActive] = useState<SectionId>(sections[0]!.id);
  const scrollRef = useRef<HTMLDivElement>(null);
  const onScroll = useCallback(() => {
    const root = scrollRef.current;
    if (!root) return;
    const top = root.getBoundingClientRect().top;
    let current = sections[0]!.id;
    for (const section of sections) {
      const node = document.getElementById(sectionDomId(section.id));
      if (node && node.getBoundingClientRect().top - top <= 24) current = section.id;
    }
    setActive(current);
  }, [sections]);
  const jump = useCallback((id: SectionId) => {
    setActive(id);
    document.getElementById(sectionDomId(id))?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);
  return { active, jump, scrollRef, onScroll };
}
