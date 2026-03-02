#!/usr/bin/env node
import { RequestManager, HTTPTransport, Client } from "@open-rpc/client-js";

/**
 * This is an OpenRPC server that provides JSON-RPC functionality.
 * It allows:
 * - Discovering JSON-RPC methods via rpc.discover
 * - Calling arbitrary JSON-RPC methods
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

type HeadersMap = Record<string, string>;

function parseHeaderArgument(value: string): [string, string] {
  const separatorIndex = value.indexOf(":");
  if (separatorIndex === -1) {
    throw new Error(
      `Invalid header format \"${value}\". Expected \"Header-Name: value\".`
    );
  }

  const key = value.slice(0, separatorIndex).trim();
  const headerValue = value.slice(separatorIndex + 1).trim();

  if (!key) {
    throw new Error(`Invalid header format \"${value}\". Header name is missing.`);
  }

  return [key, headerValue];
}

function parseToolHeaders(value: unknown): HeadersMap {
  if (value === undefined || value === null || value === "") {
    return {};
  }

  if (typeof value !== "string") {
    throw new Error("Tool headers must be a JSON object string.");
  }

  let parsedValue: unknown;
  try {
    parsedValue = JSON.parse(value);
  } catch {
    throw new Error("Invalid tool headers JSON. Expected an object map of headers.");
  }

  if (!parsedValue || typeof parsedValue !== "object" || Array.isArray(parsedValue)) {
    throw new Error("Invalid tool headers JSON. Expected an object map of headers.");
  }

  const headers: HeadersMap = {};
  for (const [key, headerValue] of Object.entries(parsedValue as Record<string, unknown>)) {
    headers[key] = String(headerValue);
  }

  return headers;
}

function parseCliHeaders(argv: string[]): HeadersMap {
  const headers: HeadersMap = {};

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "--header" || arg === "-H") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error("Missing value for --header. Expected \"Header-Name: value\".");
      }

      const [key, headerValue] = parseHeaderArgument(value);
      headers[key] = headerValue;
      i += 1;
      continue;
    }

    if (arg === "--headers" || arg === "--headers-json") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error("Missing value for --headers. Expected a JSON object string.");
      }

      const parsedHeaders = parseToolHeaders(value);
      Object.assign(headers, parsedHeaders);
      i += 1;
    }
  }

  return headers;
}

const cliHeaders = parseCliHeaders(process.argv.slice(2));

function createClient(serverUrl: string, toolHeaders: unknown): Client {
  const requestHeaders = {
    ...cliHeaders,
    ...parseToolHeaders(toolHeaders),
  };

  const transport = new HTTPTransport(serverUrl, { headers: requestHeaders });
  return new Client(new RequestManager([transport]));
}

/**
 * Create an MCP server with capabilities for tools and prompts
 * to interact with JSON-RPC servers
 */
const server = new Server(
  {
    name: "openrpc",
    version: "0.1.0",
  },
  {
    capabilities: {
      resources: {},
      tools: {},
      prompts: {},
    },
  }
);

/**
 * Handler that lists available tools.
 * Exposes two tools:
 * - rpc_call: For calling arbitrary JSON-RPC methods
 * - rpc_discover: For discovering available methods on a server
 */
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "rpc_call",
        description: "Call any JSON-RPC method on a server with parameters. A user would prompt: Call method <method> on <server url> with params <params>",
        inputSchema: {
          type: "object",
          properties: {
            server: {
              type: "string",
              description: "Server URL"
            },
            method: {
              type: "string",
              description: "JSON-RPC method name to call"
            },
            // this is a bit of a hack since claude seems to have issues with nested parameters
            params: {
              type: "string",
              description: "Stringified parameters to pass to the method"
            },
            headers: {
              type: "string",
              description: "Optional stringified JSON object of headers for this call. These are merged with CLI headers and take precedence when keys overlap."
            }
          },
          required: ["server", "method"]
        }
      },
      {
        name: "rpc_discover",
        description: "This uses JSON-RPC to call `rpc.discover` which is part of the OpenRPC Specification for discovery for JSON-RPC servers. A user would prompt: What JSON-RPC methods does this server have? <server url>",
        inputSchema: {
          type: "object",
          properties: {
            server: {
              type: "string",
              description: "Server URL"
            },
            headers: {
              type: "string",
              description: "Optional stringified JSON object of headers for this call. These are merged with CLI headers and take precedence when keys overlap."
            }
          },
          required: ["server"]
        }
      }
    ]
  };
});

/**
 * Handler for JSON-RPC tools.
 * Handles both method discovery and arbitrary method calls.
 */
server.setRequestHandler(CallToolRequestSchema, async (request) => {

  switch (request.params.name) {
    case "rpc_call": {
      const server = String(request.params.arguments?.server);
      const method = String(request.params.arguments?.method);
      const rawParams = request.params.arguments?.params;
      const params = rawParams !== undefined && rawParams !== null && rawParams !== ""
        ? JSON.parse(String(rawParams))
        : undefined;
      const client = createClient(server, request.params.arguments?.headers);
      const results = await client.request({ method: method, params: params as any});
      return {
        toolResult: {
          content: [{
            type: "text",
            text: JSON.stringify(results, null, 2)
          }],
          isError: false
        }
      };
    }
    case "rpc_discover": {
      const server = String(request.params.arguments?.server);
      if (!server) {
        throw new Error("Server is required");
      }
      const client = createClient(server, request.params.arguments?.headers);
      const results = await client.request({ method: "rpc.discover" });

      return  {
        toolResult: {
          content: [{
            type: "text",
            text: JSON.stringify(results, null, 2)
          }],
          isError: false
        }
      };
    }

    default:
      throw new Error("Unknown tool");
  }
});

/**
 * Start the server using stdio transport.
 * This allows the server to communicate via standard input/output streams.
 */
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});
