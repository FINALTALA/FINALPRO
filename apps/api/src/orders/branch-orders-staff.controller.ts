import {
  Controller,
  Get,
  NotFoundException,
  Param,
  UseGuards,
} from '@nestjs/common';
import { SessionAuthGuard } from '../auth/session-auth.guard';
import { VendorMembershipGuard } from '../auth/vendor-membership.guard';
import { RequireVendorRole } from '../auth/vendor-role.decorator';
import { PrismaService } from '../prisma/prisma.service';

interface BranchOrderRow {
  id: string;
  status: string;
  fulfilmentMethod: string;
  paymentMethod: string;
  total: unknown;
  createdAt: Date;
  pickupCode: string | null;
  customerOrder: {
    customer: { displayName: string | null; user: { phone: string } };
  };
}

// Sprint 10 (RB-ORD-004, PDR-009): a minimal, READ-ONLY order list for
// branch staff/owners - explicitly NOT the full Orders UI (no status
// actions, no Sent/Delivered workflow - that's Sprint 11). Visibility
// is limited to exactly what RB-ORD-004 names: customer name, phone,
// and the pickup code for PICKUP orders - the customer's delivery
// address is never included here, on any order, regardless of
// fulfilment method (nothing in this sprint's scope needs staff to see
// it yet - Sprint 11's Sent/Delivered workflow is where that
// requirement would actually arise).
function orderDto(o: BranchOrderRow) {
  return {
    id: o.id,
    status: o.status,
    fulfilment_method: o.fulfilmentMethod,
    payment_method: o.paymentMethod,
    total: Number(o.total),
    created_at: o.createdAt.toISOString(),
    customer_name: o.customerOrder.customer.displayName,
    customer_phone: o.customerOrder.customer.user.phone,
    pickup_code: o.fulfilmentMethod === 'PICKUP' ? o.pickupCode : null,
  };
}

const ORDER_INCLUDE = {
  customerOrder: {
    select: {
      customer: {
        select: { displayName: true, user: { select: { phone: true } } },
      },
    },
  },
} as const;

@Controller('vendors/:vendorId')
@UseGuards(SessionAuthGuard, VendorMembershipGuard)
export class BranchOrdersStaffController {
  constructor(private readonly prisma: PrismaService) {}

  // PDR-009: "An employee controls only the assigned branch's orders."
  // VendorMembershipGuard itself already 403s a BRANCH_EMPLOYEE whose
  // own membership.branchId doesn't match this route's :branchId - the
  // same guard behavior every other per-branch route in this codebase
  // already relies on (e.g. DeliveryWindowsController). An OWNER has no
  // such restriction and may view any of their own vendor's branches.
  @Get('branches/:branchId/orders')
  async listForBranch(
    @Param('vendorId') vendorId: string,
    @Param('branchId') branchId: string,
  ) {
    const branch = await this.prisma.storeBranch.findUnique({
      where: { id: branchId },
    });
    if (!branch || branch.vendorId !== vendorId) {
      throw new NotFoundException({
        code: 'BRANCH_NOT_FOUND',
        message: 'Branch not found for this vendor',
      });
    }
    const orders = await this.prisma.branchOrder.findMany({
      where: { vendorId, branchId },
      orderBy: { createdAt: 'desc' },
      include: ORDER_INCLUDE,
    });
    return orders.map(orderDto);
  }

  // PDR-009: "The owner controls ... all store inventory/orders."
  // Owner-only, all branches of this vendor at once - a convenience on
  // top of the per-branch endpoint above, not a separate authorization
  // model.
  @Get('orders')
  @RequireVendorRole('OWNER')
  async listForVendor(@Param('vendorId') vendorId: string) {
    const orders = await this.prisma.branchOrder.findMany({
      where: { vendorId },
      orderBy: { createdAt: 'desc' },
      include: ORDER_INCLUDE,
    });
    return orders.map(orderDto);
  }
}
