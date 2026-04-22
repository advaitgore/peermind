import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "PeerMind — Your paper's toughest reviewer. In 90 seconds.",
  description:
    "AI-powered scientific peer review: two adversarial reviewers, literature scout, code runner, live LaTeX patching.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
