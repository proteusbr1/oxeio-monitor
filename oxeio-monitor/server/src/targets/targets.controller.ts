import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Ip,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Delete,
} from '@nestjs/common';
import { DesignTargetStatus, UserRole } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';

import { CurrentUser, Roles } from '../auth/decorators';
import type { SessionUser } from '../auth/types';
import { RequiresFeature } from '../features/requires-feature';
import { DROP_REASONS, type DropReason } from './targets.rules';
import {
  DELETE_MAX,
  TargetsService,
  type BulkResult,
  type DeleteResult,
  type MyTarget,
} from './targets.service';

class BulkDto {
  /**
   * Ceiling of 5 million characters. It used to be 60,000 (about 500 URLs).
   *
   * 5 million characters hold about 45,000 Amazon URLs. Researchers add about
   * 500 a day, so in practice this is the same as "no limit".
   *
   * Careful: a ceiling is kept on purpose. With no limit at all, someone
   * pasting a 500 MB file by mistake would make the server load and parse it
   * in memory, and then the whole office's agents could not send data either.
   * The ceiling is there to stop accidents, not people.
   *
   * It is deliberately larger than the HTTP body limit (8 MB, `app.setup.ts`);
   * otherwise a bigger paste would get Express's silent 413 instead of this
   * message.
   */
  @IsString() @MaxLength(5_000_000)
  text!: string;
}

/**
 * Delete many at once.
 *
 * Careful: without `@Type(() => Number)`, a JSON `["12"]` would stay a string
 * and fail `IsInt`, though the mistake is in the conversion, not the screen.
 */
class DeleteManyDto {
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(DELETE_MAX)
  @Type(() => Number)
  @IsInt({ each: true })
  @Min(1, { each: true })
  ids!: number[];

  /** The same three as Skip: `DROP_REASONS` in `targets.rules.ts` */
  @IsIn([...DROP_REASONS])
  reason!: DropReason;
}

class ListQueryDto {
  /** `deleted` is included too; otherwise the owner could never find dead ASINs */
  @IsOptional() @IsIn(['pool', 'assigned', 'done', 'skipped', 'deleted'])
  status?: DesignTargetStatus;

  /**
   * ASIN or job number.
   *
   * URLs no longer work (owner's decision). If a link is pasted, the screen
   * says so directly instead of silently showing an empty list.
   */
  @IsOptional() @IsString() @MaxLength(200)
  q?: string;

  /** Without `@Type`, `"2"` from the query string would stay a string */
  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  page?: number;

  /** Which designer: `employees.id` */
  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  staffId?: number;

  /**
   * Who brought them in: `users.id`.
   *
   * Careful: this is a different id space from the one above (that is
   * `employees`, this is `users`). The two names sit side by side for exactly
   * this reason: so it is obvious at a glance that they are not the same thing.
   */
  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  addedById?: number;

  /**
   * Date range, by the day of the last thing that happened.
   *
   * Only `YYYY-MM-DD` is accepted. With loose parsing, `03-04-2026` would be
   * March to some and April to others, and the wrong result would show up as
   * "nothing found", not as a mistake.
   */
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: "from must be a date like 2026-08-23",
  })
  from?: string;

  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: "to must be a date like 2026-08-23",
  })
  to?: string;

  /**
   * Filter by work stage: the researcher's two daily queues.
   *
   * This cannot be done with `status`: `uploaded`/`live` are not states but
   * dates, on purpose. Otherwise the row would leave `done` and every "how
   * many designs were made" count would silently drop.
   */
  /**
   * Careful: `no_file` is not a stage like the others, since it has no slot
   * in the work chain. It is a question: "which targets were marked done but
   * the file was never opened?"
   *
   * It still sits in the same field because filtering, searching and paging
   * are exactly the same; a separate endpoint would have needed those three
   * written a second time.
   */
  @IsOptional()
  @IsIn(['to_check', 'to_fix', 'to_upload', 'to_live', 'to_review', 'no_file'])
  stage?:
    | 'to_check'
    | 'to_fix'
    | 'to_upload'
    | 'to_live'
    | 'to_review'
    | 'no_file';
}

