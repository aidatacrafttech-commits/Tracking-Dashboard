import { API_BASE, ApiError, csrfStore, notifyUnauthorized } from "../../api/client";
import { ADHYAAPAK_API_BASE, AdminApiError, adminFetch, adminSecret } from "../vouchers/adminApi";

// The AdhyaapakAI app's placement drives, through the app backend's admin API
// (/admin/placement, x-admin-secret typed into this tab, like Voucher Management). The
// dashboard has no database keys for it. Only two things stay on the dashboard's own server,
// neither touching the app: reading a paper from a PDF, and making the Excel file from the
// results table the admin API hands out.
export const AP_API = "/admin/placement";
export const PD_API = "/placement-drives"; // the dashboard's own server: parse-pdf, xlsx
export const KEY = ["placement-drives"] as const;
export const MAX_PDF_MB = 10;

export interface PlacementStatus {
  configured: boolean;
  database: string | null;
  multiple: boolean; // several drives may be on for the same day (one app card each)
}

export interface Marking {
  correct: number;
  wrong: number;
}

export interface DriveSummary {
  date: string; // last day (IST), the drive's key
  open_from: string | null;
  exam: string;
  label: string;
  full_name: string;
  duration_min: number | null;
  marking: Marking;
  question_count: number;
  active: boolean;
  audience_all: boolean;
  audience_count: number;
  // "Everyone" aimed at these (empty = any); the app matches the student's onboarding picks.
  audience_classes?: number[];
  audience_streams?: string[];
  audience_goals?: string[];
  has_access_code: boolean;
  has_sheet_key: boolean;
  opened: number;
  submitted: number;
  locked: boolean; // someone has opened it: the paper and the last day are fixed
  updated_at: string | null;
}

export interface Question {
  section: string;
  question: string;
  options: string[];
  correct_answer: number | null;
  explanation: string;
}

export interface ParsedQuestion extends Question {
  needs_review: boolean;
  review_notes: string[];
}

export interface DriveDetail extends DriveSummary {
  emails: string[];
  sections: { subject: string; count: number }[];
  questions: Question[];
}

export interface DriveInput {
  label: string;
  full_name: string;
  exam: string;
  open_from: string | null;
  date: string;
  duration_min: number;
  marking: Marking;
  audience: { all: boolean; emails: string[]; classes: number[]; streams: string[]; goals: string[] };
  access_code?: string | null; // null/absent keeps the stored one; "" removes it
  sheet_key?: string | null;
  questions?: Question[] | null; // null keeps the stored paper
  active?: boolean | null;
}

export interface SavedDrive {
  drive: DriveDetail;
  sheet_key: string | null;
  sheet_formula: string | null;
}

export interface ParsedPaper {
  title: string;
  questions: ParsedQuestion[];
  answer_key_found: boolean;
  warnings: string[];
}

export type ResultRow = Record<string, string | number | boolean | null>;

export interface DriveResults {
  drive: DriveSummary;
  fields: string[];
  rows: ResultRow[];
  answer_key: ResultRow;
  summary: {
    opened: number;
    submitted: number;
    not_submitted: number;
    not_started: number;
    average_score: number | null;
    highest_score: number | null;
  };
}

export const fetchStatus = () => adminFetch<PlacementStatus>(`${AP_API}/status`);
export const fetchDrives = () => adminFetch<{ drives: DriveSummary[] }>(`${AP_API}/drives`).then((r) => r.drives);
export const fetchDrive = (day: string) => adminFetch<DriveDetail>(`${AP_API}/drives/${encodeURIComponent(day)}`);
export const createDrive = (body: DriveInput) => adminFetch<SavedDrive>(`${AP_API}/drives`, { method: "POST", body });
export const updateDrive = (day: string, body: DriveInput) =>
  adminFetch<SavedDrive>(`${AP_API}/drives/${encodeURIComponent(day)}`, { method: "PUT", body });
export const setActive = (day: string, active: boolean) =>
  adminFetch<DriveSummary>(`${AP_API}/drives/${encodeURIComponent(day)}/active`, { method: "POST", body: { active } });
/** Deletes a drive that is off and that nobody has opened (the server refuses others). */
export const deleteDrive = (day: string) => adminFetch<void>(`${AP_API}/drives/${encodeURIComponent(day)}`, { method: "DELETE" });
export const newSheetKey = () => adminFetch<{ sheet_key: string }>(`${AP_API}/sheet-key`).then((r) => r.sheet_key);
export const fetchResults = (day: string) => adminFetch<DriveResults>(`${AP_API}/results`, { query: { date: day } });

async function failure(response: Response): Promise<ApiError> {
  let body: { error?: { code?: string; message?: string; request_id?: string; details?: unknown } } | null = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (response.status === 401) notifyUnauthorized(body?.error?.code ?? "unauthenticated");
  return new ApiError(
    response.status,
    body?.error?.code ?? "http_error",
    body?.error?.message ?? `Request failed (${response.status})`,
    body?.error?.request_id ?? response.headers.get("X-Request-ID"),
    body?.error?.details,
  );
}

