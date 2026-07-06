import { promises as fs } from "fs";
import path from "path";
import type { ToolResult } from "../types.js";

// ─── MCP Server Generation ────────────────────────────────────────────────────

export async function createMcpServer(params: {
  serverName: string;
  outputDirectory: string;
  description?: string;
  salesforceInstanceUrl?: string;
}): Promise<ToolResult> {
  try {
    const dir = params.outputDirectory;
    await fs.mkdir(dir, { recursive: true });
    await fs.mkdir(path.join(dir, "src"), { recursive: true });

    const packageJson = {
      name: params.serverName,
      version: "1.0.0",
      description: params.description ?? `MCP server for ${params.serverName}`,
      type: "module",
      main: "dist/index.js",
      scripts: {
        build: "tsc",
        start: "node dist/index.js",
        dev: "tsc --watch"
      },
      dependencies: {
        "@modelcontextprotocol/sdk": "1.29.0",
        "zod": "3.25.76"
      },
      devDependencies: {
        "@types/node": "22.19.19",
        "typescript": "5.9.3"
      }
    };

    const tsconfig = {
      compilerOptions: {
        target: "ES2022",
        module: "Node16",
        moduleResolution: "Node16",
        outDir: "./dist",
        rootDir: "./src",
        strict: true,
        esModuleInterop: true,
        skipLibCheck: true,
        forceConsistentCasingInFileNames: true,
        declaration: true,
        sourceMap: true
      },
      include: ["src/**/*"],
      exclude: ["node_modules", "dist"]
    };

    const indexTs = `import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({
  name: "${params.serverName}",
  version: "1.0.0",
});

// ─── Tools ────────────────────────────────────────────────────────────────────

server.registerTool(
  "hello_world",
  {
    title: "Hello World",
    description: "A sample tool that returns a greeting",
    inputSchema: z.object({
      name: z.string().optional().describe("Name to greet"),
    }),
  },
  async (params) => {
    const greeting = \`Hello, \${params.name ?? "World"}!\`;
    return { content: [{ type: "text", text: greeting }] };
  }
);

// ─── Start server ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("${params.serverName} MCP server running on stdio");
}

main().catch((err: unknown) => {
  console.error("Server error:", err);
  process.exit(1);
});
`;

    const envExample = `# Salesforce credentials
SF_INSTANCE_URL=${params.salesforceInstanceUrl ?? "https://your-org.salesforce.com"}
SF_ACCESS_TOKEN=your_access_token
# Or use OAuth refresh:
# SF_CLIENT_ID=your_client_id
# SF_CLIENT_SECRET=your_client_secret
# SF_REFRESH_TOKEN=your_refresh_token
`;

    const readme = `# ${params.serverName}

${params.description ?? "A Salesforce MCP Server"}

## Setup

\`\`\`bash
npm install
npm run build
\`\`\`

## Configuration

Copy \`.env.example\` to \`.env\` and fill in your credentials.

## Running

\`\`\`bash
npm start
\`\`\`

## Adding to Claude

\`\`\`json
{
  "mcpServers": {
    "${params.serverName}": {
      "command": "node",
      "args": ["${path.join(dir, "dist/index.js").replace(/\\/g, "/")}"],
      "env": {
        "SF_INSTANCE_URL": "https://your-org.salesforce.com",
        "SF_ACCESS_TOKEN": "your_token"
      }
    }
  }
}
\`\`\`
`;

    await fs.writeFile(path.join(dir, "package.json"), JSON.stringify(packageJson, null, 2));
    await fs.writeFile(path.join(dir, "tsconfig.json"), JSON.stringify(tsconfig, null, 2));
    await fs.writeFile(path.join(dir, "src/index.ts"), indexTs);
    await fs.writeFile(path.join(dir, ".env.example"), envExample);
    await fs.writeFile(path.join(dir, "README.md"), readme);

    return {
      success: true,
      fullName: params.serverName,
      created: true,
      message: `MCP server project created at: ${dir}\n\nFiles created:\n- package.json\n- tsconfig.json\n- src/index.ts\n- .env.example\n- README.md\n\nNext steps:\n1. cd "${dir}"\n2. npm install\n3. npm run build\n4. Add to Claude config`
    };
  } catch (err: unknown) {
    return { success: false, message: err instanceof Error ? err.message : String(err) };
  }
}

export async function createMcpTool(params: {
  projectDirectory: string;
  toolName: string;
  toolDescription: string;
  inputSchema: Record<string, unknown>;
  handlerCode: string;
}): Promise<ToolResult> {
  try {
    const indexPath = path.join(params.projectDirectory, "src/index.ts");
    let content: string;
    try {
      content = await fs.readFile(indexPath, "utf-8");
    } catch {
      return { success: false, message: `Could not read ${indexPath}. Make sure the project directory is correct.` };
    }

    const schemaFields = Object.entries(params.inputSchema)
      .map(([k, v]) => {
        const field = v as Record<string, unknown>;
        const type = field.type as string ?? "string";
        const desc = field.description as string ?? "";
        const zodType = type === "number" ? "z.number()" : type === "boolean" ? "z.boolean()" : "z.string()";
        return `      ${k}: ${zodType}${desc ? `.describe(${JSON.stringify(desc)})` : ""},`;
      })
      .join("\n");

    const toolCode = `
server.registerTool(
  "${params.toolName}",
  {
    title: "${params.toolName.replace(/_/g, " ").replace(/\b\w/g, l => l.toUpperCase())}",
    description: ${JSON.stringify(params.toolDescription)},
    inputSchema: z.object({
${schemaFields}
    }),
  },
  async (params) => {
    ${params.handlerCode}
  }
);
`;

    // Insert before the "Start server" comment or at end of file
    let newContent: string;
    const insertMarker = "// ─── Start server";
    if (content.includes(insertMarker)) {
      newContent = content.replace(insertMarker, `${toolCode}\n${insertMarker}`);
    } else {
      newContent = content + "\n" + toolCode;
    }

    await fs.writeFile(indexPath, newContent, "utf-8");

    return {
      success: true,
      fullName: params.toolName,
      created: true,
      message: `Tool '${params.toolName}' added to ${indexPath}. Run 'npm run build' to compile.`
    };
  } catch (err: unknown) {
    return { success: false, message: err instanceof Error ? err.message : String(err) };
  }
}

export async function listMcpTools(projectDirectory: string): Promise<ToolResult> {
  try {
    const indexPath = path.join(projectDirectory, "src/index.ts");
    let content: string;
    try {
      content = await fs.readFile(indexPath, "utf-8");
    } catch {
      return { success: false, message: `Could not read ${indexPath}.` };
    }

    const toolMatches = [...content.matchAll(/server\.registerTool\(\s*["']([^"']+)["']/g)];
    const tools = toolMatches.map(m => m[1]);

    if (!tools.length) {
      return { success: true, fullName: projectDirectory, created: false, message: "No tools registered in this MCP server project." };
    }

    return {
      success: true,
      fullName: projectDirectory,
      created: false,
      message: `Found ${tools.length} tool(s) in ${indexPath}:\n${tools.map((t, i) => `${i + 1}. ${t}`).join("\n")}`
    };
  } catch (err: unknown) {
    return { success: false, message: err instanceof Error ? err.message : String(err) };
  }
}
