import type { Metadata } from "next";
import "./globals.css";
// Required when react-pdf's renderTextLayer=true — positions invisible text
// spans over the canvas for selection/search without showing them visually.
import "react-pdf/dist/esm/Page/TextLayer.css";
import { ConsoleNoiseSuppressor } from "@/components/ConsoleNoiseSuppressor";

export const metadata: Metadata = {
  title: "PeerMind — your paper's toughest reviewer",
  description:
    "AI-powered scientific peer review. Two adversarial reviewers, literature scout, code runner, live LaTeX patching.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="font-body">
        <ConsoleNoiseSuppressor />
        {children}
      </body>
    </html>
  );
}
