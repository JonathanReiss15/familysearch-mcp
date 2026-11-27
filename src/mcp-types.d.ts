declare module '@modelcontextprotocol/sdk/server/mcp.js' {
  export class McpServer {
    constructor(options: { name: string; version: string });

    tool<T extends Record<string, unknown>>(
      name: string,
      description: string,
      parameters: Record<string, unknown>,
      handler: (params: T) => Promise<{
        content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>;
      }>,
    ): void;

    connect(transport: unknown): Promise<void>;
  }
}

declare module '@modelcontextprotocol/sdk/server/stdio.js' {
  export class StdioServerTransport {
    constructor();
  }
}
