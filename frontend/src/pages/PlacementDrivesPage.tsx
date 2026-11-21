import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useRef, useState, type KeyboardEvent } from "react";
import { DataTable, type Column } from "../components/DataTable";
import { ConfirmDialog, Dialog } from "../components/Dialog";
import { IconPlus } from "../components/icons";
import { useToast } from "../components/Toast";
import { Badge, Card, EmptyState, ErrorState, LoadingBlock, Notice, PageHeader } from "../components/ui";
import { deleteDrive, fetchDeletePlan, fetchDrives, fetchStatus, KEY, setActive, todayIst, type DriveSummary } from "./placementDrives/api";
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
        <div className="row" style={{ flexWrap: "nowrap" }}>
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
          {/* Any drive that is off; the dialog says what goes (results too, if students opened it). */}
          {/* Red and last, like Delete in Course Management. A drive that is on must be turned off first. */}
          <button type="button" className="btn btn-sm btn-danger" onClick={() => setRemoving(d)} disabled={d.active}
            title={d.active ? "Turn off to delete" : undefined}
            aria-label={`Delete ${d.label} (${d.date})`} aria-describedby={d.active ? `del-${d.date}` : undefined}>
            Delete
          </button>
          {d.active && (
            <span className="visually-hidden" id={`del-${d.date}`}>
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
      {removing && (
        <DeleteDriveDialog
          drive={removing}
          onClose={() => setRemoving(null)}
          onDeleted={() => {
            if (resultsDay === removing.date) setResultsDay(null);
            setRemoving(null);
          }}
        />
      )}
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

/** Delete a drive for good, like deleting a course: the server says what goes and what stops it,
 * and "delete" is typed to confirm. Students' attempts and results go with an opened drive. */
function DeleteDriveDialog({ drive, onClose, onDeleted }: { drive: DriveSummary; onClose: () => void; onDeleted: () => void }) {
  const confirmId = useId();
  const toast = useToast();
  const client = useQueryClient();
  const plan = useQuery({ queryKey: [...KEY, "delete-check", drive.date], queryFn: () => fetchDeletePlan(drive.date), retry: false, gcTime: 0 });
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const blocked = !plan.data || plan.data.blockers.length > 0;
  const opened = plan.data?.opened ?? 0;
  const close = () => !busy && onClose();

  async function remove() {
    setBusy(true);
    try {
      await deleteDrive(drive.date, opened > 0);
      toast.success(`${drive.label} (${window_(drive)}) is deleted${opened > 0 ? ", with its results" : ""}.`);
      await client.invalidateQueries({ queryKey: KEY });
      onDeleted();
    } catch (err) {
      toast.error(err, "The drive couldn't be deleted.");
      setBusy(false);
    }
  }

  return (
    <Dialog open onClose={close} title={`Delete ${drive.label}?`} description="Permanent: the app's database keeps no copy, so nothing can be brought back."
      footer={
        <>
          <button type="button" className="btn" onClick={close} data-initial-focus>Cancel</button>
          <button type="button" className="btn btn-danger" onClick={() => void remove()} disabled={blocked || typed.toLowerCase() !== "delete" || busy}>
            {busy ? "Deleting…" : "Delete for good"}
          </button>
        </>
      }>
      {plan.isPending ? (
        <LoadingBlock rows={3} label="Checking what goes" />
      ) : plan.error ? (
        <ErrorState error={plan.error} onRetry={() => void plan.refetch()} />
      ) : plan.data.blockers.length ? (
        <Notice tone="warning">
          <strong>This drive can't be deleted.</strong>
          <ul style={{ margin: "4px 0 0 16px" }}>{plan.data.blockers.map((b) => <li key={b}>{b}</li>)}</ul>
        </Notice>
      ) : (
        <div className="stack" style={{ gap: 12 }}>
          <div>
            <strong>Deleted from the app</strong>
            <ul style={{ margin: "4px 0 0 16px" }}>
              <li>The drive {plan.data.label} ({window_(drive)}) and its {plan.data.question_count} question{plan.data.question_count === 1 ? "" : "s"}</li>
              <li>
                {opened > 0
                  ? `${opened} student attempt${opened === 1 ? "" : "s"} (${plan.data.submitted} submitted): their answers, scores and results`
                  : "No student has opened it, so no results are lost"}
              </li>
              <li>Access codes students entered for it</li>
            </ul>
          </div>
          {opened > 0 && (
            <Notice tone="warning">
              Download the results first (Results tab, CSV or Excel) if you need them: after this, the results screen and downloads have nothing for this drive.
            </Notice>
          )}
          <div className="field">
            <label htmlFor={confirmId}>Type <strong>delete</strong> to confirm</label>
            <input id={confirmId} type="text" value={typed} onChange={(e) => setTyped(e.target.value.trim())} autoComplete="off" spellCheck={false} disabled={busy} />
          </div>
        </div>
      )}
    </Dialog>
  );
}
