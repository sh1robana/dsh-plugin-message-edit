import styles from './InlineMessageEdit.module.css'

/** 确认取消时保留原编辑器，只有选择“是”才提交关闭操作。 */
export function confirmCancelEdit(onConfirm: () => void, onReject: () => void): () => void {
  const overlay = document.createElement('div')
  overlay.className = `${styles['overlay'] ?? ''} ${styles['confirmationOverlay'] ?? ''}`
  const panel = document.createElement('div')
  panel.className = styles['confirmPanel'] ?? ''
  panel.setAttribute('role', 'alertdialog')
  panel.setAttribute('aria-modal', 'true')
  panel.setAttribute('aria-label', '是否确认取消编辑')
  const title = document.createElement('div')
  title.className = styles['title'] ?? ''
  title.textContent = '是否确认取消编辑'
  const footer = document.createElement('div')
  footer.className = styles['footer'] ?? ''
  const yes = document.createElement('button')
  yes.type = 'button'
  yes.textContent = '是'
  const no = document.createElement('button')
  no.type = 'button'
  no.textContent = '否'
  footer.append(yes, no)
  panel.append(title, footer)
  overlay.appendChild(panel)
  document.body.appendChild(overlay)
  let mounted = true
  const dispose = (): void => {
    if (!mounted) return
    mounted = false
    yes.removeEventListener('click', confirm)
    no.removeEventListener('click', reject)
    overlay.removeEventListener('keydown', onKeyDown)
    overlay.remove()
  }
  const confirm = (): void => {
    if (!mounted) return
    dispose()
    onConfirm()
  }
  const reject = (): void => {
    if (!mounted) return
    dispose()
    onReject()
  }
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      reject()
    } else if (event.key === 'Tab') {
      event.preventDefault()
      if (document.activeElement === no) yes.focus()
      else no.focus()
    }
  }
  yes.addEventListener('click', confirm)
  no.addEventListener('click', reject)
  overlay.addEventListener('keydown', onKeyDown)
  no.focus()
  return dispose
}
