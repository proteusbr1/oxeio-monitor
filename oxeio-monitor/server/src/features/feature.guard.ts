import {
  CanActivate,
  ExecutionContext,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import type { FeatureKey } from './features.rules';
import { FeaturesService } from './features.service';
import { REQUIRED_FEATURE } from './requires-feature';

/**
 * Blocks the endpoints of a switched-off module. 404, not 403: nobody lacks
 * permission, the module simply is not there — and the dashboard already
 * shows "not found" for a 404.
 */
@Injectable()
export class FeatureGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly features: FeaturesService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const feature = this.reflector.getAllAndOverride<FeatureKey | undefined>(
      REQUIRED_FEATURE,
      [ctx.getHandler(), ctx.getClass()],
    );
    if (!feature) return true;

    if (!(await this.features.isOn(feature))) {
      throw new NotFoundException(
        'This module is turned off — the owner can turn it on in Settings → Modules',
      );
    }
    return true;
  }
}
