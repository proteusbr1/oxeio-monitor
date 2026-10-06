/**
 * The company using this install: its name (shown on the login page, in the
 * dashboard and in the daily and weekly summaries) and country (work-week
 * defaults, public holidays). Saved by the setup wizard and on Settings →
 * Region; `ORG_NAME` in the .env is the fallback, as before.
 */
export const ORGANIZATION_SETTING_KEY = 'organization';

export const DEFAULT_ORGANIZATION_NAME = 'oXeio Monitoring';

export interface OrganizationSaved {
  name?: string;
  country?: string | null;
}

export interface Organization {
  name: string;
  country: string | null;
}

export function resolveOrganization(
  saved: OrganizationSaved | null,
  env: { ORG_NAME?: string },
): Organization {
  const name = saved?.name?.trim() || env.ORG_NAME?.trim() || DEFAULT_ORGANIZATION_NAME;
  return { name, country: saved?.country ?? null };
}
