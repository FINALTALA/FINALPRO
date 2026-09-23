import {
  Controller,
  Get,
  NotFoundException,
  Param,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
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

// Owner-facing DTO - a wider surface within the owner's own authority
// (PDR-009: "the owner controls ... all store inventory/orders").
function ownerOrderDto(o: BranchOrderRow) {
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

// Codex review round 2 on commit d0ea80d: RB-ORD-004's own wording is
// explicit - "staff view limited to name/phone/code, no address" - and
// the previous single shared DTO gave a BRANCH_EMPLOYEE the SAME wide
// surface as the owner (status/total/payment_method/created_at), well
// beyond what that requirement names.
//
// Codex review round 4 on commit 95a8430 (fix #3): the agreed surface
// for staff is name + phone + pickup code ONLY - `id` is an internal
// identifier, not one of the three, and a React list key is a frontend
// display concern that must never grow the API's own response shape.
// The frontend keys its list some other way (index, or
// phone+pickup_code) instead.
function employeeOrderDto(o: BranchOrderRow) {
  return {
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

// Sprint 10 (RB-ORD-004, PDR-009): a minimal, READ-ONLY order list for
// branch staff/owners - explicitly NOT the full Orders UI (no status
// actions, no Sent/Delivered workflow - that's Sprint 11). The
// customer's delivery address is never included here, on any order,
// for any caller, regardless of fulfilment method (nothing in this
// sprint's scope needs it yet - Sprint 11's Sent/Delivered workflow is
// where that requirement would actually arise).
@Controller('vendors/:vendorId')
@UseGuards(SessionAuthGuard, VendorMembershipGuard)
export class BranchOrdersStaffController {
  constructor(private readonly prisma: PrismaService) {}

  // PDR-009: "An employee controls only the assigned branch's orders."
  // VendorMembershipGuard itself already 403s a BRANCH_EMPLOYEE whose
  // own membership.branchId doesn't match this route's :branchId - the
  // same guard behavior every other per-branch route in this codebase
  // already relies on (e.g. DeliveryWindowsController). An OWNER has no
  // such restriction and may view any of their own vendor's branches -
  // and, reaching this same route, still gets the WIDER owner DTO
  // (role-conditional response shape, not a separate endpoint).
  @Get('branches/:branchId/orders')
  async listForBranch(
    @Param('vendorId') vendorId: string,
    @Param('branchId') branchId: string,
    @Req() req: Request,
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
    const isEmployee = req.vendorMembership?.role === 'BRANCH_EMPLOYEE';
    return orders.map(isEmployee ? employeeOrderDto : ownerOrderDto);
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
    return orders.map(ownerOrderDto);
  }
}
