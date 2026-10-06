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
import { TaskStatus, UserRole } from '@prisma/client';
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
import { DROP_REASONS, REFERENCE_MAX, type DropReason } from './tasks.rules';
import {
  DELETE_MAX,
  TasksService,
  type BulkResult,
  type DeleteResult,
  type MyTask,
  type TaskList,
  type TaskStage,
  type TaskStats,
} from './tasks.service';

class BulkDto {
  /**
   * One task per line: `reference`, `reference | link` or a bare http(s) URL.
   * At most 500 non-blank lines (checked in the service, with a clear message).
   *
   * The character ceiling only stops accidents (a huge file pasted by
   * mistake); 500 lines of a 200-character reference and a 500-character
   * link fit well inside it.
   */
  @IsString() @MaxLength(500_000)
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

  /** The same reasons as Skip: `DROP_REASONS` in `tasks.rules.ts` */
  @IsIn([...DROP_REASONS])
  reason!: DropReason;
}

const STAGES: readonly TaskStage[] = [
  'to_check',
  'to_fix',
  'to_deliver',
  'to_publish',
  'to_review',
  'no_file',
];

class ListQueryDto {
  /** `deleted` is included too; otherwise the owner could never find removed tasks */
  @IsOptional() @IsIn(['pool', 'assigned', 'done', 'skipped', 'deleted'])
  status?: TaskStatus;

  /** Reference (part of it, any case) or task number */
  @IsOptional() @IsString() @MaxLength(REFERENCE_MAX)
  q?: string;

  /** Without `@Type`, `"2"` from the query string would stay a string */
  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  page?: number;

  /** Which assignee: `employees.id` */
  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  staffId?: number;

  /**
   * Who added them: `users.id`.
   *
   * Careful: a different id space from the one above (that is `employees`,
   * this is `users`).
   */
  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  addedById?: number;

  /** Date range, by the day of the last thing that happened (`YYYY-MM-DD` only) */
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: "from must be a date like 2026-08-23",
  })
  from?: string;

  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: "to must be a date like 2026-08-23",
  })
  to?: string;

  /**
   * Filter by work stage. This cannot be done with `status`: delivered and
   * published are dates, not states. `no_file` ("done, never on screen") is a
   * question rather than a stage, but filters, search and paging are the same.
   */
  @IsOptional()
  @IsIn([...STAGES])
  stage?: TaskStage;
}

class UpdateTaskDto {
  @IsIn(['pool', 'assigned', 'done', 'skipped'])
  status!: TaskStatus;
}

class CheckedDto {
  /**
   * `true` = fine, `false` = a problem was found.
   *
   * Deliberately not optional: with a default, sending nothing by mistake
   * would silently become "ok".
   */
  @IsBoolean()
  ok!: boolean;
}

class PublishedDto {
  /**
   * Optional reference for the published result (an order number, a URL, an
   * id in another system), up to 200 characters.
   */
  @IsOptional() @IsString() @MaxLength(REFERENCE_MAX)
  publishedRef?: string;
}

/**
 * "Why are you dropping it": mandatory, one of `DROP_REASONS` (the same
 * list for Skip and Delete).
 */
class DropReasonDto {
  @IsIn([...DROP_REASONS])
  reason!: DropReason;
}

/**
 * Tasks: the whole pool.
 *
 * Careful: most routes have no `@Roles()`: the guard is
 * `TasksService.assertCanUse()` (owner, manager, coordinator), where the
 * reason is written too.
 */
@RequiresFeature('tasks')
@Controller('tasks')
export class TasksController {
  constructor(private readonly tasks: TasksService) {}

  /** Up to 500 lines at once: coordinator, manager, owner */
  @Post('bulk')
  bulk(
    @CurrentUser() actor: SessionUser,
    @Body() dto: BulkDto,
    @Ip() ip: string,
  ): Promise<BulkResult> {
    return this.tasks.bulkAdd(actor, dto.text, ip);
  }

  /** The full list: owner, manager, coordinator */
  @Get()
  async list(
    @CurrentUser() actor: SessionUser,
    @Query() q: ListQueryDto,
  ): Promise<TaskList> {
    this.tasks.assertCanUse(actor);
    return this.tasks.list(q);
  }

  /** How many each user has added: fills the "added by" dropdown, with the count */
  @Get('adders')
  adders(@CurrentUser() actor: SessionUser) {
    this.tasks.assertCanUse(actor);
    return this.tasks.adders();
  }

  /** Everyone who ever held a task, for the filter dropdown */
  @Get('assignees')
  assignees(@CurrentUser() actor: SessionUser) {
    this.tasks.assertCanUse(actor);
    return this.tasks.assignees();
  }

  @Get('stats')
  stats(@CurrentUser() actor: SessionUser): Promise<TaskStats> {
    this.tasks.assertCanUse(actor);
    return this.tasks.stats();
  }

  /** Change the status: return to the pool, mark done, or drop */
  @Patch(':id')
  update(
    @CurrentUser() actor: SessionUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateTaskDto,
  ) {
    this.tasks.assertCanUse(actor);
    return this.tasks.update(id, dto.status, new Date(), actor.userId);
  }

