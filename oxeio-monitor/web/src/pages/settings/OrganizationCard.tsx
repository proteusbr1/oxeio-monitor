import { useMemo, useState } from 'react';

import { getOrganization, saveOrganization } from '../../api/settings';
import { useApi } from '../../api/useApi';
import { Card } from '../../components/Card';
import { ErrorBox, Loading } from '../../components/States';
import { MiniButton, SelectField, ServerError, TextField, useMutation } from '../../components/ui';
import { currentLanguage, useT } from '../../i18n';
import { countryOptions } from './region.math';

/**
 * The company's name — on the login page, in the daily and weekly summaries
 * and the monthly report — and its country (used for public holidays).
 * Set by the setup wizard; ORG_NAME in the .env is the fallback.
 */
export function OrganizationCard() {
  const t = useT();
  const org = useApi(getOrganization, []);
  // named in the dashboard's language, and renamed when it changes
  const language = currentLanguage();
  const countries = useMemo(() => countryOptions(language), [language]);
  const save = useMutation();
  const [name, setName] = useState<string | null>(null);
  const [country, setCountry] = useState<string | null>(null);

  if (org.loading && !org.data) return <Loading />;
  if (!org.data) return <ErrorBox error={org.error} retry={org.reload} />;

  const shownName = name ?? org.data.name;
  const shownCountry = country ?? org.data.country ?? '';
  const changed = shownName.trim() !== org.data.name || shownCountry !== (org.data.country ?? '');

  return (
    <Card title={t('Company')} hint={t('Shown on the login page and in summaries and reports')}>
      <div className="grid gap-3.5 p-4 sm:grid-cols-2">
        <TextField label={t('Name')} value={shownName} onChange={setName} maxLength={80} />
        <SelectField
          label={t('Country')}
          value={shownCountry}
          onChange={setCountry}
          options={[{ value: '', label: '—' }, ...countries]}
        />
        <div className="sm:col-span-2">
          <ServerError error={save.error} />
          <MiniButton
            disabled={!changed || save.busy || shownName.trim().length < 2}
            onClick={() =>
              save.run(async () => {
                await saveOrganization({ name: shownName.trim(), country: shownCountry });
                setName(null);
                setCountry(null);
                org.reload();
              })
            }
          >
            {save.busy ? t('Saving…') : t('Save')}
          </MiniButton>
        </div>
      </div>
    </Card>
  );
}