class UpdateTargetDto {
  @IsIn(['pool', 'assigned', 'done', 'skipped'])
  status!: DesignTargetStatus;
}

class CheckedDto {
  /**
   * `true` = spelling is correct, `false` = a mistake was found.
   *
   * Deliberately not optional: with a default, sending nothing by mistake
   * would silently become "ok", and a wrong design would go to Amazon.
   */
  @IsBoolean()
  ok!: boolean;
}

class LiveDto {
  /**
   * ASIN of the new product that went live. Optional.
   *
   * Careful: do not confuse it with the sample ASIN the researcher brought;
   * this is our own sellable product. It is optional because "gone live"
   * should be reportable even without it in hand; otherwise someone would put
   * in something wrong just to fill the field.
   */
  @IsOptional() @IsString() @Matches(/^[A-Z0-9]{10}$/, {
    message: 'liveAsin must be a 10-character Amazon ASIN',
  })
  liveAsin?: string;
}

/**
 * "Why did you drop it".
 *
 * Careful: this used to be free text behind `@IsOptional()`, and the result
 * was that none of the 93 skipped rows in the field had a reason: the screen
 * never sent one. Now it is a choice of three, and mandatory: on screen the
 * button is the reason, so there is no way to not send it.
 *
 * The list lives in one place, `targets.rules.ts`: the same three for both
 * Skip and Delete, otherwise one day a reason would be added to one and not
 * the other.
 */
class DropReasonDto {
  @IsIn([...DROP_REASONS])
  reason!: DropReason;
}

/**
 * Design targets.
 *
 * Careful: this controller deliberately has no `@Roles()`. Permission goes by
 * kind of work, not portal role (researchers log in as `employee`). The guard
 * is in `TargetsService.assertCanSubmit()`, where the reason is written too.
 */
@RequiresFeature('designTargets')
@Controller('design-targets')
export class TargetsController {
  constructor(private readonly targets: TargetsService) {}

  /** Up to 500 URLs at once: researcher, manager, owner */
  @Post('bulk')
  bulk(
    @CurrentUser() actor: SessionUser,
    @Body() dto: BulkDto,
    @Ip() ip: string,
  ): Promise<BulkResult> {
    return this.targets.bulkAdd(actor, dto.text, ip);
  }

  /**
   * The full list: owner, manager, researcher.
   *
   * Careful: the guard is called by hand here, not through `@Roles()`. The
   * researcher's role is `employee`, so a decorator cannot single them out.
   */
  @Get()
  async list(@CurrentUser() actor: SessionUser, @Query() q: ListQueryDto) {
    await this.targets.assertCanUse(actor);
    return this.targets.list(q);
  }

  /**
   * Careful: the same guard here too. This used to be open, so any staff
   * member could read the pool counts. Not a big leak, but with two rules on
   * two routes of the same screen, one day the mistake would land somewhere
   * bigger.
   */
  /**
   * How many each person has brought in.
   *
   * Like `designers`, this only fills a dropdown, but the number comes along,
   * so the owner gets the answer without a single click.
   */
  @Get('adders')
  async adders(@CurrentUser() actor: SessionUser) {
    await this.targets.assertCanUse(actor);
    return this.targets.adders();
  }

  /** For the filter dropdown: owner, manager, researcher */
  @Get('designers')
  async designers(@CurrentUser() actor: SessionUser) {
    await this.targets.assertCanUse(actor);
    return this.targets.designers();
  }

  @Get('stats')
  async stats(@CurrentUser() actor: SessionUser) {
    await this.targets.assertCanUse(actor);
    return this.targets.stats();
  }

