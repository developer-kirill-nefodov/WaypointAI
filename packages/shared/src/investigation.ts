import type { components } from "./openapi.generated.js";

// REST types for the investigation workspace, generated from contracts/openapi.yaml.
type Schemas = components["schemas"];

export type InvestigationEvent = Schemas["InvestigationEvent"];
export type EventSearchResponse = Schemas["EventSearchResponse"];
export type AppliedEventFilters = Schemas["AppliedEventFilters"];
export type EventDetailsResponse = Schemas["EventDetailsResponse"];
export type EntityDetailsResponse = Schemas["EntityDetailsResponse"];
export type SyncSummary = Schemas["SyncSummary"];
export type InvestigationQueryRequest = Schemas["InvestigationQueryRequest"];
export type InvestigationQueryResponse = Schemas["InvestigationQueryResponse"];
export type InvestigationQueryError = Schemas["InvestigationQueryError"];
export type QueryInterpretation = Schemas["QueryInterpretation"];
