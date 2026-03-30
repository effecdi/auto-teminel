// Task Queue — main-process module shared by renderer (IPC) and remote API
// Manages per-project task queuing with bracketed paste dispatch

const PASTE_START = '\x1b[200~';
const PASTE_END   = '\x1b[201~';

function safelog(...args) { try { console.log(...args); } catch (_) {} }
function safeerr(...args) { try { console.error(...args); } catch (_) {} }

class TaskQueue {
    /**
     * @param {Object} opts
     * @param {Function} opts.writeToPty - (projectId, text) => void  — sends text via bracketed paste
     * @param {Map}      opts.ptyPool    - projectId → { process, alive, ... }
     * @param {Function} opts.onUpdate   - (state) => void — called on every state change
     */
    constructor({ writeToPty, ptyPool, onUpdate }) {
        this._writeToPty = writeToPty;
        this._ptyPool = ptyPool;
        this._onUpdate = onUpdate || (() => {});
        this._tasks = [];
        this._idCounter = 1;
        this._paused = false;
        this._retryTimers = new Map(); // projectId → timer
    }

    /** Add a task and start processing. Returns the created task. */
    enqueue(projectId, projectName, text) {
        // 빈 텍스트 전송 방지 — 빈 프롬프트가 PTY로 전달되면 CLI가 종료될 수 있음
        if (!text || !text.trim()) {
            safelog(`[TaskQueue] REJECTED empty text for project ${projectName}`);
            return null;
        }

        // 같은 프로젝트에서 60초 이상 running 상태인 태스크를 done으로 강제 전환 (stuck 방지)
        const now = Date.now();
        for (const t of this._tasks) {
            if (t.status === 'running' && t.projectId === projectId && now - (t._dispatchedAt || t.timestamp) > 60000) {
                safelog(`[TaskQueue] Force-completing stuck task ${t.id} (running for ${Math.round((now - (t._dispatchedAt || t.timestamp))/1000)}s)`);
                t.status = 'done';
            }
        }

        const task = {
            id: this._idCounter++,
            text,
            status: 'pending',
            timestamp: Date.now(),
            project: projectName,
            projectId
        };
        this._tasks.push(task);
        this._notify();
        this.process();
        return task;
    }

    /** Mark running task(s) for a project as done, then advance queue. Returns true if a task was completed. */
    markIdle(projectId) {
        let completed = false;
        for (const task of this._tasks) {
            if (task.status === 'running' && task.projectId === projectId) {
                task.status = 'done';
                completed = true;
            }
        }
        if (completed) {
            this._notify();
            // Advance queue after short delay for stability
            setTimeout(() => this.process(), 500);
        }
        return completed;
    }

    /** Dispatch next pending task per-project (supports parallel across projects). */
    process() {
        if (this._paused) return;

        // Collect which projects already have a running task
        const busyProjects = new Set();
        for (const t of this._tasks) {
            if (t.status === 'running') busyProjects.add(t.projectId);
        }

        // PTY가 준비 안 된 프로젝트를 건너뛰면서 디스패치 가능한 태스크를 찾음
        const skippedProjects = new Set();
        let dispatched = false;

        for (const task of this._tasks) {
            if (task.status !== 'pending') continue;
            if (busyProjects.has(task.projectId)) continue;
            if (skippedProjects.has(task.projectId)) continue;

            const entry = this._ptyPool.get(task.projectId);
            if (!entry || !entry.alive || !entry.process || !entry.claudeReady) {
                // PTY 준비 안 됨 → 이 프로젝트의 태스크는 건너뛰고 다음 프로젝트 시도
                safelog(`[TaskQueue] BLOCKED task ${task.id}: entry=${!!entry} alive=${entry?.alive} process=${!!entry?.process} claudeReady=${entry?.claudeReady}`);
                skippedProjects.add(task.projectId);
                // 재시도 타이머 설정
                if (!this._retryTimers.has(task.projectId)) {
                    const pid = task.projectId;
                    const timer = setTimeout(() => {
                        this._retryTimers.delete(pid);
                        this.process();
                    }, 500);
                    this._retryTimers.set(pid, timer);
                }
                continue;
            }

            // Clear retry timer
            if (this._retryTimers.has(task.projectId)) {
                clearTimeout(this._retryTimers.get(task.projectId));
                this._retryTimers.delete(task.projectId);
            }

            // 디스패치
            safelog('[TaskQueue] DISPATCHING task', task.id, 'project:', task.project, 'text:', task.text.substring(0, 80));
            task.status = 'running';
            task._dispatchedAt = Date.now();
            busyProjects.add(task.projectId);

            // Mark claudeReady=false BEFORE writing to prevent duplicate dispatch
            entry.claudeReady = false;
            // Set dispatch timestamp to prevent premature idle detection
            entry._lastDispatchTime = Date.now();

            this._writeToPty(task.projectId, task.text);
            dispatched = true;
        }

        this._notify();

        // Clean up retry timers if no pending work left
        const hasPending = this._tasks.some(t => t.status === 'pending');
        if (!hasPending) {
            for (const [pid, timer] of this._retryTimers) {
                clearTimeout(timer);
            }
            this._retryTimers.clear();
        }
    }

