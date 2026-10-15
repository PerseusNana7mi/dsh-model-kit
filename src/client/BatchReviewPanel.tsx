import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Reply, Request } from '../wire.js'
import { MAX_REVIEW_MODELS } from '../core/limits.js'
import { fieldLabels } from './FieldDiff.js'
import { formatPrice } from './price-draft.js'
import { readableError } from '../core/errors.js'
import { availableSelection, hasSelection, batchKey, type BatchSelection } from './batch-draft.js'

const keyOf = (row: { provider: string; id: string }) => JSON.stringify([row.provider, row.id])
const priceLabels = { input: '输入', output: '输出', cacheRead: '缓存读取', cacheWrite: '缓存写入' }
const priceKeys = ['input', 'output', 'cacheRead', 'cacheWrite'] as const
type Review = NonNullable<Reply['batchReview']>

export function BatchReviewPanel({
  call,
  models,
  refreshKey,
}: {
  call: (request: Request) => Promise<Reply>
  models: NonNullable<Reply['models']>
  refreshKey: number
}) {
  const [provider, setProvider] = useState('')
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<string[]>([])
  const [currency, setCurrency] = useState<'USD' | 'CNY'>('USD')
  const [pricingSource, setPricingSource] = useState<'models.dev' | 'basellm'>('models.dev')
  const [mode, setMode] = useState('fill')
  const [review, setReview] = useState<Review>()
  const [busy, setBusy] = useState(false)
  const [stale, setStale] = useState(false)
  const [error, setError] = useState('')
  const [choices, setChoices] = useState<BatchSelection[]>([])
  const [confirmed, setConfirmed] = useState(false)
  const [acceptCap, setAcceptCap] = useState(false)
  const [acceptPreset, setAcceptPreset] = useState(false)
  const [saveBusy, setSaveBusy] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [outcome, setOutcome] = useState<Reply['batchSaved']>()
  const saving = useRef(false)
  const generation = useRef(0)
  useLayoutEffect(() => {
    // Settings notifications from this save must not discard its own response or partial-success receipt.
    if (!saving.current) {
      generation.current++
      setBusy(false)
    }
    setStale(true)
    setSelected((previous) => previous.filter((key) => models.some((row) => keyOf(row) === key)))
  }, [models, refreshKey, call])
  useLayoutEffect(
    () => () => {
      // This counter invalidates whichever request is pending when the inputs change or the panel unmounts.
      generation.current++
    },
    [],
  )
  useEffect(() => {
    if (!review?.expiresAt) return
    const timer = setTimeout(() => setStale(true), Math.max(0, review.expiresAt - Date.now()))
    return () => clearTimeout(timer)
  }, [review])
  const query = search.trim().toLowerCase()
  const filtered = models.filter(
    (row) =>
      (!provider || row.provider === provider) &&
      (!query || `${row.provider} ${row.id} ${row.name}`.toLowerCase().includes(query)),
  )
  const visible = filtered.slice(0, 200)
  const combined = [...new Set([...selected, ...filtered.map(keyOf)])]
  function invalidate() {
    generation.current++
    setBusy(false)
    setReview(undefined)
    setError('')
    setSubmitted(false)
    setOutcome(undefined)
    setConfirmed(false)
    setAcceptCap(false)
    setAcceptPreset(false)
  }
  function selectDefaults(result: Review, nextMode: string) {
    setChoices(result.rows.map((row) => ({ ...availableSelection(row, nextMode), updateReference: false })))
    setConfirmed(false)
    setAcceptCap(false)
    setAcceptPreset(false)
  }
  function changeChoice(next: BatchSelection) {
    setChoices((previous) => previous.map((row) => (batchKey(row) === batchKey(next) ? next : row)))
    setConfirmed(false)
    setAcceptCap(false)
    setAcceptPreset(false)
  }
  async function check() {
    const request = ++generation.current
    const targets = models.filter((row) => selected.includes(keyOf(row))).map(({ provider, id }) => ({ provider, id }))
    setBusy(true)
    setReview(undefined)
    setError('')
    setSubmitted(false)
    setOutcome(undefined)
    setConfirmed(false)
    try {
      const result = await call({ action: 'batchReview', targets, currency, pricingSource })
      if (request !== generation.current) return
      if (!result.batchReview) throw new Error('未收到批量核对结果，请重试')
      setReview(result.batchReview)
      selectDefaults(result.batchReview, mode)
      setStale(false)
    } catch (error) {
      if (request === generation.current) setError(readableError(error))
    } finally {
      if (request === generation.current) setBusy(false)
    }
  }
  const selectedChanges = choices.filter(hasSelection)
  const requiresCap = selectedChanges.some((row) => row.fields.includes('maxTokens'))
  const requiresPreset = selectedChanges.some(
    (choice) =>
      choice.fields.length > 0 && review?.rows.some((row) => batchKey(row) === batchKey(choice) && row.protectedPreset),
  )
  async function save() {
    if (!review?.ticket || saving.current) return
    const request = ++generation.current
    saving.current = true
    setSaveBusy(true)
    setSubmitted(true)
    setError('')
    try {
      const result = await call({
        action: 'batchCommit',
        confirmed: true,
        ticket: review.ticket,
        mode: mode as 'fill' | 'update',
        selections: selectedChanges,
        acceptDefaultOutputCap: acceptCap,
        allowPresetOverride: acceptPreset,
      })
      if (request !== generation.current) return
      if (!result.batchSaved) throw new Error('未收到保存结果；请按原选择重试以核对结果')
      setOutcome(result.batchSaved)
    } catch (error) {
      if (request === generation.current) setError(`保存结果未确认，选择已保留。${readableError(error)}`)
    } finally {
      saving.current = false
      if (request === generation.current) setSaveBusy(false)
    }
  }
  return (
    <details className="dmm-import dmm-batch-review">
      <summary>批量核对与变化预览</summary>
      <p>获取目录后逐模型、逐字段勾选，核对预览并确认保存。底部单模型“保存”不处理本批选择。</p>
      <fieldset disabled={saveBusy}>
        <div className="dmm-grid">
          <label>
            核对供应商范围
            <select value={provider} onChange={(e) => setProvider(e.target.value)}>
              <option value="">全部已配置供应商</option>
              {[...new Set(models.map((row) => row.provider))].map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
          </label>
          <label>
            搜索待核对模型
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="名称、ID 或供应商"
            />
          </label>
        </div>
        <p>
          已选 {selected.length} / {MAX_REVIEW_MODELS} 个 · 匹配 {filtered.length} 个
          {filtered.length > 200 ? '，仅展示前 200 个，请缩小搜索范围' : ''}
        </p>
        <div className="dmm-actions">
          <button
            type="button"
            disabled={!filtered.length || combined.length > MAX_REVIEW_MODELS || combined.length === selected.length}
            onClick={() => {
              invalidate()
              setSelected(combined)
            }}
          >
            选择筛选结果
          </button>
          <button
            type="button"
            disabled={!selected.length}
            onClick={() => {
              invalidate()
              setSelected([])
            }}
          >
            清空批量选择
          </button>
        </div>
        <div className="dmm-import-list" aria-label="待核对模型">
          {visible.map((row) => {
            const key = keyOf(row)
            return (
              <label className="dmm-check" key={key}>
                <input
                  type="checkbox"
                  checked={selected.includes(key)}
                  disabled={!selected.includes(key) && selected.length >= MAX_REVIEW_MODELS}
                  onChange={(e) => {
                    invalidate()
                    setSelected(e.target.checked ? [...selected, key] : selected.filter((value) => value !== key))
                  }}
                />
                {row.provider} / {row.name} ({row.id})
              </label>
            )
          })}
          {!filtered.length && <p>没有匹配的已配置模型。继承目录使用“内置模型参数覆盖与恢复”。</p>}
        </div>
        <div className="dmm-grid">
          <label>
            批量核对币种
            <select
              value={currency}
              onChange={(e) => {
                invalidate()
                const next = e.target.value as 'USD' | 'CNY'
                setCurrency(next)
                setPricingSource(next === 'CNY' ? 'basellm' : 'models.dev')
              }}
            >
              <option value="USD">USD 美元</option>
              <option value="CNY">CNY 人民币</option>
            </select>
          </label>
          <label>
            批量价格数据源
            <select
              value={pricingSource}
              onChange={(e) => {
                invalidate()
                setPricingSource(e.target.value as 'models.dev' | 'basellm')
              }}
            >
              <option value="models.dev" disabled={currency === 'CNY'}>
                Models.dev（仅 USD）
              </option>
              <option value="basellm">basellm / llm-metadata</option>
            </select>
          </label>
          <label>
            变化预览模式
            <select
              disabled={submitted || busy}
              value={mode}
              onChange={(e) => {
                setMode(e.target.value)
                if (review) selectDefaults(review, e.target.value)
              }}
            >
              <option value="fill">补全缺失与可补能力</option>
              <option value="update">更新已有值</option>
            </select>
          </label>
        </div>
        <p>
          {mode === 'fill'
            ? '保留已有参数和单价；与单模型补全一致，缺少图片能力、false / 空推理档可获得可靠建议。倍率基价保持。'
            : '可选择覆盖已有人工值；目录缺失字段仍保留，不自动删除。倍率参考需单独勾选整份快照。'}
        </p>
        <button type="button" disabled={busy || !selected.length} onClick={() => void check()}>
          {busy ? '正在批量核对…' : '获取最新目录并预览'}
        </button>
      </fieldset>
      {error && (
        <p className="dmm-error" role="alert">
          {error}
        </p>
      )}
      {review && (
        <div className="dmm-batch-results" aria-label="批量核对结果">
          <p role="status">
            已核对 {review.rows.length} 个模型 · {new Date(review.checkedAt).toLocaleString()}
          </p>
          {stale && <p role="alert">配置或连接已变化，以下结果可能过期，请重新获取预览。</p>}
          {review.warnings.map((warning) => (
            <p role="alert" key={warning}>
              {warning}
            </p>
          ))}
          {review.rows.map((row) => {
            const choice = choices.find((choice) => batchKey(choice) === batchKey(row)) ?? {
              provider: row.provider,
              id: row.id,
              fields: [],
              prices: [],
              updateReference: false,
            }
            const available = availableSelection(row, mode)
            const parameters = row.parameters.filter((field) => choice.fields.includes(field.key))
            const priceChanges = row.priceChanges.filter((field) =>
              row.priceMode === 'multiplier' ? choice.updateReference : choice.prices.includes(field.key),
            )
            const count = parameters.length + choice.prices.length + (choice.updateReference ? 1 : 0)
            return (
              <details className="dmm-batch-row" key={keyOf(row)}>
                <summary>
                  {row.provider} / {row.name} ({row.id}) · {row.error ? '无法核对' : `${count} 项预览变化`}
                </summary>
                <fieldset disabled={saveBusy || submitted || stale}>
                  <label className="dmm-check">
                    <input
                      type="checkbox"
                      aria-label={`选择模型 ${row.provider} / ${row.id} 的全部可用变化`}
                      checked={hasSelection(choice)}
                      ref={(element) => {
                        if (element)
                          element.indeterminate =
                            hasSelection(choice) &&
                            (choice.fields.length < available.fields.length ||
                              choice.prices.length < available.prices.length ||
                              (available.updateReference && !choice.updateReference))
                      }}
                      disabled={!hasSelection(available)}
                      onChange={(e) =>
                        changeChoice(
                          e.target.checked ? available : { ...choice, fields: [], prices: [], updateReference: false },
                        )
                      }
                    />
                    选择此模型的全部可用变化{available.updateReference ? '（包括整份倍率快照）' : ''}
                  </label>
                  {row.error ? (
                    <p role="alert">{row.error}</p>
                  ) : (
                    <>
                      {row.protectedPreset && <p>受保护预设：后续保存参数仍需明确允许本次覆盖。</p>}
                      <p>
                        {row.parameterMessage} · {row.priceMessage}
                      </p>
                      {row.parameters.length > 0 && (
                        <table>
                          <caption>模型参数</caption>
                          <thead>
                            <tr>
                              <th scope="col">字段</th>
                              <th scope="col">当前</th>
                              <th scope="col">目录建议</th>
                              <th scope="col">本模式预览</th>
                            </tr>
                          </thead>
                          <tbody>
                            {row.parameters.map((field) => (
                              <tr key={field.key}>
                                <th scope="row">
                                  <label className="dmm-check">
                                    <input
                                      type="checkbox"
                                      aria-label={`保存 ${row.provider} / ${row.id} 的${fieldLabels[field.key]}`}
                                      checked={choice.fields.includes(field.key)}
                                      disabled={!available.fields.includes(field.key)}
                                      onChange={(e) =>
                                        changeChoice({
                                          ...choice,
                                          fields: e.target.checked
                                            ? [...choice.fields, field.key]
                                            : choice.fields.filter((key) => key !== field.key),
                                        })
                                      }
                                    />
                                    {fieldLabels[field.key]}
                                  </label>
                                </th>
                                <td>{field.before}</td>
                                <td>{field.after}</td>
                                <td>{parameters.includes(field) ? field.after : '保留当前值'}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      )}
                      {parameters.some((field) => field.key === 'maxTokens') && (
                        <p>最大输出变化也会改变每次请求的默认输出上限；实际保存时需再次确认。</p>
                      )}
                      {row.priceMode === 'multiplier' && (
                        <>
                          <label className="dmm-check">
                            <input
                              type="checkbox"
                              checked={choice.updateReference}
                              disabled={!available.updateReference}
                              aria-label={`更新 ${row.provider} / ${row.id} 的整份倍率参考快照`}
                              onChange={(e) => changeChoice({ ...choice, updateReference: e.target.checked })}
                            />
                            确认更新整份倍率参考快照（保留倍率与备用手动单价）
                          </label>
                          <p>
                            已保存基价：
                            {priceKeys
                              .map(
                                (key) =>
                                  `${priceLabels[key]} ${formatPrice(row.savedReferencePrices?.[key], row.currentCurrency ?? currency)}`,
                              )
                              .join(' · ')}
                          </p>
                        </>
                      )}
                      <table>
                        <caption>
                          每百万 tokens 单价
                          {row.priceMode === 'multiplier' ? ` · 倍率 ${row.multiplier ?? '未知'}×` : ''}
                        </caption>
                        <thead>
                          <tr>
                            <th scope="col">字段</th>
                            <th scope="col">当前（{row.currentCurrency ?? currency}）</th>
                            <th scope="col">
                              {row.priceMode === 'multiplier' ? '最新基价' : '目录参考'}（{currency}）
                            </th>
                            <th scope="col">本模式预览（{row.currentCurrency ?? currency}）</th>
                          </tr>
                        </thead>
                        <tbody>
                          {priceKeys.map((key) => {
                            const change = priceChanges.find((field) => field.key === key)
                            return (
                              <tr key={key}>
                                <th scope="row">
                                  {row.priceMode === 'multiplier' ? (
                                    priceLabels[key]
                                  ) : (
                                    <label className="dmm-check">
                                      <input
                                        type="checkbox"
                                        aria-label={`保存 ${row.provider} / ${row.id} 的${priceLabels[key]}单价`}
                                        checked={choice.prices.includes(key)}
                                        disabled={!available.prices.includes(key)}
                                        onChange={(e) =>
                                          changeChoice({
                                            ...choice,
                                            prices: e.target.checked
                                              ? [...choice.prices, key]
                                              : choice.prices.filter((field) => field !== key),
                                          })
                                        }
                                      />
                                      {priceLabels[key]}
                                    </label>
                                  )}
                                </th>
                                <td>{formatPrice(row.currentPrices[key], row.currentCurrency ?? currency)}</td>
                                <td>{formatPrice(row.referencePrices[key], currency)}</td>
                                <td>
                                  {formatPrice(
                                    change?.after ?? row.currentPrices[key],
                                    row.currentCurrency ?? currency,
                                  )}
                                </td>
                              </tr>
                            )
                          })}
                        </tbody>
                      </table>
                      {row.referenceSource && (
                        <p>
                          价格来源：{row.referenceSource.provider} / {row.referenceSource.model} ·{' '}
                          {new Date(row.referenceSource.fetchedAt).toLocaleString()}
                        </p>
                      )}
                    </>
                  )}
                </fieldset>
              </details>
            )
          })}
          <fieldset disabled={saveBusy || (submitted && outcome?.complete === true)} className="dmm-batch-save">
            {!submitted && requiresCap && (
              <label className="dmm-check">
                <input type="checkbox" checked={acceptCap} onChange={(e) => setAcceptCap(e.target.checked)} />
                确认本批最大输出变化同时更新每次请求的默认输出上限
              </label>
            )}
            {!submitted && requiresPreset && (
              <label className="dmm-check">
                <input type="checkbox" checked={acceptPreset} onChange={(e) => setAcceptPreset(e.target.checked)} />
                允许本次批量覆盖受保护预设参数
              </label>
            )}
            {!submitted && (
              <label className="dmm-check">
                <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
                已核对所选模型与字段，确认写入配置
              </label>
            )}
            <p>
              参数与价格分别保存，不是跨命名空间事务；失败时分别报告结果。
              {review.expiresAt ? `本次预览有效至 ${new Date(review.expiresAt).toLocaleString()}。` : ''}
            </p>
            {review.writable === false && <p>当前配置只读，不能保存。</p>}
            <button
              type="button"
              disabled={
                saveBusy ||
                !review.ticket ||
                review.writable === false ||
                !selectedChanges.length ||
                (!submitted &&
                  (stale || !confirmed || (requiresCap && !acceptCap) || (requiresPreset && !acceptPreset))) ||
                outcome?.complete ||
                (submitted && outcome?.retryable === false)
              }
              onClick={() => void save()}
            >
              {saveBusy ? '正在保存本批…' : submitted ? '重试未完成的批量保存' : '确认保存本批选中变化'}
            </button>
            {outcome && (
              <p role={outcome.complete ? 'status' : 'alert'}>
                参数：{outcome.models === 'saved' ? '已保存' : outcome.models === 'skipped' ? '未选择' : '未完成'}
                ；价格：{outcome.prices === 'saved' ? '已保存' : outcome.prices === 'skipped' ? '未选择' : '未完成'}。
                {outcome.message}
              </p>
            )}
          </fieldset>
        </div>
      )}
    </details>
  )
}
