import React from 'react';

type RoomTab<Id extends string> = { id: Id; label: string };

interface Props<Id extends string> {
  label: string;
  tabs: readonly RoomTab<Id>[];
  activeTab: Id;
  onChange: (id: Id) => void;
}

/** A native phone picker uses one row, even when a room has nine sections.
 * Larger screens keep all sections available as direct-access buttons. */
export function RoomTabs<Id extends string>({ label, tabs, activeTab, onChange }: Props<Id>) {
  return (
    <nav aria-label={label} className="min-w-0 rounded-xl border border-slate-700 bg-slate-800/80 p-2">
      <label className="flex min-w-0 items-center gap-2 sm:hidden">
        <span className="shrink-0 text-sm text-slate-300">Раздел</span>
        <select
          aria-label={label}
          value={activeTab}
          onChange={event => onChange(event.target.value as Id)}
          className="min-h-11 w-full min-w-0 rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm font-medium text-white"
        >
          {tabs.map(tab => <option key={tab.id} value={tab.id}>{tab.label}</option>)}
        </select>
      </label>
      <div className="hidden flex-wrap gap-2 sm:flex">
        {tabs.map(tab => (
          <button
            key={tab.id}
            type="button"
            aria-pressed={activeTab === tab.id}
            onClick={() => onChange(tab.id)}
            className={['min-h-11 min-w-0 break-words rounded-lg px-3 py-2 text-sm font-medium leading-snug transition-colors',
              activeTab === tab.id
                ? 'bg-blue-600 text-white shadow-sm'
                : 'bg-slate-900/60 text-slate-200 hover:bg-slate-700'].join(' ')}
          >
            {tab.label}
          </button>
        ))}
      </div>
    </nav>
  );
}
