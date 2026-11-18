import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState, type FormEvent, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import { ApiError } from "../../api/client";
import { useAuth } from "../../auth/AuthContext";
import { DataTable, type Column } from "../../components/DataTable";
import { ConfirmDialog, Dialog } from "../../components/Dialog";
import { useToast } from "../../components/Toast";
import { Badge, Card, EmptyState, ErrorState, LoadingBlock, Notice } from "../../components/ui";
import {
  acKeys,
  audienceLabel,
  bannerPreview,
  courseId,
  deleteCourse,
  fetchClassDeletePlan,
  fetchDeletePlan,
  fetchListDeletePlan,
  goalsFor,
  saveCatalog,
  saveClasses,
  saveLists,
  slug,
  useAcademics,
  useAppCoursesStatus,
  useCatalog,
  useClasses,
  useDetailDefaults,
  useLists,
  useSubjectOptions,
  type Academics,
  type BatchRow,
  type Catalog,
  type ClassesState,
  type ClassRow,
  type GoalItem,
  type ListsState,
  type CourseRow,
  type ProductRow,
  type SubjectOption,
} from "./appCoursesApi";
import { BannerEditor } from "./BannerEditor";
import { CourseDetailsDialog } from "./CourseDetailsDialog";
import { isoToIstInput, istInputToIso } from "../vouchers/shared";
import { avKeys, fileSize, useAppCourse } from "./appVideosApi";

interface Draft {
  courses: CourseRow[];
  products: ProductRow[];
  batches: BatchRow[];
}

type Editing =
  | { kind: "course" }
  | { kind: "combo" }
  | { kind: "product"; product: ProductRow }
  | { kind: "details"; product: ProductRow }
  | { kind: "batch"; batch: BatchRow | null; index: number | null };

const draftOf = (c: Catalog): Draft => ({
  courses: c.courses.map(({ entitlement, class_level, subject }) => ({ entitlement, class_level, subject })),
  products: c.products.map(({ from_code: _f, ...p }) => p),
  batches: c.batches.map((b) => ({ ...b })),
});

const label = (draft: Draft, ent: string) => {
  const c = draft.courses.find((x) => x.entitlement === ent);
  return c ? `Class ${c.class_level} ${c.subject}` : ent;
};

/** Courses & prices: what the AdhyaapakAI app sells, at what price, and its home-screen batches.
 * Saved to the app's database; the app picks a save up within 30 seconds. Owner only. */
export function AppCourses() {
  const { canWrite } = useAuth();
  const status = useAppCoursesStatus(canWrite);
  const catalog = useCatalog(canWrite && status.data?.configured === true);
  if (!canWrite) return <Notice tone="info">Only the owner can change the app's courses and prices.</Notice>;
  if (status.isPending) return <LoadingBlock rows={3} label="Loading" />;
  if (status.error) return <ErrorState error={status.error} onRetry={() => void status.refetch()} />;
  if (!status.data.configured) {
    return (
      <Notice tone="warning">
        <strong>Courses & prices are not configured.</strong> Set <code>ADHYAAPAK_MONGO_URL</code> and <code>ADHYAAPAK_MONGO_DB</code> in the
        dashboard's <code>backend/.env</code> and restart it.
      </Notice>
    );
  }
  if (catalog.isPending) return <LoadingBlock rows={5} label="Loading the catalogue" />;
  if (catalog.error) return <ErrorState error={catalog.error} onRetry={() => void catalog.refetch()} />;
  return <Editor key={`${catalog.data.version ?? "code"}`} catalog={catalog.data} storage={status.data.storage} onReload={() => void catalog.refetch()} />;
}

/** Each list's box stops growing at about 6 rows; more scroll inside it. */
const LIST_HEIGHT = "min(520px, 70vh)";

