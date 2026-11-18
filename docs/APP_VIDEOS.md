# App videos

> **Since 2026-11-18** the dashboard has no keys to the app's database or storage: everything below runs in the AdhyaapakAI backend's admin API (`/api/admin/...`, `x-admin-secret`) and its settings are that backend's `.env`. The dashboard's own audit log no longer records these changes (the backend logs them). Where older wording below says "the dashboard" reads or writes the database, read "the admin API".

**Course Management → App videos** (owner only) manages the lectures students see in the
AdhyaapakAI app. Here you can:

- add a lecture to a chapter, or start a new chapter
- add free demo videos
- add dubbed language copies
- replace or delete a video
- set the lecture, chapter and course images

Every change is in the app within about **30 seconds**. You don't need a new app build or a
backend change.

Nothing in the AdhyaapakAI repository changes.

## How it works

The app has no course database. Its backend lists lectures by reading the app's S3 bucket
live, cached for 30 seconds. It looks under `videos/class_<N>/<Subject>/`, in this layout:

```
videos/class_12/Account/
    account_playlist_thumbnail.png                  course image
    chapters/chapter-01-cash-flow-statement/        one folder per chapter (the name is its title)
        Lec-01 Meaning.mp4                          lecture 1 (Hinglish, the main video)
    chapters_thumbnails/chapter-01.png              chapter image
    lectures_thumbnails/<chapter folder>/lecture-01.png   lecture image (matched by number)
    regional_language/<chapter folder>/Lec-01 Meaning_Bengali.mp4   dubbed copy (matched by number)
    demo_videos/Lec-01 Basics.mp4                   free demo video
```

The dashboard reads and writes that same layout, through `GET/POST /api/admin/videos/*`.

**The app's own rules.** `backend/app/services/app_video_layout.py` is a verbatim copy of the
app's `backend/services/course_layout.py`. The dashboard uses it in two ways:

- It lists lectures with the number, chapter and title the app gives them.
- It checks every upload first, by running the app's parser on the folder as it would look
  after the upload. If the app wouldn't read the file as the intended lecture, language copy
  or image, the upload is refused before anything is stored.

If the app ever changes that file, copy it again. Ruff skips it so that it stays identical.

**You choose numbers and names, the server builds the file name:**

| Item | File |
| --- | --- |
| Lecture | `Lec-NN <name>.mp4` |
| Language copy | `<lecture's file name>_<Language>.mp4` |
| New chapter | `chapter-NN-<name>` |

**Upload checks:**

- **Lecture number:** a lecture number already used in that chapter is refused unless you
  choose **Replace**.
- **Lecture name:** it may not end with a language name (for example "Learn Hindi"), because
  the app would read that video as a dubbed copy.
- **Chapter number:**
  - A new chapter can't reuse a chapter number that already exists.
  - Some subjects already have two folders with the same number (for example Account's
    chapters 3, 12 and 13). The app merges those folders, so lectures can only be added to the
    one that already has lectures. The screen warns about this.
- **Files:**
  - Videos must be `.mp4`, at most the AdhyaapakAI backend's `ADMIN_MAX_VIDEO_MB` (4096 by default). The hard
    limit for one upload is 5 GB.
  - Images must be PNG, JPG or WebP, at most its `ADMIN_MAX_IMAGE_MB`.

**New class / new subject:** **+ New class** creates `videos/class_N/` (1–12) and **+ New
subject** creates `videos/class_N/<Name>/`, with the folders every subject has (`chapters/`,
`chapters_thumbnails/`, `demo_videos/`, `lectures_thumbnails/`, `regional_language/`). S3
holds them as empty folder markers, the same as its console makes.

- **Names:** 2–30 letters and numbers, starting with a letter (e.g. `BusinessStudies`).
- **Duplicates:** a subject the app already has in that class is refused, alias included:
  "Accountancy" is the app's `accounts`, i.e. the folder `Account`.
- **Classes outside 11 and 12:** the app's sign-up opens only Class 11 and 12 today, so other
  classes stay "coming soon" until an app update opens them.

Routes: `POST /api/admin/videos/classes` `{class_level}` and `POST /api/admin/videos/subjects`
`{class_level, name}`.

**Lecture image in the same step:** the lecture, new chapter, demo video and replace dialogs
have an optional **Lecture image**. Once the video is stored, the image is uploaded as that
lecture's image (`lectures_thumbnails/<chapter folder>/lecture-NN.<ext>`, or `demo_videos/` for
a demo), using the chapter and number the server gave the video. If only the image fails, the
video stays and the screen says so; add the image later with **Change** in the Image column.

**Upload:**

1. The server picks the file name and returns a presigned POST. The POST pins the file
   name, the type and the maximum size, and it is valid for 6 hours so a large lecture has
   time to start.
2. The browser posts the file straight to S3. It never passes through the dashboard
   server, and the screen shows its progress.
3. The server checks that the file is stored. Only then does it delete what the upload
   replaced, such as an old video or an image saved under another name. A failed upload
   loses nothing.

**Delete:**

- **Deleting a lecture** also deletes its language copies and its own image. A demo image
  shared by all demo videos is kept.
- **The language chips** (×) delete a single language copy.
- **The bucket has no versioning,** so deleted and replaced files can't be brought back. The
  confirmation says so.

**Audit:** every upload and delete is written to the audit log as `app_video.upload` or
`app_video.delete`.

## Setup

App videos uses the course storage settings in `backend/.env`:

- **`COURSE_ASSETS_BUCKET`** must be the app's bucket (its backend's `S3_BUCKET_NAME`).
- **`COURSE_ASSETS_REGION`** is the bucket's region.
- **the AdhyaapakAI backend's `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` (no longer in the dashboard)** are the keys. They
  need these permissions:
  - `s3:ListBucket` on the bucket
  - `s3:GetObject`, `s3:PutObject` and `s3:DeleteObject` on `arn:aws:s3:::<bucket>/videos/*`
- **Bucket CORS** must allow `POST` and `GET` from the dashboard's origin. It already allows
  `http://localhost:5173`; add the production dashboard origin.

If the keys can't do something, the screen says so ("The app's bucket refused the dashboard's
storage keys…"). It never shows the keys.

## Where each item shows in the app

| Item | Phone app (Android/iOS) | App website |
| --- | --- | --- |
| Lectures, demo videos, language copies | Yes, in the subject's video list | Yes |
| Lecture image | Yes, on the lecture | Yes |
| Chapter image | Only on that chapter's lectures without their own image | Yes, on the chapter |
| Course image (`*_playlist_thumbnail`) | **No.** The phone app has no playlist screen yet (`PlaylistCard` renders nothing there) | Only for a subject whose chapters have lectures |
| A chapter with no lecture | Not shown | Not shown |

The course image is also the picture on home-screen cards set to "Use the course image"
(Courses & prices); their own banners are a different image (`batch-banners/`).

### The course image is optional

**Delete course image** removes every course image of the subject: the app shows the newest one
it finds, so leaving an older one would keep it showing. Cards set to use the course image then
show their own banner. The delete is never refused: a card that showed only the course image
(no banner of its own) shows no picture in the app until it gets a banner (Courses & prices) or
a new course image. The dashboard names such cards after the delete.

## What App videos does not do

- **Courses and prices:** courses, prices, validity and home-screen cards are set in the
  **Courses & prices** tab (see [APP_COURSES.md](APP_COURSES.md)), not here.
- **Subjects:** subjects can't be renamed.
- **Videos:** videos aren't transcoded. The app plays the uploaded file as it is.
