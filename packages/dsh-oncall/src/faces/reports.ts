/**
 * `oncall_report`: the worker's one way to change what the Case says.
 *
 * ### Why a tool and not free text
 *
 * Without it the executor would have to infer "done" from prose, and the one thing a
 * report must be is unambiguous: `ready` closes the Case, `blocked` asks a person,
 * `failed` says the work cannot finish. The vocabulary is `dsh-superagent`'s
 * `ReportState` (`docs/001-domain.md:60`, `app/tools/executor.ts:75`).
 *
 * ### Why it refuses instead of inventing a Case
 *
 * Registered globally (a tool that appears and disappears per session makes the
 * model's behaviour depend on who it is), so the handler is where "is this caller a
 * worker?" is answered: the session must be one this plugin created for a Case, and
 * that Case must still be open with a running assignment. Anything else is refused
 * with a named reason the model can read and act on.
 *
 * ### What it does not do
 *
 * It never writes a table itself: it hands the report to the executor, which owns
 * `steps` and `cases` (`docs/design/oncall-v0-architecture.md` 二之一). The tool only
 * validates the shape a model can be wrong about.
 *
 * Note: 为何工具只交报告、不写表 —— 见 docs/design/oncall-v0-architecture.md 四节 3。
 */

import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { Report, ReportState } from '../contract/types.ts'

/** The tool's name. One place, so the description and the refusal agree. */
export const REPORT_TOOL = 'oncall_report'

/** The states a worker may claim. `waiting` is the executor's own word, never the model's. */
type ReportableState = Exclude<ReportState, 'waiting'>
const REPORTABLE: readonly ReportableState[] = ['progress', 'ready', 'blocked', 'failed', 'dropped']

const isReportable = (state: ReportState | undefined): state is ReportableState =>
  state !== undefined && REPORTABLE.includes(state as ReportableState)

export interface ReportArgs {
  readonly state?: ReportState
  readonly summary?: string
  readonly question?: string
}

/** What the executor answers: whether the report landed, and why not when it did not. */
export type ReportVerdict = { readonly ok: true; readonly seq: number } | { readonly ok: false; readonly reason: string }

/** The one dependency the tool has on the rest of the plugin. */
export interface ReportSink {
  submitReport(input: { readonly sessionId: string; readonly report: Report }): Promise<ReportVerdict>
}

export interface ReportToolFaces {
  readonly tools: { register(definition: unknown): unknown }
}

function refuse(message: string, code: string): never {
  throw new HarnessError(`oncall report: ${message}`, code)
}

/**
 * Register the tool. Returns the registry's disposer, owned by the calling fiber.
 *
 * The description is the model's only contract, so it says the two things a model
 * gets wrong: that `ready` ends the Case (so it must be true), and that `blocked`
 * needs one concrete question a person can answer.
 */
export function registerReportTool(faces: ReportToolFaces, sink: ReportSink): unknown {
  return faces.tools.register(defineTool({
    name: REPORT_TOOL,
    description:
      '报告这次派工的进展。state=ready 表示这件事做完了（会关闭这个 Case 并回复 issue）；'
      + 'blocked 表示必须由人决定（question 里只写一个问题）；failed 表示做不到（说明原因）；'
      + 'dropped 表示这件事不做了；progress 只更新进度，不会回复 issue。没调用本工具就结束回合，等于说"还没做完"。',
    parameters: {
      state: {
        type: 'string',
        required: true,
        enum: [...REPORTABLE],
        description: 'ready | blocked | failed | dropped | progress',
      },
      summary: {
        type: 'string',
        required: true,
        description: '面向人的说明：做了什么、还差什么。不要写给你自己的备忘。',
      },
      question: {
        type: 'string',
        description: 'state=blocked 时必填：一个具体、人能直接回答的问题。',
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args: ReportArgs, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }],
    },
    execute: async (args: ReportArgs, exec: ToolRunContext) => {
      const agent = exec.agent
      if (agent === undefined) refuse('it needs a calling agent.', 'ONCALL_REPORT_NO_AGENT')

      const state = args.state
      if (!isReportable(state)) refuse(`state must be one of ${REPORTABLE.join(', ')}.`, 'ONCALL_REPORT_BAD_STATE')
      const summary = (args.summary ?? '').trim()
      if (summary === '') refuse('summary must say what happened, in one or two sentences.', 'ONCALL_REPORT_NO_SUMMARY')

      // The four variants are built here, once: a `blocked` report without its
      // question is not a question a person can answer, and a `failed` one without a
      // code would reach the issue as "卡住了" with nothing to look up.
      let report: Report
      switch (state) {
        case 'blocked': {
          const question = (args.question ?? '').trim()
          if (question === '') refuse('a blocked report needs exactly one question a person can answer.', 'ONCALL_REPORT_NO_QUESTION')
          report = { state: 'blocked', summary, question }
          break
        }
        case 'failed':
          report = { state: 'failed', summary, code: 'REPORTED' }
          break
        case 'progress':
        case 'ready':
        case 'dropped':
          report = { state, summary }
          break
      }

      const verdict = await sink.submitReport({ sessionId: agent.session.id, report })
      if (!verdict.ok) refuse(verdict.reason, 'ONCALL_REPORT_REFUSED')
      return { recorded: true, state: report.state, seq: verdict.seq }
    },
  }))
}
