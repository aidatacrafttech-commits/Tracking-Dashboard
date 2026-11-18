import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { ApiError } from "../../api/client";
import { ConfirmDialog, Dialog } from "../../components/Dialog";
import { useToast } from "../../components/Toast";
import { Card, ErrorState, LoadingBlock, Notice } from "../../components/ui";
import {
  createDrive, fetchDrive, KEY, MAX_PDF_MB, newSheetKey, parsePdf, questionsFromJson, todayIst, updateDrive,
  type DriveDetail, type DriveInput, type SavedDrive,
} from "./api";
import { newId, problemsOf, QuestionReview, type EditableQuestion } from "./QuestionReview";
import { goalsFor, useAcademics } from "../courses/appCoursesApi";

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const emailsIn = (text: string) => [...new Set((text.match(EMAIL) ?? []).map((e) => e.toLowerCase()))].sort();

interface Form {
  label: string;
  full_name: string;
  exam: string;
  open_from: string;
  date: string;
  duration_min: string;
  correct: string;
  wrong: string;
  everyone: boolean;
  // "Everyone" aimed at these (none ticked = any), matched like the app's home-screen cards.
  classes: number[];
  streams: string[];
  goals: string[];
  emails: string;
  access_code: string; // empty = keep (edit) / none (new)
  remove_code: boolean;
  sheet_key: string; // a new key to set; empty = keep
  remove_sheet_key: boolean;
  active: boolean;
}

const EMPTY: Form = {
  label: "Placement Drive", full_name: "", exam: "Placement Drive", open_from: "", date: "", duration_min: "25",
  correct: "1", wrong: "0", everyone: true, classes: [], streams: [], goals: [], emails: "", access_code: "", remove_code: false, sheet_key: "",
  remove_sheet_key: false, active: false,
};

function formFrom(d: DriveDetail): Form {
  return {
    ...EMPTY,
    label: d.label, full_name: d.full_name, exam: d.exam || "Placement Drive", open_from: d.open_from ?? "", date: d.date,
    duration_min: String(d.duration_min ?? ""), correct: String(d.marking.correct ?? 1), wrong: String(d.marking.wrong ?? 0),
    everyone: d.audience_all, emails: d.emails.join("\n"), active: d.active,
    classes: d.audience_classes ?? [], streams: d.audience_streams ?? [], goals: d.audience_goals ?? [],
  };
}

type Props = { day: string | null; onDone: (day: string) => void; onCancel: () => void };

/** Create (day = null) or edit a drive: loads the drive, then shows the form. */
export function DriveEditor(props: Props) {
  const { day } = props;
  const existing = useQuery({ queryKey: [...KEY, "drive", day], queryFn: () => fetchDrive(day!), enabled: day !== null, retry: false });
  if (day === null) return <EditorForm {...props} drive={null} />;
  if (existing.isPending) return <LoadingBlock rows={6} label="Loading the drive" />;
  if (existing.error) return <ErrorState error={existing.error} onRetry={() => void existing.refetch()} />;
  return <EditorForm {...props} drive={existing.data} />;
}

