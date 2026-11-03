import { useEffect, useRef, useState, type CSSProperties, type FormEvent } from 'react';
import { ArrowRight, CalendarDays, Check, CheckCheck, CircleCheck, CloudCheck, Download, Leaf, LoaderCircle, Paperclip, Pencil, Plus, RotateCcw, Sparkles, Trash2, X } from 'lucide-react';
import { api, type Todo } from './api';

type Filter = 'all' | 'active' | 'completed';

interface TodoItemProps {
  todo: Todo;
  busy: boolean;
  working: boolean;
  onToggle: (todo: Todo) => void;
  onDelete: (todo: Todo) => void;
  onEdit: (todo: Todo, title: string) => Promise<boolean>;
  onAttach: (todo: Todo, file: File) => void;
  onRemoveAttachment: (todo: Todo) => void;
  onDownload: (todo: Todo) => void;
}

function TodoItem({ todo, busy, working, onToggle, onDelete, onEdit, onAttach, onRemoveAttachment, onDownload }: TodoItemProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(todo.title);
  const fileInput = useRef<HTMLInputElement>(null);

  async function save(event: FormEvent) {
    event.preventDefault();
    const title = draft.trim();
    if (!title || busy) return;
    if (title === todo.title || await onEdit(todo, title)) setEditing(false);
  }

  return (
    <li className={`task-row ${todo.completed ? 'is-completed' : ''} ${editing ? 'is-editing' : ''}`}>
      <button
        type="button"
        role="checkbox"
        aria-checked={todo.completed}
        aria-label={`${todo.completed ? 'Mark incomplete' : 'Complete'}: ${todo.title}`}
        className="task-checkbox"
        disabled={busy || editing}
        onClick={() => onToggle(todo)}
      >
        {working ? <LoaderCircle size={15} className="spin" /> : todo.completed ? <Check size={15} strokeWidth={3} /> : null}
      </button>
      {editing ? (
        <form className="edit-form" onSubmit={(event) => { void save(event); }}>
          <input
            aria-label="Edit task title"
            autoFocus
            value={draft}
            maxLength={200}
            required
            disabled={busy}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Escape' && !busy) setEditing(false); }}
          />
          <div className="edit-actions">
            <button type="submit" className="icon-button save-button" aria-label="Save task" title="Save task" disabled={busy || !draft.trim()}><Check size={18} /></button>
            <button type="button" className="icon-button" aria-label="Cancel editing" title="Cancel editing" disabled={busy} onClick={() => setEditing(false)}><X size={18} /></button>
          </div>
        </form>
      ) : (
        <>
          <div className="task-content"><span className="task-title">{todo.title}</span>
            {todo.attachment && <div className="attachment-row">
              <button type="button" className="attachment-download" title={`Download ${todo.attachment.name}`} aria-label={`Download attachment: ${todo.attachment.name}`} disabled={busy} onClick={() => onDownload(todo)}><Paperclip size={12} /><span>{todo.attachment.name}</span><span className="attachment-size">{todo.attachment.size >= 1024 * 1024 ? `${(todo.attachment.size / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.ceil(todo.attachment.size / 1024))} KB`}</span><Download size={12} /></button>
              <button type="button" className="attachment-remove" title="Remove attachment" aria-label={`Remove attachment: ${todo.attachment.name}`} disabled={busy} onClick={() => onRemoveAttachment(todo)}><X size={12} /></button>
            </div>}
          </div>
          <input ref={fileInput} type="file" className="sr-only" tabIndex={-1} aria-label={`Attachment file: ${todo.title}`} disabled={busy} onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) onAttach(todo, file);
            event.target.value = '';
          }} />
          <div className="task-actions">
            <button type="button" className="icon-button" aria-label={`${todo.attachment ? 'Replace' : 'Attach'} file: ${todo.title}`} title={`${todo.attachment ? 'Replace' : 'Attach'} file (up to 5 MB)`} disabled={busy} onClick={() => fileInput.current?.click()}><Paperclip size={16} /></button>
            <button type="button" className="icon-button" aria-label={`Edit: ${todo.title}`} title="Edit task" disabled={busy} onClick={() => { setDraft(todo.title); setEditing(true); }}><Pencil size={16} /></button>
            <button type="button" className="icon-button delete-button" aria-label={`Delete: ${todo.title}`} title="Delete task" disabled={busy} onClick={() => onDelete(todo)}><Trash2 size={16} /></button>
          </div>
        </>
      )}
    </li>
  );
}

