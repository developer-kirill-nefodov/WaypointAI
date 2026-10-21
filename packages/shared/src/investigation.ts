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
export type CrossCheckSummary = Schemas["CrossCheckSummary"];
export type CrossCheckMatch = Schemas["CrossCheckMatch"];

// Training: lessons and the exam.
export type Lesson = Schemas["Lesson"];
export type LessonInput = Schemas["LessonInput"];
export type AppliedLesson = Schemas["AppliedLesson"];
export type ExamCase = Schemas["ExamCase"];
export type ExamCaseInput = Schemas["ExamCaseInput"];
export type CaseExpectation = Schemas["CaseExpectation"];
export type EvalRun = Schemas["EvalRun"];
export type EvalResult = Schemas["EvalResult"];
export type EvalCheck = Schemas["EvalCheck"];
export type ModelCard = Schemas["ModelCard"];
export type RunMetrics = Schemas["RunMetrics"];
export type Share = Schemas["Share"];
