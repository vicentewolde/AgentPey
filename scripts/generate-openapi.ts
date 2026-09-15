/**
 * Generates the `/v1` OpenAPI contract from @agentpey/partner-api's frozen
 * Zod schemas. Run with `pnpm run generate:openapi`; do not edit its output.
 */
import {
  agentResourceSchema,
  consentSessionResourceSchema,
  createConsentSessionRequestSchema,
  createPurchaseRequestSchema,
  createTenantRequestSchema,
  errorEnvelopeSchema,
  mandateResourceSchema,
  purchaseResourceSchema,
  tenantActivityResourceSchema,
  tenantResourceSchema,
} from "@agentpey/partner-api";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { stringify } from "yaml";
import { z } from "zod";

type JsonSchema = Record<string, unknown>;

const JSON_MEDIA_TYPE = "application/json";
const OUTPUT_PATH = resolve(import.meta.dirname, "../docs/api/openapi.yaml");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toJsonSchema(schema: z.ZodType): JsonSchema {
  return z.toJSONSchema(schema, { target: "draft-2020-12", io: "input" }) as JsonSchema;
}

function fieldSchema(schema: z.ZodType, field: string): JsonSchema {
  const jsonSchema = toJsonSchema(schema);
  const properties = jsonSchema.properties;
  if (!isRecord(properties) || !isRecord(properties[field])) {
    throw new Error(`Could not derive ${field} from its resource schema.`);
  }
  return properties[field];
}

function schemaRef(name: string): JsonSchema {
  return { $ref: `#/components/schemas/${name}` };
}

function jsonContent(schemaName: string): JsonSchema {
  return { content: { [JSON_MEDIA_TYPE]: { schema: schemaRef(schemaName) } } };
}

/** The static shape of `successEnvelope`; resource fields remain $refs. */
function successEnvelopeComponent(data: JsonSchema): JsonSchema {
  return {
    type: "object",
    properties: {
      ok: { type: "boolean", const: true },
      data,
    },
    required: ["ok", "data"],
    additionalProperties: false,
  };
}

const tenantSuccessSchema = successEnvelopeComponent(schemaRef("TenantResource"));
const agentListSuccessSchema = successEnvelopeComponent({ type: "array", items: schemaRef("AgentResource") });
const consentSessionSuccessSchema = successEnvelopeComponent(schemaRef("ConsentSessionResource"));
const mandateSuccessSchema = successEnvelopeComponent(schemaRef("MandateResource"));
const mandateListSuccessSchema = successEnvelopeComponent({ type: "array", items: schemaRef("MandateResource") });
const purchaseSuccessSchema = successEnvelopeComponent(schemaRef("PurchaseResource"));
const tenantActivitySuccessSchema = successEnvelopeComponent(schemaRef("TenantActivityResource"));

const errorResponse = {
  description: "An error response.",
  ...jsonContent("ErrorEnvelope"),
};

const errorResponses = { "400": { $ref: "#/components/responses/ErrorResponse" } };

const bearerSecurity = [{ bearerAuth: [] }];
const idempotencyKeyParameter = {
  name: "Idempotency-Key",
  in: "header",
  required: true,
  description: "A unique key for safely retrying this request.",
  schema: { type: "string", minLength: 1 },
};