  /**
   * Delete selected rows (soft: the row stays as `deleted`).
   *
   * Careful: `POST`, not `DELETE`. Many proxies and clients silently drop the
   * body of a `DELETE`.
   */
  @Post('delete')
  deleteMany(
    @CurrentUser() actor: SessionUser,
    @Body() dto: DeleteManyDto,
    @Ip() ip: string,
  ): Promise<DeleteResult> {
    this.tasks.assertCanUse(actor);
    return this.tasks.softDelete(dto.ids, actor.userId, ip, dto.reason);
  }

  /**
   * One row: the single-item form of the bulk path above. The reason goes in
   * the query (`?reason=not_needed`), since proxies drop `DELETE` bodies.
   */
  @Delete(':id')
  remove(
    @CurrentUser() actor: SessionUser,
    @Param('id', ParseIntPipe) id: number,
    @Query() query: DropReasonDto,
    @Ip() ip: string,
  ): Promise<DeleteResult> {
    this.tasks.assertCanUse(actor);
    return this.tasks.softDelete([id], actor.userId, ip, query.reason);
  }

  /**
   * "Checked": owner, manager, coordinator. An assignee cannot approve their
   * own work, which is the point. `ok: false` sends the row to "to fix".
   */
  @Post(':id/checked')
  checked(
    @CurrentUser() actor: SessionUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: CheckedDto,
  ) {
    this.tasks.assertCanCheck(actor);
    return this.tasks.markChecked(id, dto.ok, actor.userId, new Date());
  }

  /** "Fixed": who fixed it is stored separately; the task keeps its assignee */
  @Post(':id/fixed')
  fixed(
    @CurrentUser() actor: SessionUser,
    @Param('id', ParseIntPipe) id: number,
  ) {
    this.tasks.assertCanCheck(actor);
    return this.tasks.markFixed(id, actor.userId, new Date());
  }

  /**
   * "Reviewed" for dropped rows: owner and manager only. Why someone dropped a
   * task is a team-management question.
   */
  @Roles(UserRole.owner, UserRole.manager)
  @Post(':id/reviewed')
  reviewed(
    @CurrentUser() actor: SessionUser,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.tasks.markReviewed(id, actor.userId, new Date());
  }

  /** "Delivered": owner, manager, coordinator */
  @Post(':id/delivered')
  delivered(
    @CurrentUser() actor: SessionUser,
    @Param('id', ParseIntPipe) id: number,
  ) {
    this.tasks.assertCanUse(actor);
    return this.tasks.markDelivered(id, new Date());
  }

  /** "Published", with an optional reference for the result */
  @Post(':id/published')
  published(
    @CurrentUser() actor: SessionUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: PublishedDto,
  ) {
    this.tasks.assertCanUse(actor);
    const ref = dto.publishedRef?.trim();
    return this.tasks.markPublished(id, ref ? ref : null, new Date());
  }

  /**
   * Take back a "done", any day.
   *
   * Careful: `PATCH :id { status: 'assigned' }` cannot do this: it does not
   * clear `completedAt`, and the queues run on `completedAt`.
   *
   * The assignee's own Undo is `/me/tasks/:id/undone`, limited to today.
   */
  @Post(':id/undone')
  undone(
    @CurrentUser() actor: SessionUser,
    @Param('id', ParseIntPipe) id: number,
    @Ip() ip: string,
  ) {
    this.tasks.assertCanUse(actor);
    return this.tasks.undoComplete(id, { userId: actor.userId, ip });
  }

  /**
   * Manual hand-out: in addition to the daily morning job. Owner/manager
   * only: once handed out it cannot be undone.
   */
  @Roles(UserRole.owner, UserRole.manager)
  @Post('distribute')
  distribute() {
    return this.tasks.distribute();
  }
}

/**
 * The assignee's own tasks, under `/me/tasks`. No role guard: everyone gets
 * only their own list.
 */
@RequiresFeature('tasks')
@Controller('me/tasks')
export class MyTasksController {
  constructor(private readonly tasks: TasksService) {}

  @Get()
  mine(@CurrentUser() actor: SessionUser): Promise<MyTask[]> {
    return this.tasks.mine(employeeIdOf(actor));
  }

  /**
   * "I am dropping this", with a reason.
   *
   * Careful: a dropped task does not go back to the pool; otherwise it would
   * land in someone's hand the next day. The owner reviews and decides.
   */
  @Post(':id/skip')
  skip(
    @CurrentUser() actor: SessionUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: DropReasonDto,
  ) {
    return this.tasks.skip(employeeIdOf(actor), id, dto.reason);
  }

  /** "I finished": a manual mark, limited to the person's daily target */
  @Post(':id/done')
  done(
    @CurrentUser() actor: SessionUser,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.tasks.markDone(employeeIdOf(actor), id, actor.userId);
  }

  /** "I pressed it by mistake": today's, own row, not yet moved along */
  @Post(':id/undone')
  undone(
    @CurrentUser() actor: SessionUser,
    @Param('id', ParseIntPipe) id: number,
    @Ip() ip: string,
  ) {
    return this.tasks.undoMine(employeeIdOf(actor), id, new Date(), {
      userId: actor.userId,
      ip,
    });
  }
}

/**
 * An owner or manager is usually not tied to a staff row, so they have no
 * "own tasks". Same rule and same message as `me.service.ts`.
 */
function employeeIdOf(actor: SessionUser): number {
  if (actor.employeeId === null) {
    throw new ForbiddenException(
      'This account is not linked to a staff record, so there are no tasks to show.',
    );
  }

  return actor.employeeId;
}
