import type { DetectedVenue, JournalProfile } from "./types";

// Hit the FastAPI backend directly. The Next.js dev rewrite buffers SSE
// (known issue with the dev proxy), which breaks live streaming — CORS is
// enabled on the backend so the browser can talk to :8000 without a proxy.
export const BACKEND_BASE =
  (typeof window !== "undefined" && process.env.NEXT_PUBLIC_API_BASE) ||
  process.env.NEXT_PUBLIC_API_BASE ||
  "http://localhost:8000";

const API_BASE = `${BACKEND_BASE}/api`;

export interface JobCreateResponse {
  job_id: string;
  title: string;
  source_type: "tex" | "zip" | "pdf" | "arxiv";
  has_source: boolean;
  detected_venue?: DetectedVenue | null;
}

export async function createJobFromFile(file: File): Promise<JobCreateResponse> {
  const fd = new FormData();
  fd.append("file", file);
  const res = await fetch(`${API_BASE}/jobs/create`, { method: "POST", body: fd });
  if (!res.ok) throw new Error(`create_job: ${res.status}`);
  return res.json();
}

export async function createJobFromArxiv(arxivId: string): Promise<JobCreateResponse> {
  const fd = new FormData();
  fd.append("arxiv_id", arxivId);
  const res = await fetch(`${API_BASE}/jobs/create`, { method: "POST", body: fd });
  if (!res.ok) throw new Error(`create_job_arxiv: ${res.status}`);
  return res.json();
}

export async function startJob(
  jobId: string,
  journal: string,
  opts?: { custom_venue_name?: string }
): Promise<void> {
  const body: Record<string, unknown> = { journal };
  if (opts?.custom_venue_name) body.custom_venue_name = opts.custom_venue_name;
  const res = await fetch(`${API_BASE}/jobs/${jobId}/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`start_job: ${res.status}`);
}

export async function applyPatch(jobId: string, patchId: string) {
  const res = await fetch(`${API_BASE}/jobs/${jobId}/patch/apply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ patch_id: patchId }),
  });
  if (!res.ok) throw new Error(`apply_patch: ${res.status}`);
  return res.json();
}

export async function rejectPatch(jobId: string, patchId: string) {
  const res = await fetch(`${API_BASE}/jobs/${jobId}/patch/reject`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ patch_id: patchId }),
  });
  if (!res.ok) throw new Error(`reject_patch: ${res.status}`);
  return res.json();
}

export async function applyAllPatches(jobId: string) {
  const res = await fetch(`${API_BASE}/jobs/${jobId}/patch/apply-all`, { method: "POST" });
  if (!res.ok) throw new Error(`apply_all: ${res.status}`);
  return res.json();
}

export async function applyAdhocPatch(
  jobId: string,
  body: { diff: string; description?: string; category?: string; source_action_id?: string }
) {
  const res = await fetch(`${API_BASE}/jobs/${jobId}/patch/adhoc-apply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`adhoc_apply: ${res.status}`);
  return res.json();
}

export async function fetchSourceText(
  jobId: string
): Promise<{ content: string; available: boolean; filename: string | null }> {
  const res = await fetch(`${API_BASE}/jobs/${jobId}/source-text`);
  if (!res.ok) throw new Error(`source_text: ${res.status}`);
  return res.json();
}

export async function fetchJournals(): Promise<Record<string, JournalProfile>> {
  const res = await fetch(`${API_BASE}/journals`);
  if (!res.ok) throw new Error(`journals: ${res.status}`);
  return res.json();
}

export function pdfUrl(jobId: string, version: string | number = "") {
  return `${API_BASE}/jobs/${jobId}/output.pdf${version ? `?v=${version}` : ""}`;
}

export function streamUrl(jobId: string) {
  return `${API_BASE}/jobs/${jobId}/stream`;
}

export async function startRebuttal(jobId: string): Promise<void> {
  const res = await fetch(`${API_BASE}/jobs/${jobId}/rebuttal`, { method: "POST" });
  if (!res.ok) throw new Error(`start_rebuttal: ${res.status}`);
}

export async function fetchExistingRebuttal(
  jobId: string
): Promise<{ text: string } | null> {
  const res = await fetch(`${API_BASE}/jobs/${jobId}/rebuttal`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`get_rebuttal: ${res.status}`);
  return res.json();
}

export function rebuttalLetterUrl(jobId: string) {
  return `${BACKEND_BASE}/api/jobs/${jobId}/rebuttal-letter`;
}
