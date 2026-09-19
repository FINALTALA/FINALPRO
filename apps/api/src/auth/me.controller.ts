import { Controller, Get, UseGuards } from '@nestjs/common';
import { CurrentUser } from './current-user.decorator';
import { AuthenticatedUser, SessionAuthGuard } from './session-auth.guard';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Sprint 4 (RB-ROLE-005, PDR-008): the workspace/role switcher's data
 * source - "one account may be a customer and also hold store-owner or
 * branch-employee roles." Every authenticated user always has an
 * implicit `customer` workspace (no self-service way to lose that);
 * each `VendorUser` row they hold adds one more entry. Deliberately
 * read-only and self-scoped only (no `:vendorId` param) - it needs no
 * `VendorMembershipGuard`, since a user listing their own memberships
 * can never be a BOLA vector.
 */
@Controller('me')
@UseGuards(SessionAuthGuard)
export class MeController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('workspaces')
  async workspaces(@CurrentUser() user: AuthenticatedUser) {
    const memberships = await this.prisma.vendorUser.findMany({
      where: { userId: user.id },
      include: { vendor: true, branch: true },
    });

    return {
      workspaces: [
        { type: 'customer' as const },
        ...memberships.map((m) => ({
          type: 'vendor' as const,
          vendor_id: m.vendorId,
          vendor_legal_name: m.vendor.legalName,
          role: m.role,
          branch_id: m.branchId,
          branch_name: m.branch?.name ?? null,
        })),
      ],
    };
  }
}
