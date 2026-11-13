import React from 'react';

/** A small shared header for offline workrooms. Status reflects a recording
 * context, never equipment connectivity, approved quality or material balance. */
export function RoomWorkspaceHeader({
  icon,title,description,
}:{icon?:string;title:string;description:string}){
  return <header className="min-w-0 rounded-xl border border-slate-700 bg-slate-800/70 p-4 space-y-2">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h2 className="flex min-w-0 items-center gap-2 text-lg sm:text-xl font-semibold text-white">
        {icon&&<span aria-hidden="true">{icon}</span>}<span>{title}</span>
      </h2>
      <span className="shrink-0 rounded-md border border-slate-600 bg-slate-900 px-2 py-1 text-xs text-slate-200">Локальная запись · офлайн</span>
    </div>
    <p className="text-sm leading-relaxed text-slate-300">{description}</p>
    <p className="text-xs text-slate-400">Результаты и источники сохраняются на устройстве; не означают QA-допуск, движение запасов или выполнение операции на оборудовании.</p>
  </header>;
}
