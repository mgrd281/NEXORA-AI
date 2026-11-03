'use client';

import { ChevronDown } from 'lucide-react';
import {
  forwardRef,
  useCallback,
  useId,
  useLayoutEffect,
  useRef,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { cx } from '@/lib/cx';
import styles from './Field.module.css';
import { Icon } from './Icon';

export interface FieldControlProps {
  id: string;
  'aria-describedby'?: string;
  'aria-invalid'?: true;
  'aria-required'?: true;
}

export interface FieldProps {
  label: ReactNode;
  /** Visually hide the label (it stays the accessible name). */
  hideLabel?: boolean;
  hint?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  /** Extra content on the label row's end side (e.g. a character count). */
  labelAside?: ReactNode;
  className?: string;
  id?: string;
  children: (control: FieldControlProps) => ReactNode;
}

/**
 * Label, control, hint and error with the right associations: the label is bound via htmlFor,
 * hint and error are referenced by aria-describedby, and an error sets aria-invalid.
 */
export function Field({
  label,
  hideLabel,
  hint,
  error,
  required,
  labelAside,
  className,
  id: idProp,
  children,
}: FieldProps) {
  const autoId = useId();
  const id = idProp ?? `f${autoId}`;
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [errorId, hintId].filter(Boolean).join(' ') || undefined;
  return (
    <div className={cx(styles.field, className)}>
      <div className={cx(styles.labelRow, hideLabel && 'visually-hidden')}>
        <label htmlFor={id} className={styles.label}>
          {label}
        </label>
        {labelAside && <span className={styles.labelAside}>{labelAside}</span>}
      </div>
      {children({
        id,
        'aria-describedby': describedBy,
        'aria-invalid': error ? true : undefined,
        'aria-required': required ? true : undefined,
      })}
      {error && (
        <p id={errorId} className={styles.error}>
          {error}
        </p>
      )}
      {hint && (
        <p id={hintId} className={styles.hint}>
          {hint}
        </p>
      )}
    </div>
  );
}

type FieldChrome = Pick<FieldProps, 'label' | 'hideLabel' | 'hint' | 'error' | 'labelAside'>;

export interface TextFieldProps
  extends FieldChrome, Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  /** Content inside the field at the end side, e.g. a show-password toggle. */
  trailing?: ReactNode;
  fieldClassName?: string;
}

export const TextField = forwardRef<HTMLInputElement, TextFieldProps>(function TextField(
  {
    label,
    hideLabel,
    hint,
    error,
    labelAside,
    trailing,
    required,
    className,
    fieldClassName,
    id,
    'aria-describedby': extraDescribedBy,
    'aria-invalid': ariaInvalid,
    ...rest
  },
  ref,
) {
  return (
    <Field
      label={label}
      hideLabel={hideLabel}
      hint={hint}
      error={error}
      labelAside={labelAside}
      required={required}
      className={fieldClassName}
      id={id}
    >
      {(control) => (
        // The wrapper takes the input's direction so a trailing control (e.g. show password)
        // sits at the input's end even for LTR fields inside RTL pages.
        <div
          className={cx(styles.control, trailing ? styles.hasTrailing : undefined)}
          dir={rest.dir}
        >
          <input
            ref={ref}
            {...rest}
            {...control}
            aria-describedby={
              [control['aria-describedby'], extraDescribedBy].filter(Boolean).join(' ') || undefined
            }
            aria-invalid={control['aria-invalid'] ?? ariaInvalid}
            required={required}
            className={cx(styles.input, className)}
          />
          {trailing && <div className={styles.trailing}>{trailing}</div>}
        </div>
      )}
    </Field>
  );
});

export interface TextAreaProps extends FieldChrome, TextareaHTMLAttributes<HTMLTextAreaElement> {
  /** Grow with the content up to this many rows, then scroll. */
  maxRows?: number;
  fieldClassName?: string;
}

/** Multi-line input that grows with its content (up to maxRows). */
export const TextArea = forwardRef<HTMLTextAreaElement, TextAreaProps>(function TextArea(
  {
    label,
    hideLabel,
    hint,
    error,
    labelAside,
    required,
    className,
    fieldClassName,
    id,
    maxRows = 10,
    rows = 3,
    onInput,
    ...rest
  },
  ref,
) {
  const inner = useRef<HTMLTextAreaElement | null>(null);
  const setRefs = useCallback(
    (node: HTMLTextAreaElement | null) => {
      inner.current = node;
      if (typeof ref === 'function') ref(node);
      else if (ref) ref.current = node;
    },
    [ref],
  );
  useAutoGrow(inner, maxRows, rest.value);
  return (
    <Field
      label={label}
      hideLabel={hideLabel}
      hint={hint}
      error={error}
      labelAside={labelAside}
      required={required}
      className={fieldClassName}
      id={id}
    >
      {(control) => (
        <textarea
          ref={setRefs}
          {...control}
          rows={rows}
          required={required}
          className={cx(styles.input, styles.textarea, className)}
          {...rest}
          onInput={(e) => {
            autoGrow(e.currentTarget, maxRows);
            onInput?.(e);
          }}
        />
      )}
    </Field>
  );
});

/** Resizes a textarea to fit its content, capped at maxRows. */
export function autoGrow(el: HTMLTextAreaElement, maxRows: number): void {
  const style = window.getComputedStyle(el);
  const line = parseFloat(style.lineHeight) || 24;
  const padding = parseFloat(style.paddingBlockStart) + parseFloat(style.paddingBlockEnd);
  const border = parseFloat(style.borderBlockStartWidth) + parseFloat(style.borderBlockEndWidth);
  el.style.height = 'auto';
  // scrollHeight covers content + padding; box-sizing is border-box, so add the borders.
  const max = line * maxRows + padding + border;
  const needed = el.scrollHeight + border;
  el.style.height = `${Math.min(needed, max)}px`;
  el.style.overflowY = needed > max ? 'auto' : 'hidden';
}

/** Keeps a textarea sized to its (controlled) value. */
export function useAutoGrow(
  ref: { current: HTMLTextAreaElement | null },
  maxRows: number,
  value: unknown,
): void {
  useLayoutEffect(() => {
    if (ref.current) autoGrow(ref.current, maxRows);
  }, [ref, maxRows, value]);
}

export interface SelectProps
  extends FieldChrome, Omit<SelectHTMLAttributes<HTMLSelectElement>, 'size'> {
  fieldClassName?: string;
  size?: 'sm' | 'md';
}

/** Native select with Meridian styling (keeps platform pickers on mobile). */
export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  {
    label,
    hideLabel,
    hint,
    error,
    labelAside,
    required,
    className,
    fieldClassName,
    id,
    children,
    size = 'md',
    ...rest
  },
  ref,
) {
  return (
    <Field
      label={label}
      hideLabel={hideLabel}
      hint={hint}
      error={error}
      labelAside={labelAside}
      required={required}
      className={fieldClassName}
      id={id}
    >
      {(control) => (
        <div className={cx(styles.control, styles.selectControl)}>
          <select
            ref={ref}
            {...control}
            required={required}
            className={cx(styles.input, styles.select, size === 'sm' && styles.selectSm, className)}
            {...rest}
          >
            {children}
          </select>
          <span className={styles.selectChevron} aria-hidden="true">
            <Icon icon={ChevronDown} size={16} />
          </span>
        </div>
      )}
    </Field>
  );
});
