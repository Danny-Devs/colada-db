/**
 * colada-db-mcp — the read-only in-page MCP agent surface over colada-db
 * (DAN-580, Stage 2c; ADR-011; design: docs/design/mcp-agent-surface.md).
 *
 * Deny-by-default: zero write tools are registered — writes are
 * structurally impossible on this surface, not merely forbidden.
 */
export {
  createColadaDbMcpServer,
  AgentSurfaceConfigError,
  QUERY_TOOL_NAME,
  HISTORY_TOOL_NAME,
  SCHEMA_RESOURCE_URI,
  UNTRUSTED_META_KEY,
  UNTRUSTED_NOTICE,
} from "./server";
export type { ColadaDbMcpServerOptions } from "./server";
