import { useQuery } from "@tanstack/react-query";
import { useId, useState, type FormEvent } from "react";
import { ApiError } from "../../api/client";
import { Dialog } from "../../components/Dialog";
import { ErrorState, LoadingBlock } from "../../components/ui";
import { useDetailDefaults, type CourseDetails, type CourseRow, type DetailDefaults, type ProductRow, type SubjectOption } from "./appCoursesApi";
import { fetchAppCourse } from "./appVideosApi";
import { blankDetails } from "./defaultDetails";

const lines = (text: string) => text.split("\n").map((l) => l.trim()).filter(Boolean);


interface AppVideosFill {
  groups: { title: string; chapters: string }[];
  languages: string[];
}
const NAVY = "#0B1F4B";
const GOLD = "#D4A23C";

type DialogProps = {
  product: ProductRow;
  courses: CourseRow[];
  subjects: SubjectOption[];
  onSave: (details: CourseDetails | null) => void;
  onClose: () => void;
};

/** Edit a paid course's "Course Details" page in the app (its brochure screen). Starts from what the app
 * shows today: the saved page, else the app's own brochure for the three code courses, else a blank one.
 * The languages and the built-in pages come from the app's backend (details-defaults).
 * Changes go into the catalogue draft; "Save to the app" sends them. */
export function CourseDetailsDialog(props: DialogProps) {
  const defaults = useDetailDefaults();
  if (defaults.data) return <DetailsEditor {...props} defaults={defaults.data} />;
  return (
    <Dialog open onClose={props.onClose} title={`Course details: ${props.product.title}`}>
      {defaults.error ? <ErrorState error={defaults.error} onRetry={() => void defaults.refetch()} /> : <LoadingBlock rows={4} label="Loading course details" />}
    </Dialog>
  );
}

