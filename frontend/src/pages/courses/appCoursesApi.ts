import { useQuery } from "@tanstack/react-query";
// Courses & prices and Classes, streams & goals call the AdhyaapakAI backend's admin API (like
// Voucher Management): /api/admin/catalog/... with the x-admin-secret typed into this tab. The
// dashboard keeps no database or storage keys, and no copy of the app's rules, for them.
import { adminFetch as apiFetch } from "../vouchers/adminApi";
import type { UploadTicket } from "./appVideosApi";

// The AdhyaapakAI app's course catalogue: products, prices and home-screen batches, saved to the
// app's database (course_catalog). The app's backend reads it within 30 seconds. Owner only.
export const AC_API = "/admin/catalog";
export const acKeys = {
  all: ["app-courses"] as const,
  status: ["app-courses", "status"] as const,
  catalog: ["app-courses", "catalog"] as const,
  subjects: ["app-courses", "subjects"] as const,
};

export interface AppCoursesStatus {
  configured: boolean;
  storage: boolean;
  database: string | null;
}

export interface CourseRow {
  entitlement: string;
  class_level: number;
  subject: string;
  from_code?: boolean;
}

export interface ProductRow {
  id: string;
  title: string;
  subtitle: string;
  price_inr: number;
  ios_product_id: string | null;
  grants: string[];
  badge: string | null;
  active: boolean;
  free?: boolean; // every lecture open to everyone; not sold
  access_days?: number | null; // one purchase opens it this long; null: the app's default
  sale_starts_at?: string | null; // launch (ISO): not sold, nor its card shown, before
  details?: CourseDetails | null; // its Course Details page in the app (paid only; null: no button)
  from_code?: boolean;
}

/** A paid course's "Course Details" page in the app (its brochure screen). */
export interface CourseDetails {
  kicker: string;
  languages: string[]; // the languages its page lists (DETAIL_LANGUAGES codes); empty: all of them
  title_lead: string;
  title_accent: string;
  title_tail: string;
  pillars: string[];
  exams: string[];
  chapter_groups: { title: string; chapters: string[] }[];
  why_choose: { title: string; detail: string }[];
  compare_at: number | null; // crossed-out price
  save_note: string;
}

export interface BatchRow {
  id: string;
  title: string;
  product_id: string;
  class_level: number;
  subjects: string[];
  banner_key: string | null;
  banner_key_dark: string | null;
  banner_from_course: boolean; // the card shows the subject's course image from App videos, live
  active: boolean;
  streams: string[]; // who sees the card in the app: empty = every stream
  goals: string[]; // empty = every goal
}

export interface Catalog {
  database: string | null;
  source: "db" | "code";
  version: number | null;
  updated_at: string | null;
  error: string | null;
  access_days: number;
  courses: CourseRow[];
  products: ProductRow[];
  batches: BatchRow[];
  coupons: { code: string; expires_at: string | null; products: { product_id: string; coupon_product_id: string; price_inr: number }[] }[];
}

/** What a student picks at onboarding in the app (the app's own lists). */
export interface Academics {
  classes: { class_level: number; name: string; available: boolean }[];
  streams: string[];
  stream_goals: Record<string, string[]>;
  names?: Record<string, string>; // stream / goal key -> the name students see
}

export const useAcademics = () =>
  useQuery({ queryKey: [...acKeys.all, "academics"], queryFn: fetchAcademics, staleTime: Infinity, retry: false });

/** The app's public onboarding lists (GET /api/academics/classes: no secret needed, nothing private),
 * shaped like the admin /academics: Placement Drives uses them too, without the admin secret. */
interface PublicAcademics {
  open: number[];
  classes?: { level: number; name: string }[];
  streams?: { key: string; name: string; active: boolean }[];
  goals?: { key: string; name: string; active: boolean; streams: string[] }[];
}

async function fetchAcademics(): Promise<Academics> {
  const r = await apiFetch<PublicAcademics>("/academics/classes");
  const streams = r.streams ?? [];
  const goals = r.goals ?? [];
  return {
    classes: (r.classes ?? []).map((c) => ({ class_level: c.level, name: c.name, available: r.open.includes(c.level) })),
    streams: streams.map((s) => s.key),
    stream_goals: Object.fromEntries(streams.map((s) => [s.key, goals.filter((g) => g.streams.includes(s.key)).map((g) => g.key)])),
    names: Object.fromEntries([...streams, ...goals].map((x) => [x.key, x.name])),
  };
}

/** The app's class list (onboarding and Academic details): names, open or closed. Owner only.
 * A class's number never changes (profiles, lecture folders and course ids use it); its name can. */
export interface ClassRow {
  class_level: number;
  name: string;
  open: boolean;
}

export interface ClassesState {
  database: string | null;
  version: number | null; // null: never saved here (the app uses Class 11 and 12 from its code)
  updated_at: string | null;
  error: string | null;
  max_class: number;
  classes: (ClassRow & { students_keep: boolean })[];
}

export interface ClassesSummary {
  version: number;
  opened: number[];
  closed: number[];
  open: number[];
  added: number[];
  removed: number[];
  renamed: Record<string, [string, string]>;
}

export interface ClassDeletePlan {
  class_level: number;
  students: number;
  courses: string[];
  cards: string[];
  subjects: string[];
  blockers: string[]; // empty: it can be deleted
}

export const useClasses = (enabled: boolean) =>
  useQuery({ queryKey: [...acKeys.all, "classes"], queryFn: () => apiFetch<ClassesState>(`${AC_API}/classes`), enabled, retry: false, refetchOnWindowFocus: false });

