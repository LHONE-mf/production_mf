import React from 'react';
import { BarChart3, TrendingUp, Users, Clock, CheckCircle, Target } from 'lucide-react';

export function ReportsModule() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-white">Отчёты</h1>
        <p className="text-slate-400 text-sm mt-1">Аналитика производства и KPI</p>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-slate-800/60 backdrop-blur border border-slate-700/50 rounded-2xl p-5">
          <div className="flex items-center gap-3 mb-2">
            <div className="w-10 h-10 bg-green-500/20 rounded-xl flex items-center justify-center">
              <CheckCircle className="w-5 h-5 text-green-400" />
            </div>
            <div>
              <p className="text-2xl font-bold text-white">94%</p>
              <p className="text-slate-400 text-xs">Выполнение плана</p>
            </div>
          </div>
          <p className="text-green-400 text-xs flex items-center gap-1">
            <TrendingUp className="w-3 h-3" /> +5% к прошлой неделе
          </p>
        </div>

        <div className="bg-slate-800/60 backdrop-blur border border-slate-700/50 rounded-2xl p-5">
          <div className="flex items-center gap-3 mb-2">
            <div className="w-10 h-10 bg-blue-500/20 rounded-xl flex items-center justify-center">
              <Target className="w-5 h-5 text-blue-400" />
            </div>
            <div>
              <p className="text-2xl font-bold text-white">156</p>
              <p className="text-slate-400 text-xs">Ячеек за смену</p>
            </div>
          </div>
          <p className="text-blue-400 text-xs flex items-center gap-1">
            <TrendingUp className="w-3 h-3" /> Цель: 160
          </p>
        </div>

        <div className="bg-slate-800/60 backdrop-blur border border-slate-700/50 rounded-2xl p-5">
          <div className="flex items-center gap-3 mb-2">
            <div className="w-10 h-10 bg-orange-500/20 rounded-xl flex items-center justify-center">
              <Clock className="w-5 h-5 text-orange-400" />
            </div>
            <div>
              <p className="text-2xl font-bold text-white">2.3ч</p>
              <p className="text-slate-400 text-xs">Среднее время задачи</p>
            </div>
          </div>
          <p className="text-green-400 text-xs flex items-center gap-1">
            <TrendingUp className="w-3 h-3" /> -12 мин к норме
          </p>
        </div>

        <div className="bg-slate-800/60 backdrop-blur border border-slate-700/50 rounded-2xl p-5">
          <div className="flex items-center gap-3 mb-2">
            <div className="w-10 h-10 bg-purple-500/20 rounded-xl flex items-center justify-center">
              <Users className="w-5 h-5 text-purple-400" />
            </div>
            <div>
              <p className="text-2xl font-bold text-white">6</p>
              <p className="text-slate-400 text-xs">Сотрудников активно</p>
            </div>
          </div>
          <p className="text-slate-400 text-xs">100% явка</p>
        </div>
      </div>

      {/* Charts placeholder */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-slate-800/60 backdrop-blur border border-slate-700/50 rounded-2xl p-6">
          <h3 className="text-white font-semibold flex items-center gap-2 mb-4">
            <BarChart3 className="w-5 h-5 text-blue-400" />
            Производство за неделю
          </h3>
          <div className="space-y-3">
            {['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'].map((day, i) => {
              const values = [145, 158, 152, 160, 148, 130, 0];
              const max = 160;
              return (
                <div key={day} className="flex items-center gap-3">
                  <span className="text-slate-400 text-xs w-6">{day}</span>
                  <div className="flex-1 h-6 bg-slate-700/50 rounded-lg overflow-hidden">
                    <div 
                      className={`h-full rounded-lg flex items-center px-2 ${
                        i < 5 ? 'bg-gradient-to-r from-blue-500 to-green-500' : 'bg-slate-600'
                      }`}
                      style={{ width: `${(values[i] / max) * 100}%` }}
                    >
                      {values[i] > 0 && <span className="text-white text-xs font-medium">{values[i]}</span>}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="bg-slate-800/60 backdrop-blur border border-slate-700/50 rounded-2xl p-6">
          <h3 className="text-white font-semibold flex items-center gap-2 mb-4">
            <Users className="w-5 h-5 text-purple-400" />
            KPI сотрудников
          </h3>
          <div className="space-y-3">
            {[
              { name: 'Козлов Д.С.', tasks: 24, efficiency: 96, rating: 'A' },
              { name: 'Новиков А.М.', tasks: 21, efficiency: 89, rating: 'B' },
              { name: 'Морозов С.Н.', tasks: 18, efficiency: 82, rating: 'B' },
              { name: 'Сидоров А.В.', tasks: 15, efficiency: 94, rating: 'A' },
            ].map((emp, i) => (
              <div key={i} className="flex items-center gap-3 p-3 bg-slate-700/30 rounded-xl">
                <div className="w-8 h-8 bg-blue-500/20 rounded-lg flex items-center justify-center text-white text-xs font-bold">
                  {emp.name.charAt(0)}
                </div>
                <div className="flex-1">
                  <p className="text-white text-sm">{emp.name}</p>
                  <div className="flex items-center gap-2 mt-1">
                    <div className="flex-1 h-1.5 bg-slate-600 rounded-full overflow-hidden">
                      <div 
                        className={`h-full rounded-full ${emp.efficiency > 90 ? 'bg-green-500' : 'bg-blue-500'}`}
                        style={{ width: `${emp.efficiency}%` }}
                      />
                    </div>
                    <span className="text-slate-400 text-xs">{emp.efficiency}%</span>
                  </div>
                </div>
                <div className="text-right">
                  <p className="text-white text-sm font-bold">{emp.tasks}</p>
                  <p className="text-slate-400 text-xs">задач</p>
                </div>
                <span className={`px-2 py-1 rounded text-xs font-bold ${
                  emp.rating === 'A' ? 'bg-green-500/20 text-green-300' : 'bg-blue-500/20 text-blue-300'
                }`}>
                  {emp.rating}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Quality metrics */}
      <div className="bg-slate-800/60 backdrop-blur border border-slate-700/50 rounded-2xl p-6">
        <h3 className="text-white font-semibold flex items-center gap-2 mb-4">
          <Target className="w-5 h-5 text-green-400" />
          Качество продукции
        </h3>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          {[
            { label: 'Брак', value: '0.8%', target: '<1%', ok: true },
            { label: 'Ёмкость (средняя)', value: '3.2 Ач', target: '>3.0 Ач', ok: true },
            { label: 'Сопротивление', value: '12 мОм', target: '<15 мОм', ok: true },
            { label: 'Отклонение напряжения', value: '±0.02V', target: '±0.05V', ok: true },
          ].map((metric, i) => (
            <div key={i} className="p-4 bg-slate-700/30 rounded-xl text-center">
              <p className={`text-xl font-bold ${metric.ok ? 'text-green-400' : 'text-red-400'}`}>
                {metric.value}
              </p>
              <p className="text-slate-400 text-xs mt-1">{metric.label}</p>
              <p className="text-slate-500 text-xs">Норма: {metric.target}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export { ReportsModule as default };