function EditorForm({ day, drive, onDone, onCancel }: Props & { drive: DriveDetail | null }) {
  const toast = useToast();
  const client = useQueryClient();
  const [form, setForm] = useState<Form>(() => (drive ? formFrom(drive) : { ...EMPTY, date: todayIst() }));
  const [questions, setQuestions] = useState<EditableQuestion[]>(() =>
    (drive?.questions ?? []).map((q) => ({ ...q, id: newId(), notes: [] })),
  );
  const [reading, setReading] = useState(false);
  const [readNote, setReadNote] = useState<{ tone: "info" | "warning"; lines: string[] } | null>(null);
  const [pending, setPending] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);
  const [saved, setSaved] = useState<SavedDrive | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const emailFileRef = useRef<HTMLInputElement>(null);
  const locked = drive?.locked === true;

  const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm((f) => ({ ...f, [key]: value }));

  async function readPaper(file: File) {
    setPending(null);
    setReadNote(null);
    const isPdf = file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
    const isJson = file.type === "application/json" || file.name.toLowerCase().endsWith(".json");
    if (!isPdf && !isJson) {
      setReadNote({ tone: "warning", lines: ["Upload a PDF, or a paper in the app's JSON format."] });
      return;
    }
    if (isPdf && file.size > MAX_PDF_MB * 1024 * 1024) {
      setReadNote({ tone: "warning", lines: [`The PDF is larger than ${MAX_PDF_MB} MB.`] });
      return;
    }
    setReading(true);
    try {
      if (isPdf) {
        const parsed = await parsePdf(file);
        setQuestions(parsed.questions.map((q) => ({ ...q, id: newId(), notes: q.review_notes })));
        if (!form.full_name && parsed.title) set("full_name", parsed.title);
        const flagged = parsed.questions.filter((q) => q.needs_review).length;
        setReadNote({
          tone: flagged || parsed.warnings.length ? "warning" : "info",
          lines: [
            `Read ${parsed.questions.length} questions from ${file.name}${parsed.answer_key_found ? ", with its answer key" : ""}.`,
            ...(flagged ? [`${flagged} question${flagged === 1 ? "" : "s"} need${flagged === 1 ? "s" : ""} checking (marked below).`] : []),
            ...parsed.warnings,
            "Check every question before saving. The PDF was not stored.",
          ],
        });
      } else {
        const { questions: qs, meta } = questionsFromJson(await file.text());
        setQuestions(qs.map((q) => ({ ...q, id: newId(), notes: q.review_notes })));
        setForm((f) => ({
          ...f,
          label: meta.label ?? f.label,
          full_name: meta.full_name ?? f.full_name,
          exam: meta.exam ?? f.exam,
          duration_min: meta.duration_min !== undefined ? String(meta.duration_min) : f.duration_min,
          correct: meta.marking ? String(meta.marking.correct) : f.correct,
          wrong: meta.marking ? String(meta.marking.wrong) : f.wrong,
        }));
        setReadNote({ tone: "info", lines: [`Read ${qs.length} questions from ${file.name}. The dates, audience and code are set here, not from the file.`] });
      }
    } catch (err) {
      setReadNote({ tone: "warning", lines: [err instanceof Error ? err.message : "The file couldn't be read."] });
    } finally {
      setReading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  function chooseFile(file: File | undefined) {
    if (!file) return;
    if (questions.length > 0) setPending(file);
    else void readPaper(file);
  }

  async function addEmailsFrom(file: File | undefined) {
    if (!file) return;
    const found = emailsIn(await file.text());
    set("emails", emailsIn(`${form.emails}\n${found.join("\n")}`).join("\n"));
    toast.success(`${found.length} email${found.length === 1 ? "" : "s"} found in ${file.name}.`);
    if (emailFileRef.current) emailFileRef.current.value = "";
  }

  function check(): string[] {
    const out: string[] = [];
    if (!form.label.trim()) out.push("Add a label (shown on the app's card).");
    if (!form.full_name.trim()) out.push("Add the full name.");
    if (!form.date) out.push("Pick the last day.");
    if (form.open_from && form.date && form.open_from > form.date) out.push("The first day is after the last day.");
    const minutes = Number(form.duration_min);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 600) out.push("Duration must be 1-600 whole minutes.");
    if (!(Number(form.correct) > 0)) out.push("Marks for a correct answer must be above 0.");
    if (!(Number(form.wrong) <= 0)) out.push("Marks for a wrong answer must be 0 or negative.");
    if (!form.everyone && emailsIn(form.emails).length === 0) out.push("Add at least one email, or open it to everyone.");
    const code = form.access_code.replace(/\s+/g, "");
    if (code && code.length < 4) out.push("The access code needs at least 4 characters.");
    if (!locked) {
      if (questions.length === 0) out.push("Add the questions: upload a PDF or JSON, or add them by hand.");
      questions.forEach((q, i) => problemsOf(q).forEach((p) => out.push(`Q${i + 1}: ${p}`)));
    }
    return out;
  }

  async function save() {
    const found = check();
    setProblems(found);
    if (found.length) return;
    const body: DriveInput = {
      label: form.label.trim(),
      full_name: form.full_name.trim(),
      exam: form.exam.trim() || "Placement Drive",
      open_from: form.open_from || null,
      date: form.date,
      duration_min: Number(form.duration_min),
      marking: { correct: Number(form.correct), wrong: Number(form.wrong) },
      audience: form.everyone
        ? { all: true, emails: [], classes: form.classes, streams: form.streams, goals: form.goals }
        : { all: false, emails: emailsIn(form.emails), classes: [], streams: [], goals: [] },
      access_code: form.remove_code ? "" : form.access_code.trim() || null,
      sheet_key: form.remove_sheet_key ? "" : form.sheet_key || null,
      questions: locked ? null : questions.map(({ section, question, options, correct_answer, explanation }) => ({
        section: section.trim(), question: question.trim(), options: options.map((o) => o.trim()), correct_answer, explanation: explanation.trim(),
      })),
      active: day === null ? form.active : null,
    };
    setSaving(true);
    try {
      const out = day === null ? await createDrive(body) : await updateDrive(day, body);
      await client.invalidateQueries({ queryKey: KEY });
      toast.success(day === null ? "Drive created." : "Drive saved.");
      if (out.sheet_key) setSaved(out);
      else onDone(out.drive.date);
    } catch (err) {
      const details = err instanceof ApiError ? (err.details as { problems?: string[] } | null) : null;
      if (details?.problems) setProblems(details.problems);
      toast.error(err, "The drive couldn't be saved.");
    } finally {
      setSaving(false);
    }
  }

  const emailCount = emailsIn(form.emails).length;
  const d = drive;
  return (
    <div className="stack" style={{ gap: 16 }}>
      <Card
        title={day === null ? "New placement drive" : `Edit: ${d?.label ?? day}`}
        description="Students see it in the app's Tests tab on these days (India time), once they enter the code."
      >
        <div className="form-grid">
          <Field id="pd-label" label="Label (on the app's card)" value={form.label} onChange={(v) => set("label", v)} />
          <Field id="pd-full" label="Full name" value={form.full_name} onChange={(v) => set("full_name", v)} />
          <Field id="pd-from" label="First day (optional)" type="date" value={form.open_from} onChange={(v) => set("open_from", v)}
            hint="Leave empty for a one-day drive." />
          <Field id="pd-date" label="Last day" type="date" value={form.date} onChange={(v) => set("date", v)} disabled={locked}
            hint={locked ? "Fixed: students have started (their attempts and the sheet link use it)." : "Open until midnight IST."} />
          <Field id="pd-duration" label="Duration (minutes)" type="number" value={form.duration_min} onChange={(v) => set("duration_min", v)} />
          <Field id="pd-correct" label="Marks: correct" type="number" value={form.correct} onChange={(v) => set("correct", v)} disabled={locked} />
          <Field id="pd-wrong" label="Marks: wrong (0 or negative)" type="number" value={form.wrong} onChange={(v) => set("wrong", v)} disabled={locked} />
        </div>
      </Card>

      <Card title="Who can take it">
        <div className="stack">
          <label className="row">
            <input type="radio" name="pd-audience" checked={form.everyone} onChange={() => set("everyone", true)} /> Everyone with the app (and the code)
          </label>
          {form.everyone && (
            <AudiencePicker classes={form.classes} streams={form.streams} goals={form.goals}
              onChange={(patch) => setForm((f) => ({ ...f, ...patch }))} />
          )}
          <label className="row">
            <input type="radio" name="pd-audience" checked={!form.everyone} onChange={() => set("everyone", false)} /> Only these emails
          </label>
          {!form.everyone && (
            <div className="field">
              <label htmlFor="pd-emails">Emails ({emailCount}): paste them, one per line or any separator</label>
              <textarea id="pd-emails" rows={5} value={form.emails} onChange={(e) => set("emails", e.target.value)} />
              <div className="row">
                <button type="button" className="btn btn-sm" onClick={() => emailFileRef.current?.click()}>
                  Add from a file (.txt or .csv)
                </button>
                <input ref={emailFileRef} type="file" accept=".txt,.csv,text/plain,text/csv" hidden
                  onChange={(e) => void addEmailsFrom(e.target.files?.[0])} aria-label="Email list file" />
              </div>
            </div>
          )}
        </div>
      </Card>

      <Card title="Access code and live sheet" description="Both are stored only as a hash. Nobody can read them back later.">
        <div className="form-grid">
          <Field id="pd-code" label={d?.has_access_code ? "New access code (empty = keep the current one)" : "Access code (empty = no code)"}
            value={form.access_code} onChange={(v) => set("access_code", v)} disabled={form.remove_code}
            hint="Students type it in the app. Capital or small letters and spaces don't matter." autoComplete="off" />
        </div>
        {d?.has_access_code && (
          <label className="row small">
            <input type="checkbox" checked={form.remove_code} onChange={(e) => set("remove_code", e.target.checked)} /> Remove the code (anyone in the audience can open it)
          </label>
        )}
        <div className="row" style={{ marginTop: 12 }}>
          <button type="button" className="btn btn-sm" disabled={form.remove_sheet_key}
            onClick={() => void newSheetKey().then((k) => set("sheet_key", k), (err) => toast.error(err))}>
            {d?.has_sheet_key ? "Make a new sheet key" : "Make a sheet key"}
          </button>
          <span className="small muted">
            {form.sheet_key ? "A new key will be set when you save, and shown once with the Google Sheets formula."
              : d?.has_sheet_key ? "A live-sheet key is set." : "No live Google Sheet yet."}
          </span>
        </div>
        {d?.has_sheet_key && (
          <label className="row small">
            <input type="checkbox" checked={form.remove_sheet_key} onChange={(e) => set("remove_sheet_key", e.target.checked)} /> Remove the key (the sheet link stops working)
          </label>
        )}
        {day === null && (
          <label className="row" style={{ marginTop: 12 }}>
            <input type="checkbox" checked={form.active} onChange={(e) => set("active", e.target.checked)} /> Turn it on when saved
          </label>
        )}
      </Card>

      <Card
        title="Questions"
        description="Upload the paper as a PDF (max 10 MB) or in the app's JSON format, then check each question. Nothing is saved until you press Save."
        actions={
          !locked && (
            <>
              <button type="button" className="btn" onClick={() => fileRef.current?.click()} disabled={reading}>
                {reading ? "Reading…" : "Upload PDF or JSON"}
              </button>
              <input ref={fileRef} type="file" accept=".pdf,.json,application/pdf,application/json" hidden
                onChange={(e) => chooseFile(e.target.files?.[0])} aria-label="Question paper file" />
            </>
          )
        }
      >
        {readNote && (
          <Notice tone={readNote.tone}>
            {readNote.lines.map((l) => (
              <div key={l}>{l}</div>
            ))}
          </Notice>
        )}
        <QuestionReview questions={questions} onChange={setQuestions} locked={locked} />
      </Card>

      {problems.length > 0 && (
        <Notice tone="critical">
          <strong>Fix these before saving:</strong>
          <ul style={{ margin: "6px 0 0" }}>
            {problems.slice(0, 15).map((p) => (
              <li key={p}>{p}</li>
            ))}
            {problems.length > 15 && <li>…and {problems.length - 15} more.</li>}
          </ul>
        </Notice>
      )}
      <div className="row">
        <button type="button" className="btn btn-primary" onClick={() => void save()} disabled={saving || reading}>
          {saving ? "Saving…" : day === null ? "Create drive" : "Save changes"}
        </button>
        <button type="button" className="btn btn-ghost" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
      </div>

      <ConfirmDialog
        open={pending !== null}
        title="Replace the questions?"
        confirmLabel="Replace"
        destructive
        onConfirm={() => pending && void readPaper(pending)}
        onCancel={() => setPending(null)}
      >
        The {questions.length} questions below will be replaced by the ones in {pending?.name}.
      </ConfirmDialog>

      <Dialog
        open={saved !== null}
        onClose={() => saved && onDone(saved.drive.date)}
        title="Live sheet key"
        description="Copy it now: it is stored only as a hash and will not be shown again."
        footer={
          <button type="button" className="btn btn-primary" onClick={() => saved && onDone(saved.drive.date)}>
            Done
          </button>
        }
      >
        {saved && (
          <div className="stack">
            <CopyField label="Sheet key" value={saved.sheet_key ?? ""} />
            <CopyField label="Paste this into cell A1 of a Google Sheet" value={saved.sheet_formula ?? ""} />
            <p className="small muted">Share the sheet only with the people who need it: anyone who can edit it can see the key.</p>
          </div>
        )}
      </Dialog>
    </div>
  );
}

