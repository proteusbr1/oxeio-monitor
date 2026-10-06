import { AlertSeverity } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsEnum, IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';

import { ALERT_TYPE_VALUES, type AlertType } from './alerts.constants';

/**
 * Query for `GET /api/v1/alerts`.
 *
 * Careful: the global ValidationPipe has `forbidNonWhitelisted` on, so sending
 * a parameter not declared here returns 400. Before adding a new filter in the
 * dashboard, add it to this class too.
 */
export class ListAlertsDto {
  /**
   * Defaults to `open`, because the list exists to show "what is still to be
   * reviewed". To see all older ones, ask for `all` explicitly.
   */
  @IsOptional()
  @IsIn(['open', 'all'])
  status?: 'open' | 'all';

  @IsOptional()
  @IsIn(ALERT_TYPE_VALUES as readonly string[])
  type?: AlertType;

  @IsOptional()
  @IsEnum(AlertSeverity)
  severity?: AlertSeverity;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  /** Maximum 200, otherwise one request could pull thousands of rows */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}
