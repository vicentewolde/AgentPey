/**
 * The UCP storefront client moved to `@vitrinee/anchor` in T128, so AgentPey's
 * MCP server reads stores with the same code. Re-exported here so the scripts
 * that used it keep their imports.
 */
export {
  assertNamespaceBinding,
  getUcpProduct,
  readUcpStoreProfile,
  readUcpStorefront,
  searchUcpStore,
  type UcpClientOptions,
  type UcpStoreProfile,
  type UcpStorefront,
} from "../../../packages/vitrinee-anchor/src/ucp-client.js";
