import { useState } from 'react';

import { markPosted, type StatementLine } from '../../api/hoursStatement';
import { Button } from '../../components/Page';
import {
  FormGrid,
  FullWidth,
  Modal,
  Notice,
  ServerError,
  TextAreaField,
  TextField,
  useMutation,
} from '../../components/ui';
import { useT } from '../../i18n';
import { hm, joinHm, splitHm } from './hours.format';

/**
 * "Mark as posted": the hours finance actually entered in the payroll
 * system, prefilled with the proposal. Only a different value is sent — a
 * mark without `postedMin` means "posted as proposed", which is what the
 * next period's carry-over reads.
 */
export function PostedDialog({
  line,
  onClose,
  onDone,
}: {
  line: StatementLine & { id: number };
  onClose: () => void;
  onDone: () => void;
}) {
  const t = useT();
  const start = splitHm(line.toPostMin);
  const [hours, setHours] = useState(start.hours);
  const [minutes, setMinutes] = useState(start.minutes);
  const [note, setNote] = useState('');
  const save = useMutation();

  const total = joinHm(hours, minutes);
  const different = total !== null && total !== line.toPostMin;

  const submit = () => {
    if (total === null) return;
    save.run(async () => {
      await markPosted(line.id, {
        postedMin: different ? total : undefined,
        note: note.trim() || undefined,
      });
      onDone();
    });
  };

  return (
    <Modal
      title={t('Mark as posted — {{name}}', { name: line.fullName })}
      hint={t('Proposed: {{hours}}', { hours: hm(line.toPostMin) })}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>{t('Cancel')}</Button>
          <Button
            tone="primary"
            onClick={submit}
            disabled={total === null || save.busy}
          >
            {save.busy ? t('Saving…') : t('Mark as posted')}
          </Button>
        </>
      }
    >
      <div className="space-y-3.5">
        <FormGrid>
          <TextField
            label={t('Hours')}
            value={hours}
            onChange={setHours}
            mono
            autoFocus
            hint={t('A minus sign makes the value negative')}
          />
          <TextField
            label={t('Minutes')}
            value={minutes}
            onChange={setMinutes}
            type="number"
            min={0}
            max={59}
            mono
          />
          <FullWidth>
            <TextAreaField
              label={t('Note (optional)')}
              value={note}
              onChange={setNote}
              rows={2}
              maxLength={500}
            />
          </FullWidth>
        </FormGrid>
        {total === null ? (
          <Notice tone="attention">
            {t('Whole hours, and minutes from 0 to 59')}
          </Notice>
        ) : (
          different && (
            <Notice>
              {t(
                'Different from the proposal: {{value}} is kept with the mark, and the next period’s carry-over follows it.',
                { value: hm(total) },
              )}
            </Notice>
          )
        )}
        <ServerError error={save.error} />
      </div>
    </Modal>
  );
}
