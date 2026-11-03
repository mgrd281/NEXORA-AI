import type { ReactNode } from 'react';

/**
 * Text someone wrote (a task title, a subject, a name, a memory) shown inside the interface.
 *
 * The element keeps the interface's direction and alignment, so a list or a two-column field
 * list lines up on one edge in every locale. Only the content is isolated (`<bdi>`), so an
 * Arabic title in an English screen, or an English one in Arabic, keeps its own word order and
 * punctuation without moving the layout around it.
 *
 * Use `dir="auto"` directly only where the text is the whole surface (an email body, a field
 * the user is typing in).
 */
export function UserText({
  as: Tag = 'span',
  children,
  className,
  id,
  title,
}: {
  as?: 'span' | 'p' | 'dd' | 'div' | 'strong';
  children: ReactNode;
  className?: string;
  id?: string;
  title?: string;
}) {
  return (
    <Tag className={className} id={id} title={title}>
      <bdi>{children}</bdi>
    </Tag>
  );
}
