import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ReviewsService } from '../reviews/reviews.service';

const WINDOW_DAYS = 30;

export interface VendorPerformance {
  vendor_id: string;
  window_days: number;
  window_from: string;
  window_to: string;
  /** null when the denominator (COMPLETED+CANCELLED+REFUNDED in the
   * window) is 0 - never a misleading 0. */
  cancellation_rate: number | null;
  /** null when responded_orders_count is 0. */
  average_response_time_hours: number | null;
  responded_orders_count: number;
  rating_average: number | null;
  rating_count: number;
}

interface OrderRow {
  id: string;
  createdAt: Date;
  status: string;
  preparingAt: Date | null;
}

/**
 * Sprint 25 (FR-VEND-011, FR-VPORTAL-007's reporting half). Every
 * formula here was defined only after reading the real code, not
 * guessed - see this sprint's own plan for the full derivation:
 *
 * - Window: the last 30 days, UTC, by `BranchOrder.createdAt`.
 * - Cancellation rate: (CANCELLED+REFUNDED) / (COMPLETED+CANCELLED+
 *   REFUNDED) in the window - active/non-terminal orders never enter
 *   either side. `BranchOrder.status` is NEVER set to REFUNDED by a
 *   post-delivery item return (`returns.service.ts` never calls
 *   `BranchOrderService.transition()` - confirmed by reading it, not
 *   assumed) - REFUNDED here is exclusively an order-level
 *   cancellation outcome (PDR-025/027/028).
 * - Response time: `BranchOrderService.transition()` is the ONLY
 *   writer of `BranchOrder.status`, and records exactly one generic
 *   `AuditLog` action (`branch_order.status_changed`,
 *   `afterState: {status}`) for every transition - there is no
 *   per-transition action name. `PREPARING` is reachable only from
 *   `PLACED` (confirmed by reading `branch-order-state-machine.ts`'s
 *   own transition table), so "first" and "only" are the same thing
 *   here. Orders that never reached PREPARING are excluded from the
 *   average entirely, not counted as 0.
 * - Rating: `ReviewsService.getVendorRatingSummary()` verbatim (the
 *   same number shown publicly on the store page) - no separate
 *   30-day-windowed rating, by design (consistency with what the
 *   customer already sees outweighs uniform windowing here).
 */
@Injectable()
export class VendorPerformanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reviews: ReviewsService,
  ) {}

  async computeForVendor(vendorId: string): Promise<VendorPerformance> {
    const to = new Date();
    const from = new Date(to.getTime() - WINDOW_DAYS * 24 * 60 * 60 * 1000);

    const orders = await this.prisma.$queryRaw<OrderRow[]>`
      SELECT
        bo.id,
        bo."createdAt",
        bo.status,
        (
          SELECT al."occurredAt"
          FROM audit_logs al
          WHERE al."entityType" = 'BranchOrder'
            AND al."entityId" = bo.id
            AND al.action = 'branch_order.status_changed'
            AND al."afterState"->>'status' = 'PREPARING'
          ORDER BY al."occurredAt" ASC
          LIMIT 1
        ) AS "preparingAt"
      FROM branch_orders bo
      WHERE bo."vendorId" = ${vendorId}
        AND bo."createdAt" >= ${from}
    `;

    const terminal = orders.filter((o) =>
      ['COMPLETED', 'CANCELLED', 'REFUNDED'].includes(o.status),
    );
    const cancelled = terminal.filter((o) =>
      ['CANCELLED', 'REFUNDED'].includes(o.status),
    );
    const cancellationRate =
      terminal.length === 0 ? null : cancelled.length / terminal.length;

    const responded = orders.filter((o) => o.preparingAt !== null);
    const averageResponseHours =
      responded.length === 0
        ? null
        : responded.reduce(
            (sum, o) =>
              sum +
              (o.preparingAt!.getTime() - o.createdAt.getTime()) /
                (60 * 60 * 1000),
            0,
          ) / responded.length;

    const rating = await this.reviews.getVendorRatingSummary(vendorId);

    return {
      vendor_id: vendorId,
      window_days: WINDOW_DAYS,
      window_from: from.toISOString(),
      window_to: to.toISOString(),
      cancellation_rate: cancellationRate,
      average_response_time_hours: averageResponseHours,
      responded_orders_count: responded.length,
      rating_average: rating.average,
      rating_count: rating.count,
    };
  }
}
