export interface Todo {
  id: string;
  title: string;
  completed: boolean;
  createdAt: string;
  updatedAt: string;
}

const apiOrigin = (import.meta.env.VITE_API_URL ?? '').replace(/\/+$/, '');

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(`${apiOrigin}/api${path}`, {
      ...options,
      headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers },
      signal: controller.signal,
      cache: 'no-store'
    });
    if (!response.ok) {
      const body = await response.json().catch(() => null) as { error?: string } | null;
      throw new Error(body?.error || 'Something went wrong. Please try again.');
    }
    if (response.status === 204) return undefined as T;
    return await response.json() as T;
  } catch (error) {
    if (error instanceof TypeError || (error instanceof DOMException && error.name === 'AbortError')) {
      throw new Error('We couldn’t reach your list. Check your connection and try again.', { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export const api = {
  list: () => request<{ todos: Todo[] }>('/todos'),
  create: (title: string) => request<{ todo: Todo }>('/todos', { method: 'POST', body: JSON.stringify({ title }) }),
  update: (id: string, changes: Partial<Pick<Todo, 'title' | 'completed'>>) =>
    request<{ todo: Todo }>(`/todos/${id}`, { method: 'PATCH', body: JSON.stringify(changes) }),
  remove: (id: string) => request<void>(`/todos/${id}`, { method: 'DELETE' }),
  clearCompleted: () => request<{ deletedCount: number }>('/todos/completed', { method: 'DELETE' })
};
