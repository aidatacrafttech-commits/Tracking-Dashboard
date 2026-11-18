# Placement Drives

> **Since 2026-11-18** the dashboard has no keys to the app's database or storage: everything below runs in the AdhyaapakAI backend's admin API (`/api/admin/...`, `x-admin-secret`) and its settings are that backend's `.env`. The dashboard's own audit log no longer records these changes (the backend logs them). Where older wording below says "the dashboard" reads or writes the database, read "the admin API".

Manage the AdhyaapakAI app's placement drives from this dashboard (nav: **Placement Drives**,
route `/placement-drives`, **owner only**):

- create a drive from a PDF or JSON paper, check every question, set its dates, audience and code
- turn a drive on or off
- see live results
- download any drive's or any dates' results as CSV or Excel

Nothing in the AdhyaapakAI repository changes. The app already reads its drives from MongoDB
(`placement_drives`), and this dashboard writes the same documents that the app's
`scripts/placement_drive.py load` writes. Students see a drive saved here exactly as they see
one loaded by the script: the Placement Drive card on the Tests tab, the code, the paper and the
timer. The app's `/sheet` Google Sheet link and its `/admin/results` CSV keep working unchanged.

## Through the AdhyaapakAI backend's admin API (since 2026-11-18)

The dashboard no longer reads or writes the app's database for placement drives. Like
**Voucher Management**, the screen opens behind **Unlock Placement Drives** (the backend's
`ADMIN_SECRET`, typed into the tab, kept only in `sessionStorage`) and calls the AdhyaapakAI
backend's `routes/admin_placement.py`, `/api/admin/placement/...`, with `x-admin-secret`:

