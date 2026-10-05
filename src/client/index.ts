import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { remoteContribution, replySchema, requestSchema, type Request, type Reply } from '../wire.js'
import { SettingsPage } from './SettingsPage.js'
import css from './style.css'
import { readableError } from '../core/errors.js'

// Public Desktop 0.2.0-rc.2 client event, also used by the official Models page.
declare module '@deepseek-ai/cordis' { interface Events { 'connection/reset'(): void } }

export const inject = ['remote', 'slots']
export function apply(ctx: Context) {
  ctx.effect(() => {
    const style = document.createElement('style')
    style.textContent = css
    document.head.append(style)
    return () => style.remove()
  }, 'model-metadata styles')
  ctx.effect(async () => {
    const unmount = await ctx.remote.$mount(remoteContribution)
    const namespace = ctx.inject(['remote.modelMetadataUi'], scoped => {
    const call = async (request: Request): Promise<Reply> => {
      try {
      const result = await scoped.remote.modelMetadataUi.execute(requestSchema.parse(request))
      if (!result.ok) throw new Error(result.error.message)
      return replySchema.parse(result.value)
      } catch (error) { throw new Error(readableError(error)) }
    }
    const subscribeChanges = (listener: () => void) => {
      const disposers = [
        scoped.remote.$on('settings/document-updated', listener),
        scoped.remote.$on('llm/adapters-updated', listener),
        scoped.on('connection/reset', listener),
      ]
      return () => { for (const dispose of disposers) dispose() }
    }
    const child = scoped.slots.inject('settings.section', () => scoped.slots.register({
      name: 'settings.section', id: 'model-metadata', order: 11, label: () => '模型信息助手',
      inject: () => ({ call, subscribeChanges }),
    }, SettingsPage))
    scoped.effect(() => child)
    })
    return async () => { await namespace.dispose(); await unmount() }
  }, 'model-metadata editor')
}
