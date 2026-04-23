import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "PeerMind — your paper's toughest reviewer",
  description:
    "AI-powered scientific peer review. Two adversarial reviewers, literature scout, code runner, live LaTeX patching.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="font-body">{children}</body>
    </html>
  );
}
