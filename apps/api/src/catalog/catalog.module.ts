import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { BrandsController } from './brands.controller';
import { CategoriesController } from './categories.controller';

@Module({
  imports: [AuditModule, AuthModule],
  controllers: [CategoriesController, BrandsController],
})
export class CatalogModule {}