  /**
   * Edit the list: owner, manager, researcher.
   *
   * There is no way to change the ASIN: it is the row's identity, and
   * changing it would shake the foundation of the duplicate guard.
   */
  @Patch(':id')
  async update(
    @CurrentUser() actor: SessionUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateTargetDto,
  ) {
    await this.targets.assertCanUse(actor);
    return this.targets.update(id, dto.status, new Date(), actor.userId);
  }

  /**
   * Delete selected rows.
   *
   * Careful: `POST`, not `DELETE`. Many proxies and clients silently drop the
   * body of a `DELETE`, and then we would be hunting a "nothing was deleted"
   * bug. The other actions in this controller (`:id/checked`, `distribute`)
   * are POST too, so the rule is the same everywhere.
   *
   * Careful: the guard is `assertCanUse` (owner, manager, researcher), like
   * the single `@Delete(':id')` below. Both paths do the same job, so with
   * two different guards one could be used to dodge the other. On screen only
   * the owner and manager see the button (`mayDelete`).
   */
  @Post('delete')
  async deleteMany(
    @CurrentUser() actor: SessionUser,
    @Body() dto: DeleteManyDto,
    @Ip() ip: string,
  ): Promise<DeleteResult> {
    await this.targets.assertCanUse(actor);
    return this.targets.softDelete(dto.ids, actor.userId, ip, dto.reason);
  }

  /**
   * One row: the single-item form of the bulk path above.
   *
   * Careful: this is no longer a real `DELETE`. The row stays and its status
   * becomes `deleted`; otherwise the `asin` UNIQUE guard would vanish too and
   * a dead ASIN would re-enter the pool tomorrow.
   */
/**
   * Many proxies drop the body of a `DELETE`, so the reason goes in the query
   * (`?reason=not_found`): a small, known value with nothing personal in it.
   */
  @Delete(':id')
  async remove(
    @CurrentUser() actor: SessionUser,
    @Param('id', ParseIntPipe) id: number,
    @Query() query: DropReasonDto,
    @Ip() ip: string,
  ): Promise<DeleteResult> {
    await this.targets.assertCanUse(actor);
    return this.targets.softDelete([id], actor.userId, ip, query.reason);
  }

  /**
   * Manual distribution: in addition to the daily morning job, not instead.
   *
   * Owner/manager only: once distributed it cannot be undone (numbers get
   * assigned), so the button should not be in everyone's hands.
   */
  /**
   * "Uploaded": owner, manager, researcher.
   *
   * Not the designer: making the file and sending it to Amazon are two
   * separate jobs, and whoever does the second is the one to say so.
   */
  /**
   * "Spelling checked" (ADR-038): the proofreader's job.
   *
   * Careful: the guard is `assertCanUse`: owner, manager, researcher. The
   * proofreader's role is `employee`, so a role could not do this; the kind of
   * work does. A designer cannot approve their own work, which is the point.
   *
   * `ok: false` means a mistake was found; the row then goes to the "to fix"
   * queue.
   */
  @Post(':id/checked')
  async checked(
    @CurrentUser() actor: SessionUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: CheckedDto,
  ) {
    await this.targets.assertCanProofread(actor);
    return this.targets.markChecked(id, dto.ok, actor.userId, new Date());
  }

  /**
   * "Fixed": the fixer's job.
   *
   * Careful: ownership of the design does not change; who fixed it is stored
   * in a separate field.
   */
  @Post(':id/fixed')
  async fixed(
    @CurrentUser() actor: SessionUser,
    @Param('id', ParseIntPipe) id: number,
  ) {
    await this.targets.assertCanProofread(actor);
    return this.targets.markFixed(id, actor.userId, new Date());
  }

  /**
   * "Reviewed": lets the owner and manager manage the designs that were
   * deleted or skipped separately.
   *
   * Careful: owner and manager only, and `assertCanUse` would not do. That
   * guard also admits researchers, but the owner named exactly these two:
   * why a designer skipped is a team-management question.
   */
  @Roles(UserRole.owner, UserRole.manager)
  @Post(':id/reviewed')
  reviewed(
    @CurrentUser() actor: SessionUser,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.targets.markReviewed(id, actor.userId, new Date());
  }

