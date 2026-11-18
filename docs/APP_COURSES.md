# Courses & prices

> **Since 2026-11-18** the dashboard has no keys to the app's database or storage: everything below runs in the AdhyaapakAI backend's admin API (`/api/admin/...`, `x-admin-secret`) and its settings are that backend's `.env`. The dashboard's own audit log no longer records these changes (the backend logs them). Where older wording below says "the dashboard" reads or writes the database, read "the admin API".

Use **Course Management → Courses & prices** (owner only) to change what the AdhyaapakAI app
sells:

- add a new course (a subject's lectures from App videos),
- add a combo,
- change a name, line, badge, price or App Store product id,
- switch a product off sale,
- add, edit, reorder, hide or remove the course cards on the app's home screen, including the
  banner images.

The app picks up a save within about 30 seconds. No app build or deploy is needed once the
backend change below is live.

## Through the AdhyaapakAI backend's admin API (since 2026-11-18)

**Courses & prices** and **Classes, streams & goals** no longer touch the app's database or
storage from this dashboard. Like **Voucher Management**, the browser calls the AdhyaapakAI
backend's admin API, `/api/admin/catalog/...`, with the `x-admin-secret` header:

- The tabs open behind an **Unlock Course Management** screen. One admin secret (the
  backend's `ADMIN_SECRET`) unlocks this and Voucher Management in the tab; it's kept only in
  the tab (`sessionStorage`) and never in code, `.env` files or the build.
- The rules live in one place: the app's own `routes/admin_catalog.py` checks every save with
  its `build_catalog` / `build_classes` / `build_academics`, applies it to its worker at once
  (the others within 30 s), and returns `{detail, code, details}` errors the screens branch on
  (`catalog_changed`, `catalog_invalid`, `class_in_use`, `lists_in_use`, ...).
- Endpoints (all `x-admin-secret`): `status`, `catalog` (GET/PUT), `subjects`,
  `banners/uploads`, `banners/uploads/complete`, `banners/preview`,
  `courses/{id}/delete-check`, `courses/{id}/delete`, `academics`, `classes` (GET/PUT),
  `classes/{n}/delete-check`, `lists` (GET/PUT), `lists/delete-check`.
- The onboarding lists for card audiences and Placement Drives come from the app's public
  `GET /api/academics/classes` (no secret; nothing private).
- Which backend: `ADHYAAPAK_BACKEND_URL` in `frontend/.env` (dev proxy). Local
  `http://127.0.0.1:8001` works now. **Live** needs the AdhyaapakAI backend with
  `routes/admin_catalog.py` deployed, and the reverse proxy forwarding `/api/admin/catalog/`
  and `/api/academics/` to it (like `/api/vouchers/`, see docs/VOUCHERS.md). Pointed at live,
  every save changes production.
- Checked on 2026-11-18 against the local test database: the admin API and the dashboard's
  earlier direct path return the same catalogue, classes, streams/goals, academics and
  subjects.

**App videos** moved the same way (`/api/admin/videos/...`, the app's
`routes/admin_videos.py`), and so did **Placement Drives** (docs/PLACEMENT_DRIVES.md) and
**App Users** (docs/APP_USERS.md). The dashboard's earlier direct routes and its database and
storage keys were removed on 2026-11-18; the editor's languages and the three code courses'
built-in Course Details pages also come from the admin API now
(`GET /api/admin/catalog/details-defaults`, the app's `data/course_details_defaults.json`).

## How it works

The app's backend used to keep the catalogue in code (`backend/services/course_catalog.py`:
`PRODUCTS`, `COURSE_ENTITLEMENTS`, `BATCHES`). It now also reads one MongoDB document,
`course_catalog {_id: "current"}`:

- The document is layered on top of the code values, which stay as the fallback.
- With no document, the app behaves exactly as before.
- A document the app finds invalid is ignored as a whole, and the last good catalogue stays in
  use.
- Every app worker re-reads it every 30 seconds.
- The payment endpoints re-check it within 5 seconds.
- Before granting a course a worker doesn't know yet, the worker re-reads it first.

The dashboard writes that document through `PUT /api/admin/catalog/catalog`:

- **Same rules as the app.** It checks the document with the app's own `build_catalog`, copied
  as `backend/app/services/app_course_catalog.py` (unchanged except one import path). If the app
  changes that file, copy it again.
- **Version check.** A save names the version it was edited from. If someone saved in between,
  it's refused with 409 and you reload.
- **Audit log.** Every save goes to the audit log as `app_course_catalog.save`. The entry lists
  the version, new products, price changes and on/off switches.

**Rules (the app's, enforced on both sides):**

- **Never deleted, only switched off.** Products and courses are kept so old orders, refunds and
  purchase history still work. A product that is off isn't listed or sold, but its open orders
  still complete.
- **Grants are fixed.** What an existing product unlocks can't change.
- **One course, one product.** Every course has its own single-course product with the same id
  (for example `class11_physics`).
- **Coupons stay in code.** Coupon prices and `ACCESS_DAYS` (182 days) are still set in the app's
  code, because each coupon price needs its own App Store product. The screen shows them
  read-only.

**Prices and payments:**

- **When a price takes effect.** Android and the web charge `price_inr`. An order keeps the
  price and courses it was created with: if the price changes while a student is paying, their
  payment still unlocks the course.
- **iPhone.**
  - The price comes from the App Store product named in `ios_product_id`.
  - That product must exist in App Store Connect and RevenueCat; a code change can't create it.
  - With no App Store id, the course isn't sold on iPhone.
- **Banners.**
  - Images go to `batch-banners/` in the app's bucket, through the same storage keys as App
    videos, at 1200 × 520.
  - The dark-mode banner is optional. Without one, the light banner is used.

## Banners (any image, framed to fit)

**The app's card takes the banner's own shape.** This needs the app change in
`frontend/app/(tabs)/batches.tsx` (`BannerImage`, 2026-11-17):

- The card's image box gets the picture's width / height, so the whole picture shows, with no
  bands and nothing cut. The ratio is kept between 1 : 1 and 3.5 : 1.
- There is no zoom on the card.
- Older app builds still use a fixed **1200 × 520** box (`resizeMode="cover"`) with a slow 4%
  zoom. In those builds a picture of another shape is cut.

**Whole image as it is (the card takes its shape)** is the default in both the batch dialog and
App videos' course image:

- The picture is uploaded in its own shape, scaled down to at most 1600 pixels across. Nothing
  else is changed.
- A very tall picture (portrait) or a very wide one (over 3.5 : 1) gets a warning, because the
  card can't take that shape.
- For the older builds (or a classic banner), the other options frame the picture into
  1200 × 520:

- **Choose an image (any size):** you get a card-shaped preview that matches the app. A dashed
  safe line marks where text survives the zoom (5% from each edge).
- **Zoom, Left – right, Up – down:** drag the picture or use the sliders, at any size.
  - Zoom 100% just covers the card.
  - Above 100% crops more.
  - Below 100% shrinks the image on every side, down to half its "whole image" size. The space
    around it takes the colour of the image's edges, so nothing is cut.
- **Quick options:**
  - **Fill the card (crop):** zoom 100%, centred.
  - **Show the whole image:** the largest size with nothing cut.
  - **Whole image inside the dashed line:** a little smaller, so the app's zoom trims nothing
    either.
- **Status line under the preview:** says whether anything is cut, whether it is only outside
  the dashed line, or whether the whole image is inside it.
- **Blurry warning:** shown when the image would be enlarged more than 10%.
- **Use this banner:** the browser draws the JPEG (`bannerFit.ts`) and uploads it to
  `batch-banners/<batch>-<time>.jpg`. The JPEG is the whole picture in its own shape, or exactly
  1200 × 520 when framed.

### Optional banners, and deleting one

Both banners are optional, and each has a **Delete banner** / **Delete dark-mode banner** button:

- **No dark-mode banner:** dark mode shows the main banner.
- **No banner:** the card shows the course image from App videos (`banner_from_course`).
- **No banner and no course image:** allowed. The app shows the card's name on the banner navy
  (with the app change in `batches.tsx`; older builds show an empty box) until it gets a banner
  or a course image.
- **On save:** banner images in `batch-banners/` that no card uses any more (deleted or
  replaced) are deleted from S3. The app's own code banners (Accountancy, Economics, Commerce
  combo) are never deleted, because the code catalogue still uses them. A banner uploaded and
  deleted again before saving stays in S3.

### A card that shows the course image, live

In the batch dialog, tick **Use the course image from App videos** (`banner_from_course`). The
card then shows the subject's course image, the one App videos sets with **Change course image**:
`videos/class_N/<Subject>/<subject>_playlist_thumbnail.*`, the newest one if there are several.

- `/payments/batches` looks it up in S3 on every request, through the video list's 30-second S3
  cache, so replacing the course image updates the card by itself.
- The card's own banner is then optional. It is only a fallback while the subject has no course
  image.
- App videos frames the course image to the same 1200 × 520 with the banner editor, so it isn't
  cut on the card.
- AdhyaapakAI backend change (local, not deployed): `routes/payments.py` (`_course_image_key`,
  `_banner_urls`) and `course_catalog.build_catalog` (`banner_from_course`).

## Paid or free

**New course** and **Edit** offer **Course type: Paid / Free**. Free is offered for a single course
added from here; the app's code courses and combos can't be free.

A free course (`free: true`, `price_inr: 0`):
- **Lectures:** every lecture is open to every student (`has_course_access`), with no purchase
  and no end date.
- **Payment screen:** the course isn't listed (`catalogue_for`). Orders and vouchers for it are
  refused.
- **Home card:** shows as owned. In today's app build the card says "You own this course"; an
  app build can say "Free" instead. The card's class / stream / goals still decide who sees it.
- **Switched off:** a free course that is switched off closes again.

## Validity and launch time

**New course** and **Edit** also offer:

- **Access validity:** 3 months (91 days), 6 months (182 days, the default), 1 year (365 days), or
  a custom number of days from 1 to 3650. It isn't offered for a free course, which has no end
  date. It is saved as `access_days` on the product. Empty (`null`) means the app's
  `ACCESS_DAYS` (182).
  - It counts from each purchase. Buying again adds it from the current end date.
  - A Razorpay order stores the validity when it is made (`access_days` on the order). So a later
    change applies to new orders only.
  - App Store purchases (RevenueCat) and vouchers without their own validity use the course's
    validity.
  - The payment screen gets each course's `access_days`. An app build can show it.
- **Opens for sale (IST, optional):** the launch time, saved as `sale_starts_at` (UTC). Empty
  means the course goes on sale once saved. Before the launch time:
  - the course isn't listed on the payment screen;
  - orders are refused ("This course isn't open for purchase yet.");
  - its home-screen card is hidden;
  - a free course doesn't open.

  After it passes, the course goes on sale by itself, with no new save. The app re-checks the
  time on every request.

The Courses on sale table shows "Access 1 year per purchase" under each course, plus an
"Opens …" badge until launch. The save confirmation lists validity and launch changes.

## Deleting a course

**Delete** (next to **Edit**, only on courses added from this dashboard) removes a course for good,
**at any time** (the owner's choice, 2026-11-16):
- Students who bought it lose access at once.
- Vouchers for it stop working.
- Purchase records stay.

The app's code courses (Accountancy, Economics, Combo) can't be deleted, only switched off.

The confirmation lists what goes, and you must type the course id. Then:
1. **The catalogue loses the course.** The course, every product that sells it, and their cards
   are removed in one versioned save. The app stops listing them within about 30 seconds.
2. **S3 loses its files.** The cards' banners in `batch-banners/` go, unless another card uses
   them. So does **the subject's whole lecture folder** `videos/class_N/<Subject>/`: videos,
   demo videos, language copies and images. Nothing else is touched. The live app reads that
   folder too, and there is no undo.

Routes: `GET /api/admin/catalog/courses/{id}/delete-check` and `POST …/{id}/delete`
(`{version}`); audit action `app_course_catalog.delete_course`. If S3 refuses some files after
the catalogue change, the response says so (`s3_error`).

## Who sees a home-screen card (class, streams, goals)

At sign-up a student picks a **class** (6–12 shown; the open ones can be picked, see below), a
**stream** (Science, Commerce, Arts or General) and **goals** (the stream's own list: Board
Exams, JEE Main & Advanced, NEET, CUET, CLAT, CA Foundation, NDA, General Knowledge). The
streams and goals come from the app (`frontend/constants/academicMapping.ts`, mirrored in the
backend's `course_catalog.py` as `STREAMS` / `STREAM_GOALS`). The **Classes, streams & goals**
tab shows them (`GET /api/admin/catalog/academics`, owner and viewer).

### Open classes (approved 2026-11-17; needs the app backend restarted and a new app build)

The owner opens and closes classes in **Classes, streams & goals → Classes** (`GET` / `PUT
/api/admin/catalog/classes`, owner only, audit `app_course_catalog.classes`). The dashboard
writes its own document, `course_catalog {_id: "classes", open, launched, version}`, so a
Courses & prices save never touches it. Saves are version-checked (409 `classes_changed`); at
least one class must stay open.

- **Open:** students can pick it at onboarding and in Academic details; the app backend
  accepts it at `/users/register` and `PUT /users/{id}`.
- **Closed:** "Coming soon" for new picks. `launched` keeps every class ever opened, so students
  already in a closed class keep their lectures and tests and can stay in it; only moving into
  it is refused.
- **No document:** Class 11 and 12 (the code's `CLASSES_WITH_CONTENT`), as before.

The app reads `GET /api/academics/classes` (public) on start, on the Batches tab's refresh,
and keeps the last answer on the phone; offline or against an older backend it uses 11 and 12.
Older app builds keep their own 11-and-12 list.

### New, renamed and deleted classes (approved 2026-11-17)

The same card lists the app's classes as a table (`classes: [{level, name}]` in the document;
missing means Class 6-12):

- **Number** never changes: students' profiles (`class`), lecture folders
  (`videos/class_N/`) and course ids (`classN_subject`) use it. Numbers go up to **20** in both
  backends (was 12), so e.g. 13 = "Dropper" can have lectures, courses and students.
- **Rename** changes only the name students see (onboarding, Academic details, coming-soon
  messages). Two classes can't share a name.
- **+ New class** picks an unused number and a name; it starts closed.
- **Delete** first asks `GET /api/admin/catalog/classes/{n}/delete-check`: refused while any
  student is in the class (counted, never listed), the catalogue has its courses or cards, or
  S3 has subject folders under `videos/class_N/`. The save checks it again (422
  `class_in_use`). A deleted class leaves `launched` too.
- The audit summary records `added`, `removed`, `renamed`, `opened`, `closed`.

Not changed: vouchers still take Class 1-12.

### Streams and goals (approved 2026-11-17)

**Classes, streams & goals → Manage** picks one list at a time (`?list=classes|streams|goals`).
Streams and goals live in `course_catalog {_id: "academics", streams: [{key, name, active}],
goals: [{key, name, active, streams}]}` (`GET` / `PUT /api/admin/catalog/lists`, audit
`app_course_catalog.lists`); missing means the app's code lists, all active.

- **Key** is what a student's profile stores (`stream: "Commerce"`, `goals: ["NEET"]`) and
  what Dome, competitive tests, emails and home-screen cards match on: it never changes. A new
  one's key is its first name. **Name** is what students see and can be renamed.
- **Active / inactive** and **Delete** go straight to the app after typing `active`,
  `inactive` or `delete` (only when nothing else is unsaved). Inactive: not offered to new
  picks; students who have it keep it. Delete (`GET .../lists/delete-check?kind=&key=`) is
  refused while any student has it (counted, never listed) or a home-screen card aims at it.
- **Goals → Streams that offer it** sets which streams offer each goal (saved with **Save**).
- Saves are refused (422) when: no stream is active; an active stream offers no active goal
  (its students couldn't finish signing up); or a Courses & prices card would no longer fit
  (the app checks cards against these lists and would ignore the whole catalogue).
- The app backend updates `STREAMS` / `STREAM_GOALS` in place from this document (before the
  catalogue, which is checked against them) and returns the lists with `GET
  /api/academics/classes`. The app's onboarding, Academic details and Change goal show the
  active ones by name, plus whatever the student already has.

Each batch has `streams` and `goals` (the batch dialog offers only the app's goals for the
ticked streams). `/payments/batches` then shows a student a card when:
- **Class:** the card is for the student's class;
- **Stream:** the card has no streams, or the student's stream is one of them, or the student is
  "General" or has no stream yet;
- **Goals:** the card has no goals, or the student picked none, or they share at least one.

A course the student owns always shows. With no sign-in, every card shows. The three code
batches are for Commerce, so Class 12 Commerce students see what they saw before.

**App change (approved 2026-11-16, needs a new build):** `app/(tabs)/batches.tsx` no longer
limits course cards to Class 12 Commerce: it asks the backend for this student's cards and
falls back to the free demo videos when there are none. Older app builds keep their own Class 12
Commerce rule.

## AdhyaapakAI backend changes (approved 2026-11-14; not deployed)

- **`services/course_catalog.py`:** the MongoDB layer (`build_catalog`, `apply_catalog`,
  `refresh`, `ensure_fresh`, `ensure_known`), the `on_sale` filter, and derived lookups rebuilt
  in place.
- **`routes/payments.py`:**
  - refreshes the catalogue before listing products and batches, and before creating an order;
  - refuses orders for a product that is off sale;
  - stores `price_inr` and `grants` on each course order;
  - skips hidden batches, and batches whose product is off sale.
- **`routes/wallet.py`:** verify, reconcile and the webhook use the order's stored price and
  grants. Before granting, it re-reads the catalogue for a course it doesn't know.
- **`routes/webhooks.py`:**
  - RevenueCat re-reads the catalogue for an App Store id it doesn't know;
  - a refund takes back the grants stored on the purchase.
- **`voucher/service.py`:** a voucher can't buy a product that is off sale.
- **Validity and launch (2026-11-16):**
  - `course_catalog.py` adds `access_days_for()`, `launched()` and the `access_days` /
    `sale_starts_at` checks;
  - orders store `access_days`;
  - wallet, webhooks and vouchers grant with the course's validity;
  - an order is refused before the course's launch.
- **`server.py`:**
  - the catalogue loads at startup, before the voucher seed;
  - a 30-second refresh job also re-seeds the voucher subjects when the catalogue changes.
- **`tests/test_course_catalog_db.py`:** 20 tests.

The suite had 381 passing and 5 failing before the change; it now has 401 passing and the same
5 failing. Those 5 were already failing: the `SCHOLAR2026` coupon in the tests expired on
30 Oct 2026.

**Local check, test database `doubt_solver_app_local`.** A save from the dashboard reached the
app backend's `/payments/course-products` and `/payments/batches` within 4 seconds. Deleting the
document brought back the code catalogue. Only the test database was written to, and the test
document was removed afterwards.

## Still needs the app (part B)

Some parts of the app screens are fixed in the app's code and need a new app build:

- **Course cards only for Class 12 Commerce:** only Class 12 Commerce students see course cards
  (`batches.tsx:149`). So a Class 11 batch doesn't show yet.
- **Brochure screen:** it is hard-coded. A new product opens the Accountancy brochure.
- **Video list:** it has no slot for the course image.
- **Batch details:** it uses its own subject templates.
- **Payment screen:** the "Class 12 Commerce" title is fixed there.
