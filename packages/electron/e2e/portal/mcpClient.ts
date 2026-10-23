/**
 * Minimal MCP (streamable HTTP) client for the Portal fixture: one connection
 * per agent actor, identified the way the host builds every transport URL
 * (`?sessionId=<ai session id>`), with the per-launch bearer token. Raw HTTP on
 * purpose: this is exactly what a provider process sends.
 */
export interface McpToolCallResult {
  text: string;
  isError: boolean;
  raw: unknown;
}

export class McpConnection {
  private mcpSessionId: string | undefined;
  private nextId = 1;

  constructor(
    private readonly port: number,
    private readonly token: string,
    private readonly endpointPath: string,
    private readonly sessionId: string | undefined,
    private readonly workspacePath: string | undefined,
  ) {}

  private url(): string {
    const query = new URLSearchParams();
    if (this.sessionId !== undefined) query.set('sessionId', this.sessionId);
    if (this.workspacePath !== undefined) query.set('workspacePath', this.workspacePath);
    const q = query.toString();
    return `http://127.0.0.1:${this.port}${this.endpointPath}${q ? `?${q}` : ''}`;
  }

  private async post(body: unknown, withSession: boolean): Promise<{ status: number; json: any; headers: Headers }> {
    const response = await fetch(this.url(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${this.token}`,
        ...(withSession && this.mcpSessionId ? { 'mcp-session-id': this.mcpSessionId } : {}),
      },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    let json: any = null;
    const dataLine = text.split(/\r?\n/).find((l) => l.startsWith('data:'));
    try {
      json = JSON.parse(dataLine ? dataLine.slice(5).trim() : text);
    } catch {
      json = text ? { rawText: text } : null;
    }
    return { status: response.status, json, headers: response.headers };
  }

  async initialize(): Promise<void> {
    const init = await this.post(
      {
        jsonrpc: '2.0',
        id: this.nextId++,
        method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'portal-fixture', version: '1' } },
      },
      false,
    );
    if (init.status !== 200) throw new Error(`MCP initialize failed: HTTP ${init.status} ${JSON.stringify(init.json)}`);
    this.mcpSessionId = init.headers.get('mcp-session-id') ?? undefined;
    await this.post({ jsonrpc: '2.0', method: 'notifications/initialized' }, true);
  }

  async listTools(): Promise<string[]> {
    const res = await this.post({ jsonrpc: '2.0', id: this.nextId++, method: 'tools/list', params: {} }, true);
    return (res.json?.result?.tools ?? []).map((t: { name: string }) => t.name);
  }

  async call(name: string, args: Record<string, unknown> = {}): Promise<McpToolCallResult> {
    const res = await this.post(
      { jsonrpc: '2.0', id: this.nextId++, method: 'tools/call', params: { name, arguments: args } },
      true,
    );
    if (res.json?.error) {
      return { text: `JSON-RPC error: ${res.json.error.message ?? JSON.stringify(res.json.error)}`, isError: true, raw: res.json };
    }
    const content: Array<{ type: string; text?: string }> = res.json?.result?.content ?? [];
    return {
      text: content.map((c) => c.text ?? '').join('\n'),
      isError: res.json?.result?.isError === true,
      raw: res.json,
    };
  }

  /** The parsed JSON a portal tool returns on success. */
  async callJson<T = any>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    const result = await this.call(name, args);
    if (result.isError) throw new Error(`${name} failed: ${result.text}`);
    return JSON.parse(result.text) as T;
  }
}
