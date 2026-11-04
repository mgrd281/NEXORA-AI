'use client';

import type { Attachment } from '@jarvis/contracts';
import { ATTACHMENT_LIMITS } from '@jarvis/contracts';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, isApiError } from '@/lib/api/client';
import { checkFile, localRefusal, mediaTypeFor, uploadAttachment } from './files';

export type DraftStatus = 'uploading' | 'ready' | 'error';

export interface DraftItem {
  key: string;
  name: string;
  size: number;
  status: DraftStatus;
  /** 0…1 while uploading. */
  progress: number;
  attachment: Attachment | null;
  error: unknown;
  /** Kept so a failed upload (network, storage) can be tried again. */
  file: File | null;
  /** The refusal is about the file itself (type, size, empty): trying again won't help. */
  final: boolean;
}

export interface AttachmentDraft {
  items: DraftItem[];
  /** Ids of the uploaded files, in the order they were added. */
  ids: string[];
  uploading: boolean;
  hasErrors: boolean;
  /** Set when more files were offered than one request can carry. */
  overflow: boolean;
  add: (files: Iterable<File>) => void;
  remove: (key: string) => void;
  retry: (key: string) => void;
  /** After a successful send: the files now belong to the task (never delete them here). */
  clear: () => void;
  /** Screen-reader announcement of the last change ("report.pdf attached"). */
  announcement: { kind: 'added' | 'removed' | 'failed'; name: string } | null;
}

let seq = 0;

/** Errors that a second try might get past (network, storage briefly down, rate limit). */
function retryable(error: unknown): boolean {
  if (!isApiError(error)) return false;
  return (
    error.code === 'NETWORK' ||
    error.code === 'RATE_LIMITED' ||
    error.code === 'INTERNAL' ||
    (error.code === 'SERVICE_UNAVAILABLE' && error.details?.reason === 'STORAGE_UNAVAILABLE')
  );
}

/**
 * The files staged in a composer: each is checked on this device first (type by extension,
 * size, count), then uploaded with progress. Removing a file stops its upload, or deletes the
 * uploaded copy (it was never attached to anything). Unmounting aborts uploads in flight.
 */
export function useAttachmentDraft(): AttachmentDraft {
  const [items, setItems] = useState<DraftItem[]>([]);
  const [overflow, setOverflow] = useState(false);
  const [announcement, setAnnouncement] = useState<AttachmentDraft['announcement']>(null);
  const controllers = useRef(new Map<string, AbortController>());
  const itemsRef = useRef(items);
  useEffect(() => {
    itemsRef.current = items;
  });

  useEffect(() => {
    const all = controllers.current;
    return () => {
      for (const c of all.values()) c.abort();
      all.clear();
    };
  }, []);

  const patch = useCallback((key: string, next: Partial<DraftItem>) => {
    setItems((list) => list.map((item) => (item.key === key ? { ...item, ...next } : item)));
  }, []);

  const start = useCallback(
    (key: string, file: File) => {
      const controller = new AbortController();
      controllers.current.set(key, controller);
      uploadAttachment(file, {
        signal: controller.signal,
        onProgress: (progress) => patch(key, { progress }),
      }).then(
        (attachment) => {
          controllers.current.delete(key);
          patch(key, { status: 'ready', progress: 1, attachment, file: null });
          setAnnouncement({ kind: 'added', name: file.name });
        },
        (error: unknown) => {
          controllers.current.delete(key);
          if (error instanceof DOMException && error.name === 'AbortError') return;
          patch(key, { status: 'error', error, final: !retryable(error) });
          setAnnouncement({ kind: 'failed', name: file.name });
        },
      );
    },
    [patch],
  );

  const add = useCallback(
    (files: Iterable<File>) => {
      const incoming = [...files];
      if (incoming.length === 0) return;
      const room = ATTACHMENT_LIMITS.maxPerRequest - itemsRef.current.length;
      setOverflow(incoming.length > room);
      const accepted = incoming.slice(0, Math.max(0, room));
      const next: DraftItem[] = accepted.map((file) => {
        const reason = checkFile(file);
        return {
          key: `f${++seq}`,
          name: file.name,
          size: file.size,
          status: reason ? 'error' : 'uploading',
          progress: 0,
          attachment: null,
          error: reason ? localRefusal(reason) : null,
          file: reason ? null : file,
          final: reason !== null,
        };
      });
      setItems((list) => [...list, ...next]);
      for (const item of next) {
        if (item.status === 'uploading' && item.file) start(item.key, item.file);
        else setAnnouncement({ kind: 'failed', name: item.name });
      }
    },
    [start],
  );

  const remove = useCallback((key: string) => {
    const item = itemsRef.current.find((i) => i.key === key);
    if (!item) return;
    controllers.current.get(key)?.abort();
    controllers.current.delete(key);
    // The upload was never attached to a request: delete the stored copy now rather than
    // leaving it for the 24-hour cleanup. Best effort — the cleanup still covers a failure.
    if (item.attachment) {
      void api.call('deleteAttachment', { params: { id: item.attachment.id } }).catch(() => {});
    }
    setItems((list) => list.filter((i) => i.key !== key));
    setOverflow(false);
    setAnnouncement({ kind: 'removed', name: item.name });
  }, []);

  const retry = useCallback(
    (key: string) => {
      const item = itemsRef.current.find((i) => i.key === key);
      if (!item?.file || item.final) return;
      patch(key, { status: 'uploading', progress: 0, error: null });
      start(key, item.file);
    },
    [patch, start],
  );

  const clear = useCallback(() => {
    for (const c of controllers.current.values()) c.abort();
    controllers.current.clear();
    setItems([]);
    setOverflow(false);
    setAnnouncement(null);
  }, []);

  return useMemo(
    () => ({
      items,
      ids: items.flatMap((i) => (i.status === 'ready' && i.attachment ? [i.attachment.id] : [])),
      uploading: items.some((i) => i.status === 'uploading'),
      hasErrors: items.some((i) => i.status === 'error'),
      overflow,
      add,
      remove,
      retry,
      clear,
      announcement,
    }),
    [items, overflow, add, remove, retry, clear, announcement],
  );
}

/** Files from a paste: the supported ones, and whether the paste should still insert text. */
export function filesFromPaste(data: Pick<DataTransfer, 'files' | 'getData'>): {
  files: File[];
  keepText: boolean;
} {
  const files = [...data.files];
  if (files.length === 0) return { files: [], keepText: true };
  const text = data.getData('text/plain').trim();
  const supported = files.filter((f) => mediaTypeFor(f.name) !== null);
  if (!text) return { files, keepText: false };
  // Text and files together (e.g. a file copied in the file manager also carries its name):
  // attach the documents JARVIS can read; the text pastes only when it is more than the names.
  const onlyNames = files.every((f) => text.includes(f.name));
  return { files: supported, keepText: !onlyNames || supported.length === 0 };
}
