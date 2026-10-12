import { useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent } from 'react';
import './table-columns.css';

export interface SortColumn<K extends string> {
  key: K;
  label: string;
}
interface HeaderProps<K extends string> {
  columns: readonly SortColumn<K>[];
  sort?: K;
  descending?: boolean;
  onSort?: (key: K) => void;
  trailing?: string;
}

export function ResizableTableHeader({
  labels,
}: {
  labels: readonly string[];
}) {
  return (
    <SortableHeader columns={labels.map((label) => ({ key: label, label }))} />
  );
}

export default function SortableHeader<K extends string>(
  props: HeaderProps<K>,
) {
  const storageKey = `isaacprof.table-columns:${[...props.columns.map(({ key }) => key), ...(props.trailing ? ['$trailing'] : [])].join('|')}`;
  return (
    <ResizableHeader key={storageKey} {...props} storageKey={storageKey} />
  );
}

function ResizableHeader<K extends string>({
  columns,
  sort,
  descending,
  onSort,
  trailing,
  storageKey,
}: HeaderProps<K> & { storageKey: string }) {
  const keys = [
    ...columns.map(({ key }) => key),
    ...(trailing ? ['$trailing'] : []),
  ];
  const [widths, setWidths] = useState<number[]>(() => {
    try {
      const value: unknown = JSON.parse(
        localStorage.getItem(storageKey) ?? 'null',
      );
      return Array.isArray(value) &&
        value.length === keys.length &&
        value.every(
          (width: unknown) =>
            typeof width === 'number' &&
            Number.isFinite(width) &&
            width >= 44 &&
            width <= 2000,
        )
        ? (value as number[])
        : [];
    } catch {
      return [];
    }
  });
  const group = useRef<HTMLTableColElement>(null);
  const drag = useRef<{
    pointer: number;
    x: number;
    index: number;
    widths: number[];
  } | null>(null);

  useLayoutEffect(() => {
    const table = group.current?.closest('table');
    if (table) {
      table.style.width = widths.length
        ? `${widths.reduce((sum, width) => sum + width, 0)}px`
        : '';
    }
  }, [widths]);

  function currentWidths() {
    const table = group.current?.closest('table');
    return table
      ? [...table.querySelectorAll('thead th')].map((cell) =>
          Math.max(44, cell.getBoundingClientRect().width),
        )
      : [];
  }

  function apply(next: number[]) {
    const colgroup = group.current;
    const table = colgroup?.closest('table');
    if (!colgroup || !table) {
      return;
    }
    [...colgroup.children].forEach((column, index) => {
      (column as HTMLTableColElement).style.width = `${next[index]}px`;
    });
    table.style.width = `${next.reduce((sum, width) => sum + width, 0)}px`;
  }

  function commit(next: number[]) {
    setWidths(next);
    try {
      localStorage.setItem(storageKey, JSON.stringify(next));
    } catch {
      // Resizing remains usable when browser storage is unavailable.
    }
  }

  function start(event: PointerEvent<HTMLSpanElement>, index: number) {
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const next = currentWidths();
    apply(next);
    drag.current = {
      pointer: event.pointerId,
      x: event.clientX,
      index,
      widths: next,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function move(event: PointerEvent<HTMLSpanElement>) {
    const active = drag.current;
    if (!active || event.pointerId !== active.pointer) {
      return;
    }
    const next = [...active.widths];
    next[active.index] = Math.max(
      44,
      Math.min(2000, active.widths[active.index] + event.clientX - active.x),
    );
    apply(next);
  }

  function finish(event: PointerEvent<HTMLSpanElement>) {
    if (drag.current?.pointer !== event.pointerId) {
      return;
    }
    commit(currentWidths());
    drag.current = null;
  }

  function keyboard(event: KeyboardEvent<HTMLSpanElement>, index: number) {
    if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) {
      return;
    }
    event.preventDefault();
    const next = currentWidths();
    next[index] = Math.max(
      44,
      Math.min(
        2000,
        next[index] +
          (event.key === 'ArrowRight' ? 1 : -1) * (event.shiftKey ? 50 : 10),
      ),
    );
    apply(next);
    commit(next);
  }

  function reset() {
    setWidths([]);
    for (const column of [...(group.current?.children ?? [])]) {
      (column as HTMLTableColElement).style.width = '';
    }
    const table = group.current?.closest('table');
    if (table) {
      table.style.width = '';
    }
    try {
      localStorage.removeItem(storageKey);
    } catch {
      // Reset is still effective for this view.
    }
  }

  function handle(label: string, index: number) {
    return (
      <span
        className="column-resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label={`Resize ${label} column`}
        aria-valuemin={44}
        aria-valuemax={2000}
        aria-valuenow={widths[index] ?? 100}
        aria-valuetext={
          widths[index]
            ? `${Math.round(widths[index])} pixels`
            : 'Automatic width'
        }
        tabIndex={0}
        title="Drag to resize; arrow keys adjust width. Double-click to reset table widths."
        onPointerDown={(event) => start(event, index)}
        onPointerMove={move}
        onPointerUp={finish}
        onLostPointerCapture={finish}
        onPointerCancel={finish}
        onKeyDown={(event) => keyboard(event, index)}
        onDoubleClick={reset}
      />
    );
  }

  return (
    <>
      <colgroup ref={group}>
        {keys.map((key, index) => (
          <col
            key={key}
            style={widths[index] ? { width: widths[index] } : undefined}
          />
        ))}
      </colgroup>
      <thead>
        <tr>
          {columns.map(({ key, label }, index) => (
            <th
              key={key}
              className="resizable-column"
              aria-sort={
                !onSort
                  ? undefined
                  : sort === key
                    ? descending
                      ? 'descending'
                      : 'ascending'
                    : 'none'
              }
            >
              {onSort ? (
                <button onClick={() => onSort(key)}>
                  {label}
                  {sort === key ? (descending ? ' \u25be' : ' \u25b4') : ''}
                </button>
              ) : (
                <span>{label}</span>
              )}
              {handle(label, index)}
            </th>
          ))}
          {trailing && (
            <th className="resizable-column">
              {trailing}
              {handle(trailing, columns.length)}
            </th>
          )}
        </tr>
      </thead>
    </>
  );
}
