import { api } from './client';

/** First-run setup: an install without an owner shows the wizard instead of the login */
export interface SetupStatus {
  needed: boolean;
  organizationName: string;
}

export interface SetupBody {
  token: string;
  organizationName: string;
  country: string;
  timeZone: string;
  currency: string;
  displayLocale: string;
  ownerName: string;
  ownerEmail: string;
  ownerPassword: string;
  monthlyTargetHours: number;
  expectedWorkdays: number;
  weeklyOffDays: number[];
  importHolidays: boolean;
}

export interface SetupResult {
  restartNeeded: boolean;
  holidaysAdded: number;
  holidayNotes: string[];
}

export function getSetupStatus(signal?: AbortSignal): Promise<SetupStatus> {
  return api('/setup/status', { signal, silent401: true });
}

export function runSetup(body: SetupBody): Promise<SetupResult> {
  return api('/setup', { method: 'POST', body, silent401: true });
}
