// ui-next/agent-panel.js
// Stage 3+ target — new agent UI (renderer side).
//
// Stage 0 placeholder: establishes the /ui-next folder. This script is NOT yet
// referenced from index.html. When wired (Stage 3), it renders the auditable
// agent run view: plan cards, tool-call timeline, inline diffs, and
// human-in-the-loop approval buttons, talking to main only via agentv2.* IPC.
//
// It stays fully behind the `agentV2Enabled` setting (default false), so the
// classic AI chat tab remains the default experience until later stages.

(function () {
    const AGENT_PANEL_STAGE = 0; // bumped to 3 when wired into index.html
    if (typeof window !== 'undefined') {
        window.__agentPanelStage = AGENT_PANEL_STAGE;
    }
})();
