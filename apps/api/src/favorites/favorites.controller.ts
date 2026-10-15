import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator';
import {
  AuthenticatedUser,
  SessionAuthGuard,
} from '../auth/session-auth.guard';
import { AddFavoriteDto } from './dto/add-favorite.dto';
import { SetNotificationPreferenceDto } from './dto/set-notification-preference.dto';
import { FavoritesService } from './favorites.service';

// Sprint 24 (FR-FAV-001/005, PDR-002, final decision #6): every route
// scoped to the session user directly (no user id in any URL/body) -
// same BOLA-safe convention StoreFollow already established. Add is a
// plain upsert (idempotent, no Idempotency-Key needed, same as
// StoreFollow.follow()); remove/list/preferences are all naturally
// idempotent reads/deletes too.
@Controller()
@UseGuards(SessionAuthGuard)
export class FavoritesController {
  constructor(private readonly favorites: FavoritesService) {}

  @Post('favorites')
  async add(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: AddFavoriteDto,
  ) {
    return this.favorites.add(user.id, dto);
  }

  @Delete('favorites/:id')
  async remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.favorites.remove(user.id, id);
  }

  @Get('favorites')
  async list(@CurrentUser() user: AuthenticatedUser) {
    return this.favorites.list(user.id);
  }

  @Get('customers/me/notification-preferences')
  async getPreferences(@CurrentUser() user: AuthenticatedUser) {
    return this.favorites.getPreferences(user.id);
  }

  @Patch('customers/me/notification-preferences')
  async setPreference(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: SetNotificationPreferenceDto,
  ) {
    return this.favorites.setPreference(user.id, dto.alert_type, dto.enabled);
  }
}
