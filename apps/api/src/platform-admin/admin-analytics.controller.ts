import {
  BadRequestException,
  Controller,
  Get,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Response } from 'express';
import * as ExcelJS from 'exceljs';
import { PlatformRole } from '../../generated/prisma/client';
import { RequirePlatformRole } from '../auth/platform-role.decorator';
import { PlatformRoleGuard } from '../auth/platform-role.guard';
import { SessionAuthGuard } from '../auth/session-auth.guard';
import {
  AdminAnalyticsService,
  EXPORT_ROW_LIMIT,
} from './admin-analytics.service';
import { sanitizeCsvFormulaField, toCsvRow } from './audit-log-export.util';

export const ANALYTICS_EXPORT_SECTIONS = [
  'overview',
  'daily',
  'stores',
  'products',
  'canonical',
  'refunds',
  'returns',
  'customers',
  'pos',
] as const;

/**
 * VIA phase 4 - Dashboard and Analytics (PLATFORM_ADMIN only, every
 * endpoint and export). Read-only; one shared query set
 * (AdminAnalyticsService) behind the screen and the files.
 */
@Controller('admin/analytics')
@UseGuards(SessionAuthGuard, PlatformRoleGuard)
export class AdminAnalyticsController {
  constructor(private readonly analytics: AdminAnalyticsService) {}

  @Get('dashboard')
  @RequirePlatformRole(PlatformRole.PLATFORM_ADMIN)
  dashboard() {
    return this.analytics.dashboard();
  }

  @Get('report')
  @RequirePlatformRole(PlatformRole.PLATFORM_ADMIN)
  report(@Query('from') from?: string, @Query('to') to?: string) {
    return this.analytics.report(from, to);
  }

  /**
   * The same figures as the report for the same filter, with the metadata
   * (period, timezone, UTC interval, currency, channel, as-of) on top.
   * Text cells are formula-safe (the audit export's own rule); rows are
   * capped at EXPORT_ROW_LIMIT in the report's stable order.
   */
  @Get('export')
  @RequirePlatformRole(PlatformRole.PLATFORM_ADMIN)
  async export(
    @Res() res: Response,
    @Query('section') section?: string,
    @Query('format') format = 'csv',
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    if (
      !section ||
      !(ANALYTICS_EXPORT_SECTIONS as readonly string[]).includes(section)
    ) {
      throw new BadRequestException({
        code: 'INVALID_SECTION',
        message: `section must be one of ${ANALYTICS_EXPORT_SECTIONS.join(', ')}`,
      });
    }
    if (format !== 'csv' && format !== 'xlsx') {
      throw new BadRequestException({
        code: 'INVALID_FORMAT',
        message: 'format must be csv or xlsx',
      });
    }
    const data = (await this.analytics.exportSection(section, from, to))!;
    const metaRows: [string, string][] = [
      ['report', `VIA analytics - ${section}`],
      ['from', data.meta.from],
      ['to', data.meta.to],
      ['time_zone', data.meta.time_zone],
      [
        'interval_utc',
        `[${data.meta.interval_utc.start}, ${data.meta.interval_utc.end})`,
      ],
      [
        'previous_period',
        `${data.meta.previous.from} .. ${data.meta.previous.to}`,
      ],
      ['currency', data.meta.currency],
      ['channel', data.channel],
      ['generated_at', data.meta.generated_at],
      ['row_limit', String(EXPORT_ROW_LIMIT)],
      ['note', 'GMV is completed marketplace merchandise, not VIA revenue'],
    ];
    const safe = (v: string) => sanitizeCsvFormulaField(v) ?? '';
    const name = `via-analytics-${section}-${data.meta.from}_${data.meta.to}`;

    if (format === 'csv') {
      const lines = [
        ...metaRows.map(([k, v]) => toCsvRow([`# ${k}`, safe(v)])),
        '',
        toCsvRow(data.columns),
        ...data.rows.map((r) => toCsvRow(r.map(safe))),
      ];
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${name}.csv"`,
      );
      // BOM so spreadsheet apps read the Arabic text as UTF-8.
      res.send('﻿' + lines.join('\n'));
      return;
    }

    const wb = new ExcelJS.Workbook();
    wb.created = new Date(data.meta.generated_at);
    const sheet = wb.addWorksheet(section);
    sheet.addRow(data.columns).font = { bold: true };
    for (const r of data.rows) sheet.addRow(r.map(safe));
    sheet.columns.forEach((c) => (c.width = 18));
    const about = wb.addWorksheet('about');
    for (const [k, v] of metaRows) about.addRow([k, safe(v)]);
    about.getColumn(1).width = 18;
    about.getColumn(2).width = 60;
    const buffer = await wb.xlsx.writeBuffer();
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader('Content-Disposition', `attachment; filename="${name}.xlsx"`);
    res.send(Buffer.from(buffer as ArrayBuffer));
  }
}
