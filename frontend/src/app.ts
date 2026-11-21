import { Component, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Api } from './api';
import { AttentionDigest, AttentionItem, Comment, Context, Project, Task, TaskDetail, TaskStatus } from './models';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './app.html',
})
export class AppComponent {
  api = inject(Api);
  context = signal<Context | null>(null);
  projects = signal<Project[]>([]);
  project = signal<Project | null>(null);
  tasks = signal<Task[]>([]);
  detail = signal<TaskDetail | null>(null);
  loading = signal(false);
  saving = signal(false);
  error = signal('');
  notice = signal('');
  status = '';
  search = '';
  comment = '';
  creating = signal(false);
  draft = this.emptyDraft();
  view = signal<'attention' | 'project'>('project');
  attention = signal<AttentionDigest | null>(null);
  attentionFilter = signal<number | null>(null);
  showHidden = signal(false);
  flaggedComment = signal<number | null>(null);
  /** The project of the open card: from the digest it may differ from the selected project. */
  detailProject = computed(() => {
    const id = this.detail()?.project_id ?? this.project()?.id;
    return this.projects().find(p => p.id === id) ?? null;
  });
  attentionItems = computed(() => {
    const filter = this.attentionFilter();
    return (this.attention()?.items ?? []).filter(item => filter === null || item.task.project_id === filter);
  });
  attentionCount = computed(() => (this.attention()?.items ?? []).filter(item => !item.acknowledged).length);
  private generation = 0;
  private detailGeneration = 0;
  private attentionGeneration = 0;
  readonly statuses: { value: TaskStatus; label: string }[] = [
    { value: 'open', label: 'Открыта' }, { value: 'in_progress', label: 'В работе' },
    { value: 'blocked', label: 'Заблокирована' }, { value: 'done', label: 'Готово' },
  ];

  constructor() { void this.load(); }

  async load(): Promise<void> {
    const generation = ++this.generation;
    this.loading.set(true);
    this.error.set('');
    this.closeDetail();
    try {
      const [context, projects, attention] = await Promise.all([
        this.api.request<Context>('/context'), this.api.request<Project[]>('/projects'), this.fetchAttention(),
      ]);
      if (generation !== this.generation) return;
      this.context.set(context);
      this.projects.set(projects);
      this.attention.set(attention);
      // A manager starts the day from the digest; other members start from their project.
      if (attention.projects.length && (this.view() === 'attention' || !this.project())) {
        this.openAttention();
        return;
      }
      const project = projects.find(p => p.id === this.project()?.id) ?? projects[0];
      if (project) await this.selectProject(project);
    } catch (error) {
      if (generation === this.generation) this.fail(error);
    } finally {
      if (generation === this.generation) this.loading.set(false);
    }
  }

  switchUser(value: string): void {
    this.api.userId = Number(value);
    this.project.set(null);
    this.projects.set([]);
    this.tasks.set([]);
    this.context.set(null);
    this.attention.set(null);
    this.attentionFilter.set(null);
    this.showHidden.set(false);
    this.view.set('project');
    this.notice.set('');
    void this.load();
  }

  async selectProject(project: Project): Promise<void> {
    const generation = ++this.generation;
    this.loading.set(true);
    this.error.set('');
    this.notice.set('');
    this.view.set('project');
    this.project.set(project);
    this.tasks.set([]);
    this.status = '';
    this.search = '';
    this.closeDetail();
    try {
      const tasks = await this.api.request<Task[]>(`/projects/${project.id}/tasks`);
      if (generation === this.generation) this.tasks.set(tasks);
    } catch (error) {
      if (generation === this.generation) this.fail(error);
    } finally {
      if (generation === this.generation) this.loading.set(false);
    }
  }

  filteredTasks(): Task[] {
    return this.tasks().filter(task => (!this.status || task.status === this.status)
      && task.title.toLocaleLowerCase('ru').includes(this.search.toLocaleLowerCase('ru')));
  }

  openAttention(): void {
    ++this.generation;
    this.loading.set(false);
    this.closeDetail();
    this.notice.set('');
    this.view.set('attention');
    void this.refreshAttention();
  }

  async refreshAttention(): Promise<void> {
    const generation = ++this.attentionGeneration;
    const userId = this.api.userId;
    try {
      const digest = await this.fetchAttention();
      if (generation === this.attentionGeneration && userId === this.api.userId) this.attention.set(digest);
    } catch (error) {
      if (generation === this.attentionGeneration && this.view() === 'attention') this.fail(error);
    }
  }

  toggleHidden(): void {
    this.showHidden.update(value => !value);
    void this.refreshAttention();
  }

  async acknowledge(item: AttentionItem): Promise<void> {
    if (this.saving()) return;
    this.saving.set(true);
    this.error.set('');
    try {
      await this.api.request(`/attention/${item.task.id}/ack`, item.acknowledged ? 'DELETE' : 'POST');
      this.notice.set(item.acknowledged ? `Задача #${item.task.id} снова в списке` : `Задача #${item.task.id} разобрана: вернётся при новых изменениях`);
      if (this.detail()?.id === item.task.id && !item.acknowledged) this.closeDetail();
      await this.refreshAttention();
    } catch (error) { this.fail(error); }
    finally { this.saving.set(false); }
  }

