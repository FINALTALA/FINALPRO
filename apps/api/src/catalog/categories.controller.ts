import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { Request } from 'express';
import { AuditLogService } from '../audit/audit-log.service';
import { CurrentUser } from '../auth/current-user.decorator';
import { PlatformRole } from '../../generated/prisma/client';
import { RequirePlatformRole } from '../auth/platform-role.decorator';
import { PlatformRoleGuard } from '../auth/platform-role.guard';
import {
  AuthenticatedUser,
  SessionAuthGuard,
} from '../auth/session-auth.guard';
import { IdempotencyInterceptor } from '../common/idempotency/idempotency.interceptor';
import { PrismaService } from '../prisma/prisma.service';
import { CreateCategoryDto } from './dto/create-category.dto';
import { UpdateCategoryDto } from './dto/update-category.dto';

// FR-CAT-001 / BL-CAT-001: catalog admin manages a hierarchical
// category/subcategory tree, AR/EN labels on every node. Read routes
// are public (Guest can browse the catalog per Part 1's role table);
// writes require PLATFORM_ADMIN - the FYP's simplified role model
// folds "catalog administrator" into Platform Admin (Part 1 footnote 2).
@Controller('categories')
export class CategoriesController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
  ) {}

  private toDto(category: {
    id: string;
    nameAr: string;
    nameEn: string;
    parentId: string | null;
  }) {
    return {
      id: category.id,
      name_ar: category.nameAr,
      name_en: category.nameEn,
      parent_id: category.parentId,
    };
  }

  @Get()
  async list() {
    const categories = await this.prisma.category.findMany({
      orderBy: { createdAt: 'asc' },
    });
    return categories.map((c) => this.toDto(c));
  }

  @Get(':id')
  async get(@Param('id') id: string) {
    const category = await this.prisma.category.findUnique({
      where: { id },
      include: { children: true },
    });
    if (!category) {
      throw new NotFoundException({
        code: 'CATEGORY_NOT_FOUND',
        message: 'Category not found',
      });
    }
    return {
      ...this.toDto(category),
      children: category.children.map((c) => this.toDto(c)),
    };
  }

  @Post()
  @HttpCode(201)
  @UseGuards(SessionAuthGuard, PlatformRoleGuard)
  @RequirePlatformRole(PlatformRole.PLATFORM_ADMIN)
  @UseInterceptors(IdempotencyInterceptor)
  async create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateCategoryDto,
    @Req() req: Request,
  ) {
    if (dto.parent_id) {
      const parent = await this.prisma.category.findUnique({
        where: { id: dto.parent_id },
      });
      if (!parent) {
        throw new NotFoundException({
          code: 'PARENT_CATEGORY_NOT_FOUND',
          message: 'parent_id does not reference an existing category',
        });
      }
    }

    const category = await this.prisma.category.create({
      data: {
        nameAr: dto.name_ar,
        nameEn: dto.name_en,
        parentId: dto.parent_id ?? null,
      },
    });

    await this.auditLog.record({
      actorId: user.id,
      correlationId: req.correlationId,
      action: 'category.created',
      entityType: 'Category',
      entityId: category.id,
      afterState: this.toDto(category),
    });

    return this.toDto(category);
  }

  @Patch(':id')
  @UseGuards(SessionAuthGuard, PlatformRoleGuard)
  @RequirePlatformRole(PlatformRole.PLATFORM_ADMIN)
  async update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateCategoryDto,
    @Req() req: Request,
  ) {
    const existing = await this.prisma.category.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundException({
        code: 'CATEGORY_NOT_FOUND',
        message: 'Category not found',
      });
    }
    if (dto.parent_id === id) {
      throw new BadRequestException({
        code: 'INVALID_PARENT',
        message: 'A category cannot be its own parent',
      });
    }

    const category = await this.prisma.category.update({
      where: { id },
      data: {
        nameAr: dto.name_ar,
        nameEn: dto.name_en,
        ...(dto.parent_id !== undefined ? { parentId: dto.parent_id } : {}),
      },
    });

    await this.auditLog.record({
      actorId: user.id,
      correlationId: req.correlationId,
      action: 'category.updated',
      entityType: 'Category',
      entityId: category.id,
      beforeState: this.toDto(existing),
      afterState: this.toDto(category),
    });

    return this.toDto(category);
  }

  @Delete(':id')
  @HttpCode(204)
  @UseGuards(SessionAuthGuard, PlatformRoleGuard)
  @RequirePlatformRole(PlatformRole.PLATFORM_ADMIN)
  async remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Req() req: Request,
  ) {
    const existing = await this.prisma.category.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundException({
        code: 'CATEGORY_NOT_FOUND',
        message: 'Category not found',
      });
    }

    const inUse = await this.prisma.canonicalProduct.findFirst({
      where: { categoryId: id },
      select: { id: true },
    });
    if (inUse) {
      throw new ConflictException({
        code: 'CATEGORY_IN_USE',
        message: 'Category has canonical products and cannot be deleted',
      });
    }

    await this.prisma.category.delete({ where: { id } });

    await this.auditLog.record({
      actorId: user.id,
      correlationId: req.correlationId,
      action: 'category.deleted',
      entityType: 'Category',
      entityId: id,
      beforeState: this.toDto(existing),
    });
  }
}
