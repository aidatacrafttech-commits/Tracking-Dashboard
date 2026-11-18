import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState, type KeyboardEvent } from "react";
import { DataTable, type Column } from "../components/DataTable";
import { ConfirmDialog } from "../components/Dialog";
import { IconPlus } from "../components/icons";
import { useToast } from "../components/Toast";
import { Badge, Card, EmptyState, ErrorState, LoadingBlock, Notice, PageHeader } from "../components/ui";
import { deleteDrive, fetchDrives, fetchStatus, KEY, setActive, todayIst, type DriveSummary } from "./placementDrives/api";
import { DriveEditor } from "./placementDrives/DriveEditor";
import { SecretGate } from "./vouchers/SecretGate";
import { Results } from "./placementDrives/Results";

const TABS = [
  { id: "drives", label: "Drives" },
  { id: "results", label: "Results" },
] as const;
type Tab = (typeof TABS)[number]["id"];
type View = { kind: "list" } | { kind: "edit"; day: string | null };

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const short = (iso: string) => {
  const [y, m, d] = iso.split("-").map(Number);
  return `${d} ${MONTHS[(m ?? 1) - 1]} ${y}`;
};
const window_ = (d: DriveSummary) => (d.open_from && d.open_from !== d.date ? `${short(d.open_from)} → ${short(d.date)}` : short(d.date));

function state(d: DriveSummary, today: string): { tone: "normal" | "info" | "unavailable"; label: string } {
  if (!d.active) return { tone: "unavailable", label: "Off" };
  if (d.date < today) return { tone: "unavailable", label: "On (ended)" };
  if ((d.open_from ?? d.date) > today) return { tone: "info", label: "On (upcoming)" };
  return { tone: "normal", label: "On (open now)" };
}

/** Everything here goes through the AdhyaapakAI backend's admin API (/admin/placement), with
 * the admin secret typed into this tab, like Voucher Management. */
export function PlacementDrivesPage() {
  return (
    <SecretGate title="Placement Drives" checkPath="/admin/placement/status">
      <PlacementDrives />
    </SecretGate>
  );
}

