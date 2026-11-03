import type { MemoryKind } from '@jarvis/contracts';
import type { LucideIcon } from 'lucide-react';
import { FileText, SlidersHorizontal } from 'lucide-react';

export const KIND_ICONS: Record<MemoryKind, LucideIcon> = {
  fact: FileText,
  preference: SlidersHorizontal,
};

/** CreateMemoryRequest / UpdateMemoryRequest allow up to 1000 characters. */
export const MAX_MEMORY_LENGTH = 1000;