    /** Interrupt running task(s) for a project. Returns the interrupted task text (for re-queue). */
    interrupt(projectId) {
        let interruptedText = null;
        for (const task of this._tasks) {
            if (task.status === 'running' && task.projectId === projectId) {
                interruptedText = task.text;
                task.status = 'done';
                task._interrupted = true;
                safelog(`[TaskQueue] Interrupted task ${task.id} for project ${task.project}`);
            }
        }
        this._notify();
        return interruptedText;
    }

    /** Remove a pending task. Returns true if removed. */
    remove(taskId) {
        const idx = this._tasks.findIndex(t => t.id === taskId);
        if (idx === -1) return false;
        if (this._tasks[idx].status !== 'pending') return false;
        this._tasks.splice(idx, 1);
        this._notify();
        return true;
    }

    /** Pause the queue (running tasks continue, no new dispatches). */
    pause() {
        this._paused = true;
        this._notify();
    }

    /** Resume the queue and advance. */
    resume() {
        this._paused = false;
        // Mark any running tasks as done if their project is idle
        // (they may have finished while paused)
        this._notify();
        this.process();
    }

    /** Clear completed tasks. */
    clearDone() {
        this._tasks = this._tasks.filter(t => t.status !== 'done');
        this._notify();
    }

    /** Clear all pending tasks (keep running). */
    clearAll() {
        const running = this._tasks.filter(t => t.status === 'running');
        this._tasks = running;
        this._notify();
    }

    /** Get serializable state. */
    getState() {
        return {
            tasks: this._tasks.map(t => ({ ...t })),
            paused: this._paused,
            running: this._tasks.some(t => t.status === 'running')
        };
    }

    /** Get pending and running tasks for persistence (running → pending on restore). */
    getPendingTasks() {
        return this._tasks
            .filter(t => t.status === 'pending' || t.status === 'running')
            .map(t => ({
                text: t.text,
                project: t.project,
                projectId: t.projectId,
                timestamp: t.timestamp
            }));
    }

    /** Restore tasks from saved state (all restored as pending). */
    restore(savedTasks) {
        if (!Array.isArray(savedTasks) || savedTasks.length === 0) return;
        for (const t of savedTasks) {
            this._tasks.push({
                id: this._idCounter++,
                text: t.text,
                status: 'pending',
                timestamp: t.timestamp || Date.now(),
                project: t.project,
                projectId: t.projectId
            });
        }
        this._notify();
        safelog(`[TaskQueue] Restored ${savedTasks.length} task(s) from previous session`);
    }

    /** Check if a project has pending/running work. */
    hasWork(projectId) {
        return this._tasks.some(t =>
            (t.status === 'pending' || t.status === 'running') && t.projectId === projectId
        );
    }

    /** Internal: notify listeners of state change. */
    _notify() {
        try {
            this._onUpdate(this.getState());
        } catch (e) {
            safeerr('[TaskQueue] onUpdate error:', e.message);
        }
    }
}

module.exports = TaskQueue;
