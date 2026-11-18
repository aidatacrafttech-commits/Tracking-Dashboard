import { useId, useState } from "react";
import { Badge, Notice } from "../../components/ui";
import type { Question } from "./api";

export const LETTERS = ["A", "B", "C", "D"];

/** A question being reviewed. `notes` are the reader's doubts (from the PDF or JSON). */
export interface EditableQuestion extends Question {
  id: string;
  notes: string[];
}

let seq = 0;
export const newId = () => `q${++seq}`;

export function blankQuestion(section = ""): EditableQuestion {
  return { id: newId(), section, question: "", options: ["", "", "", ""], correct_answer: null, explanation: "", notes: [] };
}

/** What still stops a question from being saved (the same checks as the server). */
export function problemsOf(q: Question): string[] {
  const out: string[] = [];
  if (!q.question.trim()) out.push("Question text is empty.");
  if (!q.section.trim()) out.push("Section is empty.");
  if (q.options.length !== 4 || q.options.some((o) => !o.trim())) out.push("Needs four options.");
  if (q.correct_answer === null || q.correct_answer < 0 || q.correct_answer > 3) out.push("Pick the correct answer.");
  return out;
}

export function QuestionReview({
  questions,
  onChange,
  locked,
}: {
  questions: EditableQuestion[];
  onChange: (next: EditableQuestion[]) => void;
  locked: boolean;
}) {
  const [onlyFlagged, setOnlyFlagged] = useState(false);
  const listId = useId();
  const sections = [...new Set(questions.map((q) => q.section.trim()).filter(Boolean))];
  const flagged = questions.filter((q) => q.notes.length > 0 || problemsOf(q).length > 0).length;

  // Editing a question counts as reviewing it: the reader's doubts about it are cleared.
  const update = (id: string, patch: Partial<EditableQuestion>) =>
    onChange(questions.map((q) => (q.id === id ? { ...q, ...patch, notes: [] } : q)));
  const move = (index: number, by: number) => {
    const next = [...questions];
    const [item] = next.splice(index, 1);
    next.splice(index + by, 0, item!);
    onChange(next);
  };
  const remove = (id: string) => onChange(questions.filter((q) => q.id !== id));
  const add = (index: number) => {
    const next = [...questions];
    next.splice(index + 1, 0, blankQuestion(questions[index]?.section ?? sections[sections.length - 1] ?? ""));
    onChange(next);
  };

  const shown = questions.map((q, i) => ({ q, i })).filter(({ q }) => !onlyFlagged || q.notes.length > 0 || problemsOf(q).length > 0);

  return (
    <div className="stack">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <p className="small muted" style={{ margin: 0 }}>
          {questions.length} question{questions.length === 1 ? "" : "s"}
          {sections.length > 0 && ` in ${sections.length} section${sections.length === 1 ? "" : "s"}: ${sections.join(", ")}`}
          {flagged > 0 && ` · ${flagged} to check`}
        </p>
        {flagged > 0 && (
          <label className="row small">
            <input type="checkbox" checked={onlyFlagged} onChange={(e) => setOnlyFlagged(e.target.checked)} /> Show only questions to check
          </label>
        )}
      </div>
      {locked && (
        <Notice tone="warning">
          Students have already started this drive, so its questions, answers and marking are locked: their answers are scored
          against this paper. The dates (except the last day), audience, code, timing and on/off can still change.
        </Notice>
      )}
      <datalist id={listId}>
        {sections.map((s) => (
          <option key={s} value={s} />
        ))}
      </datalist>
      {shown.map(({ q, i }) => {
        const problems = problemsOf(q);
        const label = `Question ${i + 1}`;
        return (
          <fieldset key={q.id} className="card question-card" aria-label={label} disabled={locked}>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <legend className="row" style={{ fontWeight: 650 }}>
                Q{i + 1}
                {(q.notes.length > 0 || problems.length > 0) && <Badge tone="warning">Check</Badge>}
              </legend>
              {!locked && (
                <div className="row">
                  <button type="button" className="btn btn-sm btn-ghost" onClick={() => move(i, -1)} disabled={i === 0} aria-label={`Move ${label} up`}>
                    ↑
                  </button>
                  <button type="button" className="btn btn-sm btn-ghost" onClick={() => move(i, 1)} disabled={i === questions.length - 1} aria-label={`Move ${label} down`}>
                    ↓
                  </button>
                  <button type="button" className="btn btn-sm btn-ghost" onClick={() => add(i)} aria-label={`Add a question after ${label}`}>
                    + Add below
                  </button>
                  <button type="button" className="btn btn-sm btn-danger" onClick={() => remove(q.id)} aria-label={`Delete ${label}`}>
                    Delete
                  </button>
                </div>
              )}
            </div>
            {(q.notes.length > 0 || problems.length > 0) && (
              <div className="row" style={{ alignItems: "flex-start", justifyContent: "space-between" }}>
                <ul className="small" style={{ margin: "4px 0 8px", color: "var(--warning)" }}>
                  {[...q.notes, ...problems.filter((p) => !q.notes.includes(p))].map((n) => (
                    <li key={n}>{n}</li>
                  ))}
                </ul>
                {q.notes.length > 0 && problems.length === 0 && !locked && (
                  <button type="button" className="btn btn-sm" onClick={() => update(q.id, {})}>
                    Looks right
                  </button>
                )}
              </div>
            )}
            <div className="form-grid">
              <div className="field">
                <label htmlFor={`${q.id}-section`}>Section</label>
                <input id={`${q.id}-section`} list={listId} value={q.section} onChange={(e) => update(q.id, { section: e.target.value })} />
              </div>
            </div>
            <div className="field">
              <label htmlFor={`${q.id}-text`}>Question</label>
              <textarea id={`${q.id}-text`} rows={2} value={q.question} onChange={(e) => update(q.id, { question: e.target.value })} />
            </div>
            <div className="field">
              <span className="label" id={`${q.id}-opts`}>
                Options (select the correct one)
              </span>
              <div className="stack" role="radiogroup" aria-labelledby={`${q.id}-opts`}>
                {LETTERS.map((letter, k) => (
                  <div key={letter} className="row" style={{ flexWrap: "nowrap" }}>
                    <input
                      type="radio"
                      name={`${q.id}-answer`}
                      checked={q.correct_answer === k}
                      onChange={() => update(q.id, { correct_answer: k })}
                      aria-label={`${letter} is correct`}
                    />
                    <span style={{ width: 18, fontWeight: 600 }}>{letter}</span>
                    <input
                      style={{ flex: 1 }}
                      value={q.options[k] ?? ""}
                      aria-label={`${label} option ${letter}`}
                      onChange={(e) => {
                        const options = [...q.options];
                        while (options.length < 4) options.push("");
                        options[k] = e.target.value;
                        update(q.id, { options: options.slice(0, 4) });
                      }}
                    />
                  </div>
                ))}
              </div>
            </div>
            <div className="field">
              <label htmlFor={`${q.id}-why`}>Explanation (optional, never shown to students)</label>
              <textarea id={`${q.id}-why`} rows={1} value={q.explanation} onChange={(e) => update(q.id, { explanation: e.target.value })} />
            </div>
          </fieldset>
        );
      })}
      {!locked && (
        <div>
          <button type="button" className="btn" onClick={() => add(questions.length - 1)}>
            + Add a question
          </button>
        </div>
      )}
    </div>
  );
}
