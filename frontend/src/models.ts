export interface User { id: number; name: string }
export interface Project { id: number; name: string; description: string; archived: boolean; owner_id: number; task_count: number; members: User[] }
export type TaskStatus = 'open' | 'in_progress' | 'blocked' | 'done';
export interface Task { id: number; project_id: number; title: string; description: string; status: TaskStatus; assignee_id: number | null; due_at: string | null; updated_at: string; version: number }
export interface Comment { id: number; task_id: number; user_id: number; body: string; created_at: string; author: string }
export interface TaskDetail extends Task { comments: Comment[] }
export interface Context { user: User; users: User[]; server_now: string; seeded_at: string }
export type AttentionCode = 'overdue' | 'blocked' | 'waiting_manager' | 'due_soon' | 'unassigned' | 'stale';
export interface AttentionReason { code: AttentionCode; label: string; severity: 'critical' | 'warning' | 'info'; comment_id?: number }
export interface AttentionItem {
  task: Task; project_name: string; assignee_name: string | null; reasons: AttentionReason[]; score: number; critical: boolean;
  comment_count: number; quote: { author: string; body: string; created_at: string; is_request: boolean } | null; activity_at: string; acknowledged: boolean;
}
export interface AttentionProject { id: number; name: string; items: number; critical: number }
export interface AttentionDigest {
  generated_at: string; rules: { due_soon_hours: number; stale_days: number };
  projects: AttentionProject[]; items: AttentionItem[]; hidden_count: number;
}
