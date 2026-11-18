// Course Management > App videos, against the dashboard's own API (mocked with MSW). The
// dashboard server reads the app's S3 folder and picks every file name; the browser posts the
// file straight to S3 with a presigned POST (also mocked here).

import { screen, waitFor, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it } from "vitest";
import { axeViolations } from "../test/a11y";
import { renderApp } from "../test/render";
import { requests, server } from "../test/server";
import { adminSecret } from "./vouchers/adminApi";

// App videos calls the AdhyaapakAI backend's admin API (x-admin-secret), like vouchers.
const A = "*/api/admin/videos";
beforeEach(() => adminSecret.set("test-admin-secret"));
const S3 = "https://bucket.s3.ap-south-1.amazonaws.com/";
const BASE = "videos/class_12/Account/";
const CH1 = "chapter-01-cash-flow-statement";
const LECTURE = {
  number: 1, title: "Lecture 1", key: `${BASE}chapters/${CH1}/12_ACC_P1_C1_L1_HIN.mp4`, filename: "12_ACC_P1_C1_L1_HIN.mp4",
  size: 118_345_467, last_modified: "2026-11-01T00:00:00Z", numbered: true,
  languages: [{ language: "bengali", key: `${BASE}regional_language/${CH1}/12_ACC_P1_C1_L1_BEN.mp4` }],
  thumbnail_key: `${BASE}lectures_thumbnails/${CH1}/lecture-01.png`,
};
const COURSE = {
  class_level: 12, subject: "Account", app_subject: "accounts", playlist_thumbnail_key: `${BASE}account_playlist_thumbnail.png`, lecture_count: 2,
  chapters: [
    { folder: "demo_videos", number: 0, title: "Free Demo Videos", is_demo: true, thumbnail_key: null, shared_number: [],
      lectures: [{ ...LECTURE, number: 1, title: "Dissolution", key: `${BASE}demo_videos/Lec-1 Dissolution.mp4`, filename: "Lec-1 Dissolution.mp4", languages: [] }] },
    { folder: CH1, number: 1, title: "Cash Flow Statement", is_demo: false, thumbnail_key: `${BASE}chapters_thumbnails/chapter- 01.png`, shared_number: [], lectures: [LECTURE] },
    { folder: "chapter-03-dissolution-of-partnership-firm", number: 3, title: "Dissolution of Partnership Firm", is_demo: false, thumbnail_key: null,
      shared_number: ["chapter-03-financial-statement-analysis-basic"], lectures: [] },
  ],
};
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, GET", "Access-Control-Allow-Headers": "*" };
const called = (method: string, path: string) => requests.filter((r) => r.method === method && r.url.pathname === `/api/admin/videos${path}`);

function useApi(configured = true) {
  server.use(
    http.get(`${A}/status`, () => HttpResponse.json({ configured, max_video_mb: 4096, max_image_mb: 100, languages: ["english", "hindi", "bengali", "tamil"] })),
    http.get(`${A}/classes`, () => HttpResponse.json({ classes: [11, 12] })),
    http.get(`${A}/subjects`, () => HttpResponse.json({ class_level: 12, subjects: ["Account", "Eco"] })),
    http.get(`${A}/course`, () => HttpResponse.json(COURSE)),
  );
}

const mp4 = (name = "intro.mp4") => new File(["video-bytes"], name, { type: "video/mp4" });

