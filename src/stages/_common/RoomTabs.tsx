import React from 'react';

type RoomTab<Id extends string> = { id: Id; label: string };

interface Props<Id extends string> {
  label: string;
  tabs: readonly RoomTab<Id>[];
  activeTab: Id;
  onChange: (id: Id) => void;
}

/** Shared room navigation keeps every section visible and touch-sized on phones. */
export function RoomTabs<Id extends string>({ label, tabs, activeTab, onChange }: Props<Id>) {
  return (
    <nav aria-label={label} className="grid min-w-0 grid-cols-2 gap-2 rounded-xl border border-slate-700 bg-slate-800/80 p-2 sm:flex sm:flex-wrap">
      {tabs.map(tab => (
        <button
          key={tab.id}
          type="button"
          aria-pressed={activeTab === tab.id}
          onClick={() => onChange(tab.id)}
          className={`min-h-11 min-w-0 break-words rounded-lg px-3 py-2 text-sm font-medium leading-snug transition-colors sm:w-auto ${
            activeTab === tab.id
              ? 'bg-blue-600 text-white shadow-sm'
              : 'bg-slate-900/60 text-slate-200 hover:bg-slate-700'
          }`}
        >
          {tab.label}
        </button>
      ))}
    </nav>
  );
}
