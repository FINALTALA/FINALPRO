import { Prisma } from '../../generated/prisma/client';

export interface AuditLogFilters {
  entityType?: string;
  entityId?: string;
  actorId?: string;
  action?: string;
  /** Sprint 25 review round: Part 5's "correlation-ID search" (Part 4,
   * H.1) - every row written while serving one request shares it. */
  correlationId?: string;
  from?: Date;
  to?: Date;
}

/** The ONE filter-building function `GET /admin/audit-logs` and
 * `GET /admin/audit-logs/export` both call - never two independently-
 * maintained copies of the same filter logic. */
export function buildAuditLogWhere(
  filters: AuditLogFilters,
): Prisma.AuditLogWhereInput {
  return {
    ...(filters.entityType ? { entityType: filters.entityType } : {}),
    ...(filters.entityId ? { entityId: filters.entityId } : {}),
    ...(filters.actorId ? { actorId: filters.actorId } : {}),
    ...(filters.action ? { action: filters.action } : {}),
    ...(filters.correlationId ? { correlationId: filters.correlationId } : {}),
    ...(filters.from || filters.to
      ? {
          occurredAt: {
            ...(filters.from ? { gte: filters.from } : {}),
            ...(filters.to ? { lte: filters.to } : {}),
          },
        }
      : {}),
  };
}

/**
 * Sprint 25 (FR-ADMIN-005): the ONE redaction gate between raw
 * `AuditLog.beforeState`/`afterState` and anything shown or exported -
 * same whitelist-by-action-type discipline `outbox-relay.service.ts`'s
 * own `buildSafeData()` already established, applied here instead to
 * "is this safe to summarize at all," not just "which one field."
 *
 * Deliberately starts with ONLY the action types verified, by reading
 * their actual write sites in this same sprint, to carry nothing but
 * a bounded, non-sensitive shape (`{status}`/`{enabled}`) - confirmed
 * NOT the default: `address.created`'s own `afterState` was checked
 * and found to carry raw `lat`/`lng`. Every action NOT listed here
 * returns `null` - never a guess, never a partial pass-through of
 * fields that merely "look short." Extending this list is a deliberate
 * one-action-at-a-time review, not a blanket default-allow.
 */
const SAFE_SUMMARY_BUILDERS: Record<
  string,
  (before: unknown, after: unknown) => string | null
> = {
  'branch_order.status_changed': (before, after) => {
    const b = before as { status?: string } | null;
    const a = after as { status?: string } | null;
    return `status: ${b?.status ?? '?'} → ${a?.status ?? '?'}`;
  },
  'feature_flag.changed': (before, after) => {
    const b = before as { enabled?: boolean } | null;
    const a = after as { enabled?: boolean } | null;
    return `enabled: ${String(b?.enabled)} → ${String(a?.enabled)}`;
  },
};

export function buildSafeAuditSummary(
  action: string,
  beforeState: unknown,
  afterState: unknown,
): string | null {
  const builder = SAFE_SUMMARY_BUILDERS[action];
  if (!builder) return null;
  try {
    return builder(beforeState, afterState);
  } catch {
    return null;
  }
}

/** RFC 4180-ish escaping - wraps every field in quotes and doubles any
 * internal quote, so a `summary` string that happens to contain a
 * comma/quote/newline can never break the CSV's own column structure. */
export function toCsvRow(fields: (string | null)[]): string {
  return fields.map((f) => `"${(f ?? '').replace(/"/g, '""')}"`).join(',');
}

/**
 * Review-round fix (CSV formula injection): `toCsvRow()`'s quoting
 * only protects this CSV's own column structure - it does nothing to
 * stop Excel/Google Sheets from interpreting a cell whose value
 * STARTS WITH `=`, `+`, `-`, or `@` (or a leading tab/CR/LF before
 * one of those) as an executable formula once the file is opened,
 * entirely independent of the surrounding quotes. Any exported
 * column can carry attacker-influenced data (`entityId`, `action`,
 * `correlationId`, the redacted `summary`), so every DATA-row value
 * - never the fixed, developer-written header row, which can't be
 * attacker-controlled - is passed through this first. Prefixing a
 * literal apostrophe is the standard mitigation: every major
 * spreadsheet app treats a leading `'` as "force this cell to plain
 * text" and strips it from the displayed value, so the cell renders
 * as the literal original text instead of running as a formula.
 */
const CSV_FORMULA_TRIGGER = /^[=+\-@\t\r\n]/;

export function sanitizeCsvFormulaField(value: string | null): string | null {
  if (value === null) return null;
  return CSV_FORMULA_TRIGGER.test(value) ? `'${value}` : value;
}
