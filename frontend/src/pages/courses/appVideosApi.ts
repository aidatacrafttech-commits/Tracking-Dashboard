import { useQuery } from "@tanstack/react-query";
// App videos calls the AdhyaapakAI backend's admin API (like Voucher Management):
// /api/admin/videos/... with the x-admin-secret typed into this tab. The dashboard keeps no storage
// keys, and no copy of the app's folder rules, for it. Uploads still go from the browser straight to
// S3, with the presigned POST that API hands out.
import { adminFetch as apiFetch } from "../vouchers/adminApi";

// The AdhyaapakAI app's own course videos, in its S3 bucket (videos/class_<N>/<Subject>/).
// The app reads that folder live, so a change here is in the app within about 30 seconds.
// Owner only. The server decides every file name with the app's own rules.
export const AV_API = "/admin/videos";
export const avKeys = {
  all: ["app-videos"] as const,
  status: ["app-videos", "status"] as const,
  classes: ["app-videos", "classes"] as const,
  subjects: (c: number) => ["app-videos", "subjects", c] as const,
  course: (c: number, s: string) => ["app-videos", "course", c, s] as const,
};

export interface AppVideosStatus {
  configured: boolean;
  max_video_mb: number;
  max_image_mb: number;
  languages: string[]; // dubbed languages (Hinglish is the main video)
}

export interface AppLecture {
  number: number;
  title: string; // exactly as the app shows it
  key: string;
  filename: string;
  size: number;
  last_modified: string | null;
  languages: { language: string; key: string }[];
  thumbnail_key: string | null;
  numbered: boolean;
}

export interface AppChapter {
  folder: string;
  number: number;
  title: string;
  is_demo: boolean;
  thumbnail_key: string | null;
  shared_number: string[];
  lectures: AppLecture[];
}

export interface AppCourse {
  class_level: number;
  subject: string;
  app_subject: string;
  playlist_thumbnail_key: string | null;
  lecture_count: number;
  chapters: AppChapter[];
}

export type UploadKind = "lecture" | "demo" | "language" | "lecture_thumbnail" | "chapter_thumbnail" | "playlist_thumbnail";

export interface UploadInput {
  class_level: number;
  subject: string;
  kind: UploadKind;
  filename: string;
  size_bytes: number;
  chapter?: string | null;
  new_chapter_number?: number | null;
  new_chapter_name?: string | null;
  lecture_number?: number | null;
  topic?: string | null;
  language?: string | null;
  replace?: boolean;
}

export interface UploadTicket {
  key: string;
  label: string;
  replaces: string[];
  content_type: string;
  max_bytes: number;
  upload_url: string;
  fields: Record<string, string>;
}

export const useAppVideosStatus = (enabled: boolean) =>
  useQuery({ queryKey: avKeys.status, queryFn: () => apiFetch<AppVideosStatus>(`${AV_API}/status`), enabled, staleTime: Infinity, retry: false });

export const useClasses = (enabled: boolean) =>
  useQuery({ queryKey: avKeys.classes, queryFn: () => apiFetch<{ classes: number[] }>(`${AV_API}/classes`).then((r) => r.classes), enabled, retry: false });

export const useSubjects = (classLevel: number | null) =>
  useQuery({
    queryKey: avKeys.subjects(classLevel ?? 0),
    queryFn: () => apiFetch<{ subjects: string[] }>(`${AV_API}/subjects`, { query: { class_level: classLevel } }).then((r) => r.subjects),
    enabled: classLevel !== null,
    retry: false,
  });

export const useAppCourse = (classLevel: number | null, subject: string | null) =>
  useQuery({
    queryKey: avKeys.course(classLevel ?? 0, subject ?? ""),
    queryFn: () => apiFetch<AppCourse>(`${AV_API}/course`, { query: { class_level: classLevel, subject } }),
    enabled: classLevel !== null && !!subject,
    retry: false,
  });

/** One subject's chapters and lectures as the app shows them (Course details fills its chapters from it). */
export const fetchAppCourse = (classLevel: number, subject: string) =>
  apiFetch<AppCourse>(`${AV_API}/course`, { query: { class_level: classLevel, subject } });

export const createClass = (class_level: number) =>
  apiFetch<{ class_level: number; folder: string }>(`${AV_API}/classes`, { method: "POST", body: { class_level } });

export const createSubject = (class_level: number, name: string) =>
  apiFetch<{ class_level: number; folder: string; subject: string; app_subject: string }>(`${AV_API}/subjects`, {
    method: "POST",
    body: { class_level, name },
  });

export const previewUrl = (classLevel: number, subject: string, key: string) =>
  apiFetch<{ url: string }>(`${AV_API}/preview`, { query: { class_level: classLevel, subject, key } }).then((r) => r.url);

export const deleteFile = (body: { class_level: number; subject: string; key: string; whole_lecture: boolean }) =>
  apiFetch<{ deleted: string[] }>(`${AV_API}/delete`, { method: "POST", body });

/** Every course image of the subject. `empty_cards`: cards that showed only it, now empty in the app. */
export const deleteCourseImage = (body: { class_level: number; subject: string }) =>
  apiFetch<{ deleted: string[]; empty_cards: string[] | null }>(`${AV_API}/course-image/delete`, { method: "POST", body });

export const requestTicket = (body: UploadInput) => apiFetch<UploadTicket>(`${AV_API}/uploads`, { method: "POST", body });

export const completeUpload = (body: { class_level: number; subject: string; key: string; replaces: string[]; label: string }) =>
  apiFetch<{ key: string; size: number; removed: string[] }>(`${AV_API}/uploads/complete`, { method: "POST", body });

/** Browser -> S3 with the ticket's presigned POST (the file never passes through the
 * dashboard server). Resolves when S3 has stored it. `signal` cancels the upload. */
export function postToS3(ticket: Pick<UploadTicket, "upload_url" | "fields">, file: File, onProgress: (pct: number) => void, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    for (const [k, v] of Object.entries(ticket.fields)) form.append(k, v);
    form.append("file", file); // must be the last field
    const xhr = new XMLHttpRequest();
    xhr.open("POST", ticket.upload_url);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(Math.round((e.loaded / e.total) * 100));
    xhr.onerror = () => reject(new Error("The upload to the app's storage failed. Check your connection and try again."));
    xhr.onabort = () => reject(new DOMException("Upload cancelled", "AbortError"));
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300
        ? resolve()
        : reject(new Error(xhr.status === 403
          ? "The app's storage refused the upload (403). The dashboard's storage keys may not write to videos/, or the link expired."
          : `The app's storage refused the upload (${xhr.status}).`));
    signal?.addEventListener("abort", () => xhr.abort());
    xhr.send(form);
  });
}

export const LANGUAGE_LABEL = (code: string) => code.charAt(0).toUpperCase() + code.slice(1);

export function fileSize(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
