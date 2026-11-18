// Course Management > Courses & prices (mocked with MSW), against the AdhyaapakAI backend's admin
// API, which checks a catalogue with the app's own rules and saves it.

import { fireEvent, screen, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { axeViolations } from "../test/a11y";
import { renderApp } from "../test/render";
import { requests, server } from "../test/server";
import { adminSecret } from "./vouchers/adminApi";

vi.mock("./courses/bannerFit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./courses/bannerFit")>()),
  loadImage: async () => ({ width: 1672, height: 941, src: "data:," }),
  edgeColor: () => "#eef1f6",
  drawBanner: () => undefined,
  bannerFile: async (_img: unknown, framing: { mode: string; y: number }, _bg: string, name: string) =>
    new File([JSON.stringify(framing)], `${name}.jpg`, { type: "image/jpeg" }),
  ownFile: async (_img: unknown, name: string) => new File(["whole"], `${name}.jpg`, { type: "image/jpeg" }),
}));

// Courses & prices and Classes call the AdhyaapakAI backend's admin API (x-admin-secret), like vouchers.
const A = "*/api/admin/catalog";
const SECRET = "test-admin-secret";
beforeEach(() => adminSecret.set(SECRET));
const BUILT_IN_PAGE = { kicker: "Introducing", title_lead: "The Accounts", title_accent: "Mastery", title_tail: "Batch",
  pillars: ["Concept clarity"], exams: ["CBSE", "State Boards", "CUET"], chapter_groups: [{ title: "Accountancy", chapters: ["Goodwill"] }],
  why_choose: [{ title: "Complete syllabus", detail: "All 13 chapters." }], compare_at: null, languages: [], save_note: "" };
const DETAIL_DEFAULTS = {
  languages: ["english", "hindi", "gujarati", "punjabi", "malayalam", "telugu", "tamil", "odia", "kannada", "marathi", "bengali"]
    .map((code) => ({ code, name: code === "hindi" ? "Hindi (the main Hinglish video)" : code[0]!.toUpperCase() + code.slice(1) })),
  pages: { class12_accountancy: BUILT_IN_PAGE, class12_economics: { ...BUILT_IN_PAGE, title_lead: "The Economics", title_accent: "Edge" } },
};
const S3 = "https://bucket.s3.ap-south-1.amazonaws.com/";
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, GET", "Access-Control-Allow-Headers": "*" };
const ACC = { id: "class12_accountancy", title: "Class 12 Accountancy", subtitle: "Every Accountancy lecture", price_inr: 249,
  ios_product_id: "com.adhyaapakai.class12.accountancy.6m", grants: ["class12_accountancy"], badge: null, active: true, from_code: true };
const ECO = { ...ACC, id: "class12_economics", title: "Class 12 Economics", grants: ["class12_economics"], ios_product_id: "com.adhyaapakai.class12.economics.6m" };
const CATALOG = {
  database: "doubt_solver_app_local", source: "code", version: null, updated_at: null, error: null, access_days: 182,
  courses: [
    { entitlement: "class12_accountancy", class_level: 12, subject: "accounts", from_code: true },
    { entitlement: "class12_economics", class_level: 12, subject: "eco", from_code: true },
  ],
  products: [ACC, ECO],
  batches: [{ id: "class12_accountancy", title: "Class 12 Accountancy", product_id: "class12_accountancy", class_level: 12, subjects: ["accounts"],
    banner_key: "batch-banners/12TH ACCOUNTANCY.png", banner_key_dark: "batch-banners/dark/12TH ACCOUNTANCY.png", active: true, streams: ["Commerce"], goals: [] }],
  coupons: [{ code: "SCHOLAR2026", expires_at: "2026-10-30T18:29:59Z", products: [{ product_id: "class12_accountancy", coupon_product_id: "x", price_inr: 49 }] }],
};
const STREAM_GOALS: Record<string, string[]> = {
  Science: ["Board Exams", "JEE Main & Advanced", "NEET", "CUET", "NDA", "General Knowledge"],
  Commerce: ["Board Exams", "CA Foundation", "CUET", "CLAT", "General Knowledge"],
  Arts: ["Board Exams", "CLAT", "CUET", "NDA", "General Knowledge"],
  General: ["Board Exams", "JEE Main & Advanced", "NEET", "CUET", "CLAT", "CA Foundation", "NDA", "General Knowledge"],
};
const PUBLIC_ACADEMICS = {
  open: [11, 12], with_content: [11, 12],
  classes: [6, 7, 8, 9, 10, 11, 12].map((level) => ({ level, name: `Class ${level}` })),
  streams: Object.keys(STREAM_GOALS).map((key) => ({ key, name: key, active: true })),
  goals: STREAM_GOALS.General!.map((key) => ({ key, name: key, active: true, streams: Object.keys(STREAM_GOALS).filter((st) => STREAM_GOALS[st]!.includes(key)) })),
};
const called = (method: string, path: string) => requests.filter((r) => r.method === method && r.url.pathname === `/api/admin/catalog${path}`);

function useApi() {
  server.use(
    http.get(`${A}/status`, () => HttpResponse.json({ configured: true, storage: true, database: "doubt_solver_app_local" })),
    http.get(`${A}/catalog`, () => HttpResponse.json(CATALOG)),
    http.get(`${A}/subjects`, () => HttpResponse.json({ subjects: [
      { class_level: 12, folder: "Account", subject: "accounts" },
      { class_level: 11, folder: "Physics", subject: "physics" },
    ] })),
    http.get(`${A}/banners/preview`, () => HttpResponse.json({ url: "data:image/png;base64,iVBORw0KGgo=" })),
    // The app's public onboarding lists (no secret): classes, streams, goals and which streams offer each.
    http.get("*/api/academics/classes", () => HttpResponse.json(PUBLIC_ACADEMICS)),
    // What the Course Details editor starts from: the app's languages and its built-in pages.
    http.get(`${A}/details-defaults`, () => HttpResponse.json(DETAIL_DEFAULTS)),
  );
}

describe("course management uses the AdhyaapakAI admin API", () => {
  it("asks for the admin secret first and sends it as x-admin-secret", async () => {
    useApi();
    adminSecret.clear();
    const seen: (string | null)[] = [];
    server.use(http.get(`${A}/status`, ({ request }) => {
      seen.push(request.headers.get("x-admin-secret"));
      return request.headers.get("x-admin-secret") === SECRET
        ? HttpResponse.json({ configured: true, storage: true, database: "doubt_solver_app_local" })
        : HttpResponse.json({ detail: "Forbidden" }, { status: 403 });
    }));
    const { user } = renderApp("/courses?tab=prices");
    expect(await screen.findByRole("heading", { name: "Unlock Course Management" }, { timeout: 5000 })).toBeInTheDocument();
    await user.type(screen.getByLabelText("Admin secret"), "wrong");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByText("That admin secret was not accepted.")).toBeInTheDocument();
    await user.clear(screen.getByLabelText("Admin secret"));
    await user.type(screen.getByLabelText("Admin secret"), SECRET);
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByRole("table", { name: "Courses on sale" }, { timeout: 5000 })).toBeInTheDocument();
    expect(seen).toContain(SECRET);
    // Every call goes to the AdhyaapakAI backend's admin API, none to the dashboard's own backend.
    expect(requests.some((r) => r.url.pathname.startsWith("/api/v1/app-courses"))).toBe(false);
    expect(called("GET", "/catalog").length).toBeGreaterThan(0);
  });
});

