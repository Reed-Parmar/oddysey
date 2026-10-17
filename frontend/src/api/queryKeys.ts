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
  },
  recommendations: { all: () => ["recommendations"], list: (p?: P) => k("recommendations", "list", p) },
  recommendationRuns: {
    all: () => ["recommendationRuns"],
    latest: (cycleId: string, status?: string) => k("recommendationRuns", "latest", cycleId, status),
  },
  allocations: { all: () => ["allocations"], list: (p?: P) => k("allocations", "list", p) },
  allocationRuns: { latest: (cycleId: string) => ["allocationRuns", "latest", cycleId] },
  progress: { all: () => ["progress"], list: (p?: P) => k("progress", "list", p) },
  users: { all: () => ["users"], list: (p?: P) => k("users", "list", p) },
  invitations: { all: () => ["invitations"], list: (p?: P) => k("invitations", "list", p) },
  reports: { all: () => ["reports"], overview: (cycleId?: string) => k("reports", "overview", cycleId) },
};
