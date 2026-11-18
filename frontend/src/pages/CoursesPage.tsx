import { useRef, type KeyboardEvent, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import { PageHeader } from "../components/ui";
import { AppAcademics, AppCourses } from "./courses/AppCourses";
import { AppVideos } from "./courses/AppVideos";
import { SecretGate } from "./vouchers/SecretGate";

/** WAI-ARIA tabs kept in ?tab=. */
export function Tabs<T extends string>({ tabs, label, children }: { tabs: readonly { id: T; label: string }[]; label: string; children: (tab: T) => ReactNode }) {
  const [params, setParams] = useSearchParams();
  const requested = params.get("tab");
  const tab = (tabs.some((t) => t.id === requested) ? requested : tabs[0]!.id) as T;
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});
  const select = (id: T) => setParams((p) => { const next = new URLSearchParams(p); next.set("tab", id); return next; }, { replace: true });
  const onKeyDown = (e: KeyboardEvent) => {
    const i = tabs.findIndex((t) => t.id === tab);
    const next = e.key === "ArrowRight" ? (i + 1) % tabs.length : e.key === "ArrowLeft" ? (i - 1 + tabs.length) % tabs.length : -1;
    if (next < 0) return;
    e.preventDefault();
    select(tabs[next]!.id);
    refs.current[tabs[next]!.id]?.focus();
  };
  return (
    <>
      <div className="tabs" role="tablist" aria-label={label}>
        {tabs.map((t) => (
          <button key={t.id} ref={(el) => { refs.current[t.id] = el; }} type="button" role="tab" id={`tab-${t.id}`} aria-selected={tab === t.id}
            aria-controls={`panel-${t.id}`} tabIndex={tab === t.id ? 0 : -1} className={`tab ${tab === t.id ? "active" : ""}`}
            onClick={() => select(t.id)} onKeyDown={onKeyDown}>{t.label}</button>
        ))}
      </div>
      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>{children(tab)}</div>
    </>
  );
}

const TABS = [
  { id: "app", label: "App videos" },
  { id: "prices", label: "Courses & prices" },
  { id: "taxonomy", label: "Classes, streams & goals" },
] as const;

export function CoursesPage() {
  return (
    <>
      <PageHeader title="Course Management" description="The AdhyaapakAI app's lectures, courses, prices and home-screen cards." />
      <Tabs tabs={TABS} label="Course management">
        {(tab) => (
          // Every tab uses the AdhyaapakAI backend's admin API (like Voucher Management).
          <SecretGate title="Course Management" checkPath="/admin/catalog/status">
            {tab === "app" ? <AppVideos /> : tab === "prices" ? <AppCourses /> : <AppAcademics />}
          </SecretGate>
        )}
      </Tabs>
    </>
  );
}
