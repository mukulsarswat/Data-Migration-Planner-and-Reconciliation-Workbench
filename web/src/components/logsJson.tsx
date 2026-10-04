// Collapsible raw JSON shown as plain text (never HTML). Shared by the History and Logs views; the <pre> is only
// rendered while open so long lists stay cheap.
import { useState } from 'react';

export function JsonDetails({ value, label = 'Raw JSON' }: { value: unknown; label?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <details className="mt-1" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary className="cursor-pointer select-none text-xs text-slate-500 hover:text-slate-800">{label}</summary>
      {open && (
        <pre className="mt-1 max-h-80 overflow-auto rounded-md bg-slate-900 p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap break-all text-slate-100">
          {JSON.stringify(value, null, 2)}
        </pre>
      )}
    </details>
  );
}
