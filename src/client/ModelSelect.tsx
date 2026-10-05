import { useId, useLayoutEffect, useRef, useState } from 'react'

export function ModelSelect({ value, options, onChange, label = '已配置模型', placeholder = '选择模型' }: {
  label?: string
  placeholder?: string
  value: string
  options: { value: string; label: string }[]
  onChange: (value: string) => void
}) {
  const id = useId()
  const button = useRef<HTMLButtonElement>(null)
  const list = useRef<HTMLSelectElement>(null)
  const popover = useRef<HTMLDivElement>(null)
  const [placement, setPlacement] = useState({ above: false, height: 320 })
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(value)
  const [query, setQuery] = useState('')
  const filtered = options.filter(option => option.label.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
  const shown = filtered.slice(0, 200)
  function close(commit: boolean, next = pending) {
    if (commit) onChange(next)
    setOpen(false)
    button.current?.focus({ preventScroll: true })
  }
  useLayoutEffect(() => {
    if (!open) return
    function position() {
      const anchor = button.current
      const popup = popover.current
      const wrapper = anchor?.parentElement
      if (!anchor || !popup || !wrapper) return
      const rect = anchor.getBoundingClientRect()
      const origin = wrapper.getBoundingClientRect()
      // Rects use viewport pixels; CSS offsets use the ancestor's unzoomed units.
      const scale = origin.width / parseFloat(getComputedStyle(wrapper).width) || 1
      let left = 8, right = document.documentElement.clientWidth - 8
      let top = 8, bottom = document.documentElement.clientHeight - 8
      for (let parent = wrapper.parentElement; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent)
        const bounds = parent.getBoundingClientRect()
        const parentScale = bounds.width / parent.offsetWidth || 1
        if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) {
          left = Math.max(left, bounds.left + parent.clientLeft * parentScale + 8)
          right = Math.min(right, bounds.left + (parent.clientLeft + parent.clientWidth) * parentScale - 8)
        }
        if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) {
          top = Math.max(top, bounds.top + parent.clientTop * parentScale + 8)
          bottom = Math.min(bottom, bounds.top + (parent.clientTop + parent.clientHeight) * parentScale - 8)
        }
      }
      const available = Math.max(0, right - left)
      popup.style.maxWidth = `${available / scale}px`
      popup.style.minWidth = `${Math.min(rect.width, available) / scale}px`
      const width = popup.getBoundingClientRect().width
      popup.style.left = `${(Math.max(left, Math.min(rect.left, right - width)) - origin.left) / scale}px`
      const below = (bottom - rect.bottom) / scale
      const above = (rect.top - top) / scale
      const upwards = below < 240 && above > below
      setPlacement({ above: upwards, height: Math.max(40, Math.min(320, upwards ? above : below)) })
    }
    position()
    window.addEventListener('resize', position)
    window.addEventListener('scroll', position, true)
    const observer = new ResizeObserver(position)
    if (button.current) observer.observe(button.current)
    return () => {
      window.removeEventListener('resize', position)
      window.removeEventListener('scroll', position, true)
      observer.disconnect()
    }
  }, [open, query, options])
  useLayoutEffect(() => { if (open) list.current?.focus({ preventScroll: true }) }, [open])
  function expand() {
    setQuery(''); setPending(value); setOpen(true)
  }
  return <div className="dmm-model-select" onBlur={event => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false)
  }}>
    <label id={`${id}-label`} htmlFor={`${id}-button`}>{label}</label>
    <button ref={button} id={`${id}-button`} type="button" aria-haspopup="listbox"
      aria-expanded={open} aria-controls={open ? id : undefined}
      onClick={() => open ? setOpen(false) : expand()}
      onKeyDown={event => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); expand() } }}>
      <span>{options.find(option => option.value === value)?.label ?? placeholder}</span><span aria-hidden="true">▾</span>
    </button>
    {open && <div ref={popover} className="dmm-select-popover" style={{ top: placement.above ? 'auto' : '100%', bottom: placement.above ? 'calc(100% - ' + (button.current?.offsetTop ?? 0) + 'px)' : 'auto' }}>
      <input type="search" aria-label={`搜索${label}`} placeholder="输入名称或 ID 搜索" value={query} onChange={event => { setQuery(event.target.value); setPending('') }} onKeyDown={event => {
        if (event.key === 'ArrowDown') { event.preventDefault(); list.current?.focus({ preventScroll: true }) }
        if (event.key === 'Escape') { event.preventDefault(); close(false) }
        if (event.key === 'Enter' && filtered.length === 1) { event.preventDefault(); close(true, filtered[0]!.value) }
      }}/>
      <select ref={list} id={id} size={Math.max(2, Math.min(8, shown.length + 1))} style={{ maxHeight: Math.max(40, placement.height - 64) }}
      aria-labelledby={`${id}-label`} value={pending}
      onChange={event => setPending(event.target.value)}
      onClick={event => { if ((event.target as HTMLElement).tagName === 'OPTION') close(true, event.currentTarget.value) }}
      onKeyDown={event => {
        if (event.key === 'Enter') { event.preventDefault(); close(true) }
        if (event.key === 'Escape') { event.preventDefault(); close(false) }
      }}>
      <option value="">{placeholder}</option>
      {shown.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
    </select>
      {filtered.length > shown.length && <small>显示前 {shown.length} 项，共 {filtered.length} 项；输入关键词缩小范围。</small>}
      {!filtered.length && <small>没有匹配项</small>}
    </div>}
  </div>
}
