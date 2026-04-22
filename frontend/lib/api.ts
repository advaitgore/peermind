import type { JournalProfile } from "./types";

const API_BASE = "/api";

export async function createJobFromFile(file: File): Promise<{ job_id: string; title: string }> {
  const fd = new FormData();
  fd.append("file", file);
  const res = await fetch(`${API_BASE}/jobs/create`, { method: "POST", body: fd });
  if (!res.ok) throw new Error(`create_job: ${res.status}`);
  return res.json();
}

export async function createJobFromArxiv(arxivId: string): Promise<{ job_id: string; title: string }> {
  const fd = new FormData();
  fd.append("arxiv_id", arxivId);
  const res = await fetch(`${API_BASE}/jobs/create`, { method: "POST", body: fd });
  if (!res.ok) throw new Error(`create_job_arxiv: ${res.status}`);
  return res.json();
}

export async function startJob(jobId: string, journal: string): Promise<void> {
  const res = await fetch(`${API_BASE}/jobs/${jobId}/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ journal }),
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
