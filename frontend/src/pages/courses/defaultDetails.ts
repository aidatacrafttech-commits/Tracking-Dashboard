import type { CourseDetails } from "./appCoursesApi";

// The built-in pages of the app's three code courses (and the languages a page can list) come from
// the app's backend (GET /admin/catalog/details-defaults; useDetailDefaults), not from a copy here.

/** A new course's page to start from: its name as the title, nothing else yet. */
export const blankDetails = (title: string): CourseDetails => ({
  kicker: "Introducing",
  title_lead: title.replace(/^Class \d+(th)?\s*/i, "").slice(0, 40) || "The Course",
  title_accent: "",
  title_tail: "Batch",
  pillars: [],
  exams: [],
  chapter_groups: [],
  why_choose: [],
  compare_at: null,
  save_note: "",
  languages: [],
});
