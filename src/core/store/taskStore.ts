import { create } from 'zustand';
import { Task, TaskStatus, TaskPriority } from '../types';
import { v4 as uuidv4 } from 'uuid';

interface TaskState {
  tasks: Task[];
  isLoading: boolean;
  filter: {
    status?: TaskStatus;
    assignedTo?: string;
    priority?: TaskPriority;
  };

  // Actions
  setTasks: (tasks: Task[]) => void;
  addTask: (task: Omit<Task, 'id' | 'createdAt' | 'updatedAt' | 'comments' | 'attachments'>) => void;
  updateTask: (id: string, updates: Partial<Task>) => void;
  deleteTask: (id: string) => void;
  setFilter: (filter: Partial<TaskState['filter']>) => void;
  setLoading: (loading: boolean) => void;
}

export const useTaskStore = create<TaskState>((set, get) => ({
  tasks: [],
  isLoading: false,
  filter: {},

  setTasks: (tasks) => set({ tasks }),

  addTask: (taskData) => {
    const newTask: Task = {
      ...taskData,
      id: uuidv4(),
      createdAt: new Date(),
      updatedAt: new Date(),
      comments: [],
      attachments: [],
    };
    set((state) => ({ tasks: [...state.tasks, newTask] }));
  },

  updateTask: (id, updates) => {
    set((state) => ({
      tasks: state.tasks.map((t) =>
        t.id === id ? { ...t, ...updates, updatedAt: new Date() } : t
      ),
    }));
  },

  deleteTask: (id) => {
    set((state) => ({
      tasks: state.tasks.filter((t) => t.id !== id),
    }));
  },

  setFilter: (filter) => {
    set((state) => ({ filter: { ...state.filter, ...filter } }));
  },

  setLoading: (loading) => set({ isLoading: loading }),
}));

// Селекторы
export function getFilteredTasks(tasks: Task[], filter: TaskState['filter']): Task[] {
  return tasks.filter((task) => {
    if (filter.status && task.status !== filter.status) return false;
    if (filter.assignedTo && task.assignedTo !== filter.assignedTo) return false;
    if (filter.priority && task.priority !== filter.priority) return false;
    return true;
  });
}
