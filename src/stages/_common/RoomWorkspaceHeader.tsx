import React from 'react';

/** Shared room heading. It deliberately does not claim network availability,
 * inventory confirmation or QA release. Those belong to individual workflows. */
export function RoomWorkspaceHeader({
  icon, title, description,
}: { icon?: string; title: string; description: string }) {
  return (
    <header className="min-w-0 space-y-3 rounded-2xl border border-slate-700 bg-slate-800/75 p-4 shadow-sm sm:p-5">
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          {icon && <span aria-hidden="true" className="shrink-0 rounded-xl bg-slate-900/80 p-2 text-xl">{icon}</span>}
          <div className="min-w-0">
            <h2 className="break-words text-lg font-semibold leading-snug text-white sm:text-xl">{title}</h2>
            <p className="mt-2 text-sm leading-relaxed text-slate-200">{description}</p>
          </div>
        </div>
        <span className="shrink-0 rounded-md border border-slate-600 px-2 py-1 text-xs text-slate-300">Этап производства</span>
      </div>
      <p className="border-t border-slate-700 pt-2 text-xs leading-relaxed text-slate-400">
        Расчёты и наблюдения не заменяют подтверждение качества или складского движения.
      </p>
    </header>
  );
}