function Editor({ catalog, storage, onReload }: { catalog: Catalog; storage: boolean; onReload: () => void }) {
  const [draft, setDraft] = useState<Draft>(() => draftOf(catalog));
  const [editing, setEditing] = useState<Editing | null>(null);
  const [saving, setSaving] = useState(false);
  const [problems, setProblems] = useState<string[] | null>(null);
  const [stale, setStale] = useState(false);
  const [confirmSave, setConfirmSave] = useState(false);
  const [removing, setRemoving] = useState<ProductRow | null>(null);
  const toast = useToast();
  const client = useQueryClient();
  const dirty = JSON.stringify(draft) !== JSON.stringify(draftOf(catalog));
  const subjects = useSubjectOptions(storage);
  // The app's built-in Course Details pages (its three code courses), for the cards' hint.
  const builtInPages = useDetailDefaults().data?.pages;

  const setProduct = (id: string, patch: Partial<ProductRow>) =>
    setDraft((d) => ({ ...d, products: d.products.map((p) => (p.id === id ? { ...p, ...patch } : p)) }));
  const setBatches = (batches: BatchRow[]) => setDraft((d) => ({ ...d, batches }));

  // One class at a time, like App videos: the lists stay short as subjects are added.
  const classOptions = [...new Set([...draft.courses.map((c) => c.class_level), ...draft.batches.map((b) => b.class_level)])].sort((a, b) => a - b);
  const [shownClass, setShownClass] = useState<number | "all">(() => (classOptions.includes(12) ? 12 : (classOptions[0] ?? "all")));
  const classPicker = useId();
  const productClasses = (p: ProductRow) =>
    p.grants.map((g) => draft.courses.find((c) => c.entitlement === g)?.class_level).filter((c): c is number => c !== undefined);
  const inClass = (classes: number[]) => shownClass === "all" || classes.length === 0 || classes.includes(shownClass);
  const shownProducts = draft.products.filter((p) => inClass(productClasses(p)));
  const shownBatches = draft.batches.filter((b) => inClass([b.class_level]));
  /** After adding something to another class, show that class so it doesn't seem to vanish. */
  const follow = (classLevel: number) => setShownClass((c) => (c === "all" ? c : classLevel));

  async function save() {
    setSaving(true);
    setProblems(null);
    try {
      const out = await saveCatalog({ version: catalog.version, ...draft });
      const gone = (out.summary.banners_deleted as string[] | undefined) ?? [];
      toast.success(`Saved (version ${out.catalog.version}). The app shows it within about 30 seconds.${
        gone.length ? ` ${gone.length} banner image${gone.length === 1 ? "" : "s"} no card uses any more ${gone.length === 1 ? "was" : "were"} deleted from S3.` : ""}`);
      if (out.summary.banners_delete_error) toast.error(new Error(String(out.summary.banners_delete_error)), "Some old banner images couldn't be deleted from S3.");
      setConfirmSave(false);
      client.setQueryData(acKeys.catalog, out.catalog);
    } catch (err) {
      setConfirmSave(false);
      if (err instanceof ApiError && err.code === "catalog_invalid") {
        const details = err.details as { problems?: string[] } | undefined;
        setProblems(details?.problems ?? [err.message]);
      } else if (err instanceof ApiError && err.code === "catalog_changed") {
        setStale(true);
      } else {
        toast.error(err, "The catalogue couldn't be saved.");
      }
    } finally {
      setSaving(false);
    }
  }

  const productColumns: Column<ProductRow>[] = [
    {
      key: "title",
      header: "Course (as sold in the app)",
      render: (p) => (
        <div>
          <strong>{p.title}</strong> {p.badge && <Badge tone="info">{p.badge}</Badge>}
          <div className="small muted">{p.subtitle}</div>
          <div className="small muted">{p.id}</div>
          <div className="small">
            {p.free ? "Free, no end date" : `Access ${validityLabel(p.access_days ?? catalog.access_days)} per purchase`}
            {p.sale_starts_at && (new Date(p.sale_starts_at) > new Date()
              ? <> · <Badge tone="info">{`Opens ${istLabel(p.sale_starts_at)}`}</Badge></>
              : ` · launched ${istLabel(p.sale_starts_at)}`)}
          </div>
          {!p.free && (
            <div className="small muted">
              {p.details ? "Course Details: set here" : builtInPages?.[p.id] ? "Course Details: the app's own page" : "No Course Details page"}
            </div>
          )}
        </div>
      ),
    },
    { key: "grants", header: "Unlocks", render: (p) => p.grants.map((g) => label(draft, g)).join(" + ") },
    {
      key: "price",
      header: "Price (₹)",
      numeric: true,
      render: (p) => (p.free ? <Badge tone="normal">Free</Badge> : (
        <input type="number" min={1} max={100000} value={p.price_inr} style={{ width: 96 }} aria-label={`Price of ${p.title} in rupees`}
          onChange={(e) => setProduct(p.id, { price_inr: Math.round(Number(e.target.value)) || 0 })} />
      )),
    },
    {
      key: "ios",
      header: "iPhone",
      render: (p) => (p.free ? <span className="small muted">Free on iPhone too</span> : p.ios_product_id ? <span className="small" style={{ wordBreak: "break-all" }}>{p.ios_product_id}</span> : <Badge tone="unavailable">Not on iPhone</Badge>),
    },
    {
      key: "active",
      header: "On sale",
      render: (p) => (
        <label className="row small" style={{ gap: 6 }}>
          <input type="checkbox" checked={p.active} onChange={(e) => setProduct(p.id, { active: e.target.checked })} aria-label={`${p.title} on sale`} />
          {p.active ? "On sale" : "Off"}
        </label>
      ),
    },
    {
      key: "edit",
      header: "Actions",
      render: (p) => (
        <div className="row" style={{ gap: 4, flexWrap: "nowrap" }}>
          <button type="button" className="btn btn-sm" onClick={() => setEditing({ kind: "product", product: p })} aria-label={`Edit ${p.title}`}>Edit</button>
          {/* Paid only: a free course has no Course Details page (nothing to sell). */}
          {!p.free && (
            <button type="button" className="btn btn-sm" onClick={() => setEditing({ kind: "details", product: p })} aria-label={`Course details of ${p.title}`}>
              Details
            </button>
          )}
          {/* Any single course (the app's own included), once it's saved. The app refuses while
              students can still open it: they keep it, and it can be switched off instead. */}
          {catalog.courses.some((c) => c.entitlement === p.id) && (
            <button type="button" className="btn btn-sm btn-danger" onClick={() => setRemoving(p)} disabled={dirty}
              title={dirty ? "Save or discard your changes first" : undefined} aria-label={`Delete ${p.title}`}>Delete</button>
          )}
        </div>
      ),
    },
  ];

  // Up / down swaps a card with the one next to it in the list shown (its class's cards: a student
  // only sees their class's cards, so that's the order that matters).
  const move = (b: BatchRow, by: number) => {
    const other = shownBatches[shownBatches.indexOf(b) + by];
    if (!other) return;
    const i = draft.batches.indexOf(b);
    const j = draft.batches.indexOf(other);
    const next = [...draft.batches];
    next[i] = other;
    next[j] = b;
    setBatches(next);
  };

  const batchColumns: Column<BatchRow>[] = [
    { key: "order", header: "Order", numeric: true, render: (b) => draft.batches.indexOf(b) + 1 },
    {
      key: "title",
      header: "Home-screen card",
      render: (b) => (
        <div>
          <strong>{b.title}</strong>
          <div className="small muted">Class {b.class_level} · {b.subjects.join(", ")}</div>
        </div>
      ),
    },
    { key: "product", header: "Sells", render: (b) => draft.products.find((p) => p.id === b.product_id)?.title ?? b.product_id },
    { key: "audience", header: "Shown to", render: (b) => <span className="small">{audienceLabel(b)}</span> },
    {
      key: "banner",
      header: "Banner",
      render: (b) => (b.banner_from_course
        ? <Badge tone="info">Course image (live)</Badge>
        : b.banner_key ? <BannerThumb keyName={b.banner_key} alt={`${b.title} banner`} /> : <span className="small muted">No banner</span>),
    },
    {
      key: "active",
      header: "Shown",
      render: (b) => (
        <label className="row small" style={{ gap: 6 }}>
          <input type="checkbox" checked={b.active} aria-label={`Show ${b.title} on the home screen`}
            onChange={(e) => setBatches(draft.batches.map((x) => (x.id === b.id ? { ...x, active: e.target.checked } : x)))} />
          {b.active ? "Shown" : "Hidden"}
        </label>
      ),
    },
    {
      key: "actions",
      header: "Actions",
      render: (b) => {
        const i = draft.batches.indexOf(b);
        const at = shownBatches.indexOf(b);
        return (
          <div className="row" style={{ gap: 4 }}>
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => move(b, -1)} disabled={at === 0} aria-label={`Move ${b.title} up`}>↑</button>
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => move(b, 1)} disabled={at === shownBatches.length - 1} aria-label={`Move ${b.title} down`}>↓</button>
            <button type="button" className="btn btn-sm" onClick={() => setEditing({ kind: "batch", batch: b, index: i })} aria-label={`Edit ${b.title}`}>Edit</button>
          </div>
        );
      },
    },
  ];

  return (
    <div className="stack" style={{ gap: 16 }}>
      <Notice tone="info">
        Saved to the app's database <strong>{catalog.database ?? ""}</strong>
        {catalog.source === "db" ? ` (version ${catalog.version})` : " (not saved yet: the app uses the catalogue in its code)"}. The app shows a save
        within about 30 seconds. On iPhone the price comes from the App Store product, which has to be created in App Store Connect.
      </Notice>
      {catalog.error && <Notice tone="warning">The saved catalogue is invalid, so the app ignores it: {catalog.error}</Notice>}
      {stale && (
        <Notice tone="warning">
          The catalogue was saved somewhere else since you opened it, so this save was refused.{" "}
          <button type="button" className="btn btn-sm" onClick={onReload}>Reload it</button> and make your changes again.
        </Notice>
      )}
      {problems && (
        <Notice tone="warning">
          <strong>The app would refuse this catalogue:</strong>
          <ul style={{ margin: "4px 0 0 16px" }}>{problems.map((p) => <li key={p}>{p}</li>)}</ul>
        </Notice>
      )}

      {classOptions.length > 1 && (
        <div className="field" style={{ maxWidth: 260 }}>
          <label htmlFor={classPicker}>Class</label>
          <select id={classPicker} value={String(shownClass)} onChange={(e) => setShownClass(e.target.value === "all" ? "all" : Number(e.target.value))}>
            {classOptions.map((c) => <option key={c} value={c}>Class {c}</option>)}
            <option value="all">All classes</option>
          </select>
          <span className="hint">
            {shownProducts.length} of {draft.products.length} courses · {shownBatches.length} of {draft.batches.length} home-screen cards
          </span>
        </div>
      )}

      <Card
        title="Courses on sale"
        description="What the app's payment screen sells. Products are never deleted: switch one off to stop selling it (students who bought it keep it)."
        actions={
          <div className="row" style={{ gap: 4 }}>
            <button type="button" className="btn btn-sm btn-primary" onClick={() => setEditing({ kind: "course" })}>+ New course</button>
            <button type="button" className="btn btn-sm" onClick={() => setEditing({ kind: "combo" })} disabled={draft.courses.length < 2}>+ New combo</button>
          </div>
        }
      >
        <DataTable caption="Courses on sale" columns={productColumns} rows={shownProducts} rowKey={(p) => p.id} maxHeight={LIST_HEIGHT}
          empty={<EmptyState title="No courses in this class">Add one with + New course.</EmptyState>} />
      </Card>

      <Card
        title="Home-screen batches"
        description="The cards on the app's home screen, in this order. Each opens its lectures and sells its course."
        actions={<button type="button" className="btn btn-sm btn-primary" onClick={() => setEditing({ kind: "batch", batch: null, index: null })} disabled={!storage}>+ New batch</button>}
      >
        <DataTable caption="Home-screen batches" columns={batchColumns} rows={shownBatches} rowKey={(b) => b.id} maxHeight={LIST_HEIGHT}
          empty={<EmptyState title="No batches">The home screen shows no course cards.</EmptyState>} />
      </Card>

      <Card title="Coupons" description="Coupon prices stay in the app's code: each needs its own App Store product.">
        <ul className="small" style={{ margin: 0, paddingLeft: 16 }}>
          {catalog.coupons.map((c) => (
            <li key={c.code}>
              <strong>{c.code}</strong> until {c.expires_at ? new Date(c.expires_at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }) : "—"}:{" "}
              {c.products.map((p) => `${draft.products.find((x) => x.id === p.product_id)?.title ?? p.product_id} for ₹${p.price_inr}`).join(", ")}
            </li>
          ))}
        </ul>
        <p className="small muted" style={{ marginBottom: 0 }}>Access lasts {catalog.access_days} days from each purchase.</p>
      </Card>

      <div className="card row" style={{ position: "sticky", bottom: 0, justifyContent: "space-between", gap: 8, zIndex: 2 }} aria-live="polite">
        <span className="small">{dirty ? "You have changes that aren't in the app yet." : "No unsaved changes."}</span>
        <div className="row" style={{ gap: 8 }}>
          <button type="button" className="btn" onClick={() => { setDraft(draftOf(catalog)); setProblems(null); }} disabled={!dirty || saving}>Discard</button>
          <button type="button" className="btn btn-primary" onClick={() => setConfirmSave(true)} disabled={!dirty || saving || stale}>Save to the app</button>
        </div>
      </div>

      <ConfirmDialog open={confirmSave} title="Save to the app?" confirmLabel="Save" busy={saving} onConfirm={() => void save()} onCancel={() => setConfirmSave(false)}>
        <SaveSummary before={draftOf(catalog)} after={draft} />
      </ConfirmDialog>

      {removing && <DeleteCourseDialog product={removing} version={catalog.version} onClose={() => setRemoving(null)} />}
      {editing?.kind === "course" && (
        <CourseDialog draft={draft} subjects={subjects.data ?? []} onClose={() => setEditing(null)}
          onAdd={(course, product) => { setDraft((d) => ({ ...d, courses: [...d.courses, course], products: [...d.products, product] })); follow(course.class_level); }} />
      )}
      {editing?.kind === "combo" && (
        <ProductDialog draft={draft} product={null} onClose={() => setEditing(null)}
          onSave={(product) => setDraft((d) => ({ ...d, products: [...d.products, product] }))} />
      )}
      {editing?.kind === "details" && (
        <CourseDetailsDialog product={draft.products.find((p) => p.id === editing.product.id) ?? editing.product} courses={draft.courses}
          subjects={subjects.data ?? []} onClose={() => setEditing(null)}
          onSave={(details) => setProduct(editing.product.id, { details })} />
      )}
      {editing?.kind === "product" && (
        <ProductDialog draft={draft} product={editing.product} onClose={() => setEditing(null)}
          canBeFree={catalog.courses.some((c) => c.entitlement === editing.product.id)}
          // A free course sells nothing: no Course Details page.
          onSave={(product) => setProduct(product.id, product.free ? { ...product, details: null } : product)} />
      )}
      {editing?.kind === "batch" && (
        <BatchDialog draft={draft} batch={editing.batch} subjects={subjects.data ?? []} onClose={() => setEditing(null)}
          onRemove={editing.index === null ? undefined : () => setBatches(draft.batches.filter((_, i) => i !== editing.index))}
          onSave={(batch) => { setBatches(editing.index === null ? [...draft.batches, batch] : draft.batches.map((b, i) => (i === editing.index ? batch : b))); follow(batch.class_level); }} />
      )}
    </div>
  );
}

function SaveSummary({ before, after }: { before: Draft; after: Draft }) {
  const lines: string[] = [];
  for (const p of after.products) {
    const was = before.products.find((x) => x.id === p.id);
    if (!was) lines.push(`New: ${p.title} ${p.free ? "(free)" : `at ₹${p.price_inr}`}`);
    else {
      if (!!was.free !== !!p.free) lines.push(`${p.title}: ${p.free ? "now free for everyone" : `now paid, ₹${p.price_inr}`}`);
      else if (!p.free && was.price_inr !== p.price_inr) lines.push(`${p.title}: ₹${was.price_inr} → ₹${p.price_inr}`);
      if (was.active !== p.active) lines.push(`${p.title}: ${p.active ? "back on sale" : "off sale"}`);
      if ((was.access_days ?? null) !== (p.access_days ?? null)) lines.push(`${p.title}: access ${p.access_days ? `${p.access_days} days` : "the default length"}`);
      if ((was.sale_starts_at ?? null) !== (p.sale_starts_at ?? null)) lines.push(`${p.title}: ${p.sale_starts_at ? `opens ${istLabel(p.sale_starts_at)}` : "on sale without a launch time"}`);
      if (was.title !== p.title || was.subtitle !== p.subtitle || was.badge !== p.badge || was.ios_product_id !== p.ios_product_id) lines.push(`${p.title}: details changed`);
      if (JSON.stringify(was.details ?? null) !== JSON.stringify(p.details ?? null)) {
        lines.push(`${p.title}: ${!p.details ? "Course Details page removed" : was.details ? "Course Details page changed" : "Course Details page added"}`);
      }
    }
  }
  for (const b of after.batches) {
    const was = before.batches.find((x) => x.id === b.id);
    if (!was) continue;
    if (was.banner_key && !b.banner_key) lines.push(`${b.title}: banner deleted${b.banner_from_course ? " (shows the course image)" : ""}`);
    else if (was.banner_key && b.banner_key !== was.banner_key) lines.push(`${b.title}: new banner`);
    if (was.banner_key_dark && !b.banner_key_dark) lines.push(`${b.title}: dark-mode banner deleted (dark mode shows the main one)`);
    else if (was.banner_key_dark && b.banner_key_dark !== was.banner_key_dark) lines.push(`${b.title}: new dark-mode banner`);
  }
  if (JSON.stringify(before.batches) !== JSON.stringify(after.batches)) lines.push("Home-screen batches changed");
  return (
    <div className="stack" style={{ gap: 8 }}>
      <ul style={{ margin: 0, paddingLeft: 16 }}>{lines.map((l) => <li key={l}>{l}</li>)}</ul>
      <span>Students see this in the app within about 30 seconds. Orders already started keep the price they were made at.
        Banner images no card uses any more are deleted from S3.</span>
    </div>
  );
}

