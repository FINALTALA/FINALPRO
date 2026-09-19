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
import { IdempotencyCompletionService } from '../common/idempotency/idempotency-completion.service';
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
    private readonly idempotencyCompletion: IdempotencyCompletionService,
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

    return this.prisma.$transaction(async (tx) => {
      const category = await tx.category.create({
        data: {
          nameAr: dto.name_ar,
          nameEn: dto.name_en,
          parentId: dto.parent_id ?? null,
        },
      });

      await this.auditLog.record(
        {
          actorId: user.id,
          correlationId: req.correlationId,
          action: 'category.created',
          entityType: 'Category',
          entityId: category.id,
          afterState: this.toDto(category),
        },
        tx,
      );

      const body = this.toDto(category);
      await this.idempotencyCompletion.complete(
        tx,
        req.idempotencyClaimId,
        body,
        201,
      );
      return body;
    });
  }

  /**
   * Walks the proposed-parent's ancestor chain looking for `categoryId`
   * itself - catches both direct self-parenting (`categoryId ===
   * proposedParentId`) and indirect cycles (e.g. A is currently B's
   * parent; setting A's own parent to B would close a loop). A `visited`
   * guard bounds the walk even against a pre-existing corrupt chain,
   * rather than looping forever.
   */
  private async wouldCreateCycle(
    tx: {
      category: {
        findUnique: (args: {
          where: { id: string };
          select: { parentId: true };
        }) => Promise<{ parentId: string | null } | null>;
      };
    },
    categoryId: string,
    proposedParentId: string,
  ): Promise<boolean> {
    if (categoryId === proposedParentId) {
      return true;
    }
    const visited = new Set<string>();
    let current: string | null = proposedParentId;
    while (current) {
      if (current === categoryId) {
        return true;
      }
      if (visited.has(current)) {
        break;
      }
      visited.add(current);
      const node = await tx.category.findUnique({
        where: { id: current },
        select: { parentId: true },
      });
      current = node?.parentId ?? null;
    }
    return false;
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
    return this.prisma.$transaction(async (tx) => {
      // Sprint 3 review round 6: a per-row FOR UPDATE lock (the earlier
      // version of this method) only serializes two concurrent edits of
      // *this same* category - it does nothing for two concurrent edits
      // of two *different* categories that jointly close a cycle
      // neither request's own ancestor-chain read would see (e.g. X's
      // parent -> Y and, at the same time, Y's parent -> X: each
      // transaction's read of the other's current ancestor chain still
      // shows no cycle, since neither has committed yet). A single
      // transaction-scoped Postgres advisory lock, shared by every
      // category-tree-mutating transaction (keyed by a fixed constant,
      // not by any specific row), fixes this properly: only one such
      // transaction can hold it at a time, so the second of two
      // concurrent re-parenting requests always evaluates its cycle
      // check against the first's already-committed result, not a
      // stale pre-commit snapshot. Released automatically at commit/
      // rollback - no manual unlock needed.
      // $executeRaw, not $queryRaw: pg_advisory_xact_lock() returns void,
      // and Prisma's $queryRaw can't deserialize a void result column
      // ("Failed to deserialize column of type 'void'") - $executeRaw
      // doesn't attempt to, so it's the correct call for a statement run
      // purely for its side effect.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('finalpro:category_tree'))`;

      const existing = await tx.category.findUnique({ where: { id } });
      if (!existing) {
        throw new NotFoundException({
          code: 'CATEGORY_NOT_FOUND',
          message: 'Category not found',
        });
      }

      if (dto.parent_id !== undefined && dto.parent_id !== null) {
        const parent = await tx.category.findUnique({
          where: { id: dto.parent_id },
        });
        if (!parent) {
          throw new NotFoundException({
            code: 'PARENT_CATEGORY_NOT_FOUND',
            message: 'parent_id does not reference an existing category',
          });
        }
        if (await this.wouldCreateCycle(tx, id, dto.parent_id)) {
          throw new BadRequestException({
            code: 'CATEGORY_CYCLE',
            message:
              'This parent_id would make the category an ancestor of itself',
          });
        }
      }

      const category = await tx.category.update({
        where: { id },
        data: {
          nameAr: dto.name_ar,
          nameEn: dto.name_en,
          ...(dto.parent_id !== undefined ? { parentId: dto.parent_id } : {}),
        },
      });

      await this.auditLog.record(
        {
          actorId: user.id,
          correlationId: req.correlationId,
          action: 'category.updated',
          entityType: 'Category',
          entityId: category.id,
          beforeState: this.toDto(existing),
          afterState: this.toDto(category),
        },
        tx,
      );

      return this.toDto(category);
    });
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
