export interface SortColumn<K extends string> {
  key: K;
  label: string;
}
export default function SortableHeader<K extends string>({
  columns,
  sort,
  descending,
  onSort,
  trailing,
}: {
  columns: readonly SortColumn<K>[];
  sort: K;
  descending: boolean;
  onSort: (key: K) => void;
  trailing?: string;
}) {
  return (
    <thead>
      <tr>
        {columns.map(({ key, label }) => (
          <th
            key={key}
            aria-sort={
              sort === key ? (descending ? 'descending' : 'ascending') : 'none'
            }
          >
            <button onClick={() => onSort(key)}>
              {label}
              {sort === key ? (descending ? ' \u25be' : ' \u25b4') : ''}
            </button>
          </th>
        ))}
        {trailing && <th>{trailing}</th>}
      </tr>
    </thead>
  );
}