function Field({ id, label, hint, children }: { id: string; label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children}
      {hint && <span className="hint">{hint}</span>}
    </div>
  );
}

function CourseDialog({ draft, subjects, onAdd, onClose }: {
  draft: Draft;
  subjects: SubjectOption[];
  onAdd: (course: CourseRow, product: ProductRow) => void;
  onClose: () => void;
}) {
  const ids = { cls: useId(), subject: useId(), title: useId(), subtitle: useId(), price: useId(), ios: useId() };
  const classes = [...new Set([11, 12, ...subjects.map((s) => s.class_level)])].sort((a, b) => a - b);
  const [classLevel, setClassLevel] = useState(classes.includes(12) ? 12 : classes[0]!);
  const options = subjects.filter((s) => s.class_level === classLevel && !draft.courses.some((c) => c.class_level === classLevel && c.subject === s.subject));
  const [picked, setSubject] = useState(options[0]?.subject ?? "");
  // Always one of the listed subjects: the dropdown only lists those without a course yet, so a stale pick
  // (another class's, or one already taken) would show one subject but save another.
  const subject = options.some((s) => s.subject === picked) ? picked : (options[0]?.subject ?? "");
  const [title, setTitle] = useState("");
  const [subtitle, setSubtitle] = useState("");
  const [price, setPrice] = useState("249");
  const [ios, setIos] = useState("");
  const [free, setFree] = useState(false);
  const [launch, setLaunch] = useState<Launch>({ days: DEFAULT_DAYS, start: "" });
  const [problem, setProblem] = useState<string | null>(null);
  const id = subject ? courseId(classLevel, subject) : "";

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!subject) return setProblem("Choose a subject.");
    if (draft.courses.some((c) => c.entitlement === id) || draft.products.some((p) => p.id === id)) return setProblem(`${id} already exists.`);
    if (!title.trim()) return setProblem("Give the course a name.");
    const rupees = free ? 0 : Math.round(Number(price));
    if (!free && !(rupees >= 1)) return setProblem("Give a price of at least ₹1.");
    const checked = checkLaunch(launch);
    if (typeof checked === "string") return setProblem(checked);
    onAdd({ entitlement: id, class_level: classLevel, subject },
      { id, title: title.trim(), subtitle: subtitle.trim(), price_inr: rupees, ios_product_id: free ? null : ios.trim() || null, grants: [id], badge: null,
        active: true, free, access_days: free ? null : checked.access_days, sale_starts_at: checked.sale_starts_at });
    onClose();
  }

  return (
    <Dialog open onClose={onClose} title="New course" description="A subject's lectures sold as one course. Add a home-screen batch for it afterwards."
      footer={<><button type="button" className="btn" onClick={onClose} data-initial-focus>Cancel</button><button type="submit" form="new-course" className="btn btn-primary">Add</button></>}>
      <form id="new-course" className="form-grid" onSubmit={submit} noValidate>
        <Field id={ids.cls} label="Class">
          <select id={ids.cls} value={classLevel} onChange={(e) => { setClassLevel(Number(e.target.value)); setSubject(""); }}>
            {classes.map((c) => <option key={c} value={c}>Class {c}</option>)}
          </select>
        </Field>
        <Field id={ids.subject} label="Subject (its lectures in App videos)" hint={id && `Course id: ${id}`}>
          <select id={ids.subject} value={subject} onChange={(e) => setSubject(e.target.value)}>
            {options.length === 0 && <option value="">No other subject folders in this class</option>}
            {options.map((s) => <option key={s.folder} value={s.subject}>{s.folder}</option>)}
          </select>
        </Field>
        <Field id={ids.title} label="Name"><input id={ids.title} type="text" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={80} placeholder="e.g. Class 11 Physics" /></Field>
        <Field id={ids.subtitle} label="Line under the name (optional)"><input id={ids.subtitle} type="text" value={subtitle} onChange={(e) => setSubtitle(e.target.value)} maxLength={160} /></Field>
        <PricingChoice name={`${ids.price}-type`} free={free} onChange={setFree} />
        {!free && (
          <>
            <Field id={ids.price} label="Price (₹, Android and web)"><input id={ids.price} type="number" min={1} value={price} onChange={(e) => setPrice(e.target.value)} /></Field>
            <Field id={ids.ios} label="App Store product id (optional)" hint="Leave empty until the product exists in App Store Connect; iPhone users can't buy it until then.">
              <input id={ids.ios} type="text" value={ios} onChange={(e) => setIos(e.target.value)} maxLength={100} placeholder="com.adhyaapakai.class11.physics.6m" />
            </Field>
          </>
        )}
        <LaunchFields free={free} value={launch} onChange={setLaunch} />
        {problem && <span className="error" role="alert">{problem}</span>}
      </form>
    </Dialog>
  );
}

function ProductDialog({ draft, product, canBeFree = false, onSave, onClose }: {
  draft: Draft;
  product: ProductRow | null; // null: a new combo
  canBeFree?: boolean; // a single course (the app's own included), not a combo
  onSave: (p: ProductRow) => void;
  onClose: () => void;
}) {
  const ids = { id: useId(), title: useId(), subtitle: useId(), badge: useId(), ios: useId(), price: useId() };
  const [title, setTitle] = useState(product?.title ?? "");
  const [subtitle, setSubtitle] = useState(product?.subtitle ?? "");
  const [badge, setBadge] = useState(product?.badge ?? "");
  const [ios, setIos] = useState(product?.ios_product_id ?? "");
  const [price, setPrice] = useState(String(product?.price_inr ?? 399));
  const [grants, setGrants] = useState<string[]>(product?.grants ?? []);
  const [free, setFree] = useState(!!product?.free);
  const [launch, setLaunch] = useState<Launch>({ days: product?.access_days ?? DEFAULT_DAYS, start: isoToIstInput(product?.sale_starts_at ?? null) });
  const [problem, setProblem] = useState<string | null>(null);
  const newId = product?.id ?? (title ? slug(title) : "");

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!title.trim()) return setProblem("Give it a name.");
    if (!product) {
      if (grants.length < 2) return setProblem("A combo unlocks at least two courses.");
      if (!/^[a-z0-9_]{3,64}$/.test(newId) || draft.products.some((p) => p.id === newId)) return setProblem("Choose another name: that id is taken or too short.");
    }
    const rupees = free ? 0 : Math.round(Number(price));
    if (!free && !(rupees >= 1)) return setProblem("Give a price of at least ₹1.");
    const checked = checkLaunch(launch);
    if (typeof checked === "string") return setProblem(checked);
    // The app's default length stays "default" (null) unless it was set before or is changed now.
    const days = free ? null : product?.access_days == null && checked.access_days === DEFAULT_DAYS ? null : checked.access_days;
    onSave({ id: newId, title: title.trim(), subtitle: subtitle.trim(), badge: badge.trim() || null, ios_product_id: free ? null : ios.trim() || null,
      price_inr: rupees, grants: product?.grants ?? grants, active: product?.active ?? true, free, access_days: days,
      // An unchanged launch time keeps its stored form (the same instant, written the same way).
      sale_starts_at: launch.start && launch.start === isoToIstInput(product?.sale_starts_at ?? null) ? product!.sale_starts_at! : checked.sale_starts_at });
    onClose();
  }

  return (
    <Dialog open onClose={onClose} title={product ? `Edit ${product.title}` : "New combo"}
      description={product ? `Unlocks ${product.grants.map((g) => label(draft, g)).join(" + ")}. What it unlocks can't change once on sale.` : "Several courses sold together at one price."}
      footer={<><button type="button" className="btn" onClick={onClose} data-initial-focus>Cancel</button><button type="submit" form="product-form" className="btn btn-primary">{product ? "Done" : "Add"}</button></>}>
      <form id="product-form" className="form-grid" onSubmit={submit} noValidate>
        <Field id={ids.title} label="Name" hint={!product && newId ? `Id: ${newId}` : undefined}>
          <input id={ids.title} type="text" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={80} />
        </Field>
        <Field id={ids.subtitle} label="Line under the name"><input id={ids.subtitle} type="text" value={subtitle} onChange={(e) => setSubtitle(e.target.value)} maxLength={160} /></Field>
        {canBeFree && <PricingChoice name={`${ids.price}-type`} free={free} onChange={setFree} />}
        {!free && (
          <Field id={ids.price} label="Price (₹, Android and web)"><input id={ids.price} type="number" min={1} value={price} onChange={(e) => setPrice(e.target.value)} /></Field>
        )}
        <Field id={ids.badge} label="Badge (optional)"><input id={ids.badge} type="text" value={badge} onChange={(e) => setBadge(e.target.value)} maxLength={40} placeholder="Best value" /></Field>
        {!free && (
          <Field id={ids.ios} label="App Store product id" hint="Must exist in App Store Connect and RevenueCat; empty: not sold on iPhone.">
            <input id={ids.ios} type="text" value={ios} onChange={(e) => setIos(e.target.value)} maxLength={100} />
          </Field>
        )}
        <LaunchFields free={free} value={launch} onChange={setLaunch} />
        {!product && (
          <fieldset className="field">
            <legend>Unlocks</legend>
            {draft.courses.map((c) => (
              <label key={c.entitlement} className="row small" style={{ gap: 6 }}>
                <input type="checkbox" checked={grants.includes(c.entitlement)}
                  onChange={(e) => setGrants(e.target.checked ? [...grants, c.entitlement] : grants.filter((g) => g !== c.entitlement))} />
                {label(draft, c.entitlement)}
              </label>
            ))}
          </fieldset>
        )}
        {problem && <span className="error" role="alert">{problem}</span>}
      </form>
    </Dialog>
  );
}