- `status`, `drives` (GET/POST), `drives/{day}` (GET/PUT/DELETE), `drives/{day}/active`,
  `sheet-key`, `results?date=`, `results/download?date=|start&end` (the CSV, exactly the
  app's), `results/sheet?date=|start&end` (the same table as JSON).
- The rules (`services/admin_placement.py`, `services/admin_placement_paper.py`) are the ones
  described below, moved into the app with their tests (`tests/test_admin_placement.py`).
  Several drives at once: the app's `ADMIN_PLACEMENT_MULTIPLE` (default off).
- Two things stay on the dashboard's own server, neither touching the app: **reading a PDF**
  (`POST /api/v1/placement-drives/parse-pdf`) and **making the Excel file** from the table
  `results/sheet` returns (`POST /api/v1/placement-drives/xlsx`, owner only; values written
  as data, never formulas; nothing kept).
- Saves are logged by the app's backend (drive date and action only). The dashboard's audit
  log no longer records them.
- Live needs the app backend with `routes/admin_placement.py` deployed and the reverse proxy
  forwarding `/api/admin/` to it (like `/api/vouchers/`, see docs/VOUCHERS.md).
- Checked on 2026-11-18 against the local test database: the drive list, each drive, its
  results, its CSV and a date-range CSV are the same through the admin API as through the
  dashboard's earlier direct path.

The earlier direct path and the dashboard's database keys were removed on 2026-11-18. The
sections below describe the rules, which now run in the admin API.

## How it connects

```
browser ──(owner session)──▶ dashboard backend /api/v1/placement-drives/*
                                  │  reads and writes, maxTimeMS 10 s, primary, w=majority
                                  ▼
                             MongoDB (the AdhyaapakAI backend's MONGO_URL / DB_NAME, as App Users)
```

| Collection | What the dashboard does |
| --- | --- |
| `placement_drives` | Reads; creates, edits, turns on and off, and deletes drives |
| `placement_drive_unlocks`, `placement_drive_code_tries` | Changes `drive_date` only when a drive's last day changes before anyone has opened it (codes typed in already move with it); deleted with their drive |
| `placement_drive_attempts`, `users` | Reads only (results) |

- **Access code and sheet key:** stored only as hashes. The hashes are the app's own
  `hash_code` (SHA-256 of the code with spaces removed, upper-cased) and `hash_sheet_key`
  (SHA-256 of the trimmed key). A test pins both, so a code set here works in the app. The
  plain sheet key is shown **once**, right after it's set, with its `=IMPORTDATA(...)` formula.
  It is never returned again.
- **Answer keys and student details** only leave the server through these owner-only
  endpoints. The dashboard's audit log records each create, edit and on/off, never the code,
  the key or student data.
- **The PDF** is read in memory and dropped. Nothing is stored.
- **Shared rules:** the rules the app depends on are copied from the app's backend into
  `backend/app/services/placement_paper.py`, which says so at the top:
  - paper validation (the script's `validate`, plus duration and marking checks)
  - the hashes
  - `results_rows`, the column list and the CSV
  
  If the app ever changes them, change them here too.

### Database user

The URL in the AdhyaapakAI backend's `MONGO_URL` must be allowed to write those three collections. A
read-only user still shows the drives and results, but saving fails with "The app database
refused the dashboard's login, or it may only read".

Least privilege in Atlas is a custom role with:
- `find` on the database
- `insert` and `update` on `placement_drives`
- `update` on `placement_drive_unlocks` and `placement_drive_code_tries`

## Running a drive

1. **Placement Drives → New drive.**
2. **Questions:** upload the paper.
   - **PDF:** at most 10 MB, with real text (a scanned image can't be read). The reader finds:
     - numbered questions (`1.`, `Q1.`, `1)`)
     - options `A)`…`D)` (also `(a)`, `A.`, or all four on one line)
     - section headings (`Section A: SQL`)
     - `Answer: B` and `Explanation: …` lines
     - an **Answer Key** block at the end (`1-B 2-C`, `1. B`, `Q1: B`)
   - **JSON:** the app's format (`backend/data/placement_drive_*.json`). It also fills the
     label, full name, duration and marking.
3. **Check every question.** Questions the reader isn't sure about are marked **Check**, with
   the reason. Common reasons:
   - not four options
   - no answer in the PDF
   - an answer key that disagrees with the question
   - a skipped number
   - a question before the first section
   
   Edit any text, section or answer. Use the arrows to reorder and **+ Add below** / **Delete**
   to add or remove questions. "Show only questions to check" hides the rest. Editing a
   question, or pressing **Looks right**, clears its mark. You can't save until every question
   has text, a section, four options and a chosen answer.
4. **Details:**
   - **Label:** shown on the app's card.
   - **Full name**
   - **First day:** optional. Leave it empty for a one-day drive.
   - **Last day**
   - **Duration** in minutes.
   - **Marks:** for a correct answer and a wrong answer (0 or negative).
   - **Who:** everyone, or a list of emails. Paste the list, or add it from a `.txt` or `.csv` file.
   - **Access code:** optional, at least 4 characters. Case and spaces don't matter.
5. **Live sheet (optional):** press **Make a sheet key**, then save. Copy the formula from the
   dialog into cell A1 of a Google Sheet, and share the sheet only with the people who need it.
6. **Turn it on:** tick "Turn it on when saved", or use **Turn on** in the list later.
   - By default only one drive can be on for any day, because the live AdhyaapakAI backend
     opens the first drive it finds. Turning on a drive whose days overlap another drive that
     is on is refused, with the other drive's name.
   - With the AdhyaapakAI backend's `ADMIN_PLACEMENT_MULTIPLE=true`, several drives can be on together, and the app
     shows one card per drive, one below the other. That needs the AdhyaapakAI backend whose
     `/today` lists every open drive (`drives`). An app version without the card list shows
     them one after another instead: after a student submits one, the next takes its place.
     Set it only once that backend is live.

Days are whole days in India time. A drive is open from 00:00 IST on its first day until
midnight at the end of its last day.

### What can change after students start

As soon as one student opens the paper, the drive is **locked**:

- **Stays fixed:** the questions, answers, sections and marking. Students' answers are scored
  against them. The last day is also fixed, because attempts and the sheet link are keyed by
  it. The dashboard refuses these changes with a message (409) and shows the paper read-only.
- **Can still change:** the first day, audience, code, sheet key, label, duration and on/off.

To change a locked paper, turn the drive off and create a new one with another last day.

### Deleting a drive

**Delete** (in the list) removes a drive from the app's database for good, after a
confirmation. It is offered only for a drive that **nobody has opened**, and only once the
drive is **off**. A drive with attempts can't be deleted, because its results and answer key
depend on it. Turn it off instead; its results are kept. Codes students typed for a deleted
drive are deleted with it, so a later drive on the same day starts clean.

## Results

**Results** tab: pick a drive.

- **Summary:** opened, submitted, not submitted, average and highest score. With an email
  audience, the summary also shows "not started", for invited emails with no attempt.
- **Table:** the same columns, in the same order, as the app's CSV and Google Sheet:
  `candidate_name`, `roll_number`, `college`, `account_name`, `email`, `phone`, `status`,
  `score`, `max_score`, `percentage`, `correct`, `wrong`, `skipped`, `app_switches`, `flagged`,
  `late`, `time_taken_min`, `started_ist`, `submitted_ist`, `Q1`…`Qn`.
- **Filtering:** search by name, email or roll number, filter by status, and sort by score.
  The answer key is listed under the table.
- **Live:** refreshes every 30 seconds while the tab is visible, or straight away with
  **Refresh**. Results are read directly from the database, so there is no Google Sheets
  one-hour delay.
- **Download:** CSV or Excel for the drive shown, named `placement-drive-<date>.csv` / `.xlsx`.
  - The CSV is byte-for-byte the app's CSV, ending with the `ANSWER KEY` row.
  - The Excel file has the same rows. Every cell is written as text or a number, never a
    formula, so a name typed as `=...` stays text.
- **Download by date:** every drive whose last day falls in the chosen dates, at most 92
  days. You get one file with a `drive_date` column first, and each drive ends with its
  `ANSWER KEY` row. The file is named `placement-drive-<from>-to-<to>.csv` / `.xlsx`.

## API (owner only; `{day}` = the drive's last day, YYYY-MM-DD)

| Method | Path | Returns |
| --- | --- | --- |
| GET | `/api/admin/placement/status` | `{configured, database, multiple}`. Never contacts MongoDB. |
| GET | `/api/admin/placement/drives` | `{drives: [...]}` with: label, `open_from`, `date`, duration, `question_count`, active, audience, `has_access_code`, `has_sheet_key`, opened, submitted, `locked`. Newest last day first. |
| GET | `/api/admin/placement/drives/{day}` | One drive, with its paper (answers included), sections and audience emails |
| POST | `/api/admin/placement/drives` | Creates a drive (201). It is off unless `active: true`. Fields: label, `full_name`, exam, `open_from`, `date`, `duration_min`, `marking`, `audience`, `access_code`, `sheet_key`, `sections` (optional; worked out from the questions), `questions` |
| PUT | `/api/admin/placement/drives/{day}` | Edits a drive. For `questions`, `access_code` and `sheet_key`, `null` keeps what's stored and `""` removes the code or key. |
| POST | `/api/admin/placement/drives/{day}/active` | `{active}`: turns the drive on or off |
| DELETE | `/api/admin/placement/drives/{day}` | Deletes a drive that is off and that nobody has opened (204), with its unlocks and code tries |
| GET | `/api/admin/placement/sheet-key` | A new random key. Nothing is saved. |
| POST | `/api/v1/placement-drives/parse-pdf` | Body: the PDF (`Content-Type: application/pdf`). Returns `{title, questions[{section, question, options, correct_answer\|null, explanation, needs_review, review_notes}], answer_key_found, warnings}`. Nothing is saved. |
| GET | `/api/admin/placement/results?date=` | `{drive, fields, rows, answer_key, summary}` |
| GET | `/api/admin/placement/results/download?date=&format=csv\|xlsx` or `?start=&end=&format=` | The file |

A create or edit that sets a sheet key also returns `sheet_key` and `sheet_formula`, once.

**Errors**

| Code | Status | When |
| --- | --- | --- |
| `placement_drives_not_configured` | 503 | the AdhyaapakAI backend's `MONGO_URL` / `DB_NAME` not set |
| `drive_invalid` | 422 | The paper fails the checks; `details.problems` lists each one (`Q3: correct_answer must be 0-3`, …) |
| `drive_exists` | 409 | Another drive already has that last day |
| `drive_overlap` | 409 | Another drive that is on covers some of the same days |
| `drive_locked` | 409 | Changing the paper, marking or last day after a student started |
| `drive_active`, `drive_has_attempts` | 409 | Deleting a drive that is on, or that students have opened |
| `pdf_required`, `pdf_too_large`, `pdf_unreadable` | 415, 413, 400 | The upload isn't a readable PDF of at most 10 MB |
| `placement_drives_timeout`, `placement_drives_forbidden`, `placement_drives_unreachable` | 504, 502, 502 | Database problems (no driver detail is shown) |

Request bodies may be up to 10 MB for `parse-pdf` and 4 MB for drives. Every other path keeps
`MAX_REQUEST_BYTES`. `deploy/nginx/api-cost-monitor.conf` raises `client_max_body_size` for the
same two paths only.

## Limits

- The PDF reader works on the text in the PDF, not on images, so a scanned paper must be typed
  in or converted first. Tables, two-column layouts and options written as images can come
  out jumbled; those questions are usually marked **Check**. Always review before saving.
- One drive per last day, the same as the app, whose results, sheet link and attempts are
  keyed by that day.
- The dashboard checks that dates overlap only for drives that are on. Two drives that are
  both off can share days.
