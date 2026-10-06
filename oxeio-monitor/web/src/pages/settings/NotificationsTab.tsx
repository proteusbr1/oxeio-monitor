import { useState } from 'react';
import { Trans } from 'react-i18next';

import { getTelegramSettings, saveTelegramSettings, testTelegram } from '../../api/settings';
import { useApi } from '../../api/useApi';
import { Card } from '../../components/Card';
import { Caveat, ErrorBox, Loading } from '../../components/States';
import {
  MiniButton,
  Notice,
  ServerError,
  TextField,
  useMutation,
} from '../../components/ui';
import { BackToEnv } from './BackToEnv';
import { useT } from '../../i18n';

/**
 * Telegram settings, editable from the screen.
 *
 * Careful — why this exists: the token and chat ID used to live only in `.env`, so
 * changing them meant SSH into the VPS, editing the file and restarting the
 * container. That is practically impossible for the owner, so a mistake would stay
 * for months and the weekly summary would silently stop arriving.
 *
 * Careful: the full token never reaches this screen. The server sends only the last
 * four characters, so the field always looks empty. Typing sets a new value; saving
 * with the field empty keeps the existing one.
 */
export function NotificationsTab() {
  const t = useT();
  const telegram = useApi(getTelegramSettings, []);
  const save = useMutation();
  const probe = useMutation();

  const [token, setToken] = useState('');
  const [chatId, setChatId] = useState('');
  const [result, setResult] = useState<string | null>(null);

  const current = telegram.data;

  if (telegram.loading && !current) return <Loading />;
  if (telegram.error && !current) {
    return <ErrorBox error={telegram.error} retry={telegram.reload} />;
  }

  return (
    <div className="space-y-3">
      <Card
        title="Telegram"
        hint={t('Where the weekly summary and alerts are sent')}
      >
        <div className="space-y-3.5 p-4">
          <Notice>
            <Trans
              i18nKey="Create a bot with <b>@BotFather</b> on Telegram, then send it a message so it can reply. The chat id is the conversation it should post into."
              components={{ b: <b /> }}
            />
          </Notice>

          {/*
            Careful: this says which value is **actually** in effect. Without it the owner
               would enter a new value, think it was not saved (though it was), because
               the `.env` one was still winning (it wins when one of the two fields
               is left empty).
          */}
          {current && (
            <div className="text-[13px]">
              {current.source === 'database' && (
                <span className="flex flex-wrap items-center gap-2">
                  <span className="text-ok">
                    <Trans
                      i18nKey="Set here · token {{token}} · chat <num>{{chat}}</num>"
                      values={{ token: current.tokenHint, chat: current.chatId }}
                      components={{ num: <span className="num" /> }}
                    />
                  </span>
                  <BackToEnv subject="notifications" onDone={() => telegram.reload()} />
                </span>
              )}
              {current.source === 'env' && (
                <span className="text-idle">
                  <Trans
                    i18nKey="Currently using the server’s <num>.env</num> · token {{token}} · chat <num>{{chat}}</num>"
                    values={{ token: current.tokenHint, chat: current.chatId }}
                    components={{ num: <span className="num" /> }}
                  />
                </span>
              )}
              {current.source === 'none' && (
                <span className="text-ink-3">
                  {t('Not set — nothing is being sent to Telegram')}
                </span>
              )}
            </div>
          )}

          <TextField
            label={t('Bot token')}
            value={token}
            onChange={setToken}
            mono
            placeholder={current?.configured ? t('leave empty to keep the current one') : ''}
            hint={t('From @BotFather. It is never shown again after saving.')}
          />

          <TextField
            label={t('Chat id')}
            value={chatId}
            onChange={setChatId}
            mono
            placeholder={current?.chatId || ''}
            hint={t('A number. Negative numbers are groups.')}
          />

          <ServerError error={save.error ?? probe.error} />

          {result && (
            // `result` holds the English text (the key), so the ✓ check does not
            // depend on the language on screen
            <Notice tone={result.startsWith('✓') ? 'info' : 'attention'}>
              {t(result)}
            </Notice>
          )}

          <div className="flex gap-2">
            <MiniButton
              disabled={save.busy}
              onClick={() =>
                save.run(async () => {
                  /**
                   * Careful: an empty field sends the **existing** value. Otherwise fixing
                   * only the chat ID would wipe the token, and Telegram would be
                   * silently off.
                   */
                  await saveTelegramSettings(
                    token.trim(),
                    chatId.trim() || (current?.chatId ?? ''),
                  );
                  setToken('');
                  setChatId('');
                  setResult(null);
                  telegram.reload();
                })
              }
            >
              {save.busy ? t('Saving…') : t('Save')}
            </MiniButton>

            {/*
              Important: the test button is the **most useful part**. Without it the
                 owner would save, wait for the next scheduled message, and only realise something was
                 wrong if nothing arrived, with no way to tell what was wrong.
            */}
            <MiniButton
              disabled={probe.busy || !current?.configured}
              onClick={() =>
                probe.run(async () => {
                  const { outcome } = await testTelegram();
                  setResult(
                    outcome === 'sent'
                      ? '✓ Sent — check Telegram now.'
                      : outcome === 'not_configured'
                        ? 'Nothing is configured yet.'
                        : 'Telegram refused it — check the token and chat id.',
                  );
                })
              }
            >
              {probe.busy ? t('Sending…') : t('Send a test message')}
            </MiniButton>
          </div>
        </div>

        <Caveat>
          {t('The weekly summary contains staff names and hours, so it only goes to the chat set here. Changing it takes effect immediately — no restart.')}
        </Caveat>
      </Card>
    </div>
  );
}
