// mcp/mcp-manager.js
// Stage 4 target — MCP (Model Context Protocol) client lifecycle manager.
//
// Stage 0 placeholder: establishes the /mcp folder in the tree. Real logic
// (one @modelcontextprotocol/sdk client per server, stdio + SSE transports,
// capability handshake, tool registration into agent/tools/tool-registry.js,
// and CLI --mcp-config serialization) lands in Stage 4.

const MCP_STAGE = 0; // bumped to 4 when implemented

/** @returns {{ready: boolean, servers: string[]}} */
function status() {
    return { ready: false, servers: [] };
}

module.exports = { MCP_STAGE, status };
