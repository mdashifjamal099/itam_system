"use client";

import { useRef, useState } from "react";

const MAX_DIMENSION = 900;
const JPEG_QUALITY = 0.72;

/** Downscales and re-encodes so a phone-camera photo (often 3-5MB) fits comfortably
 *  in a jsonb payload column instead of bloating the append-only audit log. */
function resizeToJpegDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const scale = Math.min(1, MAX_DIMENSION / Math.max(img.width, img.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        URL.revokeObjectURL(url);
        reject(new Error("Canvas not supported"));
        return;
      }
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL("image/jpeg", JPEG_QUALITY));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Could not read image"));
    };
    img.src = url;
  });
}

export function PhotoCapture({
  label,
  onChange,
}: {
  label: string;
  onChange: (dataUrl: string | null) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleFile(file: File | undefined) {
    setError(null);
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setError("Please choose an image file.");
      return;
    }
    setBusy(true);
    try {
      const dataUrl = await resizeToJpegDataUrl(file);
      setPreview(dataUrl);
      onChange(dataUrl);
    } catch {
      setError("Could not process that photo — try again.");
      onChange(null);
    } finally {
      setBusy(false);
    }
  }

  function clear() {
    setPreview(null);
    onChange(null);
    if (inputRef.current) inputRef.current.value = "";
  }

  return (
    <div className="field">
      <label>{label} (optional)</label>
      {preview ? (
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <img
            src={preview}
            alt="Condition photo preview"
            style={{ width: 72, height: 72, objectFit: "cover", borderRadius: "var(--radius-sm)", border: "1px solid var(--border)" }}
          />
          <button type="button" className="btn" onClick={clear}>
            Remove photo
          </button>
        </div>
      ) : (
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          capture="environment"
          disabled={busy}
          onChange={(e) => handleFile(e.target.files?.[0])}
        />
      )}
      {busy && <p className="hint-text" style={{ marginTop: 4 }}>Processing photo…</p>}
      {error && <p className="msg error">{error}</p>}
    </div>
  );
}