function BatchDialog({ draft, batch, subjects, onSave, onRemove, onClose }: {
  draft: Draft;
  batch: BatchRow | null;
  subjects: SubjectOption[];
  onSave: (b: BatchRow) => void;
  onRemove?: () => void;
  onClose: () => void;
}) {
  const ids = { title: useId(), product: useId() };
  const academics = useAcademics();
  const sellable = draft.products.filter((p) => p.active || p.id === batch?.product_id);
  const [streams, setStreams] = useState<string[]>(batch?.streams ?? []);
  const [goals, setGoals] = useState<string[]>(batch?.goals ?? []);
  const [title, setTitle] = useState(batch?.title ?? "");
  const [productId, setProductId] = useState(batch?.product_id ?? sellable[0]?.id ?? "");
  const [light, setLight] = useState(batch?.banner_key ?? "");
  const [fromCourse, setFromCourse] = useState(batch?.banner_from_course ?? false);
  const [dark, setDark] = useState(batch?.banner_key_dark ?? "");
  const [problem, setProblem] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false); // asks to type "remove" first
  const [typedRemove, setTypedRemove] = useState("");
  const removeId = useId();
  const product = draft.products.find((p) => p.id === productId);
  const courses = (product?.grants ?? []).map((g) => draft.courses.find((c) => c.entitlement === g)).filter((c): c is CourseRow => !!c);
  // A new card takes its product's id (class11_physics) unless another card already has it.
  const id = batch?.id ?? (productId && !draft.batches.some((b) => b.id === productId) ? productId : title ? slug(title) : "");
  const missingLectures = courses.filter((c) => subjects.length && !subjects.some((s) => s.class_level === c.class_level && s.subject === c.subject));
  // The course image (App videos) the card falls back to when it has no banner of its own.
  const folder = subjects.find((s) => s.class_level === courses[0]?.class_level && s.subject === courses[0]?.subject)?.folder ?? null;
  const appCourse = useAppCourse(folder ? courses[0]!.class_level : null, folder);
  const noCourseImage = !folder || (appCourse.isSuccess && !appCourse.data.playlist_thumbnail_key);

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!title.trim()) return setProblem("Give the batch a name.");
    if (!batch && (!/^[a-z0-9_]{3,64}$/.test(id) || draft.batches.some((b) => b.id === id))) return setProblem("Choose another name: that id is taken or too short.");
    if (!product || !courses.length) return setProblem("Choose what it sells.");
    // Goals that no ticked stream offers are dropped, as the app would never show them.
    const allowed = academics.data ? goalsFor(academics.data, streams) : goals;
    onSave({ id, title: title.trim(), product_id: productId, class_level: courses[0]!.class_level, subjects: [...new Set(courses.map((c) => c.subject))],
      // No banner of its own: the card shows the course image.
      banner_key: light || null, banner_key_dark: dark || null, banner_from_course: fromCourse || !light, active: batch?.active ?? true,
      streams, goals: goals.filter((g) => allowed.includes(g)) });
    onClose();
  }

  if (removing && onRemove && batch) {
    return (
      <Dialog open onClose={() => setRemoving(false)} title={`Remove ${batch.title}?`}
        description="The card leaves this list; Save to the app takes it off the app's home screen. Its course stays on sale (Courses on sale)."
        footer={
          <>
            <button type="button" className="btn" onClick={() => setRemoving(false)} data-initial-focus>Cancel</button>
            <button type="button" className="btn btn-danger" disabled={typedRemove.trim().toLowerCase() !== "remove"} onClick={() => { onRemove(); onClose(); }}>
              Remove card
            </button>
          </>
        }>
        <div className="field">
          <label htmlFor={removeId}>Type <strong>remove</strong> to confirm</label>
          <input id={removeId} type="text" value={typedRemove} onChange={(e) => setTypedRemove(e.target.value)} autoComplete="off" spellCheck={false} />
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog open onClose={onClose} title={batch ? `Edit ${batch.title}` : "New home-screen batch"} description="A card on the app's home screen that opens a course's lectures and sells it."
      footer={
        <>
          {onRemove && (
            <button type="button" className="btn btn-danger" onClick={() => { setTypedRemove(""); setRemoving(true); }} style={{ marginRight: "auto" }}>
              Remove card
            </button>
          )}
          <button type="button" className="btn" onClick={onClose} data-initial-focus>Cancel</button>
          <button type="submit" form="batch-form" className="btn btn-primary">{batch ? "Done" : "Add"}</button>
        </>
      }>
      <form id="batch-form" className="form-grid" onSubmit={submit} noValidate>
        <Field id={ids.title} label="Name on the card" hint={!batch && id ? `Id: ${id}` : undefined}>
          <input id={ids.title} type="text" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={80} placeholder="e.g. Class 11 Physics" />
        </Field>
        <Field id={ids.product} label="Sells" hint={courses.length ? `Opens: ${courses.map((c) => `Class ${c.class_level} ${c.subject}`).join(", ")}` : undefined}>
          <select id={ids.product} value={productId} onChange={(e) => setProductId(e.target.value)}>
            {sellable.map((p) => <option key={p.id} value={p.id}>{p.title} ({p.free ? "Free" : `₹${p.price_inr}`})</option>)}
          </select>
        </Field>
        {missingLectures.length > 0 && (
          <Notice tone="warning">No lectures folder for {missingLectures.map((c) => `Class ${c.class_level} ${c.subject}`).join(", ")} yet: add them in App videos.</Notice>
        )}
        {academics.data && (
          <Audience academics={academics.data} classLevel={courses[0]?.class_level ?? null} streams={streams} goals={goals}
            onStreams={setStreams} onGoals={setGoals} />
        )}
        <fieldset className="field" style={{ gridColumn: "1 / -1" }}>
          <legend>Card image</legend>
          <label className="checkbox">
            <input type="checkbox" checked={fromCourse} onChange={(e) => setFromCourse(e.target.checked)} />
            Use the course image from App videos (updates by itself)
          </label>
          <span className="hint">
            {fromCourse
              ? `The card shows whatever course image Class ${courses[0]?.class_level ?? ""} ${courses[0]?.subject ?? ""} has in App videos right now; change it there ("Change course image") and the card follows within about 30 seconds. The banner below is only used while there is no course image.`
              : "The card shows its own banner, below. Without one, it shows the course image from App videos instead."}
          </span>
        </fieldset>
        {(["light", "dark"] as const).filter((which) => !(fromCourse && which === "dark")).map((which) => {
          const key = which === "light" ? light : dark;
          const name = which === "light" ? (fromCourse ? "Fallback banner (optional)" : "Banner (optional)") : "Banner for dark mode (optional)";
          const none = which === "dark" ? "None: dark mode shows the main banner."
            : noCourseImage ? "None, and this course has no course image in App videos yet: the app shows the card with its name on a plain background until you add a banner here or a course image there."
            : "None: the card shows the course image from App videos.";
          const what = which === "light" ? "banner" : "dark-mode banner";
          return (
            <div key={which} className="field" style={{ gridColumn: "1 / -1" }}>
              <span className="label">{name}</span>
              {key ? (
                <>
                  <BannerThumb keyName={key} alt={`${name} as it is now`} wide />
                  <div className="row" style={{ gap: 8, alignItems: "center" }}>
                    <button type="button" className="btn btn-sm btn-danger" onClick={() => (which === "light" ? setLight("") : setDark(""))}>
                      {`Delete ${what}`}
                    </button>
                    <span className="hint">Its image is deleted from S3 when you save to the app.</span>
                  </div>
                </>
              ) : <span className="hint">{none}</span>}
              <BannerEditor batchId={id} dark={which === "dark"} label={`${which === "light" ? "Banner" : "Dark-mode banner"}: ${key ? "choose a new image" : "choose an image"} (any size)`}
                onUploaded={(k) => (which === "light" ? setLight(k) : setDark(k))} />
            </div>
          );
        })}
        {problem && <span className="error" role="alert">{problem}</span>}
      </form>
    </Dialog>
  );
}

function BannerThumb({ keyName, alt, wide = false }: { keyName: string; alt: string; wide?: boolean }) {
  const url = useQuery({ queryKey: [...acKeys.all, "banner", keyName], queryFn: () => bannerPreview(keyName), staleTime: 10 * 60_000, retry: false });
  if (url.isPending) return <span className="small muted">Loading…</span>;
  if (url.error) return <span className="small muted">No image</span>;
  // In its own shape, like the app's card (nothing cut, no bands).
  return <img src={url.data} alt={alt} loading="lazy" style={{ width: wide ? "100%" : 120, height: "auto", display: "block", borderRadius: 6 }} />;
}

/** Who sees a home-screen card in the app: the app's own onboarding choices. */
function Audience({ academics, classLevel, streams, goals, onStreams, onGoals }: {
  academics: Academics;
  classLevel: number | null;
  streams: string[];
  goals: string[];
  onStreams: (s: string[]) => void;
  onGoals: (g: string[]) => void;
}) {
  const offered = goalsFor(academics, streams);
  const toggle = (list: string[], item: string, on: boolean) => (on ? [...list, item] : list.filter((x) => x !== item));
  const open = classLevel === null || academics.classes.some((c) => c.class_level === classLevel && c.available);
  return (
    <>
      <fieldset className="field">
        <legend>Streams that see it</legend>
        <div className="chip-list">
          {academics.streams.map((s) => (
            <label key={s} className={`chip ${streams.includes(s) ? "on" : ""}`}>
              <input type="checkbox" checked={streams.includes(s)} onChange={(e) => onStreams(toggle(streams, s, e.target.checked))} />
              {s}
            </label>
          ))}
        </div>
        <span className="hint">
          {classLevel !== null && `Class ${classLevel} (from the course). `}
          {streams.length ? "Students of the \"General\" stream see it too." : "None ticked: every stream."}
        </span>
        {!open && <span className="error">Class {classLevel} isn't open in the app yet: its students can't sign up.</span>}
      </fieldset>
      <fieldset className="field">
        <legend>Goals that see it</legend>
        <div className="chip-list">
          {offered.map((g) => (
            <label key={g} className={`chip ${goals.includes(g) ? "on" : ""}`}>
              <input type="checkbox" checked={goals.includes(g)} onChange={(e) => onGoals(toggle(goals, g, e.target.checked))} />
              {g}
            </label>
          ))}
        </div>
        <span className="hint">
          {goals.length ? "Shown to students who picked at least one of these." : "None ticked: every goal."} Only the goals the app offers for the
          ticked streams are listed.
        </span>
      </fieldset>
    </>
  );
}

