import type { ReactNode } from 'react';

import type { ApiResult } from '../../api/useApi';
import { ErrorBox, Loading } from '../../components/States';
import { useT } from '../../i18n';

// Shows the failure of each independent data source; does not erase an older
// successful answer.
export function DataPanel({
  result,
  children,
}: {
  result: Pick<ApiResult<unknown>, 'data' | 'error' | 'reload'>;
  children: ReactNode;
}) {
  const t = useT();
  if (!result.data)
    return (
      <div className="p-5">
        {result.error ? (
          <ErrorBox error={result.error} retry={result.reload} />
        ) : (
          <Loading label={t('Loading summary…')} />
        )}
      </div>
    );
  return (
    <>
      {result.error && (
        <p role="status" className="px-5 pb-3 text-xs text-idle-ink">
          {t(
            'Couldn’t refresh this summary. Showing its last successful update.',
          )}{' '}
          <button
            type="button"
            onClick={result.reload}
            className="tap underline"
          >
            {t('Retry')}
          </button>
        </p>
      )}
      {children}
    </>
  );
}
