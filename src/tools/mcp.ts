import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CreateMcpServerSchema, CreateMcpToolSchema, ListMcpToolsSchema } from "../schemas/index.js";
import { createMcpServer, createMcpTool, listMcpTools } from "../services/mcpgen.js";
import { resultContent } from "./utils.js";

export function registerMcpTools(server: McpServer): void {

  server.registerTool(
    "sf_create_mcp_server",
    {
      title: "Create Salesforce MCP Server",
      description: `Generates a complete, working MCP server project structure on disk targeting a Salesforce org. Creates package.json, tsconfig.json, src/index.ts entry point, .env.example, and README.md. The generated server uses the MCP SDK and includes a sample 'hello_world' tool. Provide an outputDirectory (absolute path) where the files will be written. After generation, run 'npm install' then 'npm run build' in that directory.`,
      inputSchema: CreateMcpServerSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (params) => {
      const result = await createMcpServer({
        serverName: params.serverName,
        outputDirectory: params.outputDirectory,
        description: params.description,
        salesforceInstanceUrl: params.salesforceInstanceUrl,
      });
      return resultContent(result);
    }
  );

  server.registerTool(
    "sf_create_mcp_tool",
    {
      title: "Add Tool to MCP Server",
      description: `Adds a new tool definition to an existing MCP server project by reading the src/index.ts file and appending the tool registration. Provide the tool name, description, input schema as a JSON object (field names to {type, description}), and handler code. The tool code is inserted before the 'Start server' section. Run 'npm run build' after adding tools.`,
      inputSchema: CreateMcpToolSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (params) => {
      const result = await createMcpTool({
        projectDirectory: params.projectDirectory,
        toolName: params.toolName,
        toolDescription: params.toolDescription,
        inputSchema: params.inputSchema,
        handlerCode: params.handlerCode,
      });
      return resultContent(result);
    }
  );

  server.registerTool(
    "sf_list_mcp_tools",
    {
      title: "List MCP Server Tools",
      description: `Lists all tools currently registered in a given MCP server project by reading and parsing its src/index.ts file. Returns the tool names in the order they are registered. Use to audit what tools exist before adding new ones.`,
      inputSchema: ListMcpToolsSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (params) => {
      const result = await listMcpTools(params.projectDirectory);
      return resultContent(result);
    }
  );
}
