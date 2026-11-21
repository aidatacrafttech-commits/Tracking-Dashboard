import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useRef, useState, type FormEvent } from "react";
import { ApiError } from "../../api/client";
import { useAuth } from "../../auth/AuthContext";
import { DataTable, type Column } from "../../components/DataTable";
import { ConfirmDialog, Dialog } from "../../components/Dialog";
import { useToast } from "../../components/Toast";
import { Badge, Card, EmptyState, ErrorState, LoadingBlock, Notice } from "../../components/ui";
import { BannerEditor } from "./BannerEditor";
import {
  avKeys,
  completeUpload,
  createClass,
  createSubject,
  deleteCourseImage,
  deleteFile,
  fileSize,
  LANGUAGE_LABEL,
  postToS3,
  previewUrl,
  requestTicket,
  useAppCourse,
  useAppVideosStatus,
  useClasses,
  useSubjects,
  type AppChapter,
  type AppCourse,
  type AppLecture,
  type AppVideosStatus,
  type UploadInput,
} from "./appVideosApi";

type Upload =
  | { kind: "lecture"; chapter: AppChapter | null } // null: in a new chapter
  | { kind: "demo"; chapter: AppChapter }
  | { kind: "replace"; chapter: AppChapter; lecture: AppLecture }
  | { kind: "language"; chapter: AppChapter; lecture: AppLecture }
  | { kind: "lecture_thumbnail"; chapter: AppChapter; lecture: AppLecture }
  | { kind: "chapter_thumbnail"; chapter: AppChapter }
  | { kind: "playlist_thumbnail" };

interface Removal {
  key: string;
  whole: boolean;
  courseImage?: boolean; // the subject's course image (all of its files)
  what: string;
  detail: string;
}

interface Preview {
  key: string;
  title: string;
}

const IMAGE_ACCEPT = ".png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp";
const VIDEO_ACCEPT = ".mp4,video/mp4";

const isImage = (key: string) => /\.(png|jpe?g|webp)$/i.test(key);
const chapterName = (c: AppChapter) => (c.is_demo ? c.title : `Chapter ${c.number} · ${c.title}`);

/** The app's own lectures: what students see in the AdhyaapakAI app, read from and written to
 * the app's S3 folder. Owner only. */
export function AppVideos() {
  const { canWrite } = useAuth();
  const status = useAppVideosStatus(canWrite);
  if (!canWrite) {
    return <Notice tone="info">Only the owner can manage the app's videos: they are the paid lectures students watch.</Notice>;
  }
  if (status.isPending) return <LoadingBlock rows={3} label="Loading" />;
  if (status.error) return <ErrorState error={status.error} onRetry={() => void status.refetch()} />;
  if (!status.data.configured) {
    return (
      <Notice tone="warning">
        <strong>App videos are not configured.</strong> Set <code>COURSE_ASSETS_BUCKET</code> to the app's bucket, with its keys, in the
        dashboard's <code>backend/.env</code>, and restart it.
      </Notice>
    );
  }
  return <Browser status={status.data} />;
}

