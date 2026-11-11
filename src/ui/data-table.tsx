import { Span } from "@k8slens/element-components";
import { type KeyboardEvent, type ReactNode, useMemo, useState } from "react";
import { compareValues } from "../common/format";
import styles from "./ui.module.scss";

export interface Column<T> {
  readonly id: string;
  readonly header: ReactNode;
  readonly render: (row: T) => ReactNode;
  /** What the column sorts by; left out, the column cannot be sorted. */
  readonly sortValue?: (row: T) => unknown;
  readonly width?: number | string;
}

export interface DataTableProps<T> {
  readonly rows: readonly T[];
  readonly columns: readonly Column<T>[];
  readonly rowKey: (row: T) => string;
  readonly onRowClick?: (row: T) => void;
  readonly selectedKey?: string;
  readonly empty?: ReactNode;
  readonly ariaLabel: string;
  readonly initialSort?: { readonly column: string; readonly descending?: boolean };
  readonly limit?: number;
}

/** A sortable table navigable by keyboard: Arrow keys move between rows, Enter opens one. */
export const DataTable = <T,>({ rows, columns, rowKey, onRowClick, selectedKey, empty, ariaLabel, initialSort, limit = 2000 }: DataTableProps<T>) => {
  const [sort, setSort] = useState<{ column: string; descending: boolean } | undefined>(
    initialSort ? { column: initialSort.column, descending: initialSort.descending ?? false } : undefined,
  );

  const sorted = useMemo(() => {
    const column = columns.find((candidate) => candidate.id === sort?.column);

    if (!column?.sortValue || !sort) {
      return rows;
    }

    const direction = sort.descending ? -1 : 1;

    return [...rows].sort((a, b) => direction * compareValues(column.sortValue!(a), column.sortValue!(b)));
  }, [rows, columns, sort]);

  const shown = sorted.slice(0, limit);

  const onKeyDown = (event: KeyboardEvent<HTMLTableRowElement>, row: T) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onRowClick?.(row);
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();

      const sibling = event.key === "ArrowDown" ? event.currentTarget.nextElementSibling : event.currentTarget.previousElementSibling;

      (sibling as HTMLElement | null)?.focus();
    }
  };

  return (
    <>
      <table className={styles.table} aria-label={ariaLabel}>
        <thead>
          <tr>
            {columns.map((column) => {
              const active = sort?.column === column.id;

              return (
                <th
                  key={column.id}
                  style={column.width ? { width: column.width } : undefined}
                  className={column.sortValue ? styles.sortable : undefined}
                  aria-sort={active ? (sort!.descending ? "descending" : "ascending") : undefined}
                  tabIndex={column.sortValue ? 0 : undefined}
                  onClick={() => column.sortValue && setSort(active ? { column: column.id, descending: !sort!.descending } : { column: column.id, descending: false })}
                  onKeyDown={(event) => {
                    if (column.sortValue && (event.key === "Enter" || event.key === " ")) {
                      event.preventDefault();
                      setSort(active ? { column: column.id, descending: !sort!.descending } : { column: column.id, descending: false });
                    }
                  }}
                >
                  {column.header}
                  {active ? (sort!.descending ? " ▾" : " ▴") : ""}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {shown.map((row) => {
            const key = rowKey(row);

            return (
              <tr
                key={key}
                tabIndex={onRowClick ? 0 : undefined}
                className={[onRowClick ? styles.clickable : "", key === selectedKey ? styles.selected : ""].join(" ")}
                aria-selected={key === selectedKey}
                onClick={() => onRowClick?.(row)}
                onKeyDown={(event) => onKeyDown(event, row)}
              >
                {columns.map((column) => (
                  <td key={column.id}>{column.render(row)}</td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
      {rows.length === 0 && empty}
      {rows.length > limit && (
        <Span $color="textMuted" $padding="m" $block>
          Showing the first {limit} of {rows.length}; narrow the search to see the rest.
        </Span>
      )}
    </>
  );
};
