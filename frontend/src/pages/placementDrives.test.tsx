// Placement Drives page (mocked with MSW). Drives and results come from the AdhyaapakAI
// backend's admin API (/api/admin/placement, x-admin-secret), like Voucher Management; the
// dashboard's own server only reads PDFs and makes the Excel file (/api/v1/placement-drives).

import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it } from "vitest";
import { axeViolations } from "../test/a11y";
import { renderApp } from "../test/render";
import { requests, server } from "../test/server";
import { adminSecret } from "./vouchers/adminApi";

const SECRET = "test-admin-secret";
const A = "*/api/admin/placement"; // the app's admin API
const D = "*/api/v1/placement-drives"; // the dashboard's own server: parse-pdf, xlsx
const DRIVE = {
  date: "2026-12-02", open_from: "2026-12-01", exam: "Placement Drive", label: "Placement Drive",
  full_name: "Placement Drive - December", duration_min: 25, marking: { correct: 1, wrong: 0 }, question_count: 2,
  active: false, audience_all: true, audience_count: 0, has_access_code: true, has_sheet_key: false,
  opened: 0, submitted: 0, locked: false, updated_at: "2026-11-30T06:00:00Z",
};
const QUESTIONS = [
  { section: "SQL", question: "Which command reads rows?", options: ["INSERT", "SELECT", "UPDATE", "DELETE"], correct_answer: 1, explanation: "" },
  { section: "DBMS", question: "Which normal form?", options: ["1NF", "2NF", "3NF", "BCNF"], correct_answer: 1, explanation: "" },
];
const DETAIL = { ...DRIVE, emails: [], sections: [{ subject: "SQL", count: 1 }, { subject: "DBMS", count: 1 }], questions: QUESTIONS };
const PARSED = {
  title: "Placement Drive Assessment",
  answer_key_found: false,
  warnings: [],
  questions: [
    { ...QUESTIONS[0], needs_review: false, review_notes: [] },
    { ...QUESTIONS[1], correct_answer: null, needs_review: true, review_notes: ["No answer found. Pick the correct option."] },
  ],
};
const RESULTS = {
  drive: { ...DRIVE, active: true, opened: 2, submitted: 1, locked: true },
  fields: ["candidate_name", "roll_number", "college", "account_name", "email", "phone", "status", "score", "max_score",
    "percentage", "correct", "wrong", "skipped", "app_switches", "flagged", "late", "time_taken_min", "started_ist", "submitted_ist", "Q1", "Q2"],
  rows: [
    { candidate_name: "Asha Rao", roll_number: "21CS042", college: "ABC", account_name: "Asha", email: "a@x.com", phone: "9876543210",
      status: "submitted", score: 2, max_score: 2, percentage: 100, correct: 2, wrong: 0, skipped: 0, app_switches: 1, flagged: false,
      late: false, time_taken_min: 10, started_ist: "2026-12-01 10:00:00", submitted_ist: "2026-12-01 10:10:00", Q1: "B", Q2: "B" },
    { candidate_name: "Bina Shah", roll_number: "21CS050", college: "ABC", account_name: "Bina", email: "b@x.com", phone: "",
      status: "opened, not submitted", score: "", max_score: "", percentage: "", correct: "", wrong: "", skipped: "", app_switches: "",
      flagged: "", late: "", time_taken_min: "", started_ist: "2026-12-01 10:05:00", submitted_ist: "", Q1: "", Q2: "" },
  ],
  answer_key: { candidate_name: "ANSWER KEY", max_score: 2, Q1: "B", Q2: "B" },
  summary: { opened: 2, submitted: 1, not_submitted: 1, not_started: 0, average_score: 2, highest_score: 2 },
};
const called = (method: string, path: string) =>
  requests.filter((r) => r.method === method && r.url.pathname === `/api/admin/placement${path}`);
const calledDashboard = (method: string, path: string) =>
  requests.filter((r) => r.method === method && r.url.pathname === `/api/v1/placement-drives${path}`);

beforeEach(() => adminSecret.set(SECRET));