function Field({
  id, label, value, onChange, type = "text", hint, disabled, autoComplete,
}: {
  id: string; label: string; value: string; onChange: (v: string) => void; type?: string; hint?: string; disabled?: boolean; autoComplete?: string;
}) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input id={id} type={type} value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled} autoComplete={autoComplete}
        aria-describedby={hint ? `${id}-hint` : undefined} />
      {hint && (
        <span className="hint" id={`${id}-hint`}>
          {hint}
        </span>
      )}
    </div>
  );
}

function CopyField({ label, value }: { label: string; value: string }) {
  const toast = useToast();
  return (
    <div className="field">
      <span className="label">{label}</span>
      <div className="row" style={{ flexWrap: "nowrap" }}>
        <code style={{ flex: 1, wordBreak: "break-all" }}>{value}</code>
        <button type="button" className="btn btn-sm" onClick={() => void navigator.clipboard?.writeText(value).then(() => toast.success("Copied."))}>
          Copy
        </button>
      </div>
    </div>
  );
}

/** "Everyone", narrowed to some classes, streams and goals (none ticked = any): the app matches each
 * student's onboarding picks, like home-screen cards - a "General" student sees every stream's drive,
 * one with no goals every goal's. Lists and names from Classes, streams & goals. */
function AudiencePicker({ classes, streams, goals, onChange }: {
  classes: number[];
  streams: string[];
  goals: string[];
  onChange: (patch: { classes?: number[]; streams?: string[]; goals?: string[] }) => void;
}) {
  const academics = useAcademics();
  if (academics.isPending) return <LoadingBlock rows={2} label="Loading classes, streams and goals" />;
  if (academics.error) return <ErrorState error={academics.error} onRetry={() => void academics.refetch()} />;
  const a = academics.data;
  const name = (key: string) => a.names?.[key] ?? key;
  const offered = goalsFor(a, streams);
  const toggle = <T,>(list: T[], item: T, on: boolean) => (on ? [...list, item] : list.filter((x) => x !== item));
  const summary = [
    classes.length ? a.classes.filter((c) => classes.includes(c.class_level)).map((c) => c.name).join(", ") : "every class",
    streams.length ? streams.map(name).join(", ") : "every stream",
    goals.length ? goals.map(name).join(", ") : "every goal",
  ].join(" · ");
  return (
    <div className="stack" style={{ gap: 12, paddingLeft: 24 }}>
      <fieldset className="field">
        <legend>Classes</legend>
        <div className="chip-list">
          {a.classes.map((c) => (
            <label key={c.class_level} className={`chip ${classes.includes(c.class_level) ? "on" : ""}`}>
              <input type="checkbox" checked={classes.includes(c.class_level)}
                onChange={(e) => onChange({ classes: toggle(classes, c.class_level, e.target.checked).sort((x, y) => x - y) })} />
              {c.name}{c.available ? "" : " (coming soon)"}
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset className="field">
        <legend>Streams</legend>
        <div className="chip-list">
          {a.streams.map((s) => (
            <label key={s} className={`chip ${streams.includes(s) ? "on" : ""}`}>
              <input type="checkbox" checked={streams.includes(s)}
                onChange={(e) => {
                  const next = toggle(streams, s, e.target.checked);
                  const allowed = goalsFor(a, next);
                  onChange({ streams: next, goals: goals.filter((g) => allowed.includes(g)) }); // goals no ticked stream offers go
                }} />
              {name(s)}
            </label>
          ))}
        </div>
        <span className="hint">Students of the "General" stream, or with no stream yet, see it too.</span>
      </fieldset>
      <fieldset className="field">
        <legend>Goals</legend>
        <div className="chip-list">
          {offered.map((g) => (
            <label key={g} className={`chip ${goals.includes(g) ? "on" : ""}`}>
              <input type="checkbox" checked={goals.includes(g)} onChange={(e) => onChange({ goals: toggle(goals, g, e.target.checked) })} />
              {name(g)}
            </label>
          ))}
        </div>
        <span className="hint">Shown to students who picked at least one of these (or none at all). Only the goals the ticked streams offer are listed.</span>
      </fieldset>
      <span className="small" role="status">Shown to: {summary}. None ticked in a list means all of it.</span>
    </div>
  );
}