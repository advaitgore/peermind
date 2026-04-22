"use client";

import { useCallback, useState } from "react";
import { useDropzone } from "react-dropzone";

export function Dropzone({
  onFile,
  disabled = false,
}: {
  onFile: (f: File) => void;
  disabled?: boolean;
}) {
  const [picked, setPicked] = useState<File | null>(null);
  const onDrop = useCallback(
    (files: File[]) => {
      if (!files.length) return;
      setPicked(files[0]);
      onFile(files[0]);
    },
    [onFile]
  );
  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: {
      "application/pdf": [".pdf"],
      "application/zip": [".zip"],
      "text/x-tex": [".tex"],
      "application/x-tex": [".tex"],
    },
    maxFiles: 1,
    disabled,
  });

  return (
    <div
      {...getRootProps()}
      className={`card px-6 py-10 text-center cursor-pointer transition-colors ${
        isDragActive ? "bg-[color:var(--color-surface-2)]" : ""
      } ${disabled ? "opacity-50 cursor-not-allowed" : ""}`}
    >
      <input {...getInputProps()} />
      {picked ? (
        <>
          <div className="font-mono text-sm">{picked.name}</div>
          <div className="text-xs text-[color:var(--color-text-dim)] mt-1">
            {(picked.size / 1024).toFixed(1)} KB · drop a different file to replace
          </div>
        </>
      ) : isDragActive ? (
        <div className="text-sm">Drop it here.</div>
      ) : (
        <>
          <div className="text-sm font-medium">Drop your paper here or click to browse</div>
          <div className="text-xs text-[color:var(--color-text-dim)] mt-1 font-mono">
            .tex · .zip (LaTeX project) · .pdf
          </div>
        </>
      )}
    </div>
  );
}