describe("courses & prices", () => {
  it("shows what the app sells, which database, and its home-screen batches", async () => {
    useApi();
    const { container } = renderApp("/courses?tab=prices");
    const table = await screen.findByRole("table", { name: "Courses on sale" }, { timeout: 5000 });
    expect(within(table).getByText("Class 12 Accountancy")).toBeInTheDocument();
    expect(within(table).getByLabelText("Price of Class 12 Economics in rupees")).toHaveValue(249);
    expect(screen.getByText("doubt_solver_app_local")).toBeInTheDocument();
    expect(screen.getByText(/not saved yet: the app uses the catalogue in its code/)).toBeInTheDocument();
    expect(screen.getByRole("table", { name: "Home-screen batches" })).toHaveTextContent("Class 12 Accountancy");
    expect(screen.getByText("SCHOLAR2026")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save to the app" })).toBeDisabled();
    expect(await axeViolations(container)).toEqual([]);
  });

  it("changes a price and saves it after confirming", async () => {
    useApi();
    server.use(http.put(`${A}/catalog`, () => HttpResponse.json({ catalog: { ...CATALOG, source: "db", version: 1 }, summary: {} })));
    const { user } = renderApp("/courses?tab=prices");
    const price = await screen.findByLabelText("Price of Class 12 Accountancy in rupees", {}, { timeout: 5000 });
    await user.clear(price);
    await user.type(price, "299");
    await user.click(screen.getByRole("checkbox", { name: "Class 12 Economics on sale" }));
    await user.click(screen.getByRole("button", { name: "Save to the app" }));
    const dialog = await screen.findByRole("dialog", { name: "Save to the app?" });
    expect(dialog).toHaveTextContent("Class 12 Accountancy: ₹249 → ₹299");
    expect(dialog).toHaveTextContent("Class 12 Economics: off sale");
    expect(called("PUT", "/catalog")).toHaveLength(0);
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(await screen.findByText(/Saved \(version 1\)/)).toBeInTheDocument();
    const body = called("PUT", "/catalog")[0]!.body as { version: null; products: { id: string; price_inr: number; active: boolean; from_code?: boolean }[] };
    expect(body.version).toBeNull();
    expect(body.products.map((p) => [p.id, p.price_inr, p.active])).toEqual([["class12_accountancy", 299, true], ["class12_economics", 249, false]]);
    expect(body.products[0]).not.toHaveProperty("from_code");
  });

  it("lists why the app would refuse a catalogue", async () => {
    useApi();
    server.use(http.put(`${A}/catalog`, () => HttpResponse.json({ detail: "The app would refuse this catalogue.", code: "catalog_invalid",
      details: { problems: ["class12_economics: App Store id x is already used"] } }, { status: 422 })));
    const { user } = renderApp("/courses?tab=prices");
    const price = await screen.findByLabelText("Price of Class 12 Accountancy in rupees", {}, { timeout: 5000 });
    await user.type(price, "1");
    await user.click(screen.getByRole("button", { name: "Save to the app" }));
    await user.click(within(await screen.findByRole("dialog", { name: "Save to the app?" })).getByRole("button", { name: "Save" }));
    expect(await screen.findByText("class12_economics: App Store id x is already used")).toBeInTheDocument();
  });

  it("refuses a save made from an old version and offers a reload", async () => {
    useApi();
    server.use(http.put(`${A}/catalog`, () => HttpResponse.json({ detail: "changed", code: "catalog_changed" }, { status: 409 })));
    const { user } = renderApp("/courses?tab=prices");
    await user.type(await screen.findByLabelText("Price of Class 12 Accountancy in rupees", {}, { timeout: 5000 }), "1");
    await user.click(screen.getByRole("button", { name: "Save to the app" }));
    await user.click(within(await screen.findByRole("dialog", { name: "Save to the app?" })).getByRole("button", { name: "Save" }));
    expect(await screen.findByText(/was saved somewhere else since you opened it/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save to the app" })).toBeDisabled();
  });

  it("adds a new course from a subject's lecture folder", async () => {
    useApi();
    const { user } = renderApp("/courses?tab=prices");
    await user.click(await screen.findByRole("button", { name: "+ New course" }, { timeout: 5000 }));
    const dialog = await screen.findByRole("dialog", { name: "New course" });
    await user.selectOptions(within(dialog).getByLabelText("Class"), "11");
    expect(within(dialog).getByText("Course id: class11_physics")).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText("Name"), "Class 11 Physics");
    const price = within(dialog).getByLabelText("Price (₹, Android and web)");
    await user.clear(price);
    await user.type(price, "199");
    await user.click(within(dialog).getByRole("button", { name: "Add" }));
    const table = screen.getByRole("table", { name: "Courses on sale" });
    expect(within(table).getByText("Class 11 Physics")).toBeInTheDocument();
    expect(within(table).getByText("Not on iPhone")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save to the app" })).toBeEnabled();
  });

  it("shows one class at a time, and orders a card among its class's cards", async () => {
    useApi();
    const bio = { ...ACC, id: "class11_biology", title: "Class 11 Biology", grants: ["class11_biology"], ios_product_id: null, from_code: false };
    const card = (id: string, title: string, classLevel: number) => ({ ...CATALOG.batches[0]!, id, title, product_id: id, class_level: classLevel, subjects: ["x"] });
    server.use(
      http.get(`${A}/catalog`, () => HttpResponse.json({ ...CATALOG,
        courses: [...CATALOG.courses, { entitlement: "class11_biology", class_level: 11, subject: "biology" }],
        products: [...CATALOG.products, bio],
        batches: [CATALOG.batches[0], card("class11_biology", "Class 11 Biology", 11), card("class12_economics", "Class 12 Economics", 12)] })),
      http.put(`${A}/catalog`, () => HttpResponse.json({ catalog: { ...CATALOG, source: "db", version: 1 }, summary: {} })),
    );
    const { user } = renderApp("/courses?tab=prices");
    const courses = await screen.findByRole("table", { name: "Courses on sale" }, { timeout: 5000 });
    const cards = screen.getByRole("table", { name: "Home-screen batches" });
    const picker = screen.getByLabelText("Class");
    expect(picker).toHaveValue("12"); // Class 12 first, like App videos
    expect(within(courses).queryByText("Class 11 Biology")).not.toBeInTheDocument();
    expect(within(cards).queryByText("Class 11 Biology")).not.toBeInTheDocument();
    expect(screen.getByText("2 of 3 courses · 2 of 3 home-screen cards")).toBeInTheDocument();
    // Each list's box stops growing; more rows scroll inside it.
    for (const name of ["Courses on sale table", "Home-screen batches table"]) {
      expect(screen.getByRole("region", { name })).toHaveClass("table-scroll");
      expect(screen.getByRole("region", { name }).style.maxHeight).toBe("min(520px, 70vh)");
    }

    await user.selectOptions(picker, "11");
    expect(within(courses).getByText("Class 11 Biology")).toBeInTheDocument();
    expect(within(courses).queryByText("Class 12 Accountancy")).not.toBeInTheDocument();
    expect(within(cards).getByRole("button", { name: "Move Class 11 Biology up" })).toBeDisabled(); // the only class 11 card

    await user.selectOptions(picker, "12");
    // Economics moves above Accountancy, past the class 11 card in between.
    await user.click(within(cards).getByRole("button", { name: "Move Class 12 Economics up" }));
    await user.click(screen.getByRole("button", { name: "Save to the app" }));
    await user.click(within(await screen.findByRole("dialog", { name: "Save to the app?" })).getByRole("button", { name: "Save" }));
    await screen.findByText(/Saved \(version 1\)/);
    const body = called("PUT", "/catalog")[0]!.body as { batches: { id: string }[] };
    expect(body.batches.map((b) => b.id)).toEqual(["class12_economics", "class11_biology", "class12_accountancy"]);
  });

  it("opens, closes, renames, adds and deletes the app's classes", async () => {
    useApi();
    type ClassBody = { class_level: number; open: boolean };
    const cls = (c: number, open: boolean, name = `Class ${c}`) => ({ class_level: c, name, open, students_keep: false });
    const state = { database: "doubt_solver_app_local", version: null, updated_at: null, error: null, max_class: 20,
      classes: [6, 7, 8, 9, 10, 11, 12].map((c) => cls(c, c >= 11)) };
    const summary = { version: 1, opened: [10], closed: [], open: [10, 11, 12], added: [13], removed: [6], renamed: { "12": ["Class 12", "Class 12 (Boards)"] } };
    server.use(
      http.get(`${A}/classes`, () => HttpResponse.json(state)),
      http.get(`${A}/classes/6/delete-check`, () => HttpResponse.json({ class_level: 6, students: 0, courses: [], cards: [], subjects: [], blockers: [] })),
      http.get(`${A}/classes/11/delete-check`, () => HttpResponse.json({ class_level: 11, students: 40, courses: [], cards: [], subjects: ["Physics"],
        blockers: ["40 students in this class", "lecture folders in videos/class_11/: Physics (App videos)"] })),
      http.put(`${A}/classes`, () => HttpResponse.json({ ...state, version: 1, summary })),
    );
    const { user, container } = renderApp("/courses?tab=taxonomy");
    const table = await screen.findByRole("table", { name: "The app's classes" }, { timeout: 5000 });
    expect(within(table).getByRole("checkbox", { name: "Class 12 open" })).toBeChecked();
    expect(within(table).getByRole("checkbox", { name: "Class 10 open" })).not.toBeChecked();
    const save = screen.getByRole("button", { name: "Save to the app" });
    expect(save).toBeDisabled();

    const puts = () => requests.filter((r) => r.method === "PUT" && r.url.pathname === "/api/admin/catalog/classes");
    const openIn = (i: number) => (puts()[i]!.body as { classes: ClassBody[] }).classes.filter((c) => c.open).map((c) => c.class_level);

    // Active / inactive: only after typing it, then straight to the app.
    await user.click(within(table).getByRole("checkbox", { name: "Class 12 open" }));
    const off = await screen.findByRole("dialog", { name: "Make Class 12 inactive?" });
    expect(off).toHaveTextContent("Students already in it keep their lectures and tests.");
    await user.type(within(off).getByLabelText("Type inactive to confirm"), "active"); // the wrong word
    expect(within(off).getByRole("button", { name: "Make inactive" })).toBeDisabled();
    await user.click(within(off).getByRole("button", { name: "Cancel" }));
    expect(within(table).getByRole("checkbox", { name: "Class 12 open" })).toBeChecked();
    expect(puts()).toHaveLength(0);

    await user.click(within(table).getByRole("checkbox", { name: "Class 10 open" }));
    const on = await screen.findByRole("dialog", { name: "Make Class 10 active?" });
    await user.type(within(on).getByLabelText("Type active to confirm"), "active");
    await user.click(within(on).getByRole("button", { name: "Make active" }));
    expect(await screen.findByText(/Class 10 is now active in the app/)).toBeInTheDocument();
    expect(openIn(0)).toEqual([10, 11, 12]);

    // A class still in use can't be deleted: it says what's left.
    const table1 = await screen.findByRole("table", { name: "The app's classes" });
    await user.click(within(table1).getByRole("button", { name: "Delete class 11" }));
    const blocked = await screen.findByRole("dialog", { name: "Class 11 can't be deleted" });
    expect(blocked).toHaveTextContent("40 students in this class");
    await user.click(within(blocked).getByRole("button", { name: "OK" }));

    // A class nothing uses: deleted only after typing "delete", straight to the app.
    await user.click(within(table1).getByRole("button", { name: "Delete class 6" }));
    const confirmDelete = await screen.findByRole("dialog", { name: "Delete Class 6?" });
    const deleteButton = within(confirmDelete).getByRole("button", { name: "Delete" });
    await user.type(within(confirmDelete).getByLabelText("Type delete to confirm"), "delet");
    expect(deleteButton).toBeDisabled();
    expect(puts()).toHaveLength(1);
    await user.type(within(confirmDelete).getByLabelText("Type delete to confirm"), "e");
    await user.click(deleteButton);
    expect(await screen.findByText("Class 6 is deleted from the app's classes.")).toBeInTheDocument();
    expect((puts()[1]!.body as { classes: ClassBody[] }).classes.map((c) => c.class_level)).toEqual([7, 8, 9, 10, 11, 12]);

    // Rename and a new class go with Save; meanwhile saved classes wait (they'd save these too).
    const table2 = await screen.findByRole("table", { name: "The app's classes" });
    const twelve = within(table2).getByRole("textbox", { name: "Name of class 12" });
    await user.clear(twelve);
    await user.type(twelve, "Class 12 (Boards)");
    expect(within(table2).getByRole("button", { name: "Delete class 7" })).toBeDisabled();
    expect(within(table2).getByRole("checkbox", { name: "Class 7 open" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "+ New class" }));
    expect(screen.getByLabelText("Number")).toHaveValue("13");
    const name = screen.getByLabelText("Name in the app");
    await user.clear(name);
    await user.type(name, "Dropper");
    await user.click(screen.getByRole("button", { name: "Add" }));
    await user.click(within(table2).getByRole("checkbox", { name: "Class 13 open" })); // new: no typing, goes with Save

    await user.click(screen.getByRole("button", { name: "Save to the app" }));
    const dialog = await screen.findByRole("dialog", { name: "Save the classes?" });
    expect(dialog).toHaveTextContent("New class 13: Dropper (open)");
    expect(dialog).toHaveTextContent("Rename class 12: Class 12 → Class 12 (Boards)");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(await screen.findByText(/Saved \(version 1\)/)).toBeInTheDocument();
    // (The mock always answers with the first list.)
    expect(puts()[2]!.body).toEqual({ version: 1, classes: [
      ...[6, 7, 8, 9, 10].map((c) => ({ class_level: c, name: `Class ${c}`, open: false })),
      { class_level: 11, name: "Class 11", open: true },
      { class_level: 12, name: "Class 12 (Boards)", open: true },
      { class_level: 13, name: "Dropper", open: true },
    ] });
    expect(await axeViolations(container)).toEqual([]);
  });

  it("edits a paid course's Course Details page, starting from the app's own", async () => {
    useApi();
    server.use(
      http.get("*/api/admin/videos/course", () => HttpResponse.json({
        class_level: 12, subject: "Account", app_subject: "accounts", playlist_thumbnail_key: null, lecture_count: 3,
        chapters: [
          { folder: "demo_videos", number: 0, title: "Free Demo Videos", is_demo: true, thumbnail_key: null, shared_number: [], lectures: [{}] },
          { folder: "chapter-02-goodwill", number: 2, title: "Goodwill", is_demo: false, thumbnail_key: null, shared_number: [],
            lectures: [{ languages: [{ language: "tamil", key: "x" }, { language: "english", key: "y" }] }] },
          { folder: "chapter-01-cash-flow", number: 1, title: "Cash Flow Statement", is_demo: false, thumbnail_key: null, shared_number: [], lectures: [{}] },
          { folder: "chapter-03-empty", number: 3, title: "Empty", is_demo: false, thumbnail_key: null, shared_number: [], lectures: [] },
        ],
      })),
      http.put(`${A}/catalog`, () => HttpResponse.json({ catalog: { ...CATALOG, source: "db", version: 1 }, summary: {} })),
    );
    const { user } = renderApp("/courses?tab=prices");
    const table = await screen.findByRole("table", { name: "Courses on sale" }, { timeout: 5000 });
    // The app's built-in pages come from its backend (details-defaults).
    expect(await within(table).findAllByText("Course Details: the app's own page")).toHaveLength(2);
    await user.click(within(table).getByRole("button", { name: "Course details of Class 12 Accountancy" }));
    const dialog = await screen.findByRole("dialog", { name: "Course details: Class 12 Accountancy" });
    expect(within(dialog).getByLabelText("Title, first line")).toHaveValue("The Accounts"); // what the app shows today
    // No languages saved yet: ticked from what App videos has (Hinglish main video + its copies).
    expect(await within(dialog).findByText("Filled from App videos: 3 languages.")).toBeInTheDocument();
    const langs = within(dialog).getByRole("group", { name: /Languages \(3 of 11\)/ });
    expect(within(langs).getByRole("checkbox", { name: "Tamil" })).toBeChecked();
    expect(within(langs).getByRole("checkbox", { name: "Bengali" })).not.toBeChecked();
    const accent = within(dialog).getByLabelText("Title, gold word");
    await user.clear(accent);
    await user.type(accent, "Shikhar");
    await user.click(within(dialog).getByRole("button", { name: "Fill from App videos" }));
    // Its chapters with lectures, in order (no demo, no empty chapter).
    expect(await within(dialog).findByLabelText("Chapters of group 1, one per line")).toHaveValue("Cash Flow Statement\nGoodwill");
    const compare = within(dialog).getByLabelText("Crossed-out price (₹, optional)");
    await user.type(compare, "199");
    await user.click(within(dialog).getByRole("button", { name: "Done" }));
    expect(within(dialog).getByRole("alert")).toHaveTextContent("must be above the price (₹249)");
    await user.clear(compare);
    await user.type(compare, "349");
    await user.click(within(dialog).getByRole("button", { name: "Done" }));
    expect(within(table).getByText("Course Details: set here")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Save to the app" }));
    const confirm = await screen.findByRole("dialog", { name: "Save to the app?" });
    expect(confirm).toHaveTextContent("Class 12 Accountancy: Course Details page added");
    await user.click(within(confirm).getByRole("button", { name: "Save" }));
    await screen.findByText(/Saved \(version 1\)/);
    const body = called("PUT", "/catalog")[0]!.body as { products: { id: string; details?: Record<string, unknown> | null }[] };
    const acc = body.products.find((p) => p.id === "class12_accountancy")!;
    expect(acc.details).toMatchObject({
      title_lead: "The Accounts", title_accent: "Shikhar", compare_at: 349, exams: ["CBSE", "State Boards", "CUET"],
      languages: ["english", "hindi", "tamil"], // in the app's order
      chapter_groups: [{ title: "Account", chapters: ["Cash Flow Statement", "Goodwill"] }],
    });
    expect(body.products.find((p) => p.id === "class12_economics")!.details ?? null).toBeNull(); // untouched: the app's own
  });

  it("fills a new course's chapters and languages from App videos by itself", async () => {
    useApi();
    const physics = { ...ACC, id: "class11_physics", title: "Class 11 Physics", grants: ["class11_physics"], price_inr: 199, ios_product_id: null, from_code: false };
    server.use(
      http.get(`${A}/catalog`, () => HttpResponse.json({ ...CATALOG,
        courses: [...CATALOG.courses, { entitlement: "class11_physics", class_level: 11, subject: "physics" }], products: [...CATALOG.products, physics] })),
      http.get("*/api/admin/videos/course", ({ request }) => {
        expect(new URL(request.url).searchParams.get("subject")).toBe("Physics");
        return HttpResponse.json({ class_level: 11, subject: "Physics", app_subject: "physics", playlist_thumbnail_key: null, lecture_count: 2,
          chapters: [{ folder: "chapter-01-units", number: 1, title: "Units and Measurements", is_demo: false, thumbnail_key: null, shared_number: [],
            lectures: [{ languages: [{ language: "bengali", key: "b" }] }] }] });
      }),
    );
    const { user } = renderApp("/courses?tab=prices");
    await screen.findByRole("table", { name: "Courses on sale" }, { timeout: 5000 });
    await user.selectOptions(screen.getByLabelText("Class"), "11");
    expect(screen.getByText("No Course Details page")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Course details of Class 11 Physics" }));
    const dialog = await screen.findByRole("dialog", { name: "Course details: Class 11 Physics" });
    expect(await within(dialog).findByText("Filled from App videos: 1 chapter and 2 languages.")).toBeInTheDocument();
    expect(within(dialog).getByLabelText("Chapters of group 1, one per line")).toHaveValue("Units and Measurements");
    expect(within(dialog).getByRole("group", { name: /Languages \(2 of 11\)/ })).toBeInTheDocument(); // Hindi (main) + Bengali
  });

  it("offers no Course Details for a free course", async () => {
    useApi();
    const free = { ...ACC, id: "class11_bio", title: "Class 11 Bio", grants: ["class11_bio"], price_inr: 0, free: true, ios_product_id: null, from_code: false };
    server.use(http.get(`${A}/catalog`, () => HttpResponse.json({ ...CATALOG,
      courses: [...CATALOG.courses, { entitlement: "class11_bio", class_level: 11, subject: "biology" }], products: [...CATALOG.products, free] })));
    const { user } = renderApp("/courses?tab=prices");
    await screen.findByRole("table", { name: "Courses on sale" }, { timeout: 5000 });
    await user.selectOptions(screen.getByLabelText("Class"), "all");
    const table = screen.getByRole("table", { name: "Courses on sale" });
    expect(within(table).getByText("Class 11 Bio")).toBeInTheDocument();
    expect(within(table).queryByRole("button", { name: "Course details of Class 11 Bio" })).not.toBeInTheDocument();
    expect(within(table).getByRole("button", { name: "Course details of Class 12 Economics" })).toBeInTheDocument();
  });

  it("removes a home-screen card only after typing remove", async () => {
    useApi();
    const { user } = renderApp("/courses?tab=prices");
    const cards = await screen.findByRole("table", { name: "Home-screen batches" }, { timeout: 5000 });
    await user.click(within(cards).getByRole("button", { name: "Edit Class 12 Accountancy" }));
    await user.click(within(await screen.findByRole("dialog", { name: "Edit Class 12 Accountancy" })).getByRole("button", { name: "Remove card" }));
    const confirm = await screen.findByRole("dialog", { name: "Remove Class 12 Accountancy?" });
    const remove = within(confirm).getByRole("button", { name: "Remove card" });
    expect(remove).toBeDisabled();
    await user.type(within(confirm).getByLabelText("Type remove to confirm"), "remov");
    expect(remove).toBeDisabled();

    // Cancel goes back to the card, which stays.
    await user.click(within(confirm).getByRole("button", { name: "Cancel" }));
    const edit = await screen.findByRole("dialog", { name: "Edit Class 12 Accountancy" });
    await user.click(within(edit).getByRole("button", { name: "Remove card" }));
    const again = await screen.findByRole("dialog", { name: "Remove Class 12 Accountancy?" });
    await user.type(within(again).getByLabelText("Type remove to confirm"), "remove");
    await user.click(within(again).getByRole("button", { name: "Remove card" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByText("No batches")).toBeInTheDocument(); // it was the only card
    expect(screen.getByRole("button", { name: "Save to the app" })).toBeEnabled(); // goes to the app with Save
  });

  it("makes a stream with no goal active by picking its goals in the same step", async () => {
    useApi();
    const lists = {
      version: 5, updated_at: null, error: null,
      streams: [{ key: "Science", name: "Science", active: true }, { key: "placement drive", name: "placement drive", active: false }],
      goals: [
        { key: "NEET", name: "NEET", active: true, streams: ["Science"] },
        { key: "General Knowledge", name: "General Knowledge", active: true, streams: ["Science"] },
      ],
    };
    server.use(
      http.get(`${A}/lists`, () => HttpResponse.json(lists)),
      http.put(`${A}/lists`, () => HttpResponse.json({ ...lists, version: 6, summary: {} })),
    );
    const { user } = renderApp("/courses?tab=taxonomy&list=streams");
    const table = await screen.findByRole("table", { name: "The app's streams" }, { timeout: 5000 });
    await user.click(within(table).getByRole("checkbox", { name: "placement drive active" }));
    const dialog = await screen.findByRole("dialog", { name: "Make placement drive active?" });
    expect(dialog).toHaveTextContent("No active goal is offered to placement drive yet");
    await user.type(within(dialog).getByLabelText("Type active to confirm"), "active");
    const go = within(dialog).getByRole("button", { name: "Make active" });
    expect(go).toBeDisabled(); // still needs a goal
    await user.click(within(dialog).getByRole("checkbox", { name: "General Knowledge" }));
    await user.click(go);
    expect(await screen.findByText(/placement drive is now active in the app/)).toBeInTheDocument();
    const put = requests.find((r) => r.method === "PUT" && r.url.pathname === "/api/admin/catalog/lists")!;
    expect(put.body).toEqual({
      version: 5,
      streams: [{ key: "Science", name: "Science", active: true }, { key: "placement drive", name: "placement drive", active: true }],
      goals: [
        { key: "NEET", name: "NEET", active: true, streams: ["Science"] },
        { key: "General Knowledge", name: "General Knowledge", active: true, streams: ["Science", "placement drive"] },
      ],
    });
  });

  it("manages the app's streams and goals, one list at a time", async () => {
    useApi();
    const lists = {
      version: 3, updated_at: null, error: null,
      streams: [{ key: "Science", name: "Science", active: true }, { key: "Commerce", name: "Commerce", active: true }],
      goals: [
        { key: "NEET", name: "NEET", active: true, streams: ["Science"] },
        { key: "CA Foundation", name: "CA Foundation", active: true, streams: ["Commerce"] },
      ],
    };
    server.use(
      http.get(`${A}/classes`, () => HttpResponse.json({ database: "x", version: null, updated_at: null, error: null, max_class: 20,
        classes: [11, 12].map((c) => ({ class_level: c, name: `Class ${c}`, open: true, students_keep: false })) })),
      http.get(`${A}/lists`, () => HttpResponse.json(lists)),
      http.put(`${A}/lists`, () => HttpResponse.json({ ...lists, version: 4, summary: {} })),
    );
    const { user, container } = renderApp("/courses?tab=taxonomy");
    const manage = await screen.findByLabelText("Manage", {}, { timeout: 5000 });
    expect(await screen.findByRole("table", { name: "The app's classes" })).toBeInTheDocument();
    await user.selectOptions(manage, "goals");
    const table = await screen.findByRole("table", { name: "The app's goals" });
    expect(screen.queryByRole("table", { name: "The app's classes" })).not.toBeInTheDocument();
    const puts = () => requests.filter((r) => r.method === "PUT" && r.url.pathname === "/api/admin/catalog/lists");

    // Inactive only after typing it, straight to the app.
    await user.click(within(table).getByRole("checkbox", { name: "NEET active" }));
    const off = await screen.findByRole("dialog", { name: "Make NEET inactive?" });
    await user.type(within(off).getByLabelText("Type inactive to confirm"), "inactive");
    await user.click(within(off).getByRole("button", { name: "Make inactive" }));
    expect(await screen.findByText(/NEET is now inactive in the app/)).toBeInTheDocument();
    expect((puts()[0]!.body as { goals: { key: string; active: boolean }[] }).goals.map((g) => [g.key, g.active])).toEqual([["NEET", false], ["CA Foundation", true]]);

    // Rename (the key stays), offer CA Foundation to Science too, and add a goal: all with Save.
    const goals = await screen.findByRole("table", { name: "The app's goals" });
    const ca = within(goals).getByRole("textbox", { name: "Name of CA Foundation" });
    await user.clear(ca);
    await user.type(ca, "CA Foundation (ICAI)");
    expect(within(goals).getByText("Saved as “CA Foundation”")).toBeInTheDocument();
    await user.click(within(goals).getByRole("checkbox", { name: "CA Foundation for Science" }));
    expect(within(goals).getByRole("checkbox", { name: "NEET active" })).toBeDisabled(); // waits for Save / Discard
    await user.click(screen.getByRole("button", { name: "+ New goal" }));
    await user.type(screen.getByLabelText("New goal's name"), "Olympiad");
    await user.click(screen.getByRole("button", { name: "Add" }));
    await user.click(within(goals).getByRole("checkbox", { name: "Olympiad for Science" }));
    await user.click(screen.getByRole("button", { name: "Save to the app" }));
    const dialog = await screen.findByRole("dialog", { name: "Save the goals?" });
    expect(dialog).toHaveTextContent("New goal: Olympiad (inactive, for Science)");
    expect(dialog).toHaveTextContent("Rename: CA Foundation → CA Foundation (ICAI)");
    expect(dialog).toHaveTextContent("CA Foundation (ICAI): offered to Commerce, Science");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(await screen.findByText(/^Saved\. The app shows it/)).toBeInTheDocument();
    expect(puts()[1]!.body).toEqual({
      version: 4, // made from the first save's answer
      streams: lists.streams,
      goals: [
        { key: "NEET", name: "NEET", active: true, streams: ["Science"] }, // (the mock answered with the first lists)
        { key: "CA Foundation", name: "CA Foundation (ICAI)", active: true, streams: ["Commerce", "Science"] },
        { key: "Olympiad", name: "Olympiad", active: false, streams: ["Science"] },
      ],
    });
    expect(await axeViolations(container)).toEqual([]);
  });

  it("adds the subject it shows, never one that already has a course", async () => {
    useApi();
    server.use(
      http.get(`${A}/catalog`, () => HttpResponse.json({ ...CATALOG,
        courses: [...CATALOG.courses, { entitlement: "class11_accounts", class_level: 11, subject: "accounts" }],
        products: [...CATALOG.products, { ...ACC, id: "class11_accounts", title: "Class 11 Accounts", grants: ["class11_accounts"], ios_product_id: null, from_code: false }] })),
      http.get(`${A}/subjects`, () => HttpResponse.json({ subjects: [
        { class_level: 12, folder: "Account", subject: "accounts" },
        { class_level: 11, folder: "Account", subject: "accounts" }, // has a course already: not offered
        { class_level: 11, folder: "Biology", subject: "biology" },
      ] })),
    );
    const { user } = renderApp("/courses?tab=prices");
    await user.click(await screen.findByRole("button", { name: "+ New course" }, { timeout: 5000 }));
    const dialog = await screen.findByRole("dialog", { name: "New course" });
    await user.selectOptions(within(dialog).getByLabelText("Class"), "11");
    expect(within(dialog).getByLabelText("Subject (its lectures in App videos)")).toHaveValue("biology");
    expect(within(dialog).getByText("Course id: class11_biology")).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText("Name"), "Class 11th Bio");
    await user.click(within(dialog).getByRole("radio", { name: "Free" }));
    await user.click(within(dialog).getByRole("button", { name: "Add" }));
    expect(screen.queryByRole("dialog", { name: "New course" })).not.toBeInTheDocument();
    expect(within(screen.getByRole("table", { name: "Courses on sale" })).getByText("Class 11th Bio")).toBeInTheDocument();
  });

  it("aims a home-screen card at a stream and goals, like the app's onboarding", async () => {
    useApi();
    const { user } = renderApp("/courses?tab=prices");
    const table = await screen.findByRole("table", { name: "Home-screen batches" }, { timeout: 5000 });
    expect(within(table).getByText("Class 12 · Commerce · every goal")).toBeInTheDocument();
    await user.click(within(table).getByRole("button", { name: "Edit Class 12 Accountancy" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit Class 12 Accountancy" });
    const goals = () => within(within(dialog).getByRole("group", { name: "Goals that see it" })).getAllByRole("checkbox").map((c) => c.parentElement!.textContent);
    expect(goals()).toEqual(["Board Exams", "CUET", "CLAT", "CA Foundation", "General Knowledge"]); // Commerce's goals only
    await user.click(within(dialog).getByRole("checkbox", { name: "Science" }));
    expect(goals()).toContain("NEET");
    await user.click(within(dialog).getByRole("checkbox", { name: "Commerce" }));
    await user.click(within(dialog).getByRole("checkbox", { name: "NEET" }));
    await user.click(within(dialog).getByRole("button", { name: "Done" }));
    expect(within(table).getByText("Class 12 · Science · NEET")).toBeInTheDocument();
    server.use(http.put(`${A}/catalog`, () => HttpResponse.json({ catalog: { ...CATALOG, source: "db", version: 1 }, summary: {} })));
    await user.click(screen.getByRole("button", { name: "Save to the app" }));
    await user.click(within(await screen.findByRole("dialog", { name: "Save to the app?" })).getByRole("button", { name: "Save" }));
    await screen.findByText(/Saved \(version 1\)/);
    const body = called("PUT", "/catalog")[0]!.body as { batches: { streams: string[]; goals: string[] }[] };
    expect(body.batches[0]).toMatchObject({ streams: ["Science"], goals: ["NEET"] });
  });

  it("frames any image as a 1200 x 520 banner before uploading it", async () => {
    useApi();
    let s3Posts = 0;
    server.use(
      http.post(`${A}/banners/uploads`, async ({ request }) => {
        const body = (await request.json()) as { batch_id: string; dark: boolean; filename: string };
        return HttpResponse.json({ key: `batch-banners/${body.batch_id}-1.jpg`, content_type: "image/jpeg", max_bytes: 1, upload_url: S3,
          fields: { key: "k", "Content-Type": "image/jpeg" } });
      }),
      http.options(S3, () => new HttpResponse(null, { status: 200, headers: CORS })),
      http.post(S3, () => { s3Posts += 1; return new HttpResponse(null, { status: 204, headers: CORS }); }),
      http.post(`${A}/banners/uploads/complete`, () => HttpResponse.json({ key: "batch-banners/class12_accountancy-1.jpg", size: 10 })),
    );
    const { user } = renderApp("/courses?tab=prices");
    const table = await screen.findByRole("table", { name: "Home-screen batches" }, { timeout: 5000 });
    await user.click(within(table).getByRole("button", { name: "Edit Class 12 Accountancy" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit Class 12 Accountancy" });
    await user.upload(within(dialog).getByLabelText("Banner: choose a new image (any size)", { selector: "input" }), new File(["png"], "thumb.png", { type: "image/png" }));
    expect(await within(dialog).findByLabelText(/preview as the app shows it/)).toBeInTheDocument();
    // By default the whole picture in its own shape: the app's card takes that shape.
    expect(within(dialog).getByRole("radio", { name: "Whole image as it is (the card takes its shape)" })).toBeChecked();
    expect(dialog).toHaveTextContent("the card takes this picture's shape");
    expect(within(dialog).queryByLabelText("Zoom")).not.toBeInTheDocument();
    // Or framed in the classic card shape: a 16:9 picture filling it can move up and down.
    await user.click(within(dialog).getByRole("radio", { name: "Fill the card (crop)" }));
    const upDown = within(dialog).getByLabelText("Up – down");
    expect(upDown).toHaveValue("0.5");
    expect(within(dialog).getByRole("status")).toHaveTextContent("The parts outside the card are cut.");
    // Shrink it on every side: the whole picture inside the dashed line, nothing cut.
    await user.click(within(dialog).getByRole("radio", { name: "Whole image inside the dashed line" }));
    expect(within(dialog).getByRole("status")).toHaveTextContent("Nothing is cut: the whole image is inside the dashed line.");
    const zoom = within(dialog).getByLabelText("Zoom");
    expect(Number((zoom as HTMLInputElement).value)).toBeLessThan(1);
    expect(Number(zoom.getAttribute("min"))).toBeLessThan(Number((zoom as HTMLInputElement).value));
    await user.click(within(dialog).getByRole("button", { name: "Use this banner" }));
    await within(dialog).findAllByAltText(/as it is now/);
    expect(called("POST", "/banners/uploads")[0]!.body).toMatchObject({ batch_id: "class12_accountancy", dark: false, filename: "class12_accountancy.jpg" });
    expect(s3Posts).toBe(1);
    await user.click(within(dialog).getByRole("button", { name: "Done" }));
    expect(screen.getByText("You have changes that aren't in the app yet.")).toBeInTheDocument();
  });

  it("deletes a card's banners: dark mode falls back to the main one, then the course image", async () => {
    useApi();
    server.use(
      http.get("*/api/admin/videos/course", () => HttpResponse.json({ class_level: 12, subject: "Account", app_subject: "accounts",
        playlist_thumbnail_key: "videos/class_12/Account/accounts_playlist_thumbnail.png", lecture_count: 1, chapters: [] })),
      http.put(`${A}/catalog`, () => HttpResponse.json({ catalog: { ...CATALOG, source: "db", version: 1 },
        summary: { banners_deleted: ["batch-banners/dark/12TH ACCOUNTANCY.png"] } })),
    );
    const { user } = renderApp("/courses?tab=prices");
    const table = await screen.findByRole("table", { name: "Home-screen batches" }, { timeout: 5000 });
    await user.click(within(table).getByRole("button", { name: "Edit Class 12 Accountancy" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit Class 12 Accountancy" });
    expect(within(dialog).getByText("Banner (optional)")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Delete dark-mode banner" }));
    expect(within(dialog).getByText("None: dark mode shows the main banner.")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Delete banner" }));
    expect(within(dialog).getByText("None: the card shows the course image from App videos.")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Done" }));
    expect(within(table).getByText("Course image (live)")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save to the app" }));
    const confirm = await screen.findByRole("dialog", { name: "Save to the app?" });
    expect(confirm).toHaveTextContent("Class 12 Accountancy: banner deleted (shows the course image)");
    expect(confirm).toHaveTextContent("Class 12 Accountancy: dark-mode banner deleted");
    await user.click(within(confirm).getByRole("button", { name: "Save" }));
    expect(await screen.findByText(/1 banner image no card uses any more was deleted from S3/)).toBeInTheDocument();
    const body = called("PUT", "/catalog")[0]!.body as { batches: { banner_key: string | null; banner_key_dark: string | null; banner_from_course: boolean }[] };
    expect(body.batches[0]).toMatchObject({ banner_key: null, banner_key_dark: null, banner_from_course: true });
  });

  it("saves a card with no picture at all: the app shows its name instead", async () => {
    useApi();
    server.use(http.get("*/api/admin/videos/course", () => HttpResponse.json({ class_level: 12, subject: "Account", app_subject: "accounts",
      playlist_thumbnail_key: null, lecture_count: 1, chapters: [] })));
    const { user } = renderApp("/courses?tab=prices");
    const table = await screen.findByRole("table", { name: "Home-screen batches" }, { timeout: 5000 });
    await user.click(within(table).getByRole("button", { name: "Edit Class 12 Accountancy" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit Class 12 Accountancy" });
    await user.click(within(dialog).getByRole("button", { name: "Delete banner" }));
    expect(await within(dialog).findByText(/this course has no course image in App videos yet/)).toBeInTheDocument();
    expect(dialog).toHaveTextContent("the app shows the card with its name on a plain background");
    await user.click(within(dialog).getByRole("button", { name: "Done" }));
    expect(screen.queryByRole("dialog", { name: "Edit Class 12 Accountancy" })).not.toBeInTheDocument();
    expect(screen.getByText("You have changes that aren't in the app yet.")).toBeInTheDocument();
  });

  it("lets a card show the course image from App videos, live", async () => {
    useApi();
    server.use(http.put(`${A}/catalog`, () => HttpResponse.json({ catalog: { ...CATALOG, source: "db", version: 1 }, summary: {} })));
    const { user } = renderApp("/courses?tab=prices");
    const table = await screen.findByRole("table", { name: "Home-screen batches" }, { timeout: 5000 });
    await user.click(within(table).getByRole("button", { name: "Edit Class 12 Accountancy" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit Class 12 Accountancy" });
    expect(within(dialog).getByText("Banner for dark mode (optional)")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("checkbox", { name: /Use the course image from App videos/ }));
    expect(within(dialog).getByText(/change it there .*and the card follows/)).toBeInTheDocument();
    expect(within(dialog).getByText("Fallback banner (optional)")).toBeInTheDocument();
    expect(within(dialog).queryByText("Banner for dark mode (optional)")).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Done" }));
    expect(within(table).getByText("Course image (live)")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save to the app" }));
    await user.click(within(await screen.findByRole("dialog", { name: "Save to the app?" })).getByRole("button", { name: "Save" }));
    await screen.findByText(/Saved \(version 1\)/);
    const body = called("PUT", "/catalog")[0]!.body as { batches: { banner_from_course: boolean }[] };
    expect(body.batches[0]!.banner_from_course).toBe(true);
  });

  it("deletes a course added from here, with its card and S3 files, after typing its id", async () => {
    const TEST = { id: "class12_test", title: "Class 12 Test", subtitle: "", price_inr: 2, ios_product_id: null, grants: ["class12_test"],
      badge: null, active: false, from_code: false };
    const withTest = { ...CATALOG, source: "db", version: 6,
      courses: [...CATALOG.courses, { entitlement: "class12_test", class_level: 12, subject: "test", from_code: false }],
      products: [...CATALOG.products, TEST] };
    useApi();
    server.use(
      http.get(`${A}/catalog`, () => HttpResponse.json(withTest)),
      http.get(`${A}/courses/class12_test/delete-check`, () => HttpResponse.json({
        entitlement: "class12_test", class_level: 12, subject: "test", blockers: [], products: ["class12_test"], batches: ["class12_test"],
        banners: ["batch-banners/class12_test-1.png"], folder: "videos/class_12/Test/", files: 2, bytes: 330_882_541,
      })),
      http.post(`${A}/courses/class12_test/delete`, () => HttpResponse.json({ catalog: { ...CATALOG, source: "db", version: 7 }, deleted: {}, s3_error: null })),
    );
    const { user } = renderApp("/courses?tab=prices");
    const table = await screen.findByRole("table", { name: "Courses on sale" }, { timeout: 5000 });
    // The app's own courses can be deleted like any other (a combo is deleted with its courses).
    expect(within(table).getByRole("button", { name: "Delete Class 12 Accountancy" })).toBeInTheDocument();
    expect(within(table).queryByRole("button", { name: "Delete Class 12 Commerce Combo" })).not.toBeInTheDocument();
    await user.click(within(table).getByRole("button", { name: "Delete Class 12 Test" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete Class 12 Test?" });
    expect(await within(dialog).findByText("videos/class_12/Test/")).toBeInTheDocument();
    expect(dialog).toHaveTextContent("2 files, 316 MB");
    expect(dialog).toHaveTextContent("1 banner image");
    expect(dialog).toHaveTextContent("While any student can still open this course, the app refuses");
    const go = within(dialog).getByRole("button", { name: "Delete for good" });
    expect(go).toBeDisabled();
    const confirmBox = within(dialog).getByLabelText("Type delete to confirm");
    await user.type(confirmBox, "class12_test"); // the course id isn't the word
    expect(go).toBeDisabled();
    await user.clear(confirmBox);
    await user.type(confirmBox, "delete");
    expect(go).toBeEnabled();
    await user.click(go);
    expect(await screen.findByText(/Class 12 Test is deleted/)).toBeInTheDocument();
    expect(called("POST", "/courses/class12_test/delete")[0]!.body).toEqual({ version: 6 });
  });

  it("explains why a course can't be deleted", async () => {
    const TEST = { id: "class12_test", title: "Class 12 Test", subtitle: "", price_inr: 2, ios_product_id: null, grants: ["class12_test"],
      badge: null, active: true, from_code: false };
    useApi();
    server.use(
      http.get(`${A}/catalog`, () => HttpResponse.json({ ...CATALOG, source: "db", version: 6,
        courses: [...CATALOG.courses, { entitlement: "class12_test", class_level: 12, subject: "test", from_code: false }],
        products: [...CATALOG.products, TEST] })),
      http.get(`${A}/courses/class12_test/delete-check`, () => HttpResponse.json({
        entitlement: "class12_test", class_level: 12, subject: "test", blockers: ["3 students bought it and can still open it: switch it off instead (they keep it)."],
        products: ["class12_test"], batches: [], banners: [], folder: "videos/class_12/Test/", files: 2, bytes: 10,
      })),
    );
    const { user } = renderApp("/courses?tab=prices");
    const table = await screen.findByRole("table", { name: "Courses on sale" }, { timeout: 5000 });
    await user.click(within(table).getByRole("button", { name: "Delete Class 12 Test" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete Class 12 Test?" });
    expect(await within(dialog).findByText("3 students bought it and can still open it: switch it off instead (they keep it).")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Delete for good" })).toBeDisabled();
    expect(called("POST", "/courses/class12_test/delete")).toHaveLength(0);
  });

  it("launches a course as free", async () => {
    useApi();
    server.use(http.put(`${A}/catalog`, () => HttpResponse.json({ catalog: { ...CATALOG, source: "db", version: 1 }, summary: {} })));
    const { user } = renderApp("/courses?tab=prices");
    await user.click(await screen.findByRole("button", { name: "+ New course" }, { timeout: 5000 }));
    const dialog = await screen.findByRole("dialog", { name: "New course" });
    await user.selectOptions(within(dialog).getByLabelText("Class"), "11");
    await user.type(within(dialog).getByLabelText("Name"), "Class 11 Physics");
    expect(within(dialog).getByRole("radio", { name: "Paid" })).toBeChecked();
    await user.click(within(dialog).getByRole("radio", { name: "Free" }));
    expect(within(dialog).queryByLabelText("Price (₹, Android and web)")).not.toBeInTheDocument();
    expect(within(dialog).queryByLabelText("App Store product id (optional)")).not.toBeInTheDocument();
    expect(dialog).toHaveTextContent("Every lecture is open to every student");
    expect(within(dialog).queryByLabelText("Access validity")).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Add" }));
    const table = screen.getByRole("table", { name: "Courses on sale" });
    const row = within(table).getByText("Class 11 Physics").closest("tr")!;
    expect(within(row).getByText("Free")).toBeInTheDocument();
    expect(within(row).queryByLabelText(/Price of Class 11 Physics/)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save to the app" }));
    const confirm = await screen.findByRole("dialog", { name: "Save to the app?" });
    expect(confirm).toHaveTextContent("New: Class 11 Physics (free)");
    await user.click(within(confirm).getByRole("button", { name: "Save" }));
    await screen.findByText(/Saved \(version 1\)/);
    const body = called("PUT", "/catalog")[0]!.body as { products: { id: string; free?: boolean; price_inr: number; ios_product_id: string | null }[] };
    expect(body.products.find((x) => x.id === "class11_physics")).toMatchObject({ free: true, price_inr: 0, ios_product_id: null });
  });

  it("gives a new course its own access validity and launch time", async () => {
    useApi();
    server.use(http.put(`${A}/catalog`, () => HttpResponse.json({ catalog: { ...CATALOG, source: "db", version: 1 }, summary: {} })));
    const { user } = renderApp("/courses?tab=prices");
    await user.click(await screen.findByRole("button", { name: "+ New course" }, { timeout: 5000 }));
    const dialog = await screen.findByRole("dialog", { name: "New course" });
    await user.selectOptions(within(dialog).getByLabelText("Class"), "11");
    await user.type(within(dialog).getByLabelText("Name"), "Class 11 Physics");
    const price = within(dialog).getByLabelText("Price (₹, Android and web)");
    await user.clear(price);
    await user.type(price, "199");
    const validity = within(dialog).getByLabelText("Access validity");
    expect(validity).toHaveValue("182");
    await user.selectOptions(validity, "custom");
    const days = within(dialog).getByLabelText("Access validity in days");
    await user.type(days, "0");
    await user.click(within(dialog).getByRole("button", { name: "Add" }));
    expect(dialog).toHaveTextContent("Access validity must be 1 to 3650 days.");
    await user.selectOptions(validity, "365");
    expect(within(dialog).queryByLabelText("Access validity in days")).not.toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText("Opens for sale (IST, optional)"), { target: { value: "2099-12-01T10:00" } });
    await user.click(within(dialog).getByRole("button", { name: "Add" }));
    const table = screen.getByRole("table", { name: "Courses on sale" });
    const row = within(table).getByText("Class 11 Physics").closest("tr")!;
    expect(row).toHaveTextContent("Access 1 year per purchase");
    expect(within(row).getByText(/^Opens 1 Dec 2099/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save to the app" }));
    const confirm = await screen.findByRole("dialog", { name: "Save to the app?" });
    await user.click(within(confirm).getByRole("button", { name: "Save" }));
    await screen.findByText(/Saved \(version 1\)/);
    const body = called("PUT", "/catalog")[0]!.body as { products: { id: string; access_days?: number | null; sale_starts_at?: string | null }[] };
    expect(body.products.find((x) => x.id === "class11_physics")).toMatchObject({ access_days: 365, sale_starts_at: "2099-12-01T10:00:00+05:30" });
    // A course from the app's code keeps the app's default length unless it is changed.
    const acc = body.products.find((x) => x.id === "class12_accountancy")!;
    expect([acc.access_days ?? null, acc.sale_starts_at ?? null]).toEqual([null, null]);
  });

  it("is owner only", async () => {
    useApi();
    renderApp("/courses?tab=prices", "viewer");
    expect(await screen.findByText("Only the owner can change the app's courses and prices.")).toBeInTheDocument();
    expect(called("GET", "/status")).toHaveLength(0);
  });
});
