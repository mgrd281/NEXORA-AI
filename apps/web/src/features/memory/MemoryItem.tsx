'use client';

import type { Memory, MemoryKind } from '@jarvis/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Pencil, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Badge } from '@/components/ui/Badge';
import { ErrorBanner } from '@/components/ui/Banner';
import { Button, IconButton } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { TextArea } from '@/components/ui/Field';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { useToast } from '@/components/ui/Toast';
import { UserText } from '@/components/ui/UserText';
import { useI18n } from '@/i18n/I18nProvider';
import { api, type ApiError } from '@/lib/api/client';
import { qk } from '@/lib/api/query-keys';
import { removeCachedMemory, replaceCachedMemory } from './api';
import { KIND_ICONS, MAX_MEMORY_LENGTH } from './kinds';
import { memoryPreview, wasEdited } from './preview';
import styles from './memory.module.css';

export function MemoryItem({ memory, onDeleted }: { memory: Memory; onDeleted: () => void }) {
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const editButton = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);

  useEffect(() => {
    if (!editing && restoreFocus.current) {
      restoreFocus.current = false;
      editButton.current?.focus();
    }
  }, [editing]);

  const stopEditing = () => {
    restoreFocus.current = true;
    setEditing(false);
  };

  return (
    <li className={styles.item} data-editing={editing || undefined}>
      {editing ? (
        <EditMemory memory={memory} onDone={stopEditing} />
      ) : (
        <ViewMemory
          memory={memory}
          editRef={editButton}
          onEdit={() => setEditing(true)}
          onDelete={() => setConfirming(true)}
        />
      )}
      {confirming && (
        <DeleteMemoryDialog
          memory={memory}
          onClose={() => setConfirming(false)}
          onDeleted={onDeleted}
        />
      )}
    </li>
  );
}

function ViewMemory({
  memory,
  editRef,
  onEdit,
  onDelete,
}: {
  memory: Memory;
  editRef: React.RefObject<HTMLButtonElement | null>;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { t } = useI18n();
  const preview = memoryPreview(memory.content);
  const edited = wasEdited(memory.createdAt, memory.updatedAt);
  return (
    <div className={styles.view}>
      <div className={styles.main}>
        {/* The row keeps the interface's alignment (next to its kind and date); only the
            content's own direction is isolated. */}
        <UserText as="p" className={styles.content}>
          {memory.content}
        </UserText>
        <div className={styles.meta}>
          <Badge icon={KIND_ICONS[memory.kind]}>{t(`memory.kinds.${memory.kind}`)}</Badge>
          <span>
            {memory.source === 'user'
              ? t('memory.list.addedByYou')
              : t('memory.list.savedByJarvis')}
          </span>
          {/* Date and task link stay together; on phones they move to their own line. */}
          <span className={styles.when}>
            <span className={styles.sep} aria-hidden="true">
              ·
            </span>
            <RelativeTime
              value={edited ? memory.updatedAt : memory.createdAt}
              format={(time) =>
                edited ? t('memory.list.edited', { time }) : t('memory.list.added', { time })
              }
            />
            {memory.sourceTaskId && (
              <>
                <span aria-hidden="true">·</span>
                <Link href={`/tasks/${memory.sourceTaskId}`} className={styles.taskLink}>
                  {t('memory.list.viewTask')}
                </Link>
              </>
            )}
          </span>
        </div>
      </div>
      <div className={styles.actions}>
        <IconButton
          ref={editRef}
          size="sm"
          icon={Pencil}
          label={t('memory.item.editLabel', { preview })}
          tooltip="none"
          onClick={onEdit}
        />
        <IconButton
          size="sm"
          icon={Trash2}
          label={t('memory.item.deleteLabel', { preview })}
          tooltip="none"
          onClick={onDelete}
        />
      </div>
    </div>
  );
}

function EditMemory({ memory, onDone }: { memory: Memory; onDone: () => void }) {
  const { t } = useI18n();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [content, setContent] = useState(memory.content);
  const [kind, setKind] = useState<MemoryKind>(memory.kind);
  const [touched, setTouched] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = field.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);

  const update = useMutation<Memory, ApiError, { content?: string; kind?: MemoryKind }>({
    mutationFn: (body) => api.call('updateMemory', { params: { id: memory.id }, body }),
    onSuccess: (saved) => {
      replaceCachedMemory(queryClient, saved);
      void queryClient.invalidateQueries({ queryKey: qk.memories.all });
      toast({ message: t('memory.item.updated') });
      onDone();
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
    if (error || update.isPending) return;
    const body = {
      ...(trimmed !== memory.content ? { content: trimmed } : {}),
      ...(kind !== memory.kind ? { kind } : {}),
    };
    if (Object.keys(body).length === 0) {
      onDone();
      return;
    }
    update.mutate(body);
  }

  return (
    <form className={styles.edit} onSubmit={submit} noValidate>
      <TextArea
        ref={field}
        label={t('memory.item.editField')}
        hideLabel
        value={content}
        maxLength={MAX_MEMORY_LENGTH}
        maxRows={8}
        rows={2}
        // An empty field follows the interface; typed text takes its own direction.
        dir={content ? 'auto' : undefined}
        error={touched ? error : undefined}
        onChange={(e) => setContent(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            if (!update.isPending) onDone();
          }
        }}
      />
      {update.isError && <ErrorBanner error={update.error} />}
      <div className={styles.editBar}>
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
        <div className={styles.editButtons}>
          <Button size="sm" variant="ghost" onClick={onDone} disabled={update.isPending}>
            {t('common.actions.cancel')}
          </Button>
          <Button size="sm" variant="primary" type="submit" loading={update.isPending}>
            {t('memory.item.save')}
          </Button>
        </div>
      </div>
    </form>
  );
}

function DeleteMemoryDialog({
  memory,
  onClose,
  onDeleted,
}: {
  memory: Memory;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const { t } = useI18n();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const remove = useMutation<void, ApiError>({
    mutationFn: () => api.call('deleteMemory', { params: { id: memory.id } }),
    onSuccess: () => {
      toast({ message: t('memory.item.deleted') });
      // The row (and this dialog) are gone after the next render; continue from the list.
      onDeleted();
      removeCachedMemory(queryClient, memory.id);
      void queryClient.invalidateQueries({ queryKey: qk.memories.all });
    },
  });
  return (
    <Dialog
      open
      size="sm"
      onClose={() => {
        if (!remove.isPending) onClose();
      }}
      title={t('memory.deleteDialog.title')}
      description={t('memory.deleteDialog.body')}
      busy={remove.isPending}
      footer={
        <>
          <Button onClick={onClose} disabled={remove.isPending}>
            {t('common.actions.cancel')}
          </Button>
          <Button variant="destructive" loading={remove.isPending} onClick={() => remove.mutate()}>
            {t('memory.deleteDialog.confirm')}
          </Button>
        </>
      }
    >
      <div className={styles.dialogBody}>
        <blockquote className={styles.quote}>
          <UserText as="p">{memory.content}</UserText>
        </blockquote>
        {remove.isError && <ErrorBanner error={remove.error} />}
      </div>
    </Dialog>
  );
}
