import React, { useEffect, useState } from 'react';
import { useAuthStore } from './core/store/authStore';
import { initializeDatabase } from './core/db';
import { LoginForm } from './modules/auth/components/LoginForm';
import { AppLayout } from './shared/layouts/AppLayout';
import { Dashboard } from './modules/dashboard/Dashboard';
import { TasksModule } from './modules/tasks/TasksModule';
import { UsersModule } from './modules/users/UsersModule';
import { CommunicationModule } from './modules/communication/CommunicationModule';
import { SyncModule } from './modules/sync/SyncModule';
import { ReportsModule } from './modules/reports/ReportsModule';
import { renderStageIfActive } from './stages/StageRouter';

function App() {
  const { isAuthenticated } = useAuthStore();
  const [activeTab, setActiveTab] = useState('dashboard');
  const [isDbReady, setIsDbReady] = useState(false);

  useEffect(() => {
    initializeDatabase().then(() => setIsDbReady(true));
  }, []);

  if (!isDbReady) {
    return (
      <div className="min-h-screen bg-slate-900 flex items-center justify-center">
        <div className="text-center">
          <div className="w-16 h-16 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto mb-4" />
          <p className="text-white text-lg">Загрузка системы...</p>
          <p className="text-slate-400 text-sm mt-1">Инициализация базы данных</p>
        </div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return <LoginForm />;
  }

  const renderContent = () => {
    // Комнаты этапов производства ("stage:<id>")
    const stageView = renderStageIfActive(activeTab);
    if (stageView) return stageView;

    switch (activeTab) {
      case 'dashboard':
        return <Dashboard />;
      case 'tasks':
        return <TasksModule />;
      case 'users':
        return <UsersModule />;
      case 'communication':
        return <CommunicationModule />;
      case 'sync':
        return <SyncModule />;
      case 'reports':
        return <ReportsModule />;
      default:
        return <Dashboard />;
    }
  };

  return (
    <AppLayout activeTab={activeTab} onTabChange={setActiveTab}>
      {renderContent()}
    </AppLayout>
  );
}

export default App;