export default function App() {
  const [todos, setTodos] = useState<Todo[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [reload, setReload] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const inFlight = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let active = true;
    api.list().then(({ todos: data }) => {
      if (!active) return;
      setTodos(data);
      setLoadFailed(false);
      setError(null);
    }).catch((failure: unknown) => {
      if (!active) return;
      setLoadFailed(true);
      setError(failure instanceof Error ? failure.message : 'Unable to load your tasks.');
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [reload]);

  function retry() {
    setLoading(true);
    setError(null);
    setReload((value) => value + 1);
  }

  async function perform(key: string, operation: () => Promise<void>, message: string) {
    if (inFlight.current || loading || loadFailed) return false;
    inFlight.current = true;
    setBusy(key);
    setError(null);
    setNotice('');
    try {
      await operation();
      setNotice(message);
      return true;
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Unable to save your change. Please try again.');
      return false;
    } finally {
      inFlight.current = false;
      setBusy(null);
    }
  }

  async function addTask(event: FormEvent) {
    event.preventDefault();
    const draft = title.trim();
    if (!draft) { inputRef.current?.focus(); return; }
    const added = await perform('add', async () => {
      const { todo } = await api.create(draft);
      setTodos((current) => [todo, ...current]);
      setTitle('');
      setFilter('all');
    }, 'Task added.');
    if (added) inputRef.current?.focus();
  }

  async function updateTask(todo: Todo, changes: Partial<Pick<Todo, 'title' | 'completed'>>) {
    return perform(todo.id, async () => {
      const { todo: updated } = await api.update(todo.id, changes);
      setTodos((current) => current.map((item) => item.id === updated.id ? updated : item));
    }, changes.title !== undefined ? 'Task updated.' : changes.completed ? 'Task completed. Nice work!' : 'Task marked incomplete.');
  }

  function removeTask(todo: Todo) {
    void perform(todo.id, async () => {
      await api.remove(todo.id);
      setTodos((current) => current.filter((item) => item.id !== todo.id));
    }, 'Task deleted.');
  }

  function clearCompleted() {
    void perform('clear', async () => {
      await api.clearCompleted();
      setTodos((current) => current.filter((todo) => !todo.completed));
    }, 'Completed tasks cleared.');
  }

  function attachFile(todo: Todo, file: File) {
    if (!file.size || file.size > 5 * 1024 * 1024) {
      setError(!file.size ? 'Choose a non-empty file to attach.' : 'Choose a file smaller than 5 MB.');
      return;
    }
    void perform(todo.id, async () => {
      const { todo: updated } = await api.attach(todo.id, file);
      setTodos((current) => current.map((item) => item.id === updated.id ? updated : item));
    }, 'File attached.');
  }

  function removeAttachment(todo: Todo) {
    void perform(todo.id, async () => {
      const { todo: updated } = await api.removeAttachment(todo.id);
      setTodos((current) => current.map((item) => item.id === updated.id ? updated : item));
    }, 'Attachment removed.');
  }

  function downloadAttachment(todo: Todo) {
    void perform(`download:${todo.id}`, async () => {
      const url = await api.downloadAttachment(todo.id);
      const link = document.createElement('a');
      link.href = url;
      link.download = todo.attachment?.name ?? 'attachment';
      document.body.append(link);
      link.click();
      link.remove();
    }, 'Your download is ready.');
  }

  const completed = todos.filter((todo) => todo.completed).length;
  const remaining = todos.length - completed;
  const progress = todos.length ? Math.round(completed / todos.length * 100) : 0;
  const visible = todos.filter((todo) => filter === 'all' || (filter === 'completed' ? todo.completed : !todo.completed));
  const unavailable = loading || loadFailed;
  const disabled = busy !== null || unavailable;
  const date = new Intl.DateTimeFormat('en', { weekday: 'short', month: 'short', day: 'numeric' }).format(new Date());
  const filters: { key: Filter; label: string; count: number }[] = [
    { key: 'all', label: 'All tasks', count: todos.length },
    { key: 'active', label: 'Active', count: remaining },
    { key: 'completed', label: 'Completed', count: completed }
  ];

  return (
    <div className="app-shell">
      <header className="site-header">
        <a className="brand" href="/" aria-label="Everyday home">
          <span className="brand-mark"><Check size={23} strokeWidth={3} /></span>
          <span>everyday<span className="brand-dot">.</span></span>
        </a>
        <div className="date-badge"><CalendarDays size={15} /><span>{date}</span></div>
      </header>

      <main>
        <section className="intro" aria-labelledby="page-title">
          <div className="eyebrow"><span className="small-dot" /> A LITTLE FOCUS GOES A LONG WAY</div>
          <h1 id="page-title">A little less on your mind<span>.</span></h1>
          <p>Write it down CUZ IT NCEA DSADASDASDAS AYAAAAA IS UPDATED. Take it one task at a time. Make space for your day.</p>
        </section>

        <div className="workspace">
          <section className="tasks-card" aria-labelledby="tasks-heading" aria-busy={loading}>
            <div className="card-heading">
              <div><h2 id="tasks-heading">My tasks <span className="heading-count">{unavailable ? '—' : todos.length}</span></h2><p>Your next small step starts here.</p></div>
              <span className="list-symbol" aria-hidden="true"><CheckCheck size={22} /></span>
            </div>

            <form className="add-form" onSubmit={(event) => { void addTask(event); }}>
              <div className="add-input-wrap"><Plus size={20} aria-hidden="true" /><input ref={inputRef} aria-label="New task" placeholder="What would you like to get done?" value={title} onChange={(event) => setTitle(event.target.value)} maxLength={200} disabled={disabled} autoComplete="off" /></div>
              <button type="submit" className="primary-button" disabled={disabled || !title.trim()}>{busy === 'add' ? <LoaderCircle size={17} className="spin" /> : <Plus size={17} />}<span>Add task</span></button>
            </form>

            {error && <div className="error-banner" role="alert"><span>{error}</span>{loadFailed ? <button type="button" onClick={retry} disabled={loading}><RotateCcw size={14} /> Try again</button> : <button type="button" className="icon-button" aria-label="Dismiss error" onClick={() => setError(null)}><X size={16} /></button>}</div>}

            <div className="filter-bar" aria-label="Filter tasks">
              {filters.map((item) => <button key={item.key} type="button" className={`filter-button ${filter === item.key ? 'is-selected' : ''}`} aria-pressed={filter === item.key} onClick={() => setFilter(item.key)}>{item.label}<span>{unavailable ? '—' : item.count}</span></button>)}
            </div>

            <div className="task-list-area">
              {loading ? (
                <div className="empty-state" role="status"><LoaderCircle className="spin loading-icon" size={28} /><h3>Getting your list ready…</h3><p>A moment to gather your thoughts.</p></div>
              ) : loadFailed ? (
                <div className="empty-state"><span className="empty-illustration"><CloudCheck size={36} strokeWidth={1.5} /></span><h3>Let’s reconnect to your list.</h3><p>Your tasks will appear when we’re connected.</p></div>
              ) : visible.length ? (
                <ul className="task-list" aria-label="Tasks">{visible.map((todo) => <TodoItem key={todo.id} todo={todo} busy={busy !== null} working={busy === todo.id} onToggle={(item) => { void updateTask(item, { completed: !item.completed }); }} onDelete={removeTask} onEdit={(item, nextTitle) => updateTask(item, { title: nextTitle })} onAttach={attachFile} onRemoveAttachment={removeAttachment} onDownload={downloadAttachment} />)}</ul>
              ) : (
                <div className="empty-state">
                  <span className="empty-illustration"><span className="illustration-spark"><Sparkles size={15} /></span>{filter === 'active' && todos.length ? <CheckCheck size={38} strokeWidth={1.5} /> : <Leaf size={38} strokeWidth={1.5} />}</span>
                  <h3>{filter === 'all' ? 'A fresh start.' : filter === 'active' ? 'All caught up.' : 'Your wins will live here.'}</h3>
                  <p>{filter === 'all' ? 'Add your first task and give it a little focus.' : filter === 'active' ? 'Take a breath. You’ve earned a little break.' : 'Check off a task to celebrate a little progress.'}</p>
                  {filter === 'all' && <button type="button" className="text-button" onClick={() => inputRef.current?.focus()}>Let’s get started <ArrowRight size={15} /></button>}
                </div>
              )}
            </div>

            <div className="list-footer"><span>{unavailable ? 'Your list, one step at a time' : `${remaining} ${remaining === 1 ? 'task' : 'tasks'} left to do`}</span>{completed > 0 && !unavailable && <button type="button" onClick={clearCompleted} disabled={disabled}>{busy === 'clear' ? <LoaderCircle size={13} className="spin" /> : <Trash2 size={13} />}Clear completed</button>}</div>
          </section>

          <aside className="sidebar" aria-label="Your progress">
            <section className="progress-card" aria-labelledby="progress-heading">
              <div className="sidebar-heading"><h2 id="progress-heading">The little wins</h2><Sparkles size={18} aria-hidden="true" /></div>
              <p>Every checkmark counts.</p>
              <div className="progress-ring" style={{ '--progress': `${progress}%` } as CSSProperties} role="progressbar" aria-label="Tasks completed" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}>
                <div className="progress-ring-center"><span>{unavailable ? '—' : `${progress}%`}</span><span>complete</span></div>
              </div>
              <div className="progress-stats"><div><strong>{unavailable ? '—' : completed}</strong><span><span className="stat-dot done-dot" />Done</span></div><span className="stats-divider" /><div><strong>{unavailable ? '—' : remaining}</strong><span><span className="stat-dot" />To go</span></div></div>
              <div className="progress-message"><CircleCheck size={16} /><span>{completed > 0 && !remaining ? 'Look at you. All done!' : completed > 0 ? 'You’re making things happen.' : 'Small steps. Real progress.'}</span></div>
            </section>

            <section className="note-card"><span className="note-icon"><Leaf size={20} /></span><h3>One thing at a time.</h3><p>You don’t have to do it all today. Just start with what matters most.</p><span className="note-signature">You’ve got this.</span><span className="note-decoration" aria-hidden="true" /></section>
          </aside>
        </div>

        <div className="save-status" role="status"><CloudCheck size={15} /><span>{loading ? 'Connecting to your list…' : loadFailed ? 'Waiting to reconnect' : busy?.startsWith('download:') ? 'Preparing your download…' : busy ? 'Saving your change…' : error ? 'Please check the message above' : 'All changes saved'}</span></div>
        <span className="sr-only" aria-live="polite">{notice}</span>
      </main>

      <footer className="site-footer"><span>A little progress, every day.</span><span>Made for a calmer mind <Leaf size={12} /></span></footer>
    </div>
  );
}
