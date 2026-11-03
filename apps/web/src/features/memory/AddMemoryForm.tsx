'use client';

import type { Memory, MemoryKind } from '@jarvis/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useId, useRef, useState, type FormEvent } from 'react';
import { ErrorBanner } from '@/components/ui/Banner';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { TextArea } from '@/components/ui/Field';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { useToast } from '@/components/ui/Toast';
import { useI18n } from '@/i18n/I18nProvider';
import { api, type ApiError } from '@/lib/api/client';
import { qk } from '@/lib/api/query-keys';
import { prependCachedMemory } from './api';
import { KIND_ICONS, MAX_MEMORY_LENGTH } from './kinds';
import styles from './memory.module.css';

/** Characters left before the counter appears. */
const COUNTER_FROM = MAX_MEMORY_LENGTH - 200;

export function AddMemoryForm() {
  const { t } = useI18n();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const titleId = useId();
  const field = useRef<HTMLTextAreaElement>(null);
  const [content, setContent] = useState('');
  const [kind, setKind] = useState<MemoryKind>('fact');
  const [touched, setTouched] = useState(false);

  const create = useMutation<Memory, ApiError, { content: string; kind: MemoryKind }>({
    mutationFn: (body) => api.call('createMemory', { body }),
    onSuccess: (memory) => {
      prependCachedMemory(queryClient, memory);
      void queryClient.invalidateQueries({ queryKey: qk.memories.all });
      toast({ message: t('memory.add.saved') });
      setContent('');
      setTouched(false);
      field.current?.focus();
    },
  });

  const trimmed = content.trim();
  const error =
    trimmed.length === 0
      ? t('memory.add.required')
      : trimmed.length > MAX_MEMORY_LENGTH
        ? t('memory.add.tooLong', { max: MAX_MEMORY_LENGTH })
        : null;

  function submit(e: FormEvent) {
    e.preventDefault();
    setTouched(true);
    if (error) {
      field.current?.focus();
      return;
    }
    if (create.isPending) return;
    create.mutate({ content: trimmed, kind });
  }

  return (
    <Card>
      <form className={styles.addForm} onSubmit={submit} aria-labelledby={titleId} noValidate>
        <h2 id={titleId} className={styles.cardTitle}>
          {t('memory.add.title')}
        </h2>
        <TextArea
          ref={field}
          label={t('memory.add.label')}
          hideLabel
          placeholder={t('memory.add.placeholder')}
          value={content}
          rows={2}
          maxRows={8}
          maxLength={MAX_MEMORY_LENGTH}
          // Empty (placeholder) follows the interface; typed text takes its own direction.
          dir={content ? 'auto' : undefined}
          error={touched && error ? error : undefined}
          onChange={(e) => setContent(e.target.value)}
          onKeyDown={(e) => {
            // ⌘/Ctrl+Enter saves, like other multi-line inputs.
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit(e);
          }}
        />
        {create.isError && <ErrorBanner error={create.error} />}
        <div className={styles.addBar}>
          <div className={styles.kindGroup}>
            <SegmentedControl
              legend={t('memory.add.kindLegend')}
              size="sm"
              value={kind}
              onChange={setKind}
              options={(['fact', 'preference'] as const).map((k) => ({
                value: k,
                label: t(`memory.kinds.${k}`),
                icon: KIND_ICONS[k],
              }))}
            />
            <p className={styles.hint}>{t(`memory.add.kindHint.${kind}`)}</p>
          </div>
          <div className={styles.addActions}>
            {content.length >= COUNTER_FROM && (
              <span className={styles.counter} aria-live="polite">
                {t('memory.add.count', { count: content.length, max: MAX_MEMORY_LENGTH })}
              </span>
            )}
            <Button type="submit" variant="primary" icon={Plus} loading={create.isPending}>
              {t('memory.add.save')}
            </Button>
          </div>
        </div>
      </form>
    </Card>
  );
}