const document = {
  openapi: "3.1.0",
  info: {
    title: "AgentPey Partner API",
    version: "0.1.0",
    description: "The testnet partner API. This contract is generated from @agentpey/partner-api Zod schemas.",
    license: { name: "Apache-2.0", url: "https://www.apache.org/licenses/LICENSE-2.0" },
  },
  servers: [
    {
      url: "/",
      description: "The base URL of your AgentPey testnet deployment.",
    },
  ],
  paths: {
    "/v1/tenants": {
      post: {
        operationId: "createTenant",
        summary: "Create a tenant",
        description: "Requires the tenants:write scope.",
        security: bearerSecurity,
        parameters: [idempotencyKeyParameter],
        requestBody: {
          required: true,
          content: { [JSON_MEDIA_TYPE]: { schema: schemaRef("CreateTenantRequest") } },
        },
        responses: {
          "201": { description: "The created tenant.", ...jsonContent("TenantSuccessResponse") },
          ...errorResponses,
        },
      },
    },
    "/v1/tenants/{id}": {
      get: {
        operationId: "getTenant",
        summary: "Get a tenant",
        description: "Requires the tenants:read scope.",
        security: bearerSecurity,
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: fieldSchema(tenantResourceSchema, "id"),
          },
        ],
        responses: {
          "200": { description: "The tenant.", ...jsonContent("TenantSuccessResponse") },
          ...errorResponses,
        },
      },
    },
    "/v1/agents": {
      get: {
        operationId: "listAgents",
        summary: "List a tenant's agents",
        description: "Requires the agents:read scope.",
        security: bearerSecurity,
        parameters: [
          {
            name: "tenant_id",
            in: "query",
            required: true,
            schema: fieldSchema(agentResourceSchema, "tenant_id"),
          },
        ],
        responses: {
          "200": { description: "The tenant's agents.", ...jsonContent("AgentListSuccessResponse") },
          ...errorResponses,
        },
      },
    },
    "/v1/consent_sessions": {
      post: {
        operationId: "createConsentSession",
        summary: "Create a consent session",
        description: "Requires the consent_sessions:write scope.",
        security: bearerSecurity,
        parameters: [idempotencyKeyParameter],
        requestBody: {
          required: true,
          content: { [JSON_MEDIA_TYPE]: { schema: schemaRef("CreateConsentSessionRequest") } },
        },
        responses: {
          "201": { description: "The created consent session.", ...jsonContent("ConsentSessionSuccessResponse") },
          ...errorResponses,
        },
      },
    },
    "/v1/consent_sessions/{id}": {
      get: {
        operationId: "getConsentSession",
        summary: "Get a consent session",
        description: "Requires the consent_sessions:read scope.",
        security: bearerSecurity,
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: fieldSchema(consentSessionResourceSchema, "id"),
          },
        ],
        responses: {
          "200": { description: "The consent session.", ...jsonContent("ConsentSessionSuccessResponse") },
          ...errorResponses,
        },
      },
    },
    "/v1/mandates/{id}": {
      get: {
        operationId: "getMandate",
        summary: "Get a mandate",
        description: "Requires the mandates:read scope.",
        security: bearerSecurity,
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: fieldSchema(mandateResourceSchema, "id"),
          },
        ],
        responses: {
          "200": { description: "The mandate.", ...jsonContent("MandateSuccessResponse") },
          ...errorResponses,
        },
      },
    },
    "/v1/mandates": {
      get: {
        operationId: "listMandates",
        summary: "List a tenant's mandates",
        description: "Requires the mandates:read scope.",
        security: bearerSecurity,
        parameters: [
          {
            name: "tenant_id",
            in: "query",
            required: true,
            schema: fieldSchema(mandateResourceSchema, "tenant_id"),
          },
        ],
        responses: {
          "200": { description: "The tenant's mandates.", ...jsonContent("MandateListSuccessResponse") },
          ...errorResponses,
        },
      },
    },
    "/v1/purchases": {
      post: {
        operationId: "createPurchase",
        summary: "Ask an agent to buy something",
        description:
          "Requires the payments:authorize scope. This is a request, not an authorisation: the platform re-resolves the venue against its own registry, fetches the merchant's 402 invoice itself, and compares price, asset and payTo against the signed Mandate before paying. A refusal by any of those layers is a 201 whose outcome is \"refused\", not a 4xx — 4xx is reserved for the request itself being wrong. The optional mandate_id chooses which of the tenant's Mandates the purchase goes through and authorises nothing: a Mandate that is not this tenant's is a 404 MandateNotFound, identical to one that does not exist; a named Mandate that is revoked, expired, not yet valid or does not cover the product is a refusal with that code, never a fall back to another Mandate. The daily limit of the chosen Mandate is checked against everything the tenant's agent spent today.",
        security: bearerSecurity,
        parameters: [idempotencyKeyParameter],
        requestBody: {
          required: true,
          content: { [JSON_MEDIA_TYPE]: { schema: schemaRef("CreatePurchaseRequest") } },
        },
        responses: {
          "201": { description: "The decision, settled or refused.", ...jsonContent("PurchaseSuccessResponse") },
          ...errorResponses,
        },
      },
    },
    "/v1/purchases/{id}": {
      get: {
        operationId: "getPurchase",
        summary: "Get a purchase",
        description: "Requires the payments:read scope.",
        security: bearerSecurity,
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: fieldSchema(purchaseResourceSchema, "id"),
          },
        ],
        responses: {
          "200": { description: "The purchase.", ...jsonContent("PurchaseSuccessResponse") },
          ...errorResponses,
        },
      },
    },
    "/v1/tenants/{id}/activity": {
      get: {
        operationId: "getTenantActivity",
        summary: "Get everything a tenant may be shown about their own agent",
        description:
          "Requires the vault:read scope. Strictly read-only: the active Mandate and its permissions, today's spending against its perDay limit, the tenant's rail balance, its purchases, and its refused attempts with a typed code and a readable reason. Every number comes from the same computation the authorisation itself uses, never a second sum.",
        security: bearerSecurity,
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: fieldSchema(tenantActivityResourceSchema, "tenant_id"),
          },
        ],
        responses: {
          "200": { description: "The tenant's activity.", ...jsonContent("TenantActivitySuccessResponse") },
          ...errorResponses,
        },
      },
    },
  },
  components: {
    responses: {
      ErrorResponse: errorResponse,
    },
    schemas: {
      CreateTenantRequest: toJsonSchema(createTenantRequestSchema),
      TenantResource: toJsonSchema(tenantResourceSchema),
      AgentResource: toJsonSchema(agentResourceSchema),
      CreateConsentSessionRequest: toJsonSchema(createConsentSessionRequestSchema),
      ConsentSessionResource: toJsonSchema(consentSessionResourceSchema),
      MandateResource: toJsonSchema(mandateResourceSchema),
      ErrorEnvelope: toJsonSchema(errorEnvelopeSchema),
      TenantSuccessResponse: tenantSuccessSchema,
      AgentListSuccessResponse: agentListSuccessSchema,
      ConsentSessionSuccessResponse: consentSessionSuccessSchema,
      MandateSuccessResponse: mandateSuccessSchema,
      MandateListSuccessResponse: mandateListSuccessSchema,
      CreatePurchaseRequest: toJsonSchema(createPurchaseRequestSchema),
      PurchaseResource: toJsonSchema(purchaseResourceSchema),
      TenantActivityResource: toJsonSchema(tenantActivityResourceSchema),
      PurchaseSuccessResponse: purchaseSuccessSchema,
      TenantActivitySuccessResponse: tenantActivitySuccessSchema,
    },
    securitySchemes: {
      bearerAuth: {
        type: "http",
        scheme: "bearer",
        bearerFormat: "API key",
        description: "An AgentPey partner API key (`ap_test_...`).",
      },
    },
  },
};

await mkdir(dirname(OUTPUT_PATH), { recursive: true });
await writeFile(
  OUTPUT_PATH,
  `# Generated by scripts/generate-openapi.ts. Do not edit manually.\n${stringify(document, { aliasDuplicateObjects: false })}`,
  "utf8",
);
console.log(`Generated ${OUTPUT_PATH}`);