describe("app videos", () => {
  it("lists the app's chapters and lectures as the app shows them", async () => {
    useApi();
    const { container } = renderApp("/courses");
    expect(await screen.findByRole("heading", { name: "Class 12 · Account" }, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.getByText(/The app calls this subject "accounts"/)).toBeInTheDocument();
    // One chapter at a time: the first chapter with lectures is shown first.
    const ch1 = screen.getByRole("table", { name: "Chapter 1 · Cash Flow Statement lectures" });
    expect(within(ch1).getByText("Lecture 1")).toBeInTheDocument();
    // Green: the languages it has a video in; below, the ones not added yet.
    expect(within(ch1).getByText("Bengali").closest(".badge")).toHaveClass("tone-normal");
    expect(within(ch1).getByText("Hinglish").closest(".badge")).toHaveClass("tone-normal");
    expect(within(ch1).getByText("Not added yet: English, Hindi, Tamil")).toBeInTheDocument();
    expect(within(ch1).getByText("113 MB")).toBeInTheDocument();
    expect(screen.queryByRole("table", { name: "Free Demo Videos lectures" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Chapter")).toHaveValue(CH1);
    expect(screen.getByText("2 of 3")).toBeInTheDocument();
    expect(called("GET", "/course")[0]!.url.searchParams.get("class_level")).toBe("12");
    expect(await axeViolations(container)).toEqual([]);
  });

  it("moves between chapters with the arrows and the chapter list", async () => {
    useApi();
    const { user } = renderApp("/courses");
    await screen.findByRole("table", { name: "Chapter 1 · Cash Flow Statement lectures" });
    expect(screen.getByRole("option", { name: "Free Demo Videos (1 lecture)" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Chapter 3 · Dissolution of Partnership Firm (0 lectures) ⚠" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Previous chapter" }));
    expect(screen.getByRole("table", { name: "Free Demo Videos lectures" })).toHaveTextContent("Dissolution");
    expect(screen.getByRole("button", { name: "Previous chapter" })).toBeDisabled();

    await user.selectOptions(screen.getByLabelText("Chapter"), "chapter-03-dissolution-of-partnership-firm");
    // Two folders with one chapter number are flagged; an empty chapter says it's not in the app.
    expect(screen.getByText(/also has the folder chapter-03-financial-statement-analysis-basic/)).toBeInTheDocument();
    expect(screen.getByText("Not in the app yet")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next chapter" })).toBeDisabled();
    expect(screen.queryByRole("table", { name: "Chapter 1 · Cash Flow Statement lectures" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Previous chapter" }));
    expect(screen.getByRole("table", { name: "Chapter 1 · Cash Flow Statement lectures" })).toBeInTheDocument();
  });

  it("explains when storage isn't configured", async () => {
    useApi(false);
    renderApp("/courses");
    expect(await screen.findByText("App videos are not configured.")).toBeInTheDocument();
    expect(called("GET", "/classes")).toHaveLength(0);
  });

  it("is owner only", async () => {
    useApi();
    renderApp("/courses", "viewer");
    expect(await screen.findByText(/Only the owner can manage the app's videos/)).toBeInTheDocument();
    expect(called("GET", "/status")).toHaveLength(0);
  });

  it("uploads a lecture: server picks the name, the browser posts to S3, then it's confirmed", async () => {
    useApi();
    const ticket = {
      key: `${BASE}chapters/${CH1}/Lec-02 Indirect Method.mp4`, label: "Chapter 1 · Lecture 2 · Indirect Method", replaces: [],
      content_type: "video/mp4", max_bytes: 4096 * 1024 * 1024, upload_url: S3, fields: { key: "k", "Content-Type": "video/mp4", policy: "p" },
    };
    let posted = false;
    server.use(
      http.post(`${A}/uploads`, () => HttpResponse.json(ticket)),
      // The bucket's CORS rules: the browser preflights the cross-origin POST.
      http.options(S3, () => new HttpResponse(null, { status: 200, headers: CORS })),
      http.post(S3, () => { posted = true; return new HttpResponse(null, { status: 204, headers: CORS }); }),
      http.post(`${A}/uploads/complete`, () => HttpResponse.json({ key: ticket.key, size: 11, removed: [] })),
    );
    const { user } = renderApp("/courses");
    await user.click(await screen.findByRole("button", { name: `Add a lecture to chapter 1 (${CH1})` }));
    const dialog = await screen.findByRole("dialog", { name: /Add a lecture to Chapter 1/ });
    expect(within(dialog).getByLabelText("Lecture number")).toHaveValue(2);
    await user.type(within(dialog).getByLabelText("Lecture name (optional)"), "Indirect Method");
    await user.upload(within(dialog).getByLabelText("Video (.mp4)"), mp4());
    await user.click(within(dialog).getByRole("button", { name: "Upload" }));
    expect(await screen.findByText(/is uploaded\. It shows in the app within about 30 seconds/)).toBeInTheDocument();
    expect(posted).toBe(true);
    expect(called("POST", "/uploads")[0]!.body).toMatchObject({
      class_level: 12, subject: "Account", kind: "lecture", chapter: CH1, lecture_number: 2, topic: "Indirect Method", filename: "intro.mp4", size_bytes: 11,
    });
    expect(called("POST", "/uploads/complete")[0]!.body).toEqual({
      class_level: 12, subject: "Account", key: ticket.key, replaces: [], label: ticket.label,
    });
  });

  it("uploads a new chapter's first lecture with its image in one go", async () => {
    useApi();
    const video = {
      key: `${BASE}chapters/chapter-04-ratios/Lec-01 Liquidity.mp4`, label: "Chapter 4 · Lecture 1 · Liquidity", replaces: [],
      content_type: "video/mp4", max_bytes: 1, upload_url: S3, fields: { key: "v", "Content-Type": "video/mp4" },
    };
    const image = {
      key: `${BASE}lectures_thumbnails/chapter-04-ratios/lecture-01.png`, label: "Lecture 1 · Liquidity · image", replaces: [],
      content_type: "image/png", max_bytes: 1, upload_url: S3, fields: { key: "i", "Content-Type": "image/png" },
    };
    let s3Posts = 0;
    server.use(
      http.post(`${A}/uploads`, async ({ request }) => HttpResponse.json(((await request.json()) as { kind: string }).kind === "lecture_thumbnail" ? image : video)),
      http.options(S3, () => new HttpResponse(null, { status: 200, headers: CORS })),
      http.post(S3, () => { s3Posts += 1; return new HttpResponse(null, { status: 204, headers: CORS }); }),
      http.post(`${A}/uploads/complete`, () => HttpResponse.json({ key: "k", size: 11, removed: [] })),
    );
    const { user } = renderApp("/courses");
    await user.click(await screen.findByRole("button", { name: "+ New chapter" }, { timeout: 5000 }));
    const dialog = await screen.findByRole("dialog", { name: "New chapter" });
    await user.type(within(dialog).getByLabelText("Chapter name"), "Ratios");
    await user.type(within(dialog).getByLabelText("Lecture name (optional)"), "Liquidity");
    await user.upload(within(dialog).getByLabelText("Video (.mp4)"), mp4());
    await user.upload(within(dialog).getByLabelText("Lecture image (optional)"), new File(["png"], "cover.png", { type: "image/png" }));
    await user.click(within(dialog).getByRole("button", { name: "Upload" }));
    expect(await screen.findByText(/is uploaded with its image\./)).toBeInTheDocument();
    expect(s3Posts).toBe(2);
    const tickets = called("POST", "/uploads").map((r) => r.body);
    expect(tickets[1]).toEqual({
      class_level: 12, subject: "Account", kind: "lecture_thumbnail", chapter: "chapter-04-ratios", lecture_number: 1, filename: "cover.png", size_bytes: 3,
    });
    expect(called("POST", "/uploads/complete").map((r) => (r.body as { key: string }).key)).toEqual([video.key, image.key]);
  });

  it("refuses a lecture image that isn't a picture before uploading anything", async () => {
    useApi();
    const { user } = renderApp("/courses");
    await screen.findByRole("table", { name: "Chapter 1 · Cash Flow Statement lectures" }, { timeout: 5000 });
    await user.click(screen.getByRole("button", { name: "Previous chapter" })); // the free demo videos
    await user.click(screen.getByRole("button", { name: "+ Demo video" }));
    const dialog = await screen.findByRole("dialog", { name: "Add a free demo video" });
    await user.upload(within(dialog).getByLabelText("Video (.mp4)"), mp4());
    // The picker only offers images; a renamed file still gets through it, so the dialog checks too.
    await user.upload(within(dialog).getByLabelText("Lecture image (optional)"), new File(["x"], "notes.pdf", { type: "image/png" }));
    await user.click(within(dialog).getByRole("button", { name: "Upload" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("must be a PNG, JPG or WebP");
    expect(called("POST", "/uploads")).toHaveLength(0);
  });

  it("frames the course image to the home card before uploading it", async () => {
    useApi();
    const { user } = renderApp("/courses");
    await user.click(await screen.findByRole("button", { name: "Change course image" }, { timeout: 5000 }));
    const dialog = await screen.findByRole("dialog", { name: /Course image for Class 12 Account/ });
    expect(dialog).toHaveTextContent(/home-screen cards set to "Use the course image"/);
    expect(within(dialog).getByLabelText("Course image: choose an image (any size)")).toBeInTheDocument();
    expect(within(dialog).queryByLabelText("Image (PNG, JPG or WebP)")).not.toBeInTheDocument();
  });

  it("creates a new subject folder in S3 and opens it", async () => {
    useApi();
    let created = false;
    server.use(
      http.post(`${A}/subjects`, () => { created = true; return HttpResponse.json(
        { class_level: 12, folder: "videos/class_12/BusinessStudies/", subject: "BusinessStudies", app_subject: "businessstudies" }, { status: 201 }); }),
      http.get(`${A}/subjects`, () => HttpResponse.json({ class_level: 12, subjects: created ? ["Account", "BusinessStudies", "Eco"] : ["Account", "Eco"] })),
    );
    const { user } = renderApp("/courses");
    await user.click(await screen.findByRole("button", { name: "+ New subject" }, { timeout: 5000 }));
    const dialog = await screen.findByRole("dialog", { name: "New subject" });
    expect(within(dialog).getByLabelText("Class")).toHaveValue("12");
    await user.type(within(dialog).getByLabelText("Subject folder name"), "BusinessStudies");
    expect(dialog).toHaveTextContent("videos/class_12/BusinessStudies/");
    expect(dialog).toHaveTextContent('The app calls it "businessstudies"');
    await user.click(within(dialog).getByRole("button", { name: "Create" }));
    expect(await screen.findByText("BusinessStudies is created in Class 12 (S3).")).toBeInTheDocument();
    expect(called("POST", "/subjects")[0]!.body).toEqual({ class_level: 12, name: "BusinessStudies" });
    await waitFor(() => expect(screen.getByLabelText("Subject")).toHaveValue("BusinessStudies"));
  });

  it("creates a new class folder in S3", async () => {
    useApi();
    server.use(http.post(`${A}/classes`, () => HttpResponse.json({ class_level: 10, folder: "videos/class_10/" }, { status: 201 })));
    const { user } = renderApp("/courses");
    await user.click(await screen.findByRole("button", { name: "+ New class" }, { timeout: 5000 }));
    const dialog = await screen.findByRole("dialog", { name: "New class" });
    const level = within(dialog).getByLabelText("Class");
    await user.clear(level);
    await user.type(level, "10");
    expect(dialog).toHaveTextContent("videos/class_10/");
    expect(dialog).toHaveTextContent("open under Classes, streams & goals");
    await user.click(within(dialog).getByRole("button", { name: "Create" }));
    expect(await screen.findByText("Class 10 is created in S3.")).toBeInTheDocument();
    expect(called("POST", "/classes")[0]!.body).toEqual({ class_level: 10 });
  });

  it("shows the server's reason when an upload is refused, and stores nothing", async () => {
    useApi();
    server.use(
      http.post(`${A}/uploads`, () =>
        HttpResponse.json({ detail: 'The lecture name can\'t end with a language ("Hindi").', code: "topic_language" }, { status: 422 })),
    );
    const { user } = renderApp("/courses");
    await user.click(await screen.findByRole("button", { name: "+ New chapter" }, { timeout: 5000 }));
    const dialog = await screen.findByRole("dialog", { name: "New chapter" });
    expect(within(dialog).getByLabelText("Chapter number")).toHaveValue(4);
    await user.type(within(dialog).getByLabelText("Chapter name"), "Ratios");
    await user.type(within(dialog).getByLabelText("Lecture name (optional)"), "Learn Hindi");
    await user.upload(within(dialog).getByLabelText("Video (.mp4)"), mp4());
    await user.click(within(dialog).getByRole("button", { name: "Upload" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(/can't end with a language/);
    expect(called("POST", "/uploads")[0]!.body).toMatchObject({ new_chapter_number: 4, new_chapter_name: "Ratios", lecture_number: 1 });
    expect(called("POST", "/uploads/complete")).toHaveLength(0);
  });

  it("adds a language copy to a lecture", async () => {
    useApi();
    server.use(http.post(`${A}/uploads`, () => HttpResponse.json({ detail: "stop here", code: "x" }, { status: 409 })));
    const { user } = renderApp("/courses");
    await user.click(await screen.findByRole("button", { name: "Add a language to Lecture 1" }, { timeout: 5000 }));
    const dialog = await screen.findByRole("dialog", { name: "Add a language to Lecture 1" });
    expect(within(dialog).getByRole("option", { name: "Bengali (replace)" })).toBeInTheDocument();
    await user.selectOptions(within(dialog).getByLabelText("Language"), "tamil");
    await user.upload(within(dialog).getByLabelText("Video (.mp4)"), mp4());
    await user.click(within(dialog).getByRole("button", { name: "Upload" }));
    await within(dialog).findByRole("alert");
    expect(called("POST", "/uploads")[0]!.body).toMatchObject({ kind: "language", chapter: CH1, lecture_number: 1, language: "tamil", replace: false });
  });

  it("deletes a whole lecture only after confirming", async () => {
    useApi();
    server.use(http.post(`${A}/delete`, () => HttpResponse.json({ deleted: [LECTURE.key, LECTURE.languages[0]!.key, LECTURE.thumbnail_key] })));
    const { user } = renderApp("/courses");
    await user.click(await screen.findByRole("button", { name: "Delete Lecture 1" }, { timeout: 5000 }));
    const dialog = await screen.findByRole("dialog", { name: "Delete from the app?" });
    expect(dialog).toHaveTextContent("its 1 language copy and its own image");
    expect(called("POST", "/delete")).toHaveLength(0);
    const go = within(dialog).getByRole("button", { name: "Delete for good" });
    expect(go).toBeDisabled(); // waits for the word
    await user.type(within(dialog).getByLabelText("Type delete to confirm"), "delete");
    await user.click(go);
    expect(await screen.findByText(/is deleted \(3 files\)/)).toBeInTheDocument();
    expect(called("POST", "/delete")[0]!.body).toEqual({ class_level: 12, subject: "Account", key: LECTURE.key, whole_lecture: true });
  });

  it("deletes the course image after confirming, and names a card left without a picture", async () => {
    useApi();
    server.use(http.post(`${A}/course-image/delete`, () =>
      HttpResponse.json({ deleted: ["videos/class_12/Account/account_playlist_thumbnail.png"], empty_cards: ["Class 12 Accountancy"] })));
    const { user } = renderApp("/courses?tab=app");
    await user.click(await screen.findByRole("button", { name: "Delete course image" }, { timeout: 5000 }));
    const confirm = await screen.findByRole("dialog", { name: "Delete from the app?" });
    expect(confirm).toHaveTextContent("shows no picture until it gets one");
    await user.type(within(confirm).getByLabelText("Type delete to confirm"), "delete");
    await user.click(within(confirm).getByRole("button", { name: "Delete for good" }));
    expect(await screen.findByText(/Course image is deleted \(1 file\)/)).toBeInTheDocument();
    expect(await screen.findByText(/Class 12 Accountancy now has no picture in the app/)).toBeInTheDocument();
    expect(called("POST", "/course-image/delete").at(-1)!.body).toEqual({ class_level: 12, subject: "Account" });
  });

  it("opens App videos from an old Courses or Enrollments link (those tabs are gone)", async () => {
    useApi();
    renderApp("/courses?tab=enrollments");
    const tabs = await screen.findByRole("tablist", { name: "Course management" }, { timeout: 5000 });
    expect(within(tabs).getAllByRole("tab").map((t) => t.textContent)).toEqual(["App videos", "Courses & prices", "Classes, streams & goals"]);
    expect(within(tabs).getByRole("tab", { name: "App videos" })).toHaveAttribute("aria-selected", "true");
    await waitFor(() => expect(called("GET", "/status")).toHaveLength(1));
  });
});
