import React from 'react';

/** Keep the room tool above the fold. The full instructions and QA caution
 * remain accessible in an optional disclosure, never an adjacent narrow column. */
export function RoomWorkspaceHeader({
  icon, title, description,
}: { icon?: string; title: string; description: string }) {
  return (
    <header className="min-w-0 max-w-full rounded-xl border border-slate-700 bg-slate-800/75 p-3 shadow-sm sm:p-4">
      <div className="flex min-w-0 items-center gap-3">
        {icon && <span aria-hidden="true" className="shrink-0 rounded-xl bg-slate-900/80 p-2 text-xl">{icon}</span>}
        <h2 className="min-w-0 flex-1 break-words text-lg font-semibold leading-snug text-white sm:text-xl">{title}</h2>
      </div>
      <details className="group mt-2 min-w-0 border-t border-slate-700/70 pt-1">
        <summary className="flex min-h-10 cursor-pointer items-center justify-between gap-2 text-sm text-slate-300">
          <span>О комнате и порядке работы</span>
          <span aria-hidden="true" className="shrink-0 text-xs text-slate-400 group-open:hidden">Показать</span>
          <span aria-hidden="true" className="hidden shrink-0 text-xs text-slate-400 group-open:inline">Скрыть</span>
        </summary>
        <div className="min-w-0 space-y-2 pb-1">
          <p className="min-w-0 break-words text-sm leading-relaxed text-slate-200">{description}</p>
          <p className="min-w-0 break-words text-xs leading-relaxed text-slate-400">
            Расчёты и наблюдения не заменяют подтверждение качества или складского движения.
          </p>
        </div>
      </details>
    </header>
  );
}
