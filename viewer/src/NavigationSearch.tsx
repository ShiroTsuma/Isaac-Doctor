import { useEffect, useRef, useState } from 'react';
import { searchNavigation } from './navigation.ts';
import type { NavigationEntry } from './navigation.ts';
import './navigation.css';
export default function NavigationSearch({
  entries,
  hasRecording,
  select,
}: {
  entries: NavigationEntry[];
  hasRecording: boolean;
  select: (entry: NavigationEntry) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const results = searchNavigation(entries, query);
  const index = Math.min(active, Math.max(0, results.length - 1));
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        input.current?.focus();
        input.current?.select();
        setOpen(true);
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);

  useEffect(() => {
    if (open) {
      document
        .getElementById(`navigation-option-${index}`)
        ?.scrollIntoView({ block: 'nearest' });
    }
  }, [open, index, query]);

  function choose(entry: NavigationEntry) {
    if (entry.requiresRecording && !hasRecording) {
      return;
    }
    setOpen(false);
    setQuery('');
    input.current?.blur();
    select(entry);
  }

  return (
    <div
      className="navigation-search"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          setOpen(false);
        }
      }}
    >
      <span className="navigation-search-icon" aria-hidden="true">
        ⌕
      </span>
      <input
        id="navigation-search"
        ref={input}
        role="combobox"
        aria-label="Search views, commands, recordings and sources"
        aria-expanded={open}
        aria-controls="navigation-results"
        aria-autocomplete="list"
        aria-activedescendant={
          open && results.length ? `navigation-option-${index}` : undefined
        }
        placeholder="Search views, commands, files..."
        value={query}
        onFocus={() => setOpen(true)}
        onChange={(event) => {
          setQuery(event.target.value);
          setActive(0);
          setOpen(true);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            setOpen(false);
            input.current?.blur();
          }
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            setOpen(true);
            setActive(
              (index + (event.key === 'ArrowDown' ? 1 : -1) + results.length) %
                Math.max(1, results.length),
            );
          }
          if (event.key === 'Enter' && results[index]) {
            event.preventDefault();
            choose(results[index]);
          }
        }}
      />
      <kbd>Ctrl K</kbd>
      {open && (
        <div className="navigation-menu">
          <div className="navigation-help">
            &gt; commands · / recordings & sources · @ mods & hooks
          </div>
          <div
            id="navigation-results"
            role="listbox"
            aria-label="Search results"
          >
            {results.map((entry, i) => (
              <div
                key={entry.id}
                id={`navigation-option-${i}`}
                role="option"
                aria-selected={i === index}
                aria-disabled={!!entry.requiresRecording && !hasRecording}
                className={
                  i === index ? 'navigation-result active' : 'navigation-result'
                }
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => choose(entry)}
              >
                <span className="navigation-category">{entry.category}</span>
                <span>
                  <b>{entry.label}</b>
                  <small>
                    {entry.requiresRecording && !hasRecording
                      ? 'Open a recording first'
                      : entry.description}
                  </small>
                </span>
                <span aria-hidden="true">↵</span>
              </div>
            ))}
          </div>
          {!results.length && (
            <p role="status">No matching destination in this session.</p>
          )}
          <div className="navigation-help">
            ↑ ↓ select · Enter open · Esc close · files stay local
          </div>
        </div>
      )}
    </div>
  );
}
