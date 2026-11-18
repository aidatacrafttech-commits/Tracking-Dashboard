import { apiFetch } from "../../api/client";
import { useAppSettings } from "../../api/hooks";
import { useAuth } from "../../auth/AuthContext";
import { adminFetch } from "../vouchers/adminApi";

// Read-only counts from the AdhyaapakAI backend's admin API (/admin/users, x-admin-secret
// typed into this tab, like Voucher Management); the dashboard has no database keys for it.
// Lists are masked for the dashboard's viewers. Days follow the dashboard's display timezone.
// Only "app open" (the app's heartbeats to this dashboard) comes from the dashboard's server.
// Money is in paise.
export const AU_API = "/admin/users";
export const APP_USERS_API = "/app-users"; // the dashboard's own server: presence only
export const KEY = ["app-users"] as const;
export const RANGES = [7, 30, 90] as const;
export const MAX_RANGE_DAYS = 90;
/** Last N days, or a custom start..end (inclusive calendar days, YYYY-MM-DD). */
export type Selection = { days: (typeof RANGES)[number] } | { start: string; end: string };

export interface AppUsersStatus {
  configured: boolean;
  database: string | null;
}

export interface DayRow {
  date: string; // calendar day in the display timezone, YYYY-MM-DD
  signups: number;
  deleted_since: number;
  purchases: number;
  vouchers: number;
  revenue_paise: number;
}

export interface Breakdown {
  label: string;
  count: number;
}

export interface AppUsersSummary {
  timezone: string;
  start: string;
  end: string;
  days: number;
  generated_at: string;
  active_tracked_since: string;
  today: {
    date: string;
    signups: number;
    signups_yesterday: number;
    active_today: number;
    active_7d: number;
    active_30d: number;
    purchases: number;
    vouchers: number;
    revenue_paise: number;
    deletions_scheduled: number;
  };
  totals: {
    signups: number;
    deleted_since: number;
    average_per_day: number;
    best_day: string | null;
    best_day_signups: number;
    with_course: number;
    purchases: number;
    vouchers: number;
    revenue_paise: number;
    other_currency_purchases: number;
    total_users: number;
  };
  daily: DayRow[];
  by_class: Breakdown[];
  by_stream: Breakdown[];
  by_goal: Breakdown[];
}

export interface SignupRow {
  signed_up_at: string;
  name: string | null; // full name for the owner, first name only when masked
  class_level: number | null;
  stream: string | null;
  goals: string[];
  email: string | null; // masked by the server for viewers
  phone: string | null; // masked by the server for viewers
  has_course: boolean;
  deletion_scheduled: boolean;
}

export interface SignupList {
  start: string; // inclusive calendar days, YYYY-MM-DD
  end: string;
  timezone: string;
  masked: boolean; // viewers get masked contact details; the owner sees them in full
  more: boolean;
  signups: SignupRow[];
}

/** What every call needs: the display timezone (null while the settings load) and whether
 * lists come masked (the dashboard's read-only viewers). */
export interface UsersView {
  tz: string | null;
  masked: boolean;
}

export function useUsersView(): UsersView {
  const settings = useAppSettings();
  const { canWrite } = useAuth();
  const tz = settings.data?.display_timezone ?? (settings.isPending ? null : "Asia/Kolkata");
  return { tz, masked: !canWrite };
}

export const fetchStatus = () => adminFetch<AppUsersStatus>(`${AU_API}/status`);
export const fetchSummary = (sel: Selection, tz: string) =>
  adminFetch<AppUsersSummary>(`${AU_API}/summary`, { query: { ...sel, tz } });
export const fetchSignups = (start: string, end: string, view: UsersView) =>
  adminFetch<SignupList>(`${AU_API}/signups`, { query: { start, end, tz: view.tz ?? undefined, masked: view.masked || undefined } });
export interface DeletionItem {
  requested_at: string | null;
  status: string | null; // scheduled, reactivated, in_progress or completed
  due_at: string | null;
  completed_at: string | null;
  reactivated_at: string | null;
  signed_up_at: string | null;
  profile_exists: boolean; // false once permanently deleted (the app removes the profile)
  name: string | null;
  email: string | null; // masked by the server for viewers
  phone: string | null; // masked by the server for viewers
}

export interface DeletionList {
  start: string;
  end: string;
  timezone: string;
  masked: boolean;
  more: boolean;
  deletions: DeletionItem[];
}

export const fetchDeletions = (start: string, end: string, view: UsersView) =>
  adminFetch<DeletionList>(`${AU_API}/deletions`, { query: { start, end, tz: view.tz ?? undefined, masked: view.masked || undefined } });
export interface LiveNow {
  online_now: number; // distinct users in any signal below
  app_open: number | null; // app heartbeats; null until the app sends them
  using_app: number; // any app request in the last `online_window_minutes`
  watching_video: number; // last 25 seconds
  in_live_tutor: number; // last 30 seconds
  asking_doubts: number; // last 5 minutes
  taking_test: number; // last 5 minutes
  online_window_minutes: number;
  checked_at: string;
}

/** Online now from the admin API, plus "app open" from the app's heartbeats to this
 * dashboard. The two can't be matched person by person any more (the dashboard has no
 * database), so "online now" is the larger of the two counts. */
export async function fetchLive(): Promise<LiveNow> {
  const [live, presence] = await Promise.all([
    adminFetch<LiveNow>(`${AU_API}/live`),
    apiFetch<{ app_open: number | null }>(`${APP_USERS_API}/presence`).catch(() => ({ app_open: null })),
  ]);
  const appOpen = presence.app_open;
  return { ...live, app_open: appOpen, online_now: appOpen === null ? live.online_now : Math.max(live.online_now, appOpen) };
}

/** Today's calendar date (YYYY-MM-DD) in a timezone. */
export const todayIn = (timeZone: string) => new Intl.DateTimeFormat("en-CA", { timeZone }).format(new Date());