  @Post(':id/uploaded')
  async uploaded(
    @CurrentUser() actor: SessionUser,
    @Param('id', ParseIntPipe) id: number,
  ) {
    await this.targets.assertCanUse(actor);
    return this.targets.markUploaded(id, new Date());
  }

  /** "Live on Amazon", with the new product's ASIN (optional) */
  @Post(':id/live')
  async live(
    @CurrentUser() actor: SessionUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: LiveDto,
  ) {
    await this.targets.assertCanUse(actor);
    return this.targets.markLive(id, dto.liveAsin ?? null, new Date());
  }

  /**
   * Take back a "done".
   *
   * Careful: `PATCH :id { status: 'assigned' }` cannot do this. That path only
   * changes `status` and does not clear `completedAt`. The queues run on
   * `completedAt`, so the row would show "in hand" while still sitting in the
   * upload queue.
   *
   * The designer's own Undo is a separate route (`/me/targets/:id/undone`),
   * which has a same-day limit; this one has none.
   */
  @Post(':id/undone')
  async undone(
    @CurrentUser() actor: SessionUser,
    @Param('id', ParseIntPipe) id: number,
    @Ip() ip: string,
  ) {
    await this.targets.assertCanUse(actor);
    return this.targets.undoComplete(id, { userId: actor.userId, ip });
  }

  @Roles(UserRole.owner, UserRole.manager)
  @Post('distribute')
  distribute() {
    return this.targets.distribute();
  }
}

/**
 * The designer's own targets, under `/me`.
 *
 * A separate controller because the path is different (`/me/targets`), and
 * no role guard is needed here: everyone gets only their own list.
 */
@RequiresFeature('designTargets')
@Controller('me/targets')
export class MyTargetsController {
  constructor(private readonly targets: TargetsService) {}

  @Get()
  mine(@CurrentUser() actor: SessionUser): Promise<MyTarget[]> {
    return this.targets.mine(employeeIdOf(actor));
  }

  /**
   * "I dropped this": the owner chose to have both (caught by the designer
   * themselves and corrected by the designer).
   *
   * Careful: a dropped target does not go back to the pool. Otherwise it
   * would land in someone's hand the next day, and they might drop it for the
   * same reason. The owner reviews the list and decides.
   */
  @Post(':id/skip')
  skip(
    @CurrentUser() actor: SessionUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: DropReasonDto,
  ) {
    return this.targets.skip(employeeIdOf(actor), id, dto.reason);
  }

  /**
   * "I finished": a manual mark.
   *
   * Usually not needed: if the job number is in the file name, the system
   * notices by itself. This is for cases where the number was entered wrongly.
   */
  @Post(':id/done')
  done(
    @CurrentUser() actor: SessionUser,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.targets.markDone(employeeIdOf(actor), id, actor.userId);
  }

  /**
   * "I pressed it by mistake".
   *
   * Careful: it must be today's work, the person's own row, and not yet moved
   * along the chain. All three conditions are in the service. The owner
   * reverses older mistakes, not the designer: reversing yesterday's would
   * change yesterday's numbers.
   */
  @Post(':id/undone')
  undone(
    @CurrentUser() actor: SessionUser,
    @Param('id', ParseIntPipe) id: number,
    @Ip() ip: string,
  ) {
    return this.targets.undoMine(employeeIdOf(actor), id, new Date(), {
      userId: actor.userId,
      ip,
    });
  }
}

/**
 * The `employeeId` of an owner or manager is usually `null`: they are not tied
 * to a staff row, so they have no "own targets". Same rule and same message as
 * `me.service.ts`.
 */
function employeeIdOf(actor: SessionUser): number {
  if (actor.employeeId === null) {
    throw new ForbiddenException(
      'This account is not linked to a staff record, so there are no targets to show.',
    );
  }

  return actor.employeeId;
}
