/** An on/off switch for lessons and benchmark questions. */
export default function Switch({ checked, disabled, label, onChange }: { checked: boolean; disabled?: boolean; label: string; onChange(value: boolean): void }) {
  return <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} className={`training-switch${checked ? " on" : ""}`} onClick={() => onChange(!checked)}><span /></button>;
}
