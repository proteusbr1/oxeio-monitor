import { SetMetadata } from '@nestjs/common';

import type { FeatureKey } from './features.rules';

export const REQUIRED_FEATURE = 'oxeio:feature';

/**
 * The endpoint belongs to a module that can be switched off. While it is off
 * the endpoint answers 404, as if it did not exist.
 */
export const RequiresFeature = (
  feature: FeatureKey,
): MethodDecorator & ClassDecorator => SetMetadata(REQUIRED_FEATURE, feature);
