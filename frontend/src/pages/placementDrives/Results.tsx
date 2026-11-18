import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { DataTable, type Column } from "../../components/DataTable";
import { IconRefresh } from "../../components/icons";
import { useToast } from "../../components/Toast";
import { Badge, Card, EmptyState, ErrorState, LoadingBlock, StatCard } from "../../components/ui";
import { downloadResults, fetchResults, KEY, todayIst, type DownloadTarget, type DriveSummary, type ResultRow } from "./api";

const LIVE_MS = 30_000;
const STATUS_TONE: Record<string, "normal" | "warning" | "critical" | "info" | "unavailable"> = {
  submitted: "normal",
  expired: "warning",
  abandoned: "critical",
  "opened, not submitted": "info",
  "not started": "unavailable",
  "no account": "unavailable",
};
const HEADERS: Record<string, string> = {
  candidate_name: "Candidate", roll_number: "Roll no.", college: "College", account_name: "Account name", email: "Email",
  phone: "Phone", status: "Status", score: "Score", max_score: "Max", percentage: "%", correct: "Correct", wrong: "Wrong",
  skipped: "Skipped", app_switches: "App switches", flagged: "Flagged", late: "Late", time_taken_min: "Time (min)",
  started_ist: "Started (IST)", submitted_ist: "Submitted (IST)",
};
const NUMERIC = new Set(["score", "max_score", "percentage", "correct", "wrong", "skipped", "app_switches", "time_taken_min"]);

const text = (v: ResultRow[string] | undefined) => (v === null || v === undefined || v === "" ? "" : String(v));
const score = (r: ResultRow) => (typeof r.score === "number" ? r.score : -Infinity);