function useApi(drives: object[] = [DRIVE]) {
  server.use(
    http.get(`${A}/status`, () => HttpResponse.json({ configured: true, database: "doubt_solver_app", multiple: false })),
    http.get(`${A}/drives`, () => HttpResponse.json({ drives })),
    http.get(`${A}/drives/:day`, () => HttpResponse.json(DETAIL)),
    http.get(`${A}/results`, () => HttpResponse.json(RESULTS)),
  );
}

describe("placement drives", () => {
  it("lists drives and turns one on after confirming", async () => {
    useApi();
    server.use(http.post(`${A}/drives/:day/active`, () => HttpResponse.json({ ...DRIVE, active: true })));
    const user = userEvent.setup();
    renderApp("/placement-drives");

    const table = await screen.findByRole("table", { name: "Placement drives" }, { timeout: 5000 });
    const row = within(table).getByRole("row", { name: /Placement Drive - December/ });
    expect(row).toHaveTextContent("1 Dec 2026 → 2 Dec 2026");
    expect(row).toHaveTextContent("25 min");
    expect(row).toHaveTextContent("Off");
    expect(row).toHaveTextContent("Code set");
    expect(await axeViolations()).toEqual([]);

    await user.click(within(row).getByRole("button", { name: "Turn on Placement Drive (2026-12-02)" }));
    const dialog = await screen.findByRole("dialog", { name: "Turn this drive on?" });
    await user.click(within(dialog).getByRole("button", { name: "Turn on" }));

    await waitFor(() => expect(called("POST", "/drives/2026-12-02/active")).toHaveLength(1));
    const req = called("POST", "/drives/2026-12-02/active")[0]!;
    expect(req.body).toEqual({ active: true });
    expect(req.credentials).not.toBe("include");
  });

  it("deletes a drive that is off and never opened, after confirming", async () => {
    useApi([DRIVE, { ...DRIVE, date: "2026-11-14", active: true, opened: 7, submitted: 7, locked: true }]);
    server.use(http.delete(`${A}/drives/:day`, () => new HttpResponse(null, { status: 204 })));
    const user = userEvent.setup();
    renderApp("/placement-drives");

    const table = await screen.findByRole("table", { name: "Placement drives" }, { timeout: 5000 });
    // A drive students have opened has no Delete: its results need it.
    expect(within(table).queryByRole("button", { name: "Delete Placement Drive (2026-11-14)" })).not.toBeInTheDocument();
    await user.click(within(table).getByRole("button", { name: "Delete Placement Drive (2026-12-02)" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete this drive?" });
    expect(dialog).toHaveTextContent("can't be undone");
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(called("DELETE", "/drives/2026-12-02")).toHaveLength(1));
  });

  it("says when the app database is not configured, without asking for drives", async () => {
    server.use(http.get(`${A}/status`, () => HttpResponse.json({ configured: false, database: null, multiple: false })));
    renderApp("/placement-drives");
    expect(await screen.findByText("Placement drives are not configured.", {}, { timeout: 5000 })).toBeInTheDocument();
    expect(called("GET", "/drives")).toHaveLength(0);
  });

  it("asks for the admin secret first and sends it as x-admin-secret", async () => {
    useApi();
    adminSecret.clear();
    const seen: (string | null)[] = [];
    server.use(http.get(`${A}/status`, ({ request }) => {
      seen.push(request.headers.get("x-admin-secret"));
      return request.headers.get("x-admin-secret") === SECRET
        ? HttpResponse.json({ configured: true, database: "doubt_solver_app", multiple: false })
        : HttpResponse.json({ detail: "Forbidden" }, { status: 403 });
    }));
    const user = userEvent.setup();
    renderApp("/placement-drives");
    expect(await screen.findByRole("heading", { name: "Unlock Placement Drives" }, { timeout: 5000 })).toBeInTheDocument();
    await user.type(screen.getByLabelText("Admin secret"), "wrong");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByText("That admin secret was not accepted.")).toBeInTheDocument();
    await user.clear(screen.getByLabelText("Admin secret"));
    await user.type(screen.getByLabelText("Admin secret"), SECRET);
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByRole("table", { name: "Placement drives" }, { timeout: 5000 })).toBeInTheDocument();
    expect(seen).toContain(SECRET);
    // Nothing goes to the dashboard's own server: it has no keys to the app's database.
    expect(requests.some((r) => r.url.pathname.startsWith("/api/v1/placement-drives"))).toBe(false);
  });

  it("is hidden from a viewer's menu", async () => {
    adminSecret.clear();
    renderApp("/placement-drives", "viewer");
    expect(await screen.findByRole("heading", { name: "Unlock Placement Drives" }, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Placement Drives" })).not.toBeInTheDocument();
  });

  it("reads a PDF, makes the admin pick a missing answer, then creates the drive", async () => {
    useApi([]);
    server.use(
      http.post(`${D}/parse-pdf`, () => HttpResponse.json(PARSED)),
      http.post(`${A}/drives`, async ({ request }) => {
        const body = (await request.json()) as { date: string };
        return HttpResponse.json({ drive: { ...DETAIL, date: body.date }, sheet_key: null, sheet_formula: null }, { status: 201 });
      }),
    );
    const user = userEvent.setup();
    renderApp("/placement-drives");
    await user.click(await screen.findByRole("button", { name: /New drive/ }, { timeout: 5000 }));

    await user.clear(screen.getByLabelText("Last day"));
    await user.type(screen.getByLabelText("Last day"), "2026-12-02");
    await user.type(screen.getByLabelText("Access code (empty = no code)"), "HIRE2026");
    const pdf = new File(["%PDF-1.4 test"], "paper.pdf", { type: "application/pdf" });
    await user.upload(screen.getByLabelText("Question paper file"), pdf);

    expect(await screen.findByText(/Read 2 questions from paper.pdf/)).toBeInTheDocument();
    const upload = calledDashboard("POST", "/parse-pdf")[0]!; // read on the dashboard's server
    expect(upload.csrf).toBeTruthy();
    expect(screen.getByLabelText("Full name")).toHaveValue("Placement Drive Assessment");
    const q2 = screen.getByRole("group", { name: "Question 2" });
    expect(q2).toHaveTextContent("No answer found. Pick the correct option.");

    await user.click(screen.getByRole("button", { name: "Create drive" }));
    expect(await screen.findByText("Q2: Pick the correct answer.")).toBeInTheDocument();
    expect(called("POST", "/drives")).toHaveLength(0);

    await user.click(within(q2).getByRole("radio", { name: "C is correct" }));
    await user.click(screen.getByRole("button", { name: "Create drive" }));

    await waitFor(() => expect(called("POST", "/drives")).toHaveLength(1));
    const body = called("POST", "/drives")[0]!.body as Record<string, unknown>;
    expect(body).toMatchObject({ date: "2026-12-02", access_code: "HIRE2026", audience: { all: true, emails: [] }, active: false });
    expect((body.questions as { correct_answer: number }[]).map((q) => q.correct_answer)).toEqual([1, 2]);
    expect(await screen.findByText("Drive created.")).toBeInTheDocument();
    expect(await screen.findByText("No drives yet")).toBeInTheDocument(); // back on the list
  });

  it("shows a new sheet key once, with the Google Sheets formula", async () => {
    useApi();
    server.use(
      http.get(`${A}/sheet-key`, () => HttpResponse.json({ sheet_key: "k".repeat(40) })),
      http.put(`${A}/drives/:day`, () =>
        HttpResponse.json({ drive: { ...DETAIL, has_sheet_key: true }, sheet_key: "k".repeat(40), sheet_formula: `=IMPORTDATA("x&key=${"k".repeat(40)}")` }),
      ),
    );
    const user = userEvent.setup();
    renderApp("/placement-drives");
    await user.click(await screen.findByRole("button", { name: "Edit Placement Drive (2026-12-02)" }, { timeout: 5000 }));
    await user.click(await screen.findByRole("button", { name: "Make a sheet key" }));
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    const dialog = await screen.findByRole("dialog", { name: "Live sheet key" });
    expect(dialog).toHaveTextContent("k".repeat(40));
    expect(dialog).toHaveTextContent("=IMPORTDATA(");
    const body = called("PUT", "/drives/2026-12-02")[0]!.body as Record<string, unknown>;
    expect(body.sheet_key).toBe("k".repeat(40));
    expect(body.access_code).toBeNull(); // empty field: keep the stored code
  });

  it("aims an everyone drive at classes, streams and goals", async () => {
    useApi();
    server.use(
      http.get("*/api/academics/classes", () => HttpResponse.json({
        open: [11, 12], with_content: [11, 12],
        classes: [{ level: 11, name: "Class 11" }, { level: 12, name: "Class 12" }],
        streams: [{ key: "Science", name: "Science (PCM/PCB)", active: true }, { key: "Commerce", name: "Commerce", active: true }],
        goals: [{ key: "Board Exams", name: "Board Exams", active: true, streams: ["Science", "Commerce"] },
          { key: "NEET", name: "NEET", active: true, streams: ["Science"] },
          { key: "CA Foundation", name: "CA Foundation", active: true, streams: ["Commerce"] }],
      })),
      http.put(`${A}/drives/:day`, () => HttpResponse.json({ drive: DETAIL, sheet_key: null, sheet_formula: null })),
    );
    const user = userEvent.setup();
    const { container } = renderApp("/placement-drives");
    await user.click(await screen.findByRole("button", { name: "Edit Placement Drive (2026-12-02)" }, { timeout: 5000 }));
    const classes = await screen.findByRole("group", { name: "Classes" });
    await user.click(within(classes).getByRole("checkbox", { name: "Class 12" }));
    await user.click(within(screen.getByRole("group", { name: "Streams" })).getByRole("checkbox", { name: "Science (PCM/PCB)" }));
    const goals = screen.getByRole("group", { name: "Goals" });
    expect(within(goals).queryByRole("checkbox", { name: "CA Foundation" })).not.toBeInTheDocument(); // Commerce only
    await user.click(within(goals).getByRole("checkbox", { name: "NEET" }));
    expect(screen.getByText(/Shown to: Class 12 · Science \(PCM\/PCB\) · NEET/)).toBeInTheDocument();
    expect(await axeViolations(container)).toEqual([]);
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(called("PUT", "/drives/2026-12-02")).toHaveLength(1));
    expect((called("PUT", "/drives/2026-12-02")[0]!.body as Record<string, unknown>).audience).toEqual(
      { all: true, emails: [], classes: [12], streams: ["Science"], goals: ["NEET"] });
  });

  it("drops a goal when its only stream is unticked, and an email list carries no classes", async () => {
    useApi();
    server.use(
      http.get("*/api/academics/classes", () => HttpResponse.json({
        open: [12], with_content: [12], classes: [{ level: 12, name: "Class 12" }],
        streams: [{ key: "Science", name: "Science", active: true }, { key: "Commerce", name: "Commerce", active: true }],
        goals: [{ key: "NEET", name: "NEET", active: true, streams: ["Science"] },
          { key: "CA Foundation", name: "CA Foundation", active: true, streams: ["Commerce"] }],
      })),
      http.put(`${A}/drives/:day`, () => HttpResponse.json({ drive: DETAIL, sheet_key: null, sheet_formula: null })),
    );
    const user = userEvent.setup();
    renderApp("/placement-drives");
    await user.click(await screen.findByRole("button", { name: "Edit Placement Drive (2026-12-02)" }, { timeout: 5000 }));
    const streams = await screen.findByRole("group", { name: "Streams" });
    await user.click(within(streams).getByRole("checkbox", { name: "Science" }));
    await user.click(within(screen.getByRole("group", { name: "Goals" })).getByRole("checkbox", { name: "NEET" }));
    await user.click(within(streams).getByRole("checkbox", { name: "Commerce" }));
    await user.click(within(streams).getByRole("checkbox", { name: "Science" })); // NEET goes with it
    expect(screen.getByText(/Shown to: every class · Commerce · every goal/)).toBeInTheDocument();
    await user.click(screen.getByLabelText("Only these emails"));
    expect(screen.queryByRole("group", { name: "Streams" })).not.toBeInTheDocument();
    await user.type(screen.getByLabelText(/Emails \(/), "a@b.co");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(called("PUT", "/drives/2026-12-02")).toHaveLength(1));
    expect((called("PUT", "/drives/2026-12-02")[0]!.body as Record<string, unknown>).audience).toEqual(
      { all: false, emails: ["a@b.co"], classes: [], streams: [], goals: [] });
  });

  it("locks the paper once students have started, and keeps it on save", async () => {
    useApi([{ ...DRIVE, locked: true, opened: 3 }]);
    server.use(
      http.get(`${A}/drives/:day`, () => HttpResponse.json({ ...DETAIL, locked: true, opened: 3 })),
      http.put(`${A}/drives/:day`, () => HttpResponse.json({ drive: { ...DETAIL, locked: true }, sheet_key: null, sheet_formula: null })),
    );
    const user = userEvent.setup();
    renderApp("/placement-drives");
    await user.click(await screen.findByRole("button", { name: "Edit Placement Drive (2026-12-02)" }, { timeout: 5000 }));

    expect(await screen.findByText(/questions, answers and marking are locked/)).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Question 1" })).toBeDisabled();
    expect(screen.getByLabelText("Last day")).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Upload PDF or JSON" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(called("PUT", "/drives/2026-12-02")).toHaveLength(1));
    expect((called("PUT", "/drives/2026-12-02")[0]!.body as Record<string, unknown>).questions).toBeNull();
  });

  it("shows live results with a summary, search and downloads", async () => {
    useApi([{ ...DRIVE, active: true, opened: 2, submitted: 1, locked: true }]);
    const user = userEvent.setup();
    renderApp("/placement-drives");
    await user.click(await screen.findByRole("tab", { name: "Results" }, { timeout: 5000 }));

    const table = await screen.findByRole("table", { name: "Results for Placement Drive (2026-12-02)" });
    expect(within(table).getAllByRole("row")).toHaveLength(3);
    expect(screen.getByRole("region", { name: "Submitted" })).toHaveTextContent("1");
    expect(screen.getByRole("region", { name: "Not submitted" })).toHaveTextContent("1");
    expect(screen.getByRole("region", { name: "Highest score" })).toHaveTextContent("2");
    expect(screen.getByText(/Answer key: Q1 B · Q2 B/)).toBeInTheDocument();

    await user.type(screen.getByLabelText("Search"), "21CS050");
    expect(within(table).getAllByRole("row")).toHaveLength(2);
    expect(table).toHaveTextContent("Bina Shah");

    const saved: string[] = [];
    const secrets: (string | null)[] = [];
    URL.createObjectURL = () => "blob:x";
    URL.revokeObjectURL = () => undefined;
    const TABLE = { file: "placement-drive-2026-01-01-to-2026-12-31", sheets: [{ name: "x", fields: ["candidate_name"], rows: [] }] };
    server.use(
      // The CSV comes straight from the app's backend, with the admin secret.
      http.get(`${A}/results/download`, ({ request }) => {
        saved.push(new URL(request.url).search);
        secrets.push(request.headers.get("x-admin-secret"));
        return new HttpResponse("a,b\n", { headers: { "Content-Disposition": 'attachment; filename="placement-drive-2026-12-02.csv"' } });
      }),
      // Excel: the table from the app's backend, made into a file by the dashboard's server.
      http.get(`${A}/results/sheet`, ({ request }) => {
        saved.push(new URL(request.url).search);
        return HttpResponse.json(TABLE);
      }),
      http.post(`${D}/xlsx`, () => new HttpResponse("xlsx", { headers: { "Content-Disposition": 'attachment; filename="x.xlsx"' } })),
    );
    await user.click(screen.getByRole("button", { name: "Download CSV" }));
    await waitFor(() => expect(saved).toEqual(["?date=2026-12-02"]));
    expect(secrets).toEqual([SECRET]);
    await user.type(screen.getByLabelText("From"), "2026-01-01");
    await user.click(screen.getByRole("button", { name: "Excel" }));
    await waitFor(() => expect(calledDashboard("POST", "/xlsx")).toHaveLength(1));
    expect(saved[1]).toMatch(/^\?start=2026-01-01&end=\d{4}-\d{2}-\d{2}$/);
    const xlsx = calledDashboard("POST", "/xlsx")[0]!;
    expect(xlsx.body).toEqual(TABLE);
    expect(xlsx.csrf).toBeTruthy();
  });
});
