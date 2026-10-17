/** The only place query keys are defined (api.md C-6). Every key is a function; only defined args are kept. */
type P = Record<string, unknown> | undefined;
const k = (...parts: unknown[]) => parts.filter((p) => p !== undefined);

export const qk = {
  me: () => ["me"] as const,
  cycles: {
    all: () => ["cycles"],
    current: () => ["cycles", "current"],
    list: (p?: P) => k("cycles", "list", p),
    detail: (id: string) => ["cycles", "detail", id],
    archivePreview: (id: string) => ["cycles", "detail", id, "archive-preview"],
  },
  trades: { all: () => ["trades"], list: () => ["trades", "list"] },
  skills: { all: () => ["skills"], list: (q?: string) => k("skills", "list", q) },
  projects: {
    all: () => ["projects"],
    list: (p?: P) => k("projects", "list", p),
    detail: (id: string) => ["projects", "detail", id],
  },
  trainees: {
    all: () => ["trainees"],
    me: () => ["trainees", "me"],
    list: (p?: P) => k("trainees", "list", p),
    detail: (id: string) => ["trainees", "detail", id],
  },
  resumes: {
    all: () => ["resumes"],
    me: () => ["resumes", "me"],
    trainee: (traineeId: string) => ["resumes", "trainee", traineeId],
  },
  submissions: {
    all: () => ["submissions"],
    list: (p?: P) => k("submissions", "list", p),
    detail: (id: string) => ["submissions", "detail", id],
    analysis: (id: string) => ["submissions", "analysis", id],
  },
  onboarding: { me: () => ["onboarding", "me"] },
  notifications: { me: () => ["notifications", "me"] },
  allocationHistory: {
    all: () => ["allocationHistory"],
    me: () => ["allocationHistory", "me"],
    trainee: (id: string) => ["allocationHistory", "trainee", id],
  },
  automation: { status: () => ["automation", "status"] },
  allocations: { all: () => ["allocations"], list: (p?: P) => k("allocations", "list", p) },
  progress: { all: () => ["progress"], list: (p?: P) => k("progress", "list", p) },
  users: { all: () => ["users"], list: (p?: P) => k("users", "list", p) },
  invitations: { all: () => ["invitations"], list: (p?: P) => k("invitations", "list", p) },
  reports: { all: () => ["reports"], overview: (cycleId?: string) => k("reports", "overview", cycleId) },
};