export function Results({ drives, day, onDay }: { drives: DriveSummary[]; day: string | null; onDay: (day: string) => void }) {
  const toast = useToast();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [order, setOrder] = useState<"desc" | "asc">("desc");
  const [busy, setBusy] = useState<string | null>(null);
  const [range, setRange] = useState({ start: "", end: todayIst() });
  const results = useQuery({
    queryKey: [...KEY, "results", day],
    queryFn: () => fetchResults(day!),
    enabled: day !== null,
    refetchInterval: LIVE_MS,
    refetchIntervalInBackground: false,
    retry: false,
  });
  const data = results.data;

  const statuses = useMemo(() => [...new Set((data?.rows ?? []).map((r) => text(r.status)).filter(Boolean))], [data]);
  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    const out = (data?.rows ?? []).filter((r) => {
      if (status !== "all" && text(r.status) !== status) return false;
      if (!q) return true;
      return [r.candidate_name, r.account_name, r.email, r.roll_number].some((v) => text(v).toLowerCase().includes(q));
    });
    return [...out].sort((a, b) => (order === "desc" ? score(b) - score(a) : score(a) - score(b)) || text(a.email).localeCompare(text(b.email)));
  }, [data, search, status, order]);

  const columns: Column<ResultRow>[] = (data?.fields ?? []).map((field) => ({
    key: field,
    header: HEADERS[field] ?? field,
    numeric: NUMERIC.has(field),
    sortable: field === "score",
    render: (r: ResultRow) =>
      field === "status" && text(r.status) ? (
        <Badge tone={STATUS_TONE[text(r.status)] ?? "info"}>{text(r.status)}</Badge>
      ) : field === "flagged" || field === "late" ? (
        r[field] === true ? "Yes" : r[field] === false ? "No" : ""
      ) : (
        text(r[field])
      ),
  }));

  async function download(target: DownloadTarget, format: "csv" | "xlsx", id: string) {
    setBusy(id);
    try {
      await downloadResults(target, format);
    } catch (err) {
      toast.error(err, "The download failed.");
    } finally {
      setBusy(null);
    }
  }

  if (drives.length === 0) return <EmptyState title="No drives yet">Create a drive first; its results appear here as students take it.</EmptyState>;
  const s = data?.summary;
  const rangeOk = range.start && range.end && range.start <= range.end;

  return (
    <div className="stack" style={{ gap: 16 }}>
      <Card>
        <div className="filters">
          <div className="field">
            <label htmlFor="pd-results-drive">Drive</label>
            <select id="pd-results-drive" value={day ?? ""} onChange={(e) => onDay(e.target.value)}>
              {day === null && <option value="">Choose a drive</option>}
              {drives.map((d) => (
                <option key={d.date} value={d.date}>
                  {d.label}: {d.open_from && d.open_from !== d.date ? `${d.open_from} to ${d.date}` : d.date}
                  {d.active ? " (on)" : ""}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="pd-results-search">Search</label>
            <input id="pd-results-search" type="search" placeholder="Name, email or roll number" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="pd-results-status">Status</label>
            <select id="pd-results-status" value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="all">All</option>
              {statuses.map((st) => (
                <option key={st} value={st}>
                  {st}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="pd-results-order">Sort by score</label>
            <select id="pd-results-order" value={order} onChange={(e) => setOrder(e.target.value as "asc" | "desc")}>
              <option value="desc">Highest first</option>
              <option value="asc">Lowest first</option>
            </select>
          </div>
          <div className="field">
            <span className="label">Live, every 30 s</span>
            <button type="button" className="btn" onClick={() => void results.refetch()} disabled={day === null || results.isFetching}>
              <IconRefresh size={14} /> {results.isFetching ? "Refreshing…" : "Refresh"}
            </button>
          </div>
        </div>
      </Card>

      {day === null ? null : results.isPending ? (
        <LoadingBlock rows={5} label="Loading results" />
      ) : results.error ? (
        <ErrorState error={results.error} onRetry={() => void results.refetch()} />
      ) : (
        s && (
          <>
            <div className="grid grid-stats">
              <StatCard label="Opened" value={s.opened} />
              <StatCard label="Submitted" value={s.submitted} tone="normal" />
              <StatCard label="Not submitted" value={s.not_submitted} sub="Opened the paper, no submission yet" tone={s.not_submitted ? "warning" : undefined} />
              <StatCard label="Average score" value={s.average_score ?? "—"} sub={`out of ${text(data.answer_key.max_score)}`} />
              <StatCard label="Highest score" value={s.highest_score ?? "—"} />
              {!data.drive.audience_all && <StatCard label="Not started" value={s.not_started} sub="Invited emails that haven't opened it" />}
            </div>
            <Card
              title={`Results: ${data.drive.label}`}
              description={`${rows.length} of ${data.rows.length} rows · the same columns as the Google Sheet · updated ${new Date(results.dataUpdatedAt).toLocaleTimeString("en-IN")}`}
              actions={
                <div className="row">
                  <button type="button" className="btn btn-sm" disabled={busy !== null} onClick={() => void download({ date: day }, "csv", "csv")}>
                    {busy === "csv" ? "Preparing…" : "Download CSV"}
                  </button>
                  <button type="button" className="btn btn-sm" disabled={busy !== null} onClick={() => void download({ date: day }, "xlsx", "xlsx")}>
                    {busy === "xlsx" ? "Preparing…" : "Download Excel"}
                  </button>
                </div>
              }
            >
              <DataTable
                caption={`Results for ${data.drive.label} (${day})`}
                columns={columns}
                rows={rows}
                rowKey={(r) => `${text(r.email)}|${text(r.roll_number)}|${text(r.started_ist)}`}
                sort={{ key: "score", order }}
                onSort={() => setOrder((o) => (o === "desc" ? "asc" : "desc"))}
                empty={<EmptyState title={data.rows.length ? "No matching rows" : "Nobody has opened it yet"}>{data.rows.length ? "Change the search or status." : "Results appear here within 30 seconds of a student opening the paper."}</EmptyState>}
              />
              <p className="small muted">
                Answer key: {data.fields.filter((f) => /^Q\d+$/.test(f)).map((f) => `${f} ${text(data.answer_key[f])}`).join(" · ")}
              </p>
            </Card>
          </>
        )
      )}

      <Card title="Download by date" description="Every drive whose last day falls in these dates, in one file with a drive_date column. Each drive ends with its ANSWER KEY row.">
        <div className="row" style={{ alignItems: "flex-end" }}>
          <div className="field">
            <label htmlFor="pd-range-start">From</label>
            <input id="pd-range-start" type="date" value={range.start} onChange={(e) => setRange((r) => ({ ...r, start: e.target.value }))} />
          </div>
          <div className="field">
            <label htmlFor="pd-range-end">To</label>
            <input id="pd-range-end" type="date" value={range.end} onChange={(e) => setRange((r) => ({ ...r, end: e.target.value }))} />
          </div>
          <button type="button" className="btn" disabled={!rangeOk || busy !== null} onClick={() => void download(range, "csv", "range-csv")}>
            {busy === "range-csv" ? "Preparing…" : "CSV"}
          </button>
          <button type="button" className="btn" disabled={!rangeOk || busy !== null} onClick={() => void download(range, "xlsx", "range-xlsx")}>
            {busy === "range-xlsx" ? "Preparing…" : "Excel"}
          </button>
        </div>
        {range.start && range.end && range.start > range.end && <p className="small" style={{ color: "var(--warning)" }}>The start is after the end.</p>}
      </Card>
    </div>
  );
}
