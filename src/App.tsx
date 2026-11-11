import React, { useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useAuthStore } from './core/store/authStore';
import { db, initializeDatabase } from './core/db';
import { clearServerConnection } from './core/sync/serverConnection';
import { FirstRunSetup } from './modules/auth/components/FirstRunSetup';
import { LoginForm } from './modules/auth/components/LoginForm';
import { AppLayout } from './shared/layouts/AppLayout';
import { Dashboard } from './modules/dashboard/Dashboard';
import { KpiDashboard } from './kpi/KpiDashboard';
import { TasksModule } from './modules/tasks/TasksModule';
import { UsersModule } from './modules/users/UsersModule';
import { CommunicationModule } from './modules/communication/CommunicationModule';
import { ChatModule } from './chat/ChatModule';
import { SyncModule } from './modules/sync/SyncModule';
import { PlanningModule } from './modules/planning/PlanningModule';
import { ReportsModule } from './modules/reports/ReportsModule';
import { renderStageIfActive } from './stages/StageRouter';
import { ErrorBoundary } from './shared/ErrorBoundary';

function App() {
  const { isAuthenticated } = useAuthStore();
  const localUsersCount = useLiveQuery(() => db.users.count(), []);
  const [activeTab, setActiveTab] = useState('dashboard');
  const [isDbReady, setIsDbReady] = useState(false);
  const [dbError,setDbError]=useState('');

  // Task visibility is limited by an offline grant. Without a timed
  // invalidation, an already-open screen could keep showing cached server
  // tasks after the grant expires (until another Dexie write triggers refresh).
  const offlineEditLease = useLiveQuery(() => db.hybridTaskEditLeases.get('active'), []);
  useEffect(() => {
    if (!offlineEditLease) return;
    const delay = Math.max(0, offlineEditLease.expiresAt - Date.now());
    const timer = setTimeout(() => {
      void db.transaction('rw', db.hybridTaskEditLeases, async () => {
        const current = await db.hybridTaskEditLeases.get('active');
        // An in-flight successful re-verification may have renewed the grant.
        if (current && current.expiresAt <= Date.now()) {
          await db.hybridTaskEditLeases.delete('active');
        }
      }).catch(error => console.error('Unable to expire offline task permission', error));
    }, delay);
    return () => clearTimeout(timer);
  }, [offlineEditLease?.expiresAt]);

  useEffect(() => {
    void initializeDatabase().then(demoReset => {
      if(demoReset){
        clearServerConnection();
        useAuthStore.getState().logout();
        localStorage.removeItem('lip_calender_params_v1');
        localStorage.removeItem('workshop-hmac-key-v1');
      }
      setIsDbReady(true);
    }).catch(cause=>setDbError(cause instanceof Error?cause.message:'Ошибка базы данных'));
  }, []);

  if (dbError) return <main className="min-h-screen bg-slate-900 p-6 text-red-200">
    Не удалось открыть локальную базу данных: {dbError}
  </main>;

  if (!isDbReady || localUsersCount===undefined) {
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

  if (localUsersCount===0) return <FirstRunSetup />;

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
      case 'kpi':
        return <KpiDashboard />;
      case 'tasks':
        return <TasksModule />;
      case 'users':
        return <UsersModule />;
      case 'chat':
        return <ChatModule />;
      case 'communication':
        return <CommunicationModule />;
      case 'planning':
        return <PlanningModule onOpenSync={() => setActiveTab('sync')} />;
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
      <ErrorBoundary key={activeTab} onReset={() => setActiveTab('dashboard')}>
        {renderContent()}
      </ErrorBoundary>
    </AppLayout>
  );
}

export default App;
