import { useEffect, useRef } from "react";
import { List } from "@astryxdesign/core/List";
import { ListItem } from "@astryxdesign/core/List";
import { Timestamp } from "@astryxdesign/core/Timestamp";
import { Text } from "@astryxdesign/core/Text";
import { Stack } from "@astryxdesign/core/Stack";
import { CodeBlock } from "@astryxdesign/core/CodeBlock";
import type { StageLogEvent } from "./api";
import {
  formatActivityDescription,
  formatActivityLabel,
} from "./status/activityCopy";

export function StageActivityLog({
  events,
  isLive,
}: {
  events: StageLogEvent[];
  isLive: boolean;
}) {
  const rootRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!isLive) return;
    const el = rootRef.current;
    if (!el) return;
    el.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [events.length, isLive]);

  if (events.length === 0) {
    return <Text size="sm">No activity yet.</Text>;
  }

  return (
    <Stack gap={2} ref={rootRef}>
      <List hasDividers density="compact">
        {events.map((event, index) => {
          const description = formatActivityDescription(event);
          return (
            <ListItem
              key={`${event.event}-${event.at ?? index}-${index}`}
              label={formatActivityLabel(event)}
              description={description}
              endContent={
                event.at ? (
                  <Timestamp value={event.at} format="relative_short" isLive={isLive} />
                ) : undefined
              }
            />
          );
        })}
      </List>
      <CodeBlock
        code={events.map((e) => JSON.stringify(e)).join("\n")}
        language="json"
        title="Raw log"
        container="section"
        maxHeight={160}
        size="sm"
        width="100%"
        isCollapsible
        collapsibleThreshold={1}
      />
    </Stack>
  );
}
