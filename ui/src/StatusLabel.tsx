import { StatusDot as AstryxStatusDot } from "@astryxdesign/core/StatusDot";
import { Stack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import {
  cssStatusToken,
  statusCopy,
  statusDotVariant,
  statusIsPulsing,
  type DisplayStatus,
} from "./status/runStatus";

export function StatusDot({ status }: { status: DisplayStatus }) {
  const token = cssStatusToken(status);
  const statusClass =
    token && token !== "running" ? `status status--${token}` : "status";
  const dotClass = token ? `dot dot--${token}` : "dot";
  return (
    <span className={statusClass}>
      <span className={dotClass}></span> {statusCopy(status)}
    </span>
  );
}

export function StatusLabel({
  status,
}: {
  status: DisplayStatus;
}) {
  return (
    <Stack direction="horizontal" gap={1} align="center">
      <AstryxStatusDot
        variant={statusDotVariant(status)}
        label={statusCopy(status)}
        isPulsing={statusIsPulsing(status)}
      />
      <Text size="sm">{statusCopy(status)}</Text>
    </Stack>
  );
}
