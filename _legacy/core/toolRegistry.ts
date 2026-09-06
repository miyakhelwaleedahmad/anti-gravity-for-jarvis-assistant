/**
 * @deprecated core/toolRegistry.ts — LEGACY V1 (TOMBSTONED 2026-06-10)
 * ─────────────────────────────────────────────────────────────────────────────
 * THIS FILE IS NO LONGER IMPORTED BY ANY ACTIVE RUNTIME MODULE.
 *
 * Replaced by: core/toolRegistryV2.ts
 *   - toolRegistryV2.getLLMDefinitions() → replaces toolRegistry.definitions
 *   - toolRegistryV2.execute()           → replaces direct tool dispatch
 *   - toolRegistryV2.register()          → replaces manual definition arrays
 *
 * Last known importer: reasoning/grokCore.ts (migrated 2026-06-10)
 *
 * SAFE TO DELETE: Yes — remove this file when confirmed no references remain.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ToolParameterProp {
  type: string;
  description: string;
  enum?: string[];
}

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, ToolParameterProp>;
      required: string[];
    };
  };
}

// ─── Tool Definitions ─────────────────────────────────────────────────────────

export const toolDefinitions: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "web_search",
      description:
        "Search the web for real-time information. Use this whenever you need current facts, news, prices, weather, or any information that may have changed after your training cutoff. Always prefer using this over guessing.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "The search query to look up on Google. Be specific and concise.",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description:
        "Read the contents of a file on the user's system. Returns the full text content.",
      parameters: {
        type: "object",
        properties: {
          filePath: {
            type: "string",
            description: "Absolute or relative path to the file to read.",
          },
        },
        required: ["filePath"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description:
        "Write content to a file on the user's system. Creates the file and any missing parent directories automatically. Overwrites existing content.",
      parameters: {
        type: "object",
        properties: {
          filePath: {
            type: "string",
            description: "Absolute or relative path to the file to create or overwrite.",
          },
          content: {
            type: "string",
            description: "The full text content to write to the file.",
          },
        },
        required: ["filePath", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_command",
      description:
        "Run a Windows shell command on the user's system and return its output. If the user explicitly asks you to run a command so they can SEE it in a terminal window, prefix it with 'start cmd /k ' (e.g. 'start cmd /k ping google.com'). Otherwise, execute the command normally, which runs silently in the background.",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "The shell command to execute (PowerShell or CMD syntax).",
          },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_system_info",
      description:
        "Get information about the user's system: OS, CPU, memory, hostname, Node version, uptime.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "save_relation",
      description: "Save a relationship between two entities into long-term graph memory. Examples: (User, WORKS_ON, EcommerceApp).",
      parameters: {
        type: "object",
        properties: {
          entity1: {
            type: "string",
            description: "The subject entity (e.g. 'User', 'Jarvis').",
          },
          relation: {
            type: "string",
            description: "The relationship type (e.g. 'WORKS_ON', 'LIKES', 'IS_A').",
          },
          entity2: {
            type: "string",
            description: "The object entity (e.g. 'EcommerceApp', 'Python').",
          },
        },
        required: ["entity1", "relation", "entity2"],
      },
    },
  }
];

// ─── Tool Registry ────────────────────────────────────────────────────────────

export const toolRegistry = {
  /** All tool definitions to pass to the LLM */
  definitions: toolDefinitions,

  /** Look up a single tool definition by its function name */
  getByName(name: string): ToolDefinition | undefined {
    return toolDefinitions.find((t) => t.function.name === name);
  },

  /** Returns just the function names for logging */
  names(): string[] {
    return toolDefinitions.map((t) => t.function.name);
  },
};
