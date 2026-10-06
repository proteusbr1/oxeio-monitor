import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Ip,
  Param,
  ParseIntPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';

import { CurrentUser, Roles } from '../auth/decorators';
import type { SessionUser } from '../auth/types';
import {
  CategoryService,
  type CategoryRuleView,
  type DeleteResult,
} from './category.service';
import { CreateCategoryDto, RecategorizeDto, UpdateCategoryDto } from './dto';
import { RequiresFeature } from '../features/requires-feature';

/**
 * D06 - the owner's category rules (`/api/v1/categories`, spec § 4.2).
 *
 * Open to **owner and manager** (it used to be owner-only). This is day-to-day
 * work, and needing the owner to classify every new domain kept the
 * "percent unknown" figure growing.
 *
 * Careful: the role is still set at **class level**, not per method, so any
 * endpoint added later follows the same rule even if nobody thinks about it.
 *
 * Careful: changing a category rule **changes everyone's report numbers**,
 * especially `recategorize`, which re-applies the new rules to old rows too.
 * So every change is written to `audit_log` with the actor's name.
 */
@Roles(UserRole.owner, UserRole.manager)
@RequiresFeature('appTracking')
@Controller('categories')
export class CategoryController {
  constructor(private readonly categories: CategoryService) {}

  @Get()
  list(): Promise<CategoryRuleView[]> {
    return this.categories.list();
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(
    @CurrentUser() actor: SessionUser,
    @Body() dto: CreateCategoryDto,
    @Ip() ip: string,
  ): Promise<CategoryRuleView> {
    return this.categories.create(dto, actor.userId, ip);
  }

  /**
   * Careful: declaring this route after `PATCH /categories/:id` is fine,
   * because the two use different HTTP methods. But if `POST /categories/:id`
   * is ever added, the order of `POST /categories` and
   * `POST /categories/recategorize` starts to matter, and this one must then be
   * moved above it.
   */
  @Post('recategorize')
  @HttpCode(HttpStatus.OK)
  recategorize(
    @CurrentUser() actor: SessionUser,
    @Body() dto: RecategorizeDto,
    @Ip() ip: string,
  ): Promise<{ scanned: number; changed: number }> {
    return this.categories.recategorize(dto, actor.userId, ip);
  }

  @Patch(':id')
  update(
    @CurrentUser() actor: SessionUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateCategoryDto,
    @Ip() ip: string,
  ): Promise<CategoryRuleView> {
    return this.categories.update(id, dto, actor.userId, ip);
  }

  /**
   * Careful: 200, not 204. The response returns **how many rows became
   * unknown**. With 204 the owner would not learn that deleting one rule pushed
   * a thousand rows out of the D07 calculation.
   */
  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  remove(
    @CurrentUser() actor: SessionUser,
    @Param('id', ParseIntPipe) id: number,
    @Ip() ip: string,
  ): Promise<DeleteResult> {
    return this.categories.remove(id, actor.userId, ip);
  }
}
