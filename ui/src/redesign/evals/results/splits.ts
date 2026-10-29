/** The label splits a check can measure on. The 70/30 assignment itself is the server's. */
export type Split = "all" | "dev" | "held_out";

export const SPLIT_INFO: Record<Split, { option: string; title: string; what: string; short: string }> = {
  all: { option: "All labels", title: "All labels", what: "Every answer you labeled.", short: "all labels" },
  dev: {
    option: "Tuning rows (dev, 70%)",
    title: "Tuning rows",
    what: "The labeled answers you write the wording against.",
    short: "dev labels",
  },
  held_out: {
    option: "Fair-test rows (held-out, 30%)",
    title: "Fair-test rows",
    what: "Labeled answers kept aside. A wording only counts as better if it holds up here.",
    short: "held-out labels",
  },
};

export const SPLIT_ORDER: Split[] = ["all", "dev", "held_out"];
