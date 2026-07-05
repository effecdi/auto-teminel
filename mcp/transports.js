// mcp/transports.js
// Stage 4 — builds an MCP client transport from a server config.
//
// Config shapes:
//   { type: 'stdio', command, args?, env? }            local process (stdio)
//   { type: 'sse',   url }                              remote Server-Sent Events
//   { type: 'http',  url }                              remote Streamable HTTP

const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { SSEClientTransport } = require('@modelcontextprotocol/sdk/client/sse.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');

function createTransport(cfg) {
    if (!cfg || !cfg.type) throw new Error('MCP 서버 설정에 type이 필요함 (stdio|sse|http)');
    if (cfg.type === 'stdio') {
        if (!cfg.command) throw new Error('stdio MCP 서버에 command가 필요함');
        return new StdioClientTransport({
            command: cfg.command,
            args: Array.isArray(cfg.args) ? cfg.args : [],
            env: cfg.env && typeof cfg.env === 'object' ? { ...process.env, ...cfg.env } : { ...process.env },
        });
    }
    if (cfg.type === 'sse') {
        if (!cfg.url) throw new Error('sse MCP 서버에 url이 필요함');
        return new SSEClientTransport(new URL(cfg.url));
    }
    if (cfg.type === 'http') {
        if (!cfg.url) throw new Error('http MCP 서버에 url이 필요함');
        return new StreamableHTTPClientTransport(new URL(cfg.url));
    }
    throw new Error(`알 수 없는 MCP 트랜스포트 type: ${cfg.type}`);
}

module.exports = { createTransport };