function PlacementDrives() {
  const [tab, setTab] = useState<Tab>("drives");
  const [view, setView] = useState<View>({ kind: "list" });
  const [resultsDay, setResultsDay] = useState<string | null>(null);
  const [toggle, setToggle] = useState<DriveSummary | null>(null);
  const [toggling, setToggling] = useState(false);
  const [removing, setRemoving] = useState<DriveSummary | null>(null);
  const [deleting, setDeleting] = useState(false);
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});
  const toast = useToast();
  const client = useQueryClient();
  const today = todayIst();

  const status = useQuery({ queryKey: [...KEY, "status"], queryFn: fetchStatus, staleTime: Infinity, retry: false });
  const configured = status.data?.configured === true;
  const drives = useQuery({ queryKey: [...KEY, "drives"], queryFn: fetchDrives, enabled: configured, refetchInterval: 30_000, retry: false });
  const list = drives.data ?? [];
  const day = resultsDay ?? list[0]?.date ?? null;

  function select(id: Tab) {
    setTab(id);
    setView({ kind: "list" });
    refs.current[id]?.focus();
  }
  function onKeyDown(e: KeyboardEvent<HTMLButtonElement>) {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    const i = TABS.findIndex((t) => t.id === tab);
    select(TABS[(i + (e.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length]!.id);
  }
  function openResults(d: string) {
    setResultsDay(d);
    setTab("results");
    setView({ kind: "list" });
  }

  async function confirmToggle() {
    if (!toggle) return;
    setToggling(true);
    try {
      await setActive(toggle.date, !toggle.active);
      toast.success(toggle.active ? `${toggle.label} is off. Results are kept.` : `${toggle.label} is on.`);
      await client.invalidateQueries({ queryKey: KEY });
      setToggle(null);
    } catch (err) {
      toast.error(err, "The drive couldn't be switched.");
    } finally {
      setToggling(false);
    }
  }

  async function confirmDelete() {
    if (!removing) return;
    setDeleting(true);
    try {
      await deleteDrive(removing.date);
      toast.success(`${removing.label} (${window_(removing)}) is deleted.`);
      if (resultsDay === removing.date) setResultsDay(null);
      await client.invalidateQueries({ queryKey: KEY });
      setRemoving(null);
    } catch (err) {
      toast.error(err, "The drive couldn't be deleted.");
      setRemoving(null);
    } finally {
      setDeleting(false);
    }
  }

  const columns: Column<DriveSummary>[] = [
    {
      key: "label",
      header: "Drive",
      render: (d) => (
        <div>
          <strong>{d.label}</strong>
          <div className="small muted">{d.full_name}</div>
        </div>
      ),
    },
    { key: "window", header: "Open (IST)", render: (d) => window_(d) },
    { key: "duration", header: "Duration", render: (d) => `${d.duration_min ?? "—"} min`, numeric: true },
    { key: "questions", header: "Questions", render: (d) => d.question_count, numeric: true },
    {
      key: "who",
      header: "Who",
      render: (d) => (
        <div className="small">
          {d.audience_all
            ? [
                "Everyone",
                d.audience_classes?.length ? d.audience_classes.map((c) => `Class ${c}`).join(", ") : null,
                d.audience_streams?.length ? d.audience_streams.join(", ") : null,
                d.audience_goals?.length ? d.audience_goals.join(", ") : null,
              ].filter(Boolean).join(" · ")
            : `${d.audience_count} email${d.audience_count === 1 ? "" : "s"}`}
          <div className="muted">{d.has_access_code ? "Code set" : "No code"}{d.has_sheet_key ? " · Live sheet" : ""}</div>
        </div>
      ),
    },
    {
      key: "state",
      header: "Status",
      render: (d) => {
        const st = state(d, today);
        return <Badge tone={st.tone}>{st.label}</Badge>;
      },
    },
    { key: "submitted", header: "Submitted", render: (d) => `${d.submitted} of ${d.opened} opened`, numeric: true },
    {
      key: "actions",
      header: "Actions",
      render: (d) => (
        <div className="row">
          <button type="button" className="btn btn-sm" onClick={() => setView({ kind: "edit", day: d.date })} aria-label={`Edit ${d.label} (${d.date})`}>
            Edit
          </button>
          <button type="button" className={`btn btn-sm ${d.active ? "btn-danger" : "btn-primary"}`} onClick={() => setToggle(d)}
            aria-label={`${d.active ? "Turn off" : "Turn on"} ${d.label} (${d.date})`}>
            {d.active ? "Turn off" : "Turn on"}
          </button>
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => openResults(d.date)} aria-label={`Results for ${d.label} (${d.date})`}>
            Results
          </button>
          {/* Only a drive nobody has opened: results need the drive's paper and answer key. */}
          {d.opened === 0 && (
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setRemoving(d)} disabled={d.active}
              aria-label={`Delete ${d.label} (${d.date})`} aria-describedby={d.active ? `del-${d.date}` : undefined}>
              Delete
            </button>
          )}
          {d.opened === 0 && d.active && (
            <span className="small muted" id={`del-${d.date}`}>
              Turn off to delete
            </span>
          )}
        </div>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Placement Drives"
        description="The AdhyaapakAI app's placement drives: papers, dates, who can take them, and live results. Times in IST."
        actions={
          configured &&
          view.kind === "list" && (
            <button type="button" className="btn btn-primary" onClick={() => { setTab("drives"); setView({ kind: "edit", day: null }); }}>
              <IconPlus size={16} /> New drive
            </button>
          )
        }
      />
      {status.isPending ? (
        <LoadingBlock rows={3} />
      ) : status.error ? (
        <ErrorState error={status.error} onRetry={() => void status.refetch()} />
      ) : !configured ? (
        <Notice tone="warning">
          <strong>Placement drives are not configured.</strong> The AdhyaapakAI backend has no database: set <code>MONGO_URL</code> and{" "}
          <code>DB_NAME</code> in its <code>.env</code> and restart it.
        </Notice>
      ) : (
        <>
          <div className="tabs" role="tablist" aria-label="Placement drives">
            {TABS.map((t) => (
              <button key={t.id} ref={(el) => { refs.current[t.id] = el; }} type="button" role="tab" id={`tab-${t.id}`}
                aria-selected={tab === t.id} aria-controls={`panel-${t.id}`} tabIndex={tab === t.id ? 0 : -1}
                className={`tab ${tab === t.id ? "active" : ""}`} onClick={() => select(t.id)} onKeyDown={onKeyDown}>
                {t.label}
              </button>
            ))}
          </div>
          <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
            {tab === "drives" && view.kind === "edit" ? (
              <DriveEditor
                key={view.day ?? "new"}
                day={view.day}
                onCancel={() => setView({ kind: "list" })}
                onDone={() => setView({ kind: "list" })}
              />
            ) : tab === "drives" ? (
              drives.isPending ? (
                <LoadingBlock rows={4} label="Loading drives" />
              ) : drives.error ? (
                <ErrorState error={drives.error} onRetry={() => void drives.refetch()} />
              ) : (
                <Card
                  title="All drives"
                  description={
                    status.data?.multiple
                      ? "Several drives can be on for the same day: the app shows a card for each, one below the other. Turning a drive off hides it from the app at once; results are kept."
                      : "Only one drive can be on for any day. Turning a drive off hides it from the app at once; results are kept."
                  }
                >
                  <DataTable
                    caption="Placement drives"
                    columns={columns}
                    rows={list}
                    rowKey={(d) => d.date}
                    empty={<EmptyState title="No drives yet">Create one with "New drive": upload the paper as a PDF, check it, set the dates and code, and turn it on.</EmptyState>}
                  />
                </Card>
              )
            ) : (
              <Results drives={list} day={day} onDay={setResultsDay} />
            )}
          </div>
        </>
      )}
      <ConfirmDialog
        open={removing !== null}
        title="Delete this drive?"
        confirmLabel="Delete"
        destructive
        busy={deleting}
        onConfirm={() => void confirmDelete()}
        onCancel={() => setRemoving(null)}
      >
        {removing && `${removing.label} (${window_(removing)}) and its ${removing.question_count} questions are removed from the app's database for good. Nobody has opened it, so no results are lost. This can't be undone.`}
      </ConfirmDialog>
      <ConfirmDialog
        open={toggle !== null}
        title={toggle?.active ? "Turn this drive off?" : "Turn this drive on?"}
        confirmLabel={toggle?.active ? "Turn off" : "Turn on"}
        destructive={toggle?.active}
        busy={toggling}
        onConfirm={() => void confirmToggle()}
        onCancel={() => setToggle(null)}
      >
        {toggle?.active
          ? `${toggle.label} disappears from the app straight away. Students who haven't submitted can't finish it. Results are kept.`
          : `${toggle?.label} appears in the app for its audience on ${toggle ? window_(toggle) : ""}${toggle?.has_access_code ? ", after they enter the code" : " (no code is set)"}.`}
      </ConfirmDialog>
    </>
  );
}
