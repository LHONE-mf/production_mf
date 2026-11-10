import React, { useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useAuthStore } from './core/store/authStore';
import { db, initializeDatabase } from './core/db';
import { LoginForm } from './modules/auth/components/LoginForm';
import { AppLayout } from './shared/layouts/AppLayout';
import { Dashboard } from './modules/dashboard/Dashboard';
import { KpiDashboard } from './kpi/KpiDashboard';
import { TasksModule } from './modules/tasks/TasksModule';
import { UsersModule } from './modules/users/UsersModule';
import { CommunicationModule } from './modules/communication/CommunicationModule';
import { ChatModule } from './chat/ChatModule';
import { SyncModule } from './modules/sync/SyncModule';
import { ReportsModule } from './modules/reports/ReportsModule';
import { renderStageIfActive } from './stages/StageRouter';
import { ErrorBoundary } from './shared/ErrorBoundary';

function App() {
  const { isAuthenticated } = useAuthStore();
  const [activeTab, setActiveTab] = useState('dashboard');
  const [isDbReady, setIsDbReady] = useState(false);

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
