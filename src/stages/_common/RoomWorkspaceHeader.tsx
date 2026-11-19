import React from 'react';

/** Shared room heading. It deliberately does not claim network availability,
 * inventory confirmation or QA release. Those belong to individual workflows. */
export function RoomWorkspaceHeader({
  icon, title, description,
}: { icon?: string; title: string; description: string }) {
  return (
    <header className="min-w-0 space-y-3 rounded-2xl border border-slate-700 bg-slate-800/75 p-4 shadow-sm sm:p-5">
      {/* The metadata badge must not take width away from the room title or
          force the long description into a narrow mobile column. */}
      <div className="flex min-w-0 items-center gap-3">
        {icon && <span aria-hidden="true" className="shrink-0 rounded-xl bg-slate-900/80 p-2 text-xl">{icon}</span>}
        <h2 className="min-w-0 break-words text-lg font-semibold leading-snug text-white sm:text-xl">{title}</h2>
      </div>
      <p className="break-words text-sm leading-relaxed text-slate-200">{description}</p>
      <div className="flex flex-wrap items-center gap-2 border-t border-slate-700 pt-2">
        <span className="shrink-0 rounded-md border border-slate-600 px-2 py-1 text-xs text-slate-300">Этап производства</span>
        <p className="min-w-0 text-xs leading-relaxed text-slate-400">
          Расчёты и наблюдения не заменяют подтверждение качества или складского движения.
        </p>
      </div>
    </header>
  );
}
