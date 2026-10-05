import { useLayoutEffect, useRef } from 'react'
import { Panel, type PanelProps } from './Panel.js'

export function SettingsPage(props: PanelProps) {
  const root = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const element = root.current!
    const resize = () => {
      const rect = element.getBoundingClientRect()
      const scale = rect.width / parseFloat(getComputedStyle(element).width) || 1
      let bottom = document.documentElement.clientHeight
      let trailingSpace = 0
      let scrollOffset = 0
      for (let parent = element.parentElement; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent)
        const bounds = parent.getBoundingClientRect()
        const parentScale = bounds.width / parent.offsetWidth || scale
        trailingSpace += (parseFloat(style.paddingBottom) || 0) * parentScale
        scrollOffset += parent.scrollTop * parentScale
        if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) {
          bottom = Math.min(bottom, bounds.top + (parent.clientTop + parent.clientHeight) * parentScale - trailingSpace)
        }
        trailingSpace += (parseFloat(style.marginBottom) || 0) * parentScale
      }
      element.style.height = `${Math.max(0, (bottom - rect.top - scrollOffset - 2) / scale)}px`
    }
    resize()
    const observer = new ResizeObserver(resize)
    if (element.parentElement) observer.observe(element.parentElement)
    window.addEventListener('resize', resize)
    return () => { observer.disconnect(); window.removeEventListener('resize', resize) }
  }, [])
  return <div ref={root} className="dmm-settings-page"><Panel {...props}/></div>
}