function DetailsEditor({ product, courses, subjects, onSave, onClose, defaults }: DialogProps & { defaults: DetailDefaults }) {
  // "hindi" is the main Hinglish video; the others are its dubbed copies in App videos.
  const DETAIL_LANGUAGES = defaults.languages;
  const ALL_LANGUAGES = DETAIL_LANGUAGES.map((l) => l.code);
  const builtIn = defaults.pages[product.id];
  const start = product.details ?? builtIn ?? blankDetails(product.title);
  const fromApp = !product.details && !!builtIn;
  const ids = { kicker: useId(), lead: useId(), accent: useId(), tail: useId(), pillars: useId(), exams: useId(), compare: useId(), save: useId() };
  const [kicker, setKicker] = useState(start.kicker);
  const [lead, setLead] = useState(start.title_lead);
  const [accent, setAccent] = useState(start.title_accent);
  const [tail, setTail] = useState(start.title_tail);
  const [pillars, setPillars] = useState(start.pillars.join("\n"));
  const [exams, setExams] = useState(start.exams.join("\n"));
  const [groups, setGroups] = useState(start.chapter_groups.map((g) => ({ title: g.title, chapters: g.chapters.join("\n") })));
  const [why, setWhy] = useState(start.why_choose.map((w) => ({ ...w })));
  const [compareAt, setCompareAt] = useState(start.compare_at ? String(start.compare_at) : "");
  const [saveNote, setSaveNote] = useState(start.save_note);
  // None saved: every language (as the app lists today) until App videos says which it has.
  const [languages, setLanguages] = useState<string[]>(start.languages.length ? start.languages : ALL_LANGUAGES);
  const [filling, setFilling] = useState(false);
  const [filledNote, setFilledNote] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  // The courses it sells, with their lecture folders in App videos.
  const sold = product.grants
    .map((g) => courses.find((c) => c.entitlement === g))
    .filter((c): c is CourseRow => !!c)
    .map((c) => ({ course: c, folder: subjects.find((s) => s.class_level === c.class_level && s.subject === c.subject)?.folder ?? null }));

  /** The course's chapters (with lectures, in order) and the languages its lectures are in, from App videos. */
  async function readAppVideos(): Promise<AppVideosFill> {
    const groups: AppVideosFill["groups"] = [];
    const found = new Set<string>();
    for (const { course, folder } of sold) {
      if (!folder) continue;
      const app = await fetchAppCourse(course.class_level, folder);
      const withLectures = app.chapters.filter((c) => !c.is_demo && c.lectures.length).sort((a, b) => a.number - b.number);
      if (withLectures.length) groups.push({ title: folder, chapters: withLectures.map((c) => c.title).join("\n") });
      for (const ch of app.chapters) {
        for (const lec of ch.lectures) {
          found.add("hindi"); // every lecture is the Hinglish main video
          for (const copy of lec.languages ?? []) found.add(copy.language);
        }
      }
    }
    return { groups, languages: ALL_LANGUAGES.filter((l) => found.has(l)) };
  }

  function apply(fill: AppVideosFill, what: { chapters: boolean; languages: boolean }): boolean {
    const done = [];
    if (what.chapters && fill.groups.length) {
      setGroups(fill.groups);
      const n = fill.groups.reduce((sum, g) => sum + lines(g.chapters).length, 0);
      done.push(`${n} chapter${n === 1 ? "" : "s"}`);
    }
    if (what.languages && fill.languages.length) {
      setLanguages(fill.languages);
      done.push(`${fill.languages.length} language${fill.languages.length === 1 ? "" : "s"}`);
    }
    if (done.length) setFilledNote(`Filled from App videos: ${done.join(" and ")}.`);
    return done.length > 0;
  }

  async function fillFromAppVideos(what: { chapters: boolean; languages: boolean }) {
    setFilling(true);
    setProblem(null);
    try {
      if (!apply(await readAppVideos(), what)) setProblem("App videos has no lectures for this course yet.");
    } catch (err) {
      setProblem(err instanceof ApiError ? err.message : "App videos couldn't be read.");
    } finally {
      setFilling(false);
    }
  }

  // Nothing filled in yet: take the chapters and languages from App videos as soon as they're read.
  const needChapters = !start.chapter_groups.some((g) => g.chapters.length);
  const needLanguages = !start.languages.length;
  const auto = useQuery({
    queryKey: ["app-courses", "details-fill", product.id, sold.map((s) => s.folder).join(",")],
    queryFn: readAppVideos,
    enabled: (needChapters || needLanguages) && sold.some((s) => s.folder),
    retry: false,
    gcTime: 0,
  });
  const [autoApplied, setAutoApplied] = useState(false);
  if (auto.data && !autoApplied) {
    setAutoApplied(true); // once, when it arrives (state adjusted while rendering)
    apply(auto.data, { chapters: needChapters, languages: needLanguages });
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!lead.trim()) return setProblem("Give the page a title (the first line of the title).");
    const compare = compareAt.trim() ? Math.round(Number(compareAt)) : null;
    if (compare !== null && !(compare > product.price_inr)) return setProblem(`The crossed-out price must be above the price (₹${product.price_inr}).`);
    if (lines(pillars).length > 6) return setProblem("At most 6 highlights.");
    if (lines(exams).length > 10) return setProblem("At most 10 exams.");
    if (!languages.length) return setProblem("Tick at least one language.");
    onSave({
      kicker: kicker.trim(),
      languages: ALL_LANGUAGES.filter((l) => languages.includes(l)),
      title_lead: lead.trim(),
      title_accent: accent.trim(),
      title_tail: tail.trim(),
      pillars: lines(pillars),
      exams: lines(exams),
      chapter_groups: groups.map((g) => ({ title: g.title.trim() || product.title, chapters: lines(g.chapters) })).filter((g) => g.chapters.length),
      why_choose: why.filter((w) => w.title.trim()).map((w) => ({ title: w.title.trim(), detail: w.detail.trim() })),
      compare_at: compare,
      save_note: saveNote.trim(),
    });
    onClose();
  }

  const chapterCount = groups.reduce((n, g) => n + lines(g.chapters).length, 0);
  return (
    <Dialog open onClose={onClose} title={`Course details: ${product.title}`}
      description="The page the app's “Course Details” button opens on this course's card. Optional: without it the card has no such button."
      footer={
        <>
          {product.details && (
            <button type="button" className="btn btn-ghost" style={{ marginRight: "auto" }} onClick={() => { onSave(null); onClose(); }}>
              Remove the page
            </button>
          )}
          <button type="button" className="btn" onClick={onClose} data-initial-focus>Cancel</button>
          <button type="submit" form="course-details" className="btn btn-primary">Done</button>
        </>
      }>
      <form id="course-details" className="stack" style={{ gap: 14 }} onSubmit={submit} noValidate>
        {fromApp && <span className="hint">Filled in with the page the app shows today (in its code). Saving it here lets you change it.</span>}

        {/* Like the app's hero, roughly. */}
        <div aria-hidden="true" style={{ background: `linear-gradient(135deg, ${NAVY}, #16337A)`, borderRadius: 14, padding: 16, color: "#fff" }}>
          <div style={{ fontSize: 12, opacity: 0.75 }}>{kicker || " "}</div>
          <div style={{ fontSize: 22, fontWeight: 800, fontFamily: "Georgia, serif", lineHeight: 1.2 }}>{lead || "Title"}</div>
          <div style={{ fontSize: 22, fontWeight: 800, fontFamily: "Georgia, serif", lineHeight: 1.2 }}>
            <span style={{ color: GOLD }}>{accent}</span> {tail}
          </div>
          {lines(pillars).length > 0 && <div style={{ fontSize: 12, opacity: 0.85, marginTop: 6 }}>{lines(pillars).join("  ·  ")}</div>}
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
            {lines(exams).map((x) => <span key={x} style={{ background: "rgba(255,255,255,0.14)", borderRadius: 999, padding: "2px 10px", fontSize: 11 }}>{x}</span>)}
          </div>
          <div style={{ marginTop: 10, fontSize: 13 }}>
            ₹{product.price_inr}{compareAt.trim() && <s style={{ opacity: 0.6, marginLeft: 6 }}>₹{compareAt}</s>}{saveNote && <span style={{ marginLeft: 8, color: GOLD }}>{saveNote}</span>}
            <span style={{ opacity: 0.7 }}> · {chapterCount} chapters · {languages.length} language{languages.length === 1 ? "" : "s"}</span>
          </div>
        </div>

        <div className="form-grid">
          <div className="field">
            <label htmlFor={ids.kicker}>Line above the title</label>
            <input id={ids.kicker} type="text" value={kicker} maxLength={120} onChange={(e) => setKicker(e.target.value)} placeholder="Introducing" />
          </div>
          <div className="field">
            <label htmlFor={ids.lead}>Title, first line</label>
            <input id={ids.lead} type="text" value={lead} maxLength={40} onChange={(e) => setLead(e.target.value)} placeholder="The Accounts" />
          </div>
          <div className="field">
            <label htmlFor={ids.accent}>Title, gold word</label>
            <input id={ids.accent} type="text" value={accent} maxLength={40} onChange={(e) => setAccent(e.target.value)} placeholder="Mastery" />
          </div>
          <div className="field">
            <label htmlFor={ids.tail}>Title, after the gold word</label>
            <input id={ids.tail} type="text" value={tail} maxLength={40} onChange={(e) => setTail(e.target.value)} placeholder="Batch" />
          </div>
          <div className="field">
            <label htmlFor={ids.pillars}>Highlights (one per line, up to 6)</label>
            <textarea id={ids.pillars} rows={3} value={pillars} onChange={(e) => setPillars(e.target.value)} placeholder={"Concept clarity\nSmart practice"} />
          </div>
          <div className="field">
            <label htmlFor={ids.exams}>Exams it prepares for (one per line, up to 10)</label>
            <textarea id={ids.exams} rows={3} value={exams} onChange={(e) => setExams(e.target.value)} placeholder={"CBSE\nState Boards\nCUET"} />
          </div>
        </div>

        {filledNote && <span className="hint" role="status">{filledNote}</span>}

        <fieldset className="field">
          <legend>Languages ({languages.length} of {ALL_LANGUAGES.length})</legend>
          <div className="chip-list">
            {DETAIL_LANGUAGES.map((l) => {
              const on = languages.includes(l.code);
              return (
                <label key={l.code} className={`chip ${on ? "on" : ""}`}>
                  <input type="checkbox" checked={on}
                    onChange={(e) => setLanguages((ls) => (e.target.checked ? [...ls, l.code] : ls.filter((x) => x !== l.code)))} />
                  {l.name}
                </label>
              );
            })}
          </div>
          <div className="row" style={{ gap: 8 }}>
            <button type="button" className="btn btn-sm" onClick={() => void fillFromAppVideos({ chapters: false, languages: true })} disabled={filling || !sold.some((s) => s.folder)}>
              {filling ? "Reading App videos…" : "Tick the ones App videos has"}
            </button>
          </div>
          <span className="hint">Only the ticked languages show on the page, and its “Languages” count is theirs.</span>
        </fieldset>

        <fieldset className="field">
          <legend>Chapters ({chapterCount})</legend>
          <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
            <button type="button" className="btn btn-sm" onClick={() => void fillFromAppVideos({ chapters: true, languages: false })} disabled={filling || !sold.some((s) => s.folder)}>
              {filling ? "Reading App videos…" : "Fill from App videos"}
            </button>
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setGroups((g) => [...g, { title: product.title, chapters: "" }])} disabled={groups.length >= 6}>
              + Add a group
            </button>
          </div>
          {groups.map((g, i) => (
            <div key={i} className="stack" style={{ gap: 6, marginTop: 8 }}>
              <div className="row" style={{ gap: 8 }}>
                <input type="text" value={g.title} maxLength={80} aria-label={`Chapter group ${i + 1} title`} style={{ flex: 1 }}
                  onChange={(e) => setGroups((gs) => gs.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)))} />
                <button type="button" className="btn btn-sm btn-ghost" onClick={() => setGroups((gs) => gs.filter((_, j) => j !== i))}
                  aria-label={`Remove chapter group ${i + 1}`}>Remove</button>
              </div>
              <textarea rows={5} value={g.chapters} aria-label={`Chapters of group ${i + 1}, one per line`}
                onChange={(e) => setGroups((gs) => gs.map((x, j) => (j === i ? { ...x, chapters: e.target.value } : x)))} />
            </div>
          ))}
          <span className="hint">One chapter per line, in order. A combo can have a group per subject.</span>
        </fieldset>

        <fieldset className="field">
          <legend>Why choose it ({why.length} of 8)</legend>
          {why.map((w, i) => (
            <div key={i} className="row" style={{ gap: 8, marginTop: 6, flexWrap: "wrap" }}>
              <input type="text" value={w.title} maxLength={80} placeholder="Complete syllabus" aria-label={`Point ${i + 1} title`} style={{ flex: "1 1 160px" }}
                onChange={(e) => setWhy((ws) => ws.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)))} />
              <input type="text" value={w.detail} maxLength={200} placeholder="Every chapter, in order." aria-label={`Point ${i + 1} detail`} style={{ flex: "2 1 240px" }}
                onChange={(e) => setWhy((ws) => ws.map((x, j) => (j === i ? { ...x, detail: e.target.value } : x)))} />
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => setWhy((ws) => ws.filter((_, j) => j !== i))} aria-label={`Remove point ${i + 1}`}>Remove</button>
            </div>
          ))}
          <button type="button" className="btn btn-sm btn-ghost" style={{ alignSelf: "flex-start", marginTop: 6 }}
            onClick={() => setWhy((ws) => [...ws, { title: "", detail: "" }])} disabled={why.length >= 8}>+ Add a point</button>
        </fieldset>

        <div className="form-grid">
          <div className="field">
            <label htmlFor={ids.compare}>Crossed-out price (₹, optional)</label>
            <input id={ids.compare} type="number" min={product.price_inr + 1} value={compareAt} onChange={(e) => setCompareAt(e.target.value)} placeholder="e.g. 498" />
            <span className="hint">The price itself is the course's price (₹{product.price_inr}); students pay that.</span>
          </div>
          <div className="field">
            <label htmlFor={ids.save}>Saving note (optional)</label>
            <input id={ids.save} type="text" value={saveNote} maxLength={40} onChange={(e) => setSaveNote(e.target.value)} placeholder="Save ₹99" />
          </div>
        </div>
        <span className="hint">The app adds its own parts to every page: what you get (videos, notes, tests, AI help), the 11 languages, and “6 months of access”.</span>
        {problem && <span className="error" role="alert">{problem}</span>}
      </form>
    </Dialog>
  );
}
