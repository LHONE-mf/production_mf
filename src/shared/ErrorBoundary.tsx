// Глобальный предохранитель: если любой экран падает с ошибкой — показываем
// сообщение и кнопку «На главную», вместо белой страницы / перезагрузки SPA.

import React from 'react';

interface Props {
  children: React.ReactNode;
  onReset?: () => void; // например, вернуться на dashboard
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('ErrorBoundary поймал ошибку:', error, info.componentStack);
  }

  componentDidUpdate(prev: Props) {
    // сменили экран (children) — сбрасываем состояние ошибки
    if (prev.children !== this.props.children && this.state.error) {
      this.setState({ error: null });
    }
  }

  render() {
    if (this.state.error) {
      return (
        <div className="bg-slate-800 border border-red-700 rounded-xl p-6 max-w-lg mx-auto mt-10 space-y-4">
          <h2 className="text-white font-bold text-lg">⚠️ Экран отобразился с ошибкой</h2>
          <p className="text-slate-300 text-sm break-words">
            Данные остались целы. Текст ошибки: <span className="font-mono text-red-300">{String(this.state.error?.message ?? this.state.error)}</span>
          </p>
          <button
            onClick={() => {
              this.setState({ error: null });
              this.props.onReset?.();
            }}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-500 rounded text-white text-sm font-medium"
          >
            ⟳ Повторить / Назад
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
