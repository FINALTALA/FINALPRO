import { Controller, Get, Param } from '@nestjs/common';
import { StoreHomeService } from './store-home.service';

// «الصفحة الرئيسية المرنة للمتجر» (2026-11-20): what shoppers see - public,
// like every other storefronts/:slug read. Only the PUBLISHED layout, each
// reference re-checked now (published, in stock in a sellable branch,
// visible, the store's own image); never the draft, never stock numbers.
// With the flag off (or the store unavailable) there are no blocks and the
// store page stays exactly as before.
@Controller('storefronts/:slug')
export class StoreHomePublicController {
  constructor(private readonly home: StoreHomeService) {}

  @Get('home')
  home_(@Param('slug') slug: string) {
    return this.home.publicHome(slug);
  }
}