function Browser({ status }: { status: AppVideosStatus }) {
  const classes = useClasses(true);
  const [chosenClass, setChosenClass] = useState<number | null>(null);
  const [chosenSubject, setChosenSubject] = useState<string | null>(null);
  const classList = classes.data ?? [];
  const classLevel = chosenClass ?? (classList.includes(12) ? 12 : (classList[0] ?? null));
  const subjects = useSubjects(classLevel);
  const subjectList = subjects.data ?? [];
  const subject = chosenSubject && subjectList.includes(chosenSubject) ? chosenSubject : (subjectList[0] ?? null);
  const course = useAppCourse(classLevel, subject);
  const classId = useId();
  const subjectId = useId();
  const [creating, setCreating] = useState<"class" | "subject" | null>(null);

  if (classes.error) return <ErrorState error={classes.error} onRetry={() => void classes.refetch()} />;

  return (
    <div className="stack" style={{ gap: 16 }}>
      <Notice tone="info">
        This is the app's own course library. Anything you add, replace or delete here is in the AdhyaapakAI app for every student within about 30
        seconds. Deleted and replaced files can't be brought back.
      </Notice>
      <div className="filters">
        <div className="field">
          <label htmlFor={classId}>Class</label>
          <select id={classId} value={classLevel ?? ""} onChange={(e) => { setChosenClass(Number(e.target.value)); setChosenSubject(null); }}
            disabled={classes.isPending}>
            {classList.map((c) => <option key={c} value={c}>Class {c}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor={subjectId}>Subject</label>
          <select id={subjectId} value={subject ?? ""} onChange={(e) => setChosenSubject(e.target.value)} disabled={!subjectList.length}>
            {subjectList.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        <button type="button" className="btn" style={{ alignSelf: "end" }} onClick={() => void course.refetch()} disabled={!subject || course.isFetching}>
          {course.isFetching ? "Refreshing…" : "Refresh"}
        </button>
        <button type="button" className="btn" style={{ alignSelf: "end" }} onClick={() => setCreating("class")} disabled={classes.isPending}>+ New class</button>
        <button type="button" className="btn" style={{ alignSelf: "end" }} onClick={() => setCreating("subject")} disabled={classLevel === null}>
          + New subject
        </button>
      </div>
      {creating && (
        <NewFolderDialog kind={creating} classLevel={classLevel} classes={classList} onClose={() => setCreating(null)}
          onCreated={(level, name) => { setChosenClass(level); setChosenSubject(name); setCreating(null); }} />
      )}
      {subjects.error ? (
        <ErrorState error={subjects.error} onRetry={() => void subjects.refetch()} />
      ) : !subject ? (
        subjects.isPending ? <LoadingBlock rows={3} label="Loading subjects" /> : <EmptyState title="No subjects">This class has no subject folders.</EmptyState>
      ) : course.isPending ? (
        <LoadingBlock rows={5} label="Loading lectures" />
      ) : course.error ? (
        <ErrorState error={course.error} onRetry={() => void course.refetch()} />
      ) : (
        <CourseView key={`${classLevel}-${subject}`} course={course.data} status={status} />
      )}
    </div>
  );
}

function CourseView({ course, status }: { course: AppCourse; status: AppVideosStatus }) {
  const [upload, setUpload] = useState<Upload | null>(null);
  const [removal, setRemoval] = useState<Removal | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [removing, setRemoving] = useState(false);
  const [chosen, setChosen] = useState<string | null>(null);
  const pickerId = useId();
  const toast = useToast();
  const client = useQueryClient();
  const all = course.chapters; // the free demo videos first, then the chapters in order
  const chapters = all.filter((c) => !c.is_demo);
  // One chapter at a time: the chosen one, else the first chapter with lectures.
  const current = all.find((c) => c.folder === chosen) ?? chapters.find((c) => c.lectures.length) ?? all[0]!;
  const index = all.indexOf(current);

  function uploaded(key: string) {
    // A new chapter's first lecture: show that chapter once the list refreshes.
    const folder = key.match(/\/chapters\/([^/]+)\//)?.[1];
    if (folder) setChosen(folder);
  }

  async function confirmRemoval() {
    if (!removal) return;
    setRemoving(true);
    try {
      let empty: string[] = [];
      let deleted: string[];
      if (removal.courseImage) {
        const out = await deleteCourseImage({ class_level: course.class_level, subject: course.subject });
        deleted = out.deleted;
        empty = out.empty_cards ?? [];
      } else {
        deleted = (await deleteFile({ class_level: course.class_level, subject: course.subject, key: removal.key, whole_lecture: removal.whole })).deleted;
      }
      toast.success(`${removal.what} is deleted (${deleted.length} file${deleted.length === 1 ? "" : "s"}). It leaves the app within about 30 seconds.`);
      if (empty.length) {
        toast.info(`${empty.join(", ")} now ${empty.length === 1 ? "has" : "have"} no picture in the app: give ${empty.length === 1 ? "it" : "them"} a banner in Courses & prices, or add a course image here.`);
      }
      setRemoval(null);
    } catch (err) {
      toast.error(err, "The file couldn't be deleted.");
      setRemoval(null);
    } finally {
      setRemoving(false);
      await client.invalidateQueries({ queryKey: avKeys.all });
    }
  }

  const columns = (chapter: AppChapter): Column<AppLecture>[] => [
    { key: "number", header: "No.", render: (l) => l.number, numeric: true },
    {
      key: "title",
      header: "Lecture (as in the app)",
      render: (l) => (
        <div>
          <strong>{l.title}</strong>
          <div className="small muted" style={{ wordBreak: "break-all" }}>{l.filename}</div>
        </div>
      ),
    },
    {
      key: "languages",
      header: "Languages",
      // Green: each language this lecture has a video in (Hinglish is the main video). Below: the app's
      // languages it doesn't have yet (+ Language adds them).
      render: (l) => {
        const missing = status.languages.filter((lang) => !l.languages.some((x) => x.language === lang));
        return (
          <div className="stack" style={{ gap: 4 }}>
            <div className="row" style={{ gap: 4, flexWrap: "wrap" }}>
              <Badge tone="normal">Hinglish</Badge>
              {l.languages.map((x) => (
                <span key={x.language} className="row" style={{ gap: 2 }}>
                  <Badge tone="normal">{LANGUAGE_LABEL(x.language)}</Badge>
                  <button type="button" className="btn btn-sm btn-ghost" style={{ padding: "0 4px" }}
                    aria-label={`Delete the ${LANGUAGE_LABEL(x.language)} copy of ${l.title}`}
                    onClick={() => setRemoval({ key: x.key, whole: false, what: `The ${LANGUAGE_LABEL(x.language)} copy of ${l.title}`,
                      detail: "Only this language copy is deleted; the lecture and its other languages stay." })}>×</button>
                </span>
              ))}
            </div>
            <span className="small muted">
              {missing.length ? `Not added yet: ${missing.map(LANGUAGE_LABEL).join(", ")}` : "Every language added"}
            </span>
          </div>
        );
      },
    },
    {
      key: "image",
      header: "Image",
      render: (l) => (
        <div className="row" style={{ gap: 4 }}>
          {l.thumbnail_key && (
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setPreview({ key: l.thumbnail_key!, title: `${l.title}: image` })}
              aria-label={`View the image of ${l.title}`}>View</button>
          )}
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => setUpload({ kind: "lecture_thumbnail", chapter, lecture: l })}
            aria-label={`${l.thumbnail_key ? "Change" : "Add"} the image of ${l.title}`}>{l.thumbnail_key ? "Change" : "Add"}</button>
        </div>
      ),
    },
    { key: "size", header: "Size", render: (l) => fileSize(l.size), numeric: true },
    {
      key: "actions",
      header: "Actions",
      render: (l) => (
        <div className="row" style={{ gap: 4, flexWrap: "nowrap" }}>
          <button type="button" className="btn btn-sm" onClick={() => setPreview({ key: l.key, title: l.title })} aria-label={`Watch ${l.title}`}>Watch</button>
          <button type="button" className="btn btn-sm" onClick={() => setUpload({ kind: "language", chapter, lecture: l })} disabled={!l.numbered}
            title={l.numbered ? undefined : "The file name has no lecture number, so the app can't match a language copy to it."}
            aria-label={`Add a language to ${l.title}`}>+ Language</button>
          <button type="button" className="btn btn-sm" onClick={() => setUpload({ kind: "replace", chapter, lecture: l })}
            aria-label={`Replace the video of ${l.title}`}>Replace</button>
          <button type="button" className="btn btn-sm btn-danger" aria-label={`Delete ${l.title}`}
            onClick={() => setRemoval({ key: l.key, whole: true, what: `${chapterName(chapter)}: ${l.title}`,
              detail: `The video${l.languages.length ? `, its ${l.languages.length} language cop${l.languages.length === 1 ? "y" : "ies"}` : ""} and its own image are deleted.` })}>
            Delete
          </button>
        </div>
      ),
    },
  ];

  function chapterCard(chapter: AppChapter) {
    const actions = chapter.is_demo ? (
      <button type="button" className="btn btn-sm btn-primary" onClick={() => setUpload({ kind: "demo", chapter })}>+ Demo video</button>
    ) : (
      <div className="row" style={{ gap: 4 }}>
        {chapter.thumbnail_key && (
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => setPreview({ key: chapter.thumbnail_key!, title: `${chapterName(chapter)}: image` })}
            aria-label={`View the image of chapter ${chapter.number}`}>View image</button>
        )}
        <button type="button" className="btn btn-sm" onClick={() => setUpload({ kind: "chapter_thumbnail", chapter })}
          aria-label={`${chapter.thumbnail_key ? "Change" : "Add"} the image of chapter ${chapter.number}`}>{chapter.thumbnail_key ? "Change image" : "Add image"}</button>
        <button type="button" className="btn btn-sm btn-primary" onClick={() => setUpload({ kind: "lecture", chapter })}
          aria-label={`Add a lecture to chapter ${chapter.number} (${chapter.folder})`}>+ Lecture</button>
      </div>
    );
    return (
      <Card key={chapter.folder} headingLevel={3} title={chapterName(chapter)} description={chapter.is_demo ? "Free for everyone, shown before chapter 1." : chapter.folder} actions={actions}>
        {chapter.shared_number.length > 0 && (
          <Notice tone="warning">
            Chapter {chapter.number} also has the folder {chapter.shared_number.join(", ")}. The app puts both folders under one chapter, so lectures can
            only be added to the folder that already has some.
          </Notice>
        )}
        <DataTable
          caption={`${chapterName(chapter)} lectures`}
          columns={columns(chapter)}
          rows={chapter.lectures}
          rowKey={(l) => l.key}
          empty={
            <EmptyState title={chapter.is_demo ? "No demo videos" : "Not in the app yet"}>
              {chapter.is_demo ? "Add a free demo video for students who haven't bought the course." : "The app shows a chapter once it has a lecture."}
            </EmptyState>
          }
        />
      </Card>
    );
  }

  return (
    <>
      <Card
        title={`Class ${course.class_level} · ${course.subject}`}
        description={`${course.lecture_count} lecture${course.lecture_count === 1 ? "" : "s"} in the app, in ${chapters.length} chapter folder${chapters.length === 1 ? "" : "s"}. The app calls this subject "${course.app_subject}".`}
        actions={
          <div className="row" style={{ gap: 4 }}>
            {course.playlist_thumbnail_key && (
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => setPreview({ key: course.playlist_thumbnail_key!, title: "Course image" })}>View course image</button>
            )}
            <button type="button" className="btn btn-sm" onClick={() => setUpload({ kind: "playlist_thumbnail" })}
              title="Shown on home-screen cards set to use the course image, and on the app's website">
              {course.playlist_thumbnail_key ? "Change course image" : "Add course image (optional)"}
            </button>
            {course.playlist_thumbnail_key && (
              <button type="button" className="btn btn-sm btn-danger"
                onClick={() => setRemoval({ key: course.playlist_thumbnail_key!, whole: false, courseImage: true, what: "Course image",
                  detail: "Home-screen cards set to use the course image show their own banner instead. A card with no banner of its own shows no picture until it gets one." })}>
                Delete course image
              </button>
            )}
            <button type="button" className="btn btn-sm btn-primary" onClick={() => setUpload({ kind: "lecture", chapter: null })}>+ New chapter</button>
          </div>
        }
      >
        <p className="small muted" style={{ margin: 0 }}>
          Lecture titles, numbers and chapters below are worked out with the app's own rules, so they read exactly as students see them. In the
          phone app a subject shows its lectures and demo videos with their images; a chapter with no lecture doesn't show. The course image is
          the banner of home-screen cards set to "Use the course image" (Courses & prices), and shows on the app's website.
        </p>
      </Card>
      <div className="row" style={{ gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}>
        <button type="button" className="btn" onClick={() => setChosen(all[index - 1]!.folder)} disabled={index <= 0} aria-label="Previous chapter">
          ‹ Previous
        </button>
        <div className="field" style={{ flex: "1 1 320px", margin: 0 }}>
          <label htmlFor={pickerId}>Chapter</label>
          <select id={pickerId} value={current.folder} onChange={(e) => setChosen(e.target.value)}>
            {all.map((c) => (
              <option key={c.folder} value={c.folder}>
                {chapterName(c)} ({c.lectures.length} lecture{c.lectures.length === 1 ? "" : "s"}){c.shared_number.length ? " ⚠" : ""}
              </option>
            ))}
          </select>
        </div>
        <span className="small muted" style={{ paddingBottom: 8 }}>{index + 1} of {all.length}</span>
        <button type="button" className="btn" onClick={() => setChosen(all[index + 1]!.folder)} disabled={index >= all.length - 1} aria-label="Next chapter">
          Next ›
        </button>
      </div>
      {chapterCard(current)}
      {upload && (
        <UploadDialog key={JSON.stringify(upload, (k, v) => (k === "lectures" ? undefined : v))} upload={upload} course={course} status={status}
          onUploaded={uploaded} onClose={() => setUpload(null)} />
      )}
      {preview && <PreviewDialog preview={preview} course={course} onClose={() => setPreview(null)} />}
      <ConfirmDialog open={removal !== null} title="Delete from the app?" confirmLabel="Delete for good" destructive busy={removing} confirmWord="delete"
        onConfirm={() => void confirmRemoval()} onCancel={() => setRemoval(null)}>
        {removal && (
          <div className="stack" style={{ gap: 8 }}>
            <strong>{removal.what}</strong>
            <span>{removal.detail}</span>
            <span>It disappears from the app for every student within about 30 seconds. The app's storage keeps no copies, so this can't be undone.</span>
          </div>
        )}
      </ConfirmDialog>
    </>
  );
}

function PreviewDialog({ preview, course, onClose }: { preview: Preview; course: AppCourse; onClose: () => void }) {
  const url = useQuery({
    queryKey: [...avKeys.all, "preview", preview.key],
    queryFn: () => previewUrl(course.class_level, course.subject, preview.key),
    staleTime: 5 * 60_000,
    gcTime: 0,
    retry: false,
  });
  return (
    <Dialog open onClose={onClose} title={preview.title} description={preview.key.split("/").pop()} wide>
      {url.isPending ? (
        <LoadingBlock rows={2} label="Loading" />
      ) : url.error ? (
        <ErrorState error={url.error} onRetry={() => void url.refetch()} />
      ) : isImage(preview.key) ? (
        <img src={url.data} alt={preview.title} style={{ maxWidth: "100%", borderRadius: 8 }} />
      ) : (
        <video src={url.data} controls autoPlay style={{ width: "100%", borderRadius: 8, background: "#000" }}>
          <track kind="captions" />
        </video>
      )}
    </Dialog>
  );
}

type Phase = "idle" | "checking" | "uploading" | "saving" | "image";

const IMAGE_FILE = /\.(png|jpe?g|webp)$/i;

function UploadDialog({ upload, course, status, onUploaded, onClose }: {
  upload: Upload;
  course: AppCourse;
  status: AppVideosStatus;
  onUploaded: (key: string) => void;
  onClose: () => void;
}) {
  const toast = useToast();
  const client = useQueryClient();
  const ids = { file: useId(), image: useId(), number: useId(), topic: useId(), chapterNo: useId(), chapterName: useId(), language: useId() };
  const abort = useRef<AbortController | null>(null);
  const chapter = "chapter" in upload ? upload.chapter : null;
  const lecture = "lecture" in upload ? upload.lecture : null;
  const newChapter = upload.kind === "lecture" && upload.chapter === null;
  const isVideo = upload.kind === "lecture" || upload.kind === "demo" || upload.kind === "replace" || upload.kind === "language";
  const numbered = upload.kind === "lecture" || upload.kind === "demo";
  const named = numbered || upload.kind === "replace";
  const withImage = named; // a lecture video can bring its image in the same step
  const nextChapter = Math.max(0, ...course.chapters.map((c) => c.number)) + 1;
  const nextLecture = Math.max(0, ...(chapter?.lectures.map((l) => l.number) ?? [])) + 1;
  const freeLanguages = status.languages.filter((l) => !lecture?.languages.some((x) => x.language === l));

  const [file, setFile] = useState<File | null>(null);
  const [image, setImage] = useState<File | null>(null);
  const [lectureNo, setLectureNo] = useState(String(newChapter ? 1 : nextLecture));
  const [topic, setTopic] = useState("");
  const [chapterNo, setChapterNo] = useState(String(nextChapter));
  const [chapterTitle, setChapterTitle] = useState("");
  const [language, setLanguage] = useState(freeLanguages[0] ?? status.languages[0] ?? "");
  const [phase, setPhase] = useState<Phase>("idle");
  const [pct, setPct] = useState(0);
  const [problem, setProblem] = useState<string | null>(null);
  const busy = phase !== "idle";
  const replacingLanguage = upload.kind === "language" && !!lecture?.languages.some((x) => x.language === language);
  const limitMb = isVideo ? status.max_video_mb : status.max_image_mb;

  const title = {
    lecture: newChapter ? "New chapter" : `Add a lecture to ${chapter ? chapterName(chapter) : ""}`,
    demo: "Add a free demo video",
    replace: `Replace the video of ${lecture?.title ?? ""}`,
    language: `Add a language to ${lecture?.title ?? ""}`,
    lecture_thumbnail: `Image for ${lecture?.title ?? ""}`,
    chapter_thumbnail: `Image for ${chapter ? chapterName(chapter) : ""}`,
    playlist_thumbnail: `Course image for Class ${course.class_level} ${course.subject}`,
  }[upload.kind];

  const note = {
    lecture: newChapter
      ? "The chapter appears in the app with its first lecture."
      : "Students who bought the course can watch it; others see it locked.",
    demo: "Free for everyone, listed before chapter 1.",
    replace: "The new video takes this lecture's place; its language copies and image stay. The old video is deleted once the new one is stored.",
    language: replacingLanguage ? `This replaces the ${LANGUAGE_LABEL(language)} copy it already has.` : "Students can switch to this language while watching.",
    lecture_thumbnail: lecture?.thumbnail_key ? "Replaces the current image." : "Shown on the lecture's card.",
    chapter_thumbnail: `${chapter?.thumbnail_key ? "Replaces the current image. " : ""}The phone app shows it on this chapter's lectures that have no image of their own.`,
    playlist_thumbnail: `${course.playlist_thumbnail_key ? "Replaces the current course image. " : ""}Shown on home-screen cards set to "Use the course image" (Courses & prices), and on the app's website. Framed to the card's 1200 × 520 so it isn't cut.`,
  }[upload.kind];

  function close() {
    abort.current?.abort();
    onClose();
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setProblem(null);
    if (!file) return setProblem("Choose a file.");
    if (file.size > limitMb * 1024 * 1024) return setProblem(`The file is larger than ${limitMb} MB.`);
    if (image && !IMAGE_FILE.test(image.name)) return setProblem("The lecture image must be a PNG, JPG or WebP file.");
    if (image && image.size > status.max_image_mb * 1024 * 1024) return setProblem(`The lecture image is larger than ${status.max_image_mb} MB.`);
    const body: UploadInput = {
      class_level: course.class_level,
      subject: course.subject,
      kind: upload.kind === "replace" ? (chapter?.is_demo ? "demo" : "lecture") : upload.kind,
      filename: file.name,
      size_bytes: file.size,
    };
    if (chapter && !(upload.kind === "demo")) body.chapter = chapter.folder;
    if (newChapter) {
      body.new_chapter_number = Number(chapterNo);
      body.new_chapter_name = chapterTitle;
    }
    if (numbered) body.lecture_number = Number(lectureNo) || null;
    if (lecture) body.lecture_number = lecture.number;
    if (named) body.topic = topic;
    if (upload.kind === "replace") body.replace = true;
    if (upload.kind === "language") {
      body.language = language;
      body.replace = replacingLanguage;
    }
    abort.current = new AbortController();
    try {
      setPhase("checking");
      const ticket = await requestTicket(body);
      setPhase("uploading");
      setPct(0);
      await postToS3(ticket, file, setPct, abort.current.signal);
      setPhase("saving");
      await completeUpload({ class_level: course.class_level, subject: course.subject, key: ticket.key, replaces: ticket.replaces, label: ticket.label });
      let imageNote = "";
      if (image) {
        // The image goes where the app looks for this lecture's image: its chapter folder and
        // lecture number, both read from the name the server gave the video.
        const demo = upload.kind === "demo" || !!chapter?.is_demo;
        const folder = demo ? "demo_videos" : (ticket.key.match(/\/chapters\/([^/]+)\//)?.[1] ?? chapter?.folder);
        const number = Number(ticket.key.match(/\/Lec-(\d+)/)?.[1] ?? lecture?.number);
        try {
          setPhase("image");
          const imageTicket = await requestTicket({
            class_level: course.class_level, subject: course.subject, kind: "lecture_thumbnail",
            chapter: folder, lecture_number: number, filename: image.name, size_bytes: image.size,
          });
          await postToS3(imageTicket, image, () => undefined, abort.current.signal);
          await completeUpload({ class_level: course.class_level, subject: course.subject, key: imageTicket.key, replaces: imageTicket.replaces, label: imageTicket.label });
          imageNote = " with its image";
        } catch (err) {
          if (err instanceof DOMException && err.name === "AbortError") return;
          toast.error(err, "The video is uploaded, but its image failed. Add it with Change in the Image column.");
        }
      }
      toast.success(`${ticket.label} is uploaded${imageNote}. It shows in the app within about 30 seconds.`);
      onUploaded(ticket.key);
      await client.invalidateQueries({ queryKey: avKeys.all });
      onClose();
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      setProblem(err instanceof ApiError ? (Object.values(err.fieldErrors())[0] ?? err.message) : err instanceof Error ? err.message : "The upload failed.");
      setPhase("idle");
    }
  }

  return (
    <Dialog
      open
      onClose={close}
      title={title}
      description={note}
      footer={
        <>
          <button type="button" className="btn" onClick={close} data-initial-focus>{phase === "uploading" ? "Cancel upload" : "Cancel"}</button>
          <button type="submit" form="app-video-upload" className="btn btn-primary" disabled={busy}>
            {phase === "checking" ? "Checking…" : phase === "uploading" ? `Uploading ${pct}%` : phase === "saving" ? "Finishing…" : phase === "image" ? "Uploading image…" : "Upload"}
          </button>
        </>
      }
    >
      <form id="app-video-upload" className="form-grid" onSubmit={(e) => void submit(e)} noValidate aria-busy={busy}>
        {newChapter && (
          <>
            <div className="field">
              <label htmlFor={ids.chapterNo}>Chapter number</label>
              <input id={ids.chapterNo} type="number" min={1} max={99} value={chapterNo} onChange={(e) => setChapterNo(e.target.value)} disabled={busy} required />
            </div>
            <div className="field">
              <label htmlFor={ids.chapterName}>Chapter name</label>
              <input id={ids.chapterName} type="text" value={chapterTitle} onChange={(e) => setChapterTitle(e.target.value)} disabled={busy} required maxLength={90}
                placeholder="e.g. Accounting Ratios" />
              <span className="hint">The app shows it as the chapter's title.</span>
            </div>
          </>
        )}
        {numbered && (
          <div className="field">
            <label htmlFor={ids.number}>Lecture number</label>
            <input id={ids.number} type="number" min={1} max={999} value={lectureNo} onChange={(e) => setLectureNo(e.target.value)} disabled={busy} />
            <span className="hint">The app orders lectures by this number.</span>
          </div>
        )}
        {named && (
          <div className="field">
            <label htmlFor={ids.topic}>Lecture name (optional)</label>
            <input id={ids.topic} type="text" value={topic} onChange={(e) => setTopic(e.target.value)} disabled={busy} maxLength={80} placeholder="e.g. Indirect Method" />
            <span className="hint">Shown as "Lecture N · name". Leave it empty for just "Lecture N".</span>
          </div>
        )}
        {upload.kind === "language" && (
          <div className="field">
            <label htmlFor={ids.language}>Language</label>
            <select id={ids.language} value={language} onChange={(e) => setLanguage(e.target.value)} disabled={busy}>
              {status.languages.map((l) => (
                <option key={l} value={l}>{LANGUAGE_LABEL(l)}{lecture?.languages.some((x) => x.language === l) ? " (replace)" : ""}</option>
              ))}
            </select>
          </div>
        )}
        {upload.kind === "playlist_thumbnail" ? (
          // The course image can be a home card's banner: frame it to the card first.
          <div className="field" style={{ gridColumn: "1 / -1" }}>
            <BannerEditor batchId={`${course.subject.toLowerCase().replace(/[^a-z0-9]+/g, "_")}_course_image`} dark={false}
              label="Course image: choose an image (any size)" actionLabel="Use this framing" disabled={busy}
              onFile={(f) => setFile(f)} />
            <span className="hint">{file ? `Ready: ${file.name} · 1200 × 520 · ${fileSize(file.size)}. Press Upload.` : "Choose an image, frame it, then press “Use this framing”."}</span>
          </div>
        ) : (
          <div className="field">
            <label htmlFor={ids.file}>{isVideo ? "Video (.mp4)" : "Image (PNG, JPG or WebP)"}</label>
            <input id={ids.file} type="file" accept={isVideo ? VIDEO_ACCEPT : IMAGE_ACCEPT} disabled={busy}
              onChange={(e) => setFile(e.target.files?.[0] ?? null)} aria-describedby={`${ids.file}-hint`} />
            <span className="hint" id={`${ids.file}-hint`}>
              {file ? `${file.name} · ${fileSize(file.size)}` : `At most ${limitMb >= 1024 ? `${(limitMb / 1024).toFixed(0)} GB` : `${limitMb} MB`}.`}
            </span>
          </div>
        )}
        {withImage && (
          <div className="field">
            <label htmlFor={ids.image}>Lecture image (optional)</label>
            <input id={ids.image} type="file" accept={IMAGE_ACCEPT} disabled={busy}
              onChange={(e) => setImage(e.target.files?.[0] ?? null)} aria-describedby={`${ids.image}-hint`} />
            <span className="hint" id={`${ids.image}-hint`}>
              {image
                ? `${image.name} · ${fileSize(image.size)}`
                : lecture?.thumbnail_key
                  ? "Leave empty to keep the lecture's current image. PNG, JPG or WebP."
                  : "Shown on the lecture's card in the app. PNG, JPG or WebP; 16:9 looks best."}
            </span>
          </div>
        )}
        {phase === "uploading" && <progress max={100} value={pct} aria-label="Upload progress">{pct}%</progress>}
        {problem && <span className="error" role="alert">{problem}</span>}
      </form>
    </Dialog>
  );
}


/** A new class (videos/class_N/) or subject (videos/class_N/<Subject>/ and its usual folders) in
 * the app's S3, laid out like the app's own. */
function NewFolderDialog({ kind, classLevel, classes, onCreated, onClose }: {
  kind: "class" | "subject";
  classLevel: number | null;
  classes: number[];
  onCreated: (classLevel: number, subject: string | null) => void;
  onClose: () => void;
}) {
  const ids = { level: useId(), name: useId() };
  const toast = useToast();
  const client = useQueryClient();
  const [level, setLevel] = useState(String(kind === "class" ? ([...Array(12)].map((_, i) => i + 1).find((c) => !classes.includes(c)) ?? "") : (classLevel ?? "")));
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const n = Number(level);
  const appName = name.trim().toLowerCase();
  const opensInApp = n === 11 || n === 12;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setProblem(null);
    if (!(n >= 1 && n <= 20)) return setProblem("Use a class from 1 to 20.");
    if (kind === "subject" && !/^[A-Za-z][A-Za-z0-9]{1,29}$/.test(name.trim()))
      return setProblem("Use 2-30 letters and numbers, starting with a letter (e.g. Physics, BusinessStudies).");
    setBusy(true);
    try {
      if (kind === "class") await createClass(n);
      else await createSubject(n, name.trim());
      toast.success(kind === "class" ? `Class ${n} is created in S3.` : `${name.trim()} is created in Class ${n} (S3).`);
      await client.invalidateQueries({ queryKey: avKeys.all });
      onCreated(n, kind === "subject" ? name.trim() : null);
    } catch (err) {
      setProblem(err instanceof ApiError ? err.message : "It couldn't be created.");
      setBusy(false);
    }
  }

  return (
    <Dialog open onClose={onClose} title={kind === "class" ? "New class" : "New subject"}
      description={kind === "class" ? "Creates the class folder in the app's S3." : "Creates the subject folder in the app's S3, with the folders every subject has."}
      footer={<><button type="button" className="btn" onClick={onClose} data-initial-focus>Cancel</button>
        <button type="submit" form="new-folder" className="btn btn-primary" disabled={busy}>{busy ? "Creating…" : "Create"}</button></>}>
      <form id="new-folder" className="form-grid" onSubmit={(e) => void submit(e)} noValidate>
        <div className="field">
          <label htmlFor={ids.level}>Class</label>
          {kind === "class" ? (
            <input id={ids.level} type="number" min={1} max={20} value={level} onChange={(e) => setLevel(e.target.value)} disabled={busy} />
          ) : (
            <select id={ids.level} value={level} onChange={(e) => setLevel(e.target.value)} disabled={busy}>
              {classes.map((c) => <option key={c} value={c}>Class {c}</option>)}
            </select>
          )}
          {!opensInApp && n >= 1 && <span className="hint">Students can pick this class once it's in the list and open under Classes, streams & goals; until then it shows "coming soon".</span>}
        </div>
        {kind === "subject" && (
          <div className="field">
            <label htmlFor={ids.name}>Subject folder name</label>
            <input id={ids.name} type="text" value={name} onChange={(e) => setName(e.target.value)} maxLength={30} placeholder="e.g. BusinessStudies" disabled={busy} />
            <span className="hint">
              {appName ? <>S3: <code>videos/class_{n}/{name.trim()}/</code> with chapters/, demo_videos/, lectures_thumbnails/, chapters_thumbnails/, regional_language/. The app calls it "{appName}".</> : "Letters and numbers only, no spaces."}
            </span>
          </div>
        )}
        {kind === "class" && n >= 1 && n <= 20 && <span className="hint">S3: <code>videos/class_{n}/</code>. Add its subjects next.</span>}
        {problem && <span className="error" role="alert">{problem}</span>}
      </form>
    </Dialog>
  );
}
