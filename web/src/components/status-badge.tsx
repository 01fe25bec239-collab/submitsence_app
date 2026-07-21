import { Badge } from "@/components/ui/badge";
import { assertSafeSystemCopy, labelFor } from "@/lib/compliance/copy";

type StatusMap = Record<string, { label: string; tone: string; help?: string }>;

/**
 * Renders a domain status as a compliance-checked badge. `tone` values in the
 * copy catalogue are 1:1 with Badge variants. Every system-authored label runs
 * through assertSafeSystemCopy so a banned phrase can never reach the screen.
 */
export function StatusBadge({
  map,
  value,
  className,
}: {
  map: StatusMap;
  value: string | null | undefined;
  className?: string;
}) {
  const { label, tone } = labelFor(map as never, value);
  const entry = value ? map[value] : undefined;
  return (
    <Badge
      variant={tone as never}
      className={className}
      title={entry?.help}
    >
      {assertSafeSystemCopy(label)}
    </Badge>
  );
}
