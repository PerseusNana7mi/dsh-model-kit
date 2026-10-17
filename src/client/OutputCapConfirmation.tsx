import { useEffect, useId, useRef } from 'react'

const explanation = '例如填 8192，默认每次最多输出 8192 tokens；回答可以更短，设得太小可能被截断。'

export function OutputCapConfirmation({
  confirmed,
  attempts,
  onChange,
}: {
  confirmed: boolean
  attempts: number
  onChange: (checked: boolean) => void
}) {
  const root = useRef<HTMLDivElement>(null)
  const id = useId()
  const missing = attempts > 0 && !confirmed
  useEffect(() => {
    if (!missing) return
    root.current?.scrollIntoView({ block: 'nearest' })
    root.current?.querySelector('input')?.focus({ preventScroll: true })
  }, [attempts, missing])
  return (
    <div ref={root} className={`dmm-output-confirm${missing ? ' dmm-output-confirm-missing' : ''}`}>
      <div className="dmm-output-confirm-row" key={attempts}>
        <label className="dmm-check">
          <input
            type="checkbox"
            checked={confirmed}
            aria-invalid={missing || undefined}
            aria-describedby={missing ? `${id}-error` : undefined}
            aria-description={explanation}
            onChange={(event) => onChange(event.target.checked)}
          />
          <span title={explanation}>确认将此值作为默认输出上限</span>
        </label>
      </div>
      {missing && (
        <div className="dmm-output-bubble" role="alert" id={`${id}-error`}>
          请先勾选确认，再保存
        </div>
      )}
    </div>
  )
}