  async openFromAttention(item: AttentionItem, reply = false): Promise<void> {
    await this.openTask(item.task);
    if (this.detail()?.id !== item.task.id) return;
    this.flaggedComment.set(item.reasons.find(r => r.comment_id)?.comment_id ?? null);
    setTimeout(() => {
      // On narrow screens the card is rendered below the list.
      if (window.matchMedia('(max-width: 850px)').matches) document.querySelector('.detail')?.scrollIntoView({ block: 'start' });
      if (reply) document.getElementById('comment-input')?.focus();
    });
  }

  reasonClass(item: AttentionItem): string {
    return item.critical ? 'critical' : item.reasons.some(r => r.severity === 'warning') ? 'warning' : 'info';
  }

  async openTask(task: Task): Promise<void> {
    const generation = ++this.detailGeneration;
    this.error.set('');
    this.creating.set(false);
    this.detail.set(null);
    this.flaggedComment.set(null);
    try {
      const detail = await this.api.request<TaskDetail>(`/tasks/${task.id}`);
      if (generation !== this.detailGeneration) return;
      this.detail.set(detail);
      this.comment = '';
      this.draft = {
        title: detail.title, description: detail.description, status: detail.status,
        assignee_id: detail.assignee_id,
        due_at: detail.due_at ? detail.due_at.slice(0, 16) : '',
      };
    } catch (error) {
      if (generation === this.detailGeneration) this.fail(error);
    }
  }

  closeDetail(): void {
    ++this.detailGeneration;
    this.detail.set(null);
    this.creating.set(false);
    this.comment = '';
  }

  createTask(): void {
    this.closeDetail();
    this.draft = this.emptyDraft();
    this.creating.set(true);
  }

  async saveTask(): Promise<void> {
    const existing = this.detail();
    const project = existing ? this.detailProject() : this.project();
    if (!project || this.saving()) return;
    const userId = this.api.userId;
    const generation = this.detailGeneration;
    this.saving.set(true);
    this.error.set('');
    try {
      const data = {
        ...this.draft,
        due_at: this.draft.due_at ? `${this.draft.due_at}:00Z` : null,
        ...(existing ? { version: existing.version } : {}),
      };
      const task = await this.api.request<Task>(existing ? `/tasks/${existing.id}` : `/projects/${project.id}/tasks`, existing ? 'PATCH' : 'POST', data);
      if (userId !== this.api.userId) return;
      if (!existing) this.projects.update(list => list.map(p => p.id === project.id ? { ...p, task_count: p.task_count + 1 } : p));
      if (this.project()?.id === project.id) this.tasks.update(list => existing ? list.map(t => t.id === task.id ? task : t) : [...list, task]);
      void this.refreshAttention();
      if (generation === this.detailGeneration) {
        // Saving fields must not erase a comment the user has not sent yet.
        this.detail.set({ ...task, comments: existing?.comments ?? [] });
        this.creating.set(false);
        this.draft = {
          title: task.title, description: task.description, status: task.status,
          assignee_id: task.assignee_id, due_at: task.due_at?.slice(0, 16) ?? '',
        };
        this.notice.set('Задача сохранена');
      }
    } catch (error) { if (generation === this.detailGeneration) this.fail(error); }
    finally { this.saving.set(false); }
  }

  async addComment(): Promise<void> {
    const task = this.detail();
    if (!task || this.saving()) return;
    const generation = this.detailGeneration;
    this.saving.set(true);
    this.error.set('');
    try {
      const comment = await this.api.request<Comment>(`/tasks/${task.id}/comments`, 'POST', { body: this.comment });
      if (generation !== this.detailGeneration) return;
      // Refresh only the discussion: fields may contain unsaved user edits.
      this.detail.update(current => current ? { ...current, comments: [...current.comments, comment] } : current);
      this.comment = '';
      this.notice.set('Комментарий добавлен');
      void this.refreshAttention();
    } catch (error) { if (generation === this.detailGeneration) this.fail(error); }
    finally { this.saving.set(false); }
  }

  statusLabel(status: string): string { return this.statuses.find(s => s.value === status)?.label ?? status; }
  userName(id: number | null): string { return this.context()?.users.find(u => u.id === id)?.name ?? 'Не назначен'; }
  private fetchAttention(): Promise<AttentionDigest> {
    return this.api.request<AttentionDigest>(`/attention${this.showHidden() ? '?include_hidden=1' : ''}`);
  }
  private fail(error: unknown): void { this.error.set(error instanceof Error ? error.message : 'Не удалось выполнить запрос'); }
  private emptyDraft(): { title: string; description: string; status: TaskStatus; assignee_id: number | null; due_at: string } {
    return { title: '', description: '', status: 'open', assignee_id: null, due_at: '' };
  }
}
