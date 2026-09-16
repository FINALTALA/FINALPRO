import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { AuditLogService } from '../audit/audit-log.service';
import { CurrentUser } from '../auth/current-user.decorator';
import { AuthenticatedUser } from '../auth/session-auth.guard';
import { SessionAuthGuard } from '../auth/session-auth.guard';
import { PrismaService } from '../prisma/prisma.service';
import { CreateAddressDto } from './dto/create-address.dto';

@Controller('customers/me')
@UseGuards(SessionAuthGuard)
export class CustomersController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
  ) {}

  @Get()
  async me(@CurrentUser() user: AuthenticatedUser) {
    // Every account created via POST /auth/register also creates a
    // CustomerProfile in the same transaction, so this can be trusted
    // to exist for any authenticated user.
    const profile = await this.prisma.customerProfile.findUniqueOrThrow({
      where: { userId: user.id },
      include: { user: true },
    });
    return {
      id: profile.user.id,
      phone: profile.user.phone,
      email: profile.user.email,
      language_pref: profile.user.languagePref,
      phone_verified_at: profile.user.phoneVerifiedAt?.toISOString() ?? null,
      display_name: profile.displayName,
    };
  }

  // BL-AUTH-004's "minimal slice": create an address at the point of
  // use. Full saved-address management (list/edit/delete) is
  // BL-AUTH-004b, a Should/stretch item deferred past the FYP Must scope.
  @Post('addresses')
  async createAddress(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateAddressDto,
    @Req() req: Request,
  ) {
    const profile = await this.prisma.customerProfile.findUniqueOrThrow({
      where: { userId: user.id },
    });

    const address = await this.prisma.address.create({
      data: {
        customerId: profile.id,
        label: dto.label,
        lat: dto.lat,
        lng: dto.lng,
        landmarkNote: dto.landmark_note,
        phoneNumber1: dto.phone_number_1,
        phoneNumber2: dto.phone_number_2,
      },
    });

    await this.auditLog.record({
      actorId: user.id,
      correlationId: req.correlationId,
      action: 'address.created',
      entityType: 'Address',
      entityId: address.id,
      afterState: {
        lat: address.lat,
        lng: address.lng,
        label: address.label,
      },
    });

    return {
      id: address.id,
      label: address.label,
      lat: address.lat,
      lng: address.lng,
      landmark_note: address.landmarkNote,
      phone_number_1: address.phoneNumber1,
      phone_number_2: address.phoneNumber2,
    };
  }
}
