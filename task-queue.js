// Task Queue — main-process module shared by renderer (IPC) and remote API
// Manages per-project task queuing with bracketed paste dispatch

const PASTE_START = '\x1b[200~';
const PASTE_END   = '\x1b[201~';

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

        // Find next pending task whose project is NOT busy
        const next = this._tasks.find(t => t.status === 'pending' && !busyProjects.has(t.projectId));
        if (!next) {
            // Clean up retry timers if no pending work
            const hasPending = this._tasks.some(t => t.status === 'pending');
            if (!hasPending) {
                for (const [pid, timer] of this._retryTimers) {
                    clearTimeout(timer);
                }
                this._retryTimers.clear();
            }
            this._notify();
            return;
        }

        const targetProjectId = next.projectId;
        const entry = this._ptyPool.get(targetProjectId);

        if (!entry || !entry.alive || !entry.process || !entry.claudeReady) {
            // Terminal not ready (or Claude CLI not started yet) — retry every 2s
            if (!this._retryTimers.has(targetProjectId)) {
                const timer = setTimeout(() => {
                    this._retryTimers.delete(targetProjectId);
                    this.process();
                }, 2000);
                this._retryTimers.set(targetProjectId, timer);
            }
            this._notify();
            return;
        }

        // Clear retry timer for this project
        if (this._retryTimers.has(targetProjectId)) {
            clearTimeout(this._retryTimers.get(targetProjectId));
            this._retryTimers.delete(targetProjectId);
        }

        // Mark as running and send via bracketed paste
        next.status = 'running';
        this._writeToPty(targetProjectId, next.text);
        this._notify();

        // Try to dispatch tasks for other idle projects too
        setTimeout(() => this.process(), 600);
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
        console.log(`[TaskQueue] Restored ${savedTasks.length} task(s) from previous session`);
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
            console.error('[TaskQueue] onUpdate error:', e.message);
        }
    }
}

module.exports = TaskQueue;