/** Sends the PDF as the request body; the server reads it in memory and keeps nothing. */
export async function parsePdf(file: File): Promise<ParsedPaper> {
  const headers: Record<string, string> = { "Content-Type": "application/pdf", Accept: "application/json" };
  const csrf = csrfStore.get();
  if (csrf) headers["X-CSRF-Token"] = csrf;
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${PD_API}/parse-pdf`, { method: "POST", headers, body: file, credentials: "same-origin" });
  } catch {
    throw new ApiError(0, "network_error", "Cannot reach the monitoring server.", null);
  }
  if (!response.ok) throw await failure(response);
  return (await response.json()) as ParsedPaper;
}

export type DownloadTarget = { date: string } | { start: string; end: string };

interface ResultsSheets {
  file: string;
  sheets: { name: string; fields: string[]; rows: ResultRow[] }[];
}

/** The CSV exactly as the app's backend makes it (sent with the admin secret). */
async function csvFromApp(target: DownloadTarget): Promise<Response> {
  const secret = adminSecret.get();
  const headers: Record<string, string> = { Accept: "text/csv" };
  if (secret) headers["x-admin-secret"] = secret;
  let response: Response;
  try {
    response = await fetch(`${ADHYAAPAK_API_BASE}${AP_API}/results/download?${new URLSearchParams(target)}`, {
      headers,
      credentials: "omit",
      cache: "no-store",
    });
  } catch {
    throw new AdminApiError(0, "network_error", "Cannot reach the AdhyaapakAI backend. Is it running?", null);
  }
  if (!response.ok) {
    let body: { detail?: unknown; code?: unknown } | null = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    if (response.status === 403) adminSecret.clear(true);
    const message = typeof body?.detail === "string" ? body.detail : `Request failed (${response.status})`;
    const code = typeof body?.code === "string" ? body.code : `http_${response.status}`;
    throw new AdminApiError(response.status, code, message, null);
  }
  return response;
}

/** The Excel file: the results table from the app's admin API, made into a workbook by the
 * dashboard's own server (which reads nothing of the app and keeps nothing). */
async function xlsxFromTable(target: DownloadTarget): Promise<Response> {
  const table = await adminFetch<ResultsSheets>(`${AP_API}/results/sheet`, { query: target });
  const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "application/octet-stream" };
  const csrf = csrfStore.get();
  if (csrf) headers["X-CSRF-Token"] = csrf;
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${PD_API}/xlsx`, {
      method: "POST",
      headers,
      body: JSON.stringify(table),
      credentials: "same-origin",
    });
  } catch {
    throw new ApiError(0, "network_error", "Cannot reach the monitoring server.", null);
  }
  if (!response.ok) throw await failure(response);
  return response;
}

/** Downloads a results file (CSV or Excel). */
export async function downloadResults(target: DownloadTarget, format: "csv" | "xlsx"): Promise<void> {
  const response = format === "csv" ? await csvFromApp(target) : await xlsxFromTable(target);
  const name = /filename="([^"]+)"/.exec(response.headers.get("Content-Disposition") ?? "")?.[1];
  const fallback = "date" in target ? `placement-drive-${target.date}.${format}` : `placement-drive-${target.start}-to-${target.end}.${format}`;
  const url = URL.createObjectURL(await response.blob());
  const a = document.createElement("a");
  a.href = url;
  a.download = name ?? fallback;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** A paper in the app's JSON format (backend/data/placement_drive_*.json) as editable questions. */
export function questionsFromJson(text: string): { questions: ParsedQuestion[]; meta: Partial<DriveInput> } {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("That file isn't valid JSON.");
  }
  const paper = data as { questions?: unknown; label?: unknown; full_name?: unknown; exam?: unknown; duration_min?: unknown; marking?: unknown };
  if (!paper || !Array.isArray(paper.questions)) throw new Error('The JSON has no "questions" list.');
  const questions = (paper.questions as Record<string, unknown>[]).map((q) => {
    const options = Array.isArray(q.options) ? (q.options as unknown[]).map((o) => String(o ?? "")) : [];
    while (options.length < 4) options.push("");
    const answer = typeof q.correct_answer === "number" && q.correct_answer >= 0 && q.correct_answer < 4 ? q.correct_answer : null;
    const notes: string[] = [];
    if (options.length !== 4 || options.some((o) => !o.trim())) notes.push("Needs exactly four options.");
    if (answer === null) notes.push("No answer. Pick the correct option.");
    return {
      section: String(q.section ?? ""),
      question: String(q.question ?? ""),
      options: options.slice(0, Math.max(4, options.length)),
      correct_answer: answer,
      explanation: String(q.explanation ?? ""),
      needs_review: notes.length > 0,
      review_notes: notes,
    };
  });
  const meta: Partial<DriveInput> = {};
  if (typeof paper.label === "string") meta.label = paper.label;
  if (typeof paper.full_name === "string") meta.full_name = paper.full_name;
  if (typeof paper.exam === "string") meta.exam = paper.exam;
  if (typeof paper.duration_min === "number") meta.duration_min = paper.duration_min;
  const m = paper.marking as Marking | undefined;
  if (m && typeof m.correct === "number" && typeof m.wrong === "number") meta.marking = { correct: m.correct, wrong: m.wrong };
  return { questions, meta };
}

/** Today's calendar date (YYYY-MM-DD) in India time. */
export const todayIst = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