const CLASSES_DESCRIPTION = "Which classes a student can pick in the app, at sign-up and in Academic details. The rest show “Coming soon”.";

/** The open classes: editable by the owner once the app's database is set up; otherwise as the app has them. */
function ClassesCard({ academics }: { academics: Academics }) {
  const { canWrite } = useAuth();
  const status = useAppCoursesStatus(canWrite);
  const classes = useClasses(canWrite && status.data?.configured === true);
  const readOnly = (note: ReactNode) => (
    <Card title="Classes" description={CLASSES_DESCRIPTION}>
      <div className="chip-list">
        {academics.classes.map((c) => (
          <span key={c.class_level} className={`chip ${c.available ? "on" : ""}`}>
            {c.name} {c.available ? "· open" : "· coming soon"}
          </span>
        ))}
      </div>
      <p className="small muted" style={{ marginBottom: 0 }}>{note}</p>
    </Card>
  );
  if (!canWrite) return readOnly("Only the owner can open or close classes.");
  if (status.isPending) return <LoadingBlock rows={2} label="Loading the classes" />;
  if (status.error) return <ErrorState error={status.error} onRetry={() => void status.refetch()} />;
  if (!status.data.configured) {
    return readOnly(<>Opening and closing classes needs the app database: set <code>ADHYAAPAK_MONGO_URL</code> and <code>ADHYAAPAK_MONGO_DB</code> in the dashboard's <code>backend/.env</code> and restart it.</>);
  }
  if (classes.isPending) return <LoadingBlock rows={2} label="Loading the classes" />;
  if (classes.error) return <ErrorState error={classes.error} onRetry={() => void classes.refetch()} />;
  return <ClassesEditor key={classes.data.version ?? "code"} state={classes.data} onReload={() => void classes.refetch()} />;
}

function ClassesEditor({ state, onReload }: { state: ClassesState; onReload: () => void }) {
  const initial: ClassRow[] = state.classes.map(({ class_level, name, open }) => ({ class_level, name, open }));
  const keeps = new Set(state.classes.filter((c) => c.students_keep).map((c) => c.class_level));
  const [rows, setRows] = useState<ClassRow[]>(initial);
  const [adding, setAdding] = useState<{ level: string; name: string } | null>(null);
  const [checking, setChecking] = useState<number | null>(null);
  const [blocked, setBlocked] = useState<{ name: string; blockers: string[] } | null>(null);
  const [deleting, setDeleting] = useState<ClassRow | null>(null); // asks to type "delete" first
  const [toggling, setToggling] = useState<{ row: ClassRow; open: boolean } | null>(null); // asks to type "active" / "inactive"
  const [typed, setTyped] = useState("");
  const [problems, setProblems] = useState<string[] | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [stale, setStale] = useState(false);
  const toast = useToast();
  const client = useQueryClient();
  const ids = { level: useId(), name: useId(), confirm: useId() };

  const before = new Map(initial.map((r) => [r.class_level, r]));
  const levels = new Set(rows.map((r) => r.class_level));
  const clean = rows.map((r) => ({ ...r, name: r.name.trim() }));
  const added = clean.filter((r) => !before.has(r.class_level));
  const removed = initial.filter((r) => !levels.has(r.class_level));
  const renamed = clean.filter((r) => before.has(r.class_level) && before.get(r.class_level)!.name !== r.name);
  const opened = clean.filter((r) => r.open && before.get(r.class_level)?.open === false);
  const closed = clean.filter((r) => !r.open && before.get(r.class_level)?.open === true);
  const dirty = JSON.stringify(clean) !== JSON.stringify(initial);
  const names = clean.map((r) => r.name.toLowerCase());
  const problem = !clean.some((r) => r.open)
    ? "Keep at least one class open: new students must be able to sign up."
    : clean.find((r) => !r.name)
      ? `Give Class ${clean.find((r) => !r.name)!.class_level} a name.`
      : names.find((n, i) => names.indexOf(n) !== i)
        ? "Two classes have the same name: students couldn't tell them apart."
        : null;
  const free = Array.from({ length: state.max_class }, (_, i) => i + 1).filter((n) => !levels.has(n));
  const listOf = (list: ClassRow[]) => list.map((r) => r.name).join(", ");
  const set = (level: number, patch: Partial<ClassRow>) => setRows((rs) => rs.map((r) => (r.class_level === level ? { ...r, ...patch } : r)));

  function startAdding() {
    const next = free.find((n) => n > Math.max(0, ...levels)) ?? free[0];
    if (next !== undefined) setAdding({ level: String(next), name: `Class ${next}` });
  }

  function add(e: FormEvent) {
    e.preventDefault();
    if (!adding) return;
    const level = Number(adding.level);
    setRows((rs) => [...rs, { class_level: level, name: adding.name.trim() || `Class ${level}`, open: false }].sort((a, b) => a.class_level - b.class_level));
    setAdding(null);
  }

  async function remove(r: ClassRow) {
    if (!before.has(r.class_level)) return setRows((rs) => rs.filter((x) => x.class_level !== r.class_level)); // added here, not saved yet
    setChecking(r.class_level);
    try {
      const plan = await fetchClassDeletePlan(r.class_level);
      if (plan.blockers.length) setBlocked({ name: r.name, blockers: plan.blockers });
      else {
        setTyped("");
        setDeleting(r);
      }
    } catch (err) {
      toast.error(err, "Couldn't check what uses this class.");
    } finally {
      setChecking(null);
    }
  }

  /** Saves this list to the app: the edits (Save), or one typed-confirmed delete / active / inactive
   * (those wait until nothing else is unsaved, so only that one change goes). */
  async function save(list: ClassRow[] = clean, done?: string) {
    setBusy(true);
    setProblems(null);
    try {
      const out = await saveClasses({ version: state.version, classes: list });
      toast.success(done ?? `Saved (version ${out.summary.version}). The app shows it within about 30 seconds.`);
      setConfirm(false);
      setDeleting(null);
      setToggling(null);
      const { summary, ...next } = out;
      void summary; // the toast used it; the list keeps the rest
      client.setQueryData([...acKeys.all, "classes"], next);
      void client.invalidateQueries({ queryKey: [...acKeys.all, "academics"] });
    } catch (err) {
      setConfirm(false);
      setDeleting(null);
      setToggling(null);
      if (err instanceof ApiError && err.code === "classes_changed") setStale(true);
      else if (err instanceof ApiError && err.code === "class_in_use") setProblems((err.details as { problems?: string[] } | undefined)?.problems ?? [err.message]);
      else toast.error(err, "The classes couldn't be saved.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      title="Classes"
      description={CLASSES_DESCRIPTION}
      actions={<button type="button" className="btn btn-sm btn-primary" onClick={startAdding} disabled={!!adding || free.length === 0}>+ New class</button>}
    >
      <div className="stack" style={{ gap: 12 }}>
        {state.error && <Notice tone="warning">{state.error} Save the classes again to fix it.</Notice>}
        {stale && (
          <Notice tone="warning">
            The classes were changed somewhere else since you opened them, so this save was refused.{" "}
            <button type="button" className="btn btn-sm" onClick={onReload}>Reload them</button> and make your change again.
          </Notice>
        )}
        {problems && (
          <Notice tone="warning">
            <strong>Not saved:</strong>
            <ul style={{ margin: "4px 0 0 16px" }}>{problems.map((p) => <li key={p}>{p}</li>)}</ul>
          </Notice>
        )}
        {adding && (
          <form className="row" style={{ gap: 12, alignItems: "flex-end", flexWrap: "wrap" }} onSubmit={add}>
            <div className="field" style={{ width: 120 }}>
              <label htmlFor={ids.level}>Number</label>
              <select id={ids.level} value={adding.level}
                onChange={(e) => setAdding((a) => a && { level: e.target.value, name: a.name === `Class ${a.level}` ? `Class ${e.target.value}` : a.name })}>
                {free.map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </div>
            <div className="field" style={{ flex: "1 1 220px" }}>
              <label htmlFor={ids.name}>Name in the app</label>
              <input id={ids.name} type="text" value={adding.name} maxLength={40} placeholder="e.g. Dropper"
                onChange={(e) => setAdding((a) => a && { ...a, name: e.target.value })} />
            </div>
            <button type="submit" className="btn btn-primary">Add</button>
            <button type="button" className="btn" onClick={() => setAdding(null)}>Cancel</button>
            <span className="hint" style={{ flexBasis: "100%" }}>
              The number never changes: students' profiles, the lecture folder (<code>videos/class_{adding.level}/</code>) and course ids use it.
              A new class starts closed; open it once its lectures and cards are ready.
            </span>
          </form>
        )}
        <div className="table-wrap">
          <table className="cells-middle">
            <caption className="visually-hidden">The app's classes</caption>
            <thead>
              <tr>
                <th scope="col" className="num">S.No.</th>
                <th scope="col" className="num" title="Fixed: students' profiles, lecture folders and course ids use it">Class no.</th>
                <th scope="col">Name in the app</th>
                <th scope="col">Open</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.class_level}>
                  <td className="num">{i + 1}</td>
                  <td className="num">{r.class_level}</td>
                  <td>
                    <input type="text" value={r.name} maxLength={40} aria-label={`Name of class ${r.class_level}`} style={{ width: "100%", maxWidth: 320 }}
                      onChange={(e) => set(r.class_level, { name: e.target.value })} />
                  </td>
                  <td>
                    <label className="row small" style={{ gap: 6 }}>
                      {/* A saved class goes active / inactive only after typing it, straight to the app; a new
                          (unsaved) class just changes here and goes with Save. */}
                      <input type="checkbox" checked={r.open} aria-label={`Class ${r.class_level} open`}
                        disabled={before.has(r.class_level) && (busy || stale || dirty)}
                        title={before.has(r.class_level) && dirty ? "Save or discard your changes first" : undefined}
                        onChange={(e) => {
                          if (!before.has(r.class_level)) return set(r.class_level, { open: e.target.checked });
                          setTyped("");
                          setToggling({ row: r, open: e.target.checked });
                        }} />
                      {r.open ? "Open" : !before.has(r.class_level) ? "Closed (new)" : keeps.has(r.class_level) ? "Closed (its students keep theirs)" : "Coming soon"}
                    </label>
                  </td>
                  <td>
                    {/* A saved class is deleted straight to the app, so nothing else may be unsaved then. */}
                    <button type="button" className="btn btn-sm btn-danger" onClick={() => void remove(r)}
                      disabled={checking !== null || busy || stale || (dirty && before.has(r.class_level))}
                      title={dirty && before.has(r.class_level) ? "Save or discard your changes first" : undefined}
                      aria-label={`Delete class ${r.class_level}`}>{checking === r.class_level ? "Checking…" : "Delete"}</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <span className="hint">
          Renaming changes only what students see. Closing a class only stops new students picking it: students already in it keep their lectures
          and tests. A class can be deleted only when nothing uses it (no students, courses, cards or lectures).
        </span>
        {dirty && problem && <span className="error" role="alert">{problem}</span>}
        <div className="row" style={{ gap: 8, justifyContent: "flex-end" }}>
          <button type="button" className="btn" onClick={() => { setRows(initial); setAdding(null); setProblems(null); }} disabled={!dirty || busy}>Discard</button>
          <button type="button" className="btn btn-primary" onClick={() => setConfirm(true)} disabled={!dirty || busy || stale || !!problem}>
            Save to the app
          </button>
        </div>
      </div>

      <ConfirmDialog open={confirm} title="Save the classes?" confirmLabel="Save" busy={busy} onConfirm={() => void save()} onCancel={() => setConfirm(false)}>
        <ul style={{ margin: "0 0 8px 16px" }}>
          {added.map((r) => <li key={`a${r.class_level}`}>New class {r.class_level}: {r.name} ({r.open ? "open" : "closed"})</li>)}
          {renamed.map((r) => <li key={`r${r.class_level}`}>Rename class {r.class_level}: {before.get(r.class_level)!.name} → {r.name}</li>)}
          {opened.length > 0 && <li>Open {listOf(opened)}: new students can pick {opened.length === 1 ? "it" : "them"}.</li>}
          {closed.length > 0 && <li>Close {listOf(closed)}: “Coming soon” for new students; students already in {closed.length === 1 ? "it" : "them"} keep their lectures and tests.</li>}
          {removed.length > 0 && <li>Delete {listOf(removed)}: {removed.length === 1 ? "it leaves" : "they leave"} the app's list.</li>}
        </ul>
        <p className="small muted" style={{ margin: 0 }}>The app shows this within about 30 seconds (app versions with this feature).</p>
      </ConfirmDialog>

      {deleting && (
        <Dialog open onClose={() => !busy && setDeleting(null)} title={`Delete ${deleting.name}?`}
          description="Nothing uses this class (no students, courses, cards or lectures). It leaves the app's class list; the app shows that within about 30 seconds."
          footer={<>
            <button type="button" className="btn" onClick={() => setDeleting(null)} disabled={busy} data-initial-focus>Cancel</button>
            <button type="button" className="btn btn-danger" disabled={busy || typed.trim().toLowerCase() !== "delete"}
              onClick={() => void save(clean.filter((r) => r.class_level !== deleting.class_level), `${deleting.name} is deleted from the app's classes.`)}>
              {busy ? "Deleting…" : "Delete"}
            </button>
          </>}>
          <div className="field">
            <label htmlFor={ids.confirm}>Type <strong>delete</strong> to confirm</label>
            <input id={ids.confirm} type="text" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" disabled={busy} />
          </div>
        </Dialog>
      )}

      {toggling && (() => {
        const word = toggling.open ? "active" : "inactive";
        const lastOpen = !toggling.open && clean.filter((r) => r.open).length <= 1;
        return (
          <Dialog open onClose={() => !busy && setToggling(null)} title={`Make ${toggling.row.name} ${word}?`}
            description={toggling.open
              ? "New students can pick it at sign-up and in Academic details. Make sure its lectures (App videos) and cards (Courses & prices) are ready."
              : "New students can't pick it any more: it shows “Coming soon”. Students already in it keep their lectures and tests."}
            footer={<>
              <button type="button" className="btn" onClick={() => setToggling(null)} disabled={busy} data-initial-focus>Cancel</button>
              <button type="button" className={toggling.open ? "btn btn-primary" : "btn btn-danger"} disabled={busy || lastOpen || typed.trim().toLowerCase() !== word}
                onClick={() => void save(clean.map((r) => (r.class_level === toggling.row.class_level ? { ...r, open: toggling.open } : r)),
                  `${toggling.row.name} is now ${word} in the app (within about 30 seconds).`)}>
                {busy ? "Saving…" : toggling.open ? "Make active" : "Make inactive"}
              </button>
            </>}>
            {lastOpen ? (
              <span className="error" role="alert">This is the only open class: keep at least one open so new students can sign up.</span>
            ) : (
              <div className="field">
                <label htmlFor={ids.confirm}>Type <strong>{word}</strong> to confirm</label>
                <input id={ids.confirm} type="text" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" disabled={busy} />
              </div>
            )}
          </Dialog>
        );
      })()}

      {blocked && (
        <Dialog open onClose={() => setBlocked(null)} title={`${blocked.name} can't be deleted`}
          description="Something still uses it. Remove these first, or close the class instead: new students can't pick it, and its students keep everything."
          footer={<button type="button" className="btn btn-primary" onClick={() => setBlocked(null)} data-initial-focus>OK</button>}>
          <ul style={{ margin: "0 0 0 16px" }}>{blocked.blockers.map((b) => <li key={b}>{b}</li>)}</ul>
        </Dialog>
      )}
    </Card>
  );
}

type ListKind = "stream" | "goal";
const LIST_TEXT: Record<ListKind, { title: string; plural: string; description: string }> = {
  stream: {
    title: "Streams",
    plural: "streams",
    description: "A student picks one stream at sign-up and in Academic details, then its goals. Inactive ones aren't offered to new picks.",
  },
  goal: {
    title: "Goals",
    plural: "goals",
    description: "A student picks any of their stream's goals. Tick the streams that offer each goal. Inactive ones aren't offered to new picks.",
  },
};

/** Streams or goals: editable by the owner once the app's database is set up; otherwise as the app has them. */
function ListsCard({ kind, academics }: { kind: ListKind; academics: Academics }) {
  const { canWrite } = useAuth();
  const status = useAppCoursesStatus(canWrite);
  const lists = useLists(canWrite && status.data?.configured === true);
  const text = LIST_TEXT[kind];
  const name = (key: string) => academics.names?.[key] ?? key;
  const readOnly = (note: ReactNode) => {
    const goals = [...new Set(academics.streams.flatMap((s) => academics.stream_goals[s] ?? []))];
    return (
      <Card title={text.title} description={text.description}>
        {kind === "stream" ? (
          <div className="chip-list">{academics.streams.map((s) => <span key={s} className="chip on">{name(s)}</span>)}</div>
        ) : (
          <div className="table-wrap">
            <table>
              <caption className="visually-hidden">Goals each stream offers</caption>
              <thead>
                <tr>
                  <th scope="col">Goal</th>
                  {academics.streams.map((s) => <th key={s} scope="col">{name(s)}</th>)}
                </tr>
              </thead>
              <tbody>
                {goals.map((g) => (
                  <tr key={g}>
                    <th scope="row">{name(g)}</th>
                    {academics.streams.map((s) => (
                      <td key={s}>{(academics.stream_goals[s] ?? []).includes(g) ? <Badge tone="normal">✓</Badge> : <span className="muted" aria-label="Not offered">—</span>}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="small muted" style={{ marginBottom: 0 }}>{note}</p>
      </Card>
    );
  };
  if (!canWrite) return readOnly(`Only the owner can change the ${text.plural}.`);
  if (status.isPending) return <LoadingBlock rows={2} label={`Loading the ${text.plural}`} />;
  if (status.error) return <ErrorState error={status.error} onRetry={() => void status.refetch()} />;
  if (!status.data.configured) {
    return readOnly(<>Changing them needs the app database: set <code>ADHYAAPAK_MONGO_URL</code> and <code>ADHYAAPAK_MONGO_DB</code> in the dashboard's <code>backend/.env</code> and restart it.</>);
  }
  if (lists.isPending) return <LoadingBlock rows={2} label={`Loading the ${text.plural}`} />;
  if (lists.error) return <ErrorState error={lists.error} onRetry={() => void lists.refetch()} />;
  return <ListEditor key={`${kind}-${lists.data.version ?? "code"}`} kind={kind} state={lists.data} onReload={() => void lists.refetch()} />;
}

type ListRow = GoalItem; // a stream's `streams` stays empty

function ListEditor({ kind, state, onReload }: { kind: ListKind; state: ListsState; onReload: () => void }) {
  const text = LIST_TEXT[kind];
  const initial: ListRow[] = kind === "stream" ? state.streams.map((s) => ({ ...s, streams: [] })) : state.goals.map((g) => ({ ...g, streams: [...g.streams] }));
  const [rows, setRows] = useState<ListRow[]>(initial);
  const [adding, setAdding] = useState<string | null>(null);
  const [checking, setChecking] = useState<string | null>(null);
  const [blocked, setBlocked] = useState<{ name: string; blockers: string[] } | null>(null);
  const [deleting, setDeleting] = useState<ListRow | null>(null);
  const [toggling, setToggling] = useState<{ row: ListRow; active: boolean } | null>(null);
  // Making a stream with no active goal active: the goals to offer it, picked in the same step.
  const [linkGoals, setLinkGoals] = useState<string[]>([]);
  const [typed, setTyped] = useState("");
  const [problems, setProblems] = useState<string[] | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [stale, setStale] = useState(false);
  const toast = useToast();
  const client = useQueryClient();
  const ids = { name: useId(), confirm: useId() };
  const single = kind === "stream" ? "stream" : "goal";

  const before = new Map(initial.map((r) => [r.key, r]));
  const clean = rows.map((r) => ({ ...r, name: r.name.trim() }));
  const added = clean.filter((r) => !before.has(r.key));
  const renamed = clean.filter((r) => before.has(r.key) && before.get(r.key)!.name !== r.name);
  const relinked = clean.filter((r) => before.has(r.key) && [...before.get(r.key)!.streams].sort().join() !== [...r.streams].sort().join());
  const dirty = JSON.stringify(clean) !== JSON.stringify(initial);
  const names = clean.map((r) => r.name.toLowerCase());
  const problem = clean.find((r) => !r.name)
    ? `Give every ${single} a name.`
    : names.find((n, i) => names.indexOf(n) !== i)
      ? `Two ${text.plural} have the same name: students couldn't tell them apart.`
      : null;
  const streamName = (key: string) => state.streams.find((s) => s.key === key)?.name ?? key;
  const set = (key: string, patch: Partial<ListRow>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  /** Both lists as the app gets them, with this list replaced (a deleted stream leaves the goals too;
   * `link` offers these goals to a stream as well). */
  function body(list: ListRow[], link?: { stream: string; goals: string[] }) {
    if (kind === "stream") {
      const keys = new Set(list.map((s) => s.key));
      return {
        version: state.version,
        streams: list.map(({ key, name, active }) => ({ key, name, active })),
        goals: state.goals.map((g) => {
          const streams = g.streams.filter((s) => keys.has(s));
          return { ...g, streams: link?.goals.includes(g.key) && !streams.includes(link.stream) ? [...streams, link.stream] : streams };
        }),
      };
    }
    return { version: state.version, streams: state.streams, goals: list };
  }

  function add(e: FormEvent) {
    e.preventDefault();
    const name = (adding ?? "").trim();
    if (!name) return;
    if (rows.some((r) => r.key.toLowerCase() === name.toLowerCase() || r.name.toLowerCase() === name.toLowerCase())) {
      return toast.error(new Error(`${name} is already in the list.`), "Pick another name.");
    }
    // The key is the first name, for good: profiles store it. A new one starts inactive.
    setRows((rs) => [...rs, { key: name, name, active: false, streams: [] }]);
    setAdding(null);
  }

  async function remove(r: ListRow) {
    if (!before.has(r.key)) return setRows((rs) => rs.filter((x) => x.key !== r.key)); // added here, not saved yet
    setChecking(r.key);
    try {
      const plan = await fetchListDeletePlan(kind, r.key);
      if (plan.blockers.length) setBlocked({ name: r.name, blockers: plan.blockers });
      else {
        setTyped("");
        setDeleting(r);
      }
    } catch (err) {
      toast.error(err, `Couldn't check what uses this ${single}.`);
    } finally {
      setChecking(null);
    }
  }

  async function save(list: ListRow[] = clean, done?: string, link?: { stream: string; goals: string[] }) {
    setBusy(true);
    setProblems(null);
    try {
      const out = await saveLists(body(list, link));
      toast.success(done ?? "Saved. The app shows it within about 30 seconds.");
      setConfirm(false);
      setDeleting(null);
      setToggling(null);
      const { summary, ...next } = out;
      void summary; // the toast used it; the list keeps the rest
      client.setQueryData([...acKeys.all, "lists"], next);
      void client.invalidateQueries({ queryKey: [...acKeys.all, "academics"] });
    } catch (err) {
      setConfirm(false);
      setDeleting(null);
      setToggling(null);
      if (err instanceof ApiError && err.code === "lists_changed") setStale(true);
      else if (err instanceof ApiError && (err.code === "lists_in_use" || err.code === "lists_invalid" || err.code === "lists_none_active")) {
        setProblems((err.details as { problems?: string[] } | undefined)?.problems ?? [err.message]);
      } else toast.error(err, `The ${text.plural} couldn't be saved.`);
    } finally {
      setBusy(false);
    }
  }

  const waits = (r: ListRow) => before.has(r.key) && dirty;

  return (
    <Card title={text.title} description={text.description}
      actions={<button type="button" className="btn btn-sm btn-primary" onClick={() => setAdding("")} disabled={adding !== null}>+ New {single}</button>}>
      <div className="stack" style={{ gap: 12 }}>
        {state.error && <Notice tone="warning">{state.error} Save them again to fix it.</Notice>}
        {stale && (
          <Notice tone="warning">
            The streams and goals were changed somewhere else since you opened them, so this save was refused.{" "}
            <button type="button" className="btn btn-sm" onClick={onReload}>Reload them</button> and make your change again.
          </Notice>
        )}
        {problems && (
          <Notice tone="warning">
            <strong>Not saved:</strong>
            <ul style={{ margin: "4px 0 0 16px" }}>{problems.map((p) => <li key={p}>{p}</li>)}</ul>
          </Notice>
        )}
        {adding !== null && (
          <form className="row" style={{ gap: 12, alignItems: "flex-end", flexWrap: "wrap" }} onSubmit={add}>
            <div className="field" style={{ flex: "1 1 260px" }}>
              <label htmlFor={ids.name}>New {single}'s name</label>
              <input id={ids.name} type="text" value={adding} maxLength={60} onChange={(e) => setAdding(e.target.value)}
                placeholder={kind === "stream" ? "e.g. Vocational" : "e.g. Olympiad"} />
            </div>
            <button type="submit" className="btn btn-primary" disabled={!adding.trim()}>Add</button>
            <button type="button" className="btn" onClick={() => setAdding(null)}>Cancel</button>
            <span className="hint" style={{ flexBasis: "100%" }}>
              This first name is saved for good in students' profiles; you can rename what they see later. It starts inactive
              {kind === "goal" ? ": tick its streams, then make it active." : ": give it goals in Goals, then make it active."}
            </span>
          </form>
        )}
        <div className="table-wrap table-scroll" style={{ maxHeight: LIST_HEIGHT }}>
          <table className="cells-middle">
            <caption className="visually-hidden">The app's {text.plural}</caption>
            <thead>
              <tr>
                <th scope="col" className="num">S.No.</th>
                <th scope="col">Name in the app</th>
                {kind === "goal" && <th scope="col">Streams that offer it</th>}
                <th scope="col">Active</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.key}>
                  <td className="num">{i + 1}</td>
                  <td>
                    <input type="text" value={r.name} maxLength={60} aria-label={`Name of ${r.key}`} style={{ width: "100%", maxWidth: 280 }}
                      onChange={(e) => set(r.key, { name: e.target.value })} />
                    {r.name.trim() !== r.key && <div className="small muted">Saved as “{r.key}”</div>}
                  </td>
                  {kind === "goal" && (
                    <td>
                      <div className="chip-list">
                        {state.streams.map((s) => {
                          const on = r.streams.includes(s.key);
                          return (
                            <label key={s.key} className={`chip ${on ? "on" : ""}`}>
                              <input type="checkbox" checked={on} aria-label={`${r.key} for ${s.key}`}
                                onChange={(e) => set(r.key, { streams: e.target.checked ? [...r.streams, s.key] : r.streams.filter((x) => x !== s.key) })} />
                              {streamName(s.key)}
                            </label>
                          );
                        })}
                      </div>
                    </td>
                  )}
                  <td>
                    <label className="row small" style={{ gap: 6 }}>
                      <input type="checkbox" checked={r.active} aria-label={`${r.key} active`}
                        disabled={before.has(r.key) && (busy || stale || dirty)}
                        title={waits(r) ? "Save or discard your changes first" : undefined}
                        onChange={(e) => {
                          if (!before.has(r.key)) return set(r.key, { active: e.target.checked });
                          setTyped("");
                          setLinkGoals([]);
                          setToggling({ row: r, active: e.target.checked });
                        }} />
                      {r.active ? "Active" : before.has(r.key) ? "Inactive" : "Inactive (new)"}
                    </label>
                  </td>
                  <td>
                    <button type="button" className="btn btn-sm btn-danger" onClick={() => void remove(r)}
                      disabled={checking !== null || busy || stale || waits(r)}
                      title={waits(r) ? "Save or discard your changes first" : undefined}
                      aria-label={`Delete ${r.key}`}>{checking === r.key ? "Checking…" : "Delete"}</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <span className="hint">
          Renaming changes only what students see. Inactive: not offered to new picks; students who have it keep it. A {single} can be deleted only
          when no student has it and no home-screen card aims at it.
        </span>
        {dirty && problem && <span className="error" role="alert">{problem}</span>}
        <div className="row" style={{ gap: 8, justifyContent: "flex-end" }}>
          <button type="button" className="btn" onClick={() => { setRows(initial); setAdding(null); setProblems(null); }} disabled={!dirty || busy}>Discard</button>
          <button type="button" className="btn btn-primary" onClick={() => setConfirm(true)} disabled={!dirty || busy || stale || !!problem}>Save to the app</button>
        </div>
      </div>

      <ConfirmDialog open={confirm} title={`Save the ${text.plural}?`} confirmLabel="Save" busy={busy} onConfirm={() => void save()} onCancel={() => setConfirm(false)}>
        <ul style={{ margin: "0 0 8px 16px" }}>
          {added.map((r) => <li key={`a${r.key}`}>New {single}: {r.name} ({r.active ? "active" : "inactive"}{kind === "goal" && r.streams.length ? `, for ${r.streams.map(streamName).join(", ")}` : ""})</li>)}
          {renamed.map((r) => <li key={`r${r.key}`}>Rename: {before.get(r.key)!.name} → {r.name}</li>)}
          {relinked.map((r) => <li key={`l${r.key}`}>{r.name}: offered to {r.streams.length ? r.streams.map(streamName).join(", ") : "no stream"}</li>)}
        </ul>
        <p className="small muted" style={{ margin: 0 }}>The app shows this within about 30 seconds (app versions with this feature).</p>
      </ConfirmDialog>

      {toggling && (() => {
        const word = toggling.active ? "active" : "inactive";
        const stream = toggling.row.key;
        // A stream with no active goal: its students couldn't finish signing up, so pick goals for it here.
        const needsGoals = kind === "stream" && toggling.active && !state.goals.some((g) => g.active && g.streams.includes(stream));
        const activeGoals = state.goals.filter((g) => g.active);
        return (
          <Dialog open onClose={() => !busy && setToggling(null)} title={`Make ${toggling.row.name} ${word}?`}
            description={toggling.active
              ? `New students can pick it at sign-up and in Academic details.${kind === "stream" ? "" : " It shows for the streams ticked for it."}`
              : "New students can't pick it any more. Students who have it keep it."}
            footer={<>
              <button type="button" className="btn" onClick={() => setToggling(null)} disabled={busy} data-initial-focus>Cancel</button>
              <button type="button" className={toggling.active ? "btn btn-primary" : "btn btn-danger"}
                disabled={busy || typed.trim().toLowerCase() !== word || (needsGoals && linkGoals.length === 0)}
                onClick={() => void save(clean.map((r) => (r.key === stream ? { ...r, active: toggling.active } : r)),
                  `${toggling.row.name} is now ${word} in the app (within about 30 seconds).`,
                  needsGoals ? { stream, goals: linkGoals } : undefined)}>
                {busy ? "Saving…" : toggling.active ? "Make active" : "Make inactive"}
              </button>
            </>}>
            {needsGoals && (
              <fieldset className="field" style={{ marginBottom: 12 }}>
                <legend>Goals it offers</legend>
                <span className="hint">No active goal is offered to {toggling.row.name} yet: pick at least one, or its students couldn't finish signing up.</span>
                <div className="chip-list">
                  {activeGoals.map((g) => {
                    const on = linkGoals.includes(g.key);
                    return (
                      <label key={g.key} className={`chip ${on ? "on" : ""}`}>
                        <input type="checkbox" checked={on} disabled={busy}
                          onChange={(e) => setLinkGoals((l) => (e.target.checked ? [...l, g.key] : l.filter((x) => x !== g.key)))} />
                        {g.name}
                      </label>
                    );
                  })}
                </div>
              </fieldset>
            )}
            <div className="field">
              <label htmlFor={ids.confirm}>Type <strong>{word}</strong> to confirm</label>
              <input id={ids.confirm} type="text" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" disabled={busy} />
            </div>
          </Dialog>
        );
      })()}

      {deleting && (
        <Dialog open onClose={() => !busy && setDeleting(null)} title={`Delete ${deleting.name}?`}
          description={`No student has it and no home-screen card aims at it. It leaves the app's ${text.plural}${kind === "stream" ? " (and every goal's stream list)" : ""}; the app shows that within about 30 seconds.`}
          footer={<>
            <button type="button" className="btn" onClick={() => setDeleting(null)} disabled={busy} data-initial-focus>Cancel</button>
            <button type="button" className="btn btn-danger" disabled={busy || typed.trim().toLowerCase() !== "delete"}
              onClick={() => void save(clean.filter((r) => r.key !== deleting.key), `${deleting.name} is deleted from the app's ${text.plural}.`)}>
              {busy ? "Deleting…" : "Delete"}
            </button>
          </>}>
          <div className="field">
            <label htmlFor={ids.confirm}>Type <strong>delete</strong> to confirm</label>
            <input id={ids.confirm} type="text" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" disabled={busy} />
          </div>
        </Dialog>
      )}

      {blocked && (
        <Dialog open onClose={() => setBlocked(null)} title={`${blocked.name} can't be deleted`}
          description="Something still uses it. Remove these first, or make it inactive instead: new students can't pick it, and those who have it keep it."
          footer={<button type="button" className="btn btn-primary" onClick={() => setBlocked(null)} data-initial-focus>OK</button>}>
          <ul style={{ margin: "0 0 0 16px" }}>{blocked.blockers.map((b) => <li key={b}>{b}</li>)}</ul>
        </Dialog>
      )}
    </Card>
  );
}

const MANAGE = [
  { id: "classes", label: "Classes" },
  { id: "streams", label: "Streams" },
  { id: "goals", label: "Goals" },
] as const;

/** The app's onboarding lists: what a student can pick, so courses can be aimed at them. One list at a time. */
export function AppAcademics() {
  const academics = useAcademics();
  const [params, setParams] = useSearchParams();
  const manageId = useId();
  const requested = params.get("list");
  const list = MANAGE.find((m) => m.id === requested)?.id ?? "classes";
  if (academics.isPending) return <LoadingBlock rows={3} label="Loading" />;
  if (academics.error) return <ErrorState error={academics.error} onRetry={() => void academics.refetch()} />;
  const a = academics.data;
  return (
    <div className="stack" style={{ gap: 16 }}>
      <Notice tone="info">
        What a student picks when they sign up to the AdhyaapakAI app: a class, a stream and goals. Each one's name, whether it's offered, new
        ones and deleting unused ones are set here. Home-screen batches (Courses & prices) are aimed at a class, streams and goals from these lists.
      </Notice>
      <div className="field" style={{ maxWidth: 260 }}>
        <label htmlFor={manageId}>Manage</label>
        <select id={manageId} value={list}
          onChange={(e) => setParams((p) => { const next = new URLSearchParams(p); next.set("list", e.target.value); return next; }, { replace: true })}>
          {MANAGE.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
        </select>
      </div>
      {list === "classes" ? <ClassesCard academics={a} /> : <ListsCard key={list} kind={list === "streams" ? "stream" : "goal"} academics={a} />}
    </div>
  );
}


/** Delete a course for good: it leaves the app, and its banners and lecture folder leave S3. */
function DeleteCourseDialog({ product, version, onClose }: { product: ProductRow; version: number | null; onClose: () => void }) {
  const confirmId = useId();
  const toast = useToast();
  const client = useQueryClient();
  const plan = useQuery({ queryKey: [...acKeys.all, "delete-check", product.id], queryFn: () => fetchDeletePlan(product.id), retry: false, gcTime: 0 });
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const blocked = !plan.data || plan.data.blockers.length > 0;

  async function remove() {
    setBusy(true);
    try {
      const out = await deleteCourse(product.id, version);
      client.setQueryData(acKeys.catalog, out.catalog);
      await client.invalidateQueries({ queryKey: avKeys.all });
      if (out.s3_error) toast.error(new Error(out.s3_error), "The course left the app, but some of its files are still in S3.");
      else toast.success(`${product.title} is deleted: it left the app, with its banners and lecture files.`);
      onClose();
    } catch (err) {
      toast.error(err, "The course couldn't be deleted.");
      setBusy(false);
    }
  }

  return (
    <Dialog open onClose={onClose} title={`Delete ${product.title}?`} description="Permanent: S3 keeps no copies, so nothing can be brought back."
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} data-initial-focus>Cancel</button>
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
          <strong>This course can't be deleted.</strong>
          <ul style={{ margin: "4px 0 0 16px" }}>{plan.data.blockers.map((b) => <li key={b}>{b}</li>)}</ul>
        </Notice>
      ) : (
        <div className="stack" style={{ gap: 12 }}>
          <div>
            <strong>Leaves the app</strong>
            <ul style={{ margin: "4px 0 0 16px" }}>
              <li>The course {plan.data.entitlement} and what sells it: {plan.data.products.join(", ")}</li>
              <li>{plan.data.batches.length ? `Home-screen card${plan.data.batches.length === 1 ? "" : "s"}: ${plan.data.batches.join(", ")}` : "No home-screen card"}</li>
            </ul>
          </div>
          <div>
            <strong>Deleted from S3</strong>
            <ul style={{ margin: "4px 0 0 16px" }}>
              <li>{plan.data.banners.length} banner image{plan.data.banners.length === 1 ? "" : "s"} (batch-banners/)</li>
              <li>
                {plan.data.folder
                  ? <>The whole lecture folder <code>{plan.data.folder}</code>: {plan.data.files} file{plan.data.files === 1 ? "" : "s"}, {fileSize(plan.data.bytes)} (videos, demo videos, language copies and images). The live app reads this folder too.</>
                  : "No lecture folder"}
              </li>
            </ul>
          </div>
          <Notice tone="warning">While any student can still open this course, the app refuses: switch it off instead and they keep it. Vouchers for it stop working; purchase records stay.</Notice>
          <div className="field">
            <label htmlFor={confirmId}>Type <strong>delete</strong> to confirm</label>
            <input id={confirmId} type="text" value={typed} onChange={(e) => setTyped(e.target.value.trim())} autoComplete="off" spellCheck={false} disabled={busy} />
          </div>
        </div>
      )}
    </Dialog>
  );
}

function PricingChoice({ name, free, onChange }: { name: string; free: boolean; onChange: (free: boolean) => void }) {
  return (
    <fieldset className="field" style={{ gridColumn: "1 / -1" }}>
      <legend>Course type</legend>
      <div className="row" style={{ gap: 16 }}>
        <label className="checkbox"><input type="radio" name={name} checked={!free} onChange={() => onChange(false)} /> Paid</label>
        <label className="checkbox"><input type="radio" name={name} checked={free} onChange={() => onChange(true)} /> Free</label>
      </div>
      <span className="hint">
        {free
          ? "Every lecture is open to every student, with nothing to buy: it isn't on the payment screen, and its card shows it as theirs."
          : "Students who haven't bought it see the lectures locked (the free demo videos stay open)."}
      </span>
    </fieldset>
  );
}

// --- access validity and launch (sale start) ------------------------------------------------

const DEFAULT_DAYS = 182; // the app's ACCESS_DAYS: about 6 months
const VALIDITY_PRESETS = [
  { days: 91, label: "3 months (91 days)" },
  { days: 182, label: "6 months (182 days)" },
  { days: 365, label: "1 year (365 days)" },
];

interface Launch {
  days: number | "custom" | string; // a preset, or the custom number of days being typed
  start: string; // datetime-local in IST, "" = no launch time
}

function validityLabel(days: number): string {
  const preset = VALIDITY_PRESETS.find((p) => p.days === days);
  return preset ? preset.label.replace(/ \(.*\)/, "") : `${days} days`;
}

function istLabel(iso: string): string {
  return new Date(iso).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" });
}

function checkLaunch(l: Launch): { access_days: number; sale_starts_at: string | null } | string {
  const days = Number(l.days);
  if (!Number.isInteger(days) || days < 1 || days > 3650) return "Access validity must be 1 to 3650 days.";
  if (!l.start) return { access_days: days, sale_starts_at: null };
  const iso = istInputToIso(l.start);
  return iso ? { access_days: days, sale_starts_at: iso } : "Choose a valid launch date and time.";
}

function LaunchFields({ free, value, onChange }: { free: boolean; value: Launch; onChange: (l: Launch) => void }) {
  const ids = { days: useId(), custom: useId(), start: useId() };
  const preset = VALIDITY_PRESETS.some((p) => p.days === Number(value.days)) && value.days !== "custom" ? String(value.days) : "custom";
  return (
    <>
      {!free && (
        <div className="field">
          <label htmlFor={ids.days}>Access validity</label>
          <select id={ids.days} value={preset} onChange={(e) => onChange({ ...value, days: e.target.value === "custom" ? "custom" : Number(e.target.value) })}>
            {VALIDITY_PRESETS.map((p) => <option key={p.days} value={p.days}>{p.label}</option>)}
            <option value="custom">Custom number of days…</option>
          </select>
          {preset === "custom" && (
            <input id={ids.custom} type="number" min={1} max={3650} aria-label="Access validity in days" style={{ marginTop: 6 }}
              value={value.days === "custom" ? "" : value.days} onChange={(e) => onChange({ ...value, days: e.target.value })} />
          )}
          <span className="hint">From each purchase. Buying again adds it from the current end date. Changing it later affects new purchases only.</span>
        </div>
      )}
      <div className="field">
        <label htmlFor={ids.start}>Opens for sale (IST, optional)</label>
        <input id={ids.start} type="datetime-local" value={value.start} onChange={(e) => onChange({ ...value, start: e.target.value })} />
        <span className="hint">Before this, it isn't sold and its home-screen card is hidden{free ? " (a free course opens then)" : ""}. Empty: on sale once saved.</span>
      </div>
    </>
  );
}
