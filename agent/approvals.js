// agent/approvals.js
// Stage 3 — human-in-the-loop approval broker.
//
// When the orchestrator is about to run a tool that requiresApproval, it calls
// broker.request(...). That emits an 'approvalRequest' to the renderer and
// returns a promise that resolves once the user approves/rejects (via IPC ->
// broker.resolve). Supports an auto-approve mode per broker (off by default).

class ApprovalBroker {
    /** @param {(event:string, payload:object)=>void} emit sends events to the renderer */
    constructor(emit) {
        this.emit = typeof emit === 'function' ? emit : () => {};
        this.pending = new Map(); // id -> { resolve }
        this.seq = 0;
        this.autoApprove = false;
    }

    setAutoApprove(on) { this.autoApprove = !!on; }

    /**
     * Ask the user to approve a tool call.
     * @returns {Promise<{approved:boolean, reason?:string}>}
     */
    request({ runId, toolName, input }) {
        if (this.autoApprove) {
            this.emit('approvalAuto', { runId, toolName });
            return Promise.resolve({ approved: true, auto: true });
        }
        const id = `apr_${++this.seq}`;
        return new Promise((resolve) => {
            this.pending.set(id, resolve);
            this.emit('approvalRequest', { id, runId, toolName, input });
        });
    }

    /** Called from IPC when the user responds. */
    resolve(id, approved, reason) {
        const r = this.pending.get(id);
        if (!r) return false;
        this.pending.delete(id);
        r({ approved: !!approved, reason: reason || '' });
        return true;
    }

    /** Reject everything still pending (e.g. run aborted). */
    rejectAllPending(reason = 'aborted') {
        for (const [id, r] of this.pending) r({ approved: false, reason });
        this.pending.clear();
    }
}

module.exports = { ApprovalBroker };