export const saveClasses = (body: { version: number | null; classes: ClassRow[] }) =>
  apiFetch<ClassesState & { summary: ClassesSummary }>(`${AC_API}/classes`, { method: "PUT", body });

export const fetchClassDeletePlan = (classLevel: number) => apiFetch<ClassDeletePlan>(`${AC_API}/classes/${classLevel}/delete-check`);

/** The app's streams and goals. `key` is what a student's profile stores (and Dome, tests, emails and
 * cards match on): it never changes; `name` is what students see. Owner only. */
export interface StreamItem {
  key: string;
  name: string;
  active: boolean;
}

export interface GoalItem extends StreamItem {
  streams: string[]; // the stream keys it's offered to
}

export interface ListsState {
  version: number | null; // null: never saved here (the app's code lists)
  updated_at: string | null;
  error: string | null;
  streams: StreamItem[];
  goals: GoalItem[];
}

export interface ListDeletePlan {
  kind: "stream" | "goal";
  key: string;
  students: number;
  cards: string[];
  blockers: string[]; // empty: it can be deleted
}

export const useLists = (enabled: boolean) =>
  useQuery({ queryKey: [...acKeys.all, "lists"], queryFn: () => apiFetch<ListsState>(`${AC_API}/lists`), enabled, retry: false, refetchOnWindowFocus: false });

export const saveLists = (body: { version: number | null; streams: StreamItem[]; goals: GoalItem[] }) =>
  apiFetch<ListsState & { summary: Record<string, unknown> }>(`${AC_API}/lists`, { method: "PUT", body });

export const fetchListDeletePlan = (kind: "stream" | "goal", key: string) =>
  apiFetch<ListDeletePlan>(`${AC_API}/lists/delete-check`, { query: { kind, key } });

/** Goals a card can aim at for these streams (none ticked: every stream's). */
export const goalsFor = (a: Academics, streams: string[]) => [...new Set((streams.length ? streams : a.streams).flatMap((s) => a.stream_goals[s] ?? []))];

/** "Class 11 · Science · NEET, Board Exams" */
export const audienceLabel = (b: { class_level: number; streams: string[]; goals: string[] }) =>
  `Class ${b.class_level} · ${b.streams.length ? b.streams.join(", ") : "every stream"} · ${b.goals.length ? b.goals.join(", ") : "every goal"}`;

export interface SubjectOption {
  class_level: number;
  folder: string;
  subject: string;
}

/** What the Course Details editor starts from, from the app's backend: the languages a page can
 * list (in the app's order) and the built-in pages of its three code courses. */
export interface DetailDefaults {
  languages: { code: string; name: string }[];
  pages: Record<string, CourseDetails>;
}

export const useDetailDefaults = (enabled = true) =>
  useQuery({
    queryKey: [...acKeys.all, "details-defaults"],
    queryFn: () => apiFetch<DetailDefaults>(`${AC_API}/details-defaults`),
    enabled,
    staleTime: Infinity,
    retry: false,
  });

export const useAppCoursesStatus = (enabled: boolean) =>
  useQuery({ queryKey: acKeys.status, queryFn: () => apiFetch<AppCoursesStatus>(`${AC_API}/status`), enabled, staleTime: Infinity, retry: false });

export const useCatalog = (enabled: boolean) =>
  useQuery({ queryKey: acKeys.catalog, queryFn: () => apiFetch<Catalog>(`${AC_API}/catalog`), enabled, retry: false, refetchOnWindowFocus: false });

export const useSubjectOptions = (enabled: boolean) =>
  useQuery({
    queryKey: acKeys.subjects,
    queryFn: () => apiFetch<{ subjects: SubjectOption[] }>(`${AC_API}/subjects`).then((r) => r.subjects),
    enabled,
    retry: false,
    staleTime: 5 * 60_000,
  });

export const saveCatalog = (body: { version: number | null; courses: CourseRow[]; products: ProductRow[]; batches: BatchRow[] }) =>
  apiFetch<{ catalog: Catalog; summary: Record<string, unknown> }>(`${AC_API}/catalog`, { method: "PUT", body });

export const bannerTicket = (body: { batch_id: string; dark: boolean; filename: string; size_bytes: number }) =>
  apiFetch<Pick<UploadTicket, "key" | "upload_url" | "fields" | "content_type" | "max_bytes">>(`${AC_API}/banners/uploads`, { method: "POST", body });

export const bannerComplete = (key: string) => apiFetch<{ key: string; size: number }>(`${AC_API}/banners/uploads/complete`, { method: "POST", body: { key } });

export const bannerPreview = (key: string) => apiFetch<{ url: string }>(`${AC_API}/banners/preview`, { query: { key } }).then((r) => r.url);

/** "class12_accountancy" for Class 12 + "accounts". */
export const courseId = (classLevel: number, subject: string) => `class${classLevel}_${subject.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "")}`;

export const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 60);

/** What deleting a course removes (catalogue entries, banners, its lecture folder in S3), or why not. */
export interface DeletePlan {
  entitlement: string;
  class_level: number | null;
  subject: string | null;
  blockers: string[];
  products: string[];
  batches: string[];
  banners: string[];
  folder: string | null;
  files: number;
  bytes: number;
}

export const fetchDeletePlan = (entitlement: string) => apiFetch<DeletePlan>(`${AC_API}/courses/${entitlement}/delete-check`);

export const deleteCourse = (entitlement: string, version: number | null) =>
  apiFetch<{ catalog: Catalog; deleted: Record<string, unknown>; s3_error: string | null }>(`${AC_API}/courses/${entitlement}/delete`, {
    method: "POST",
    body: { version },
  });
