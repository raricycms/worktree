import { useState } from 'react';
import type { ReactElement } from 'react';
import type { AgentStep } from '@worktree/agent';
import { useI18n } from '../../i18n';
import { Loader, toolIcon } from './icons';

/** Localized names for the tool calls, keyed by wire name. Unknown tools show the wire name. */
const TOOL_LABEL_KEYS: Record<string, string> = {
  get_agenda: 'agent.tool.getAgenda',
  search_tasks: 'agent.tool.searchTasks',
  get_task: 'agent.tool.getTask',
  get_tree: 'agent.tool.getTree',
  list_rules: 'agent.tool.listRules',
  find_free_slots: 'agent.tool.findFreeSlots',
  suggest_tasks: 'agent.tool.suggestTasks',
  create_event: 'agent.tool.createEvent',
  create_task: 'agent.tool.createTask',
  create_tasks: 'agent.tool.createTasks',
  create_recurring: 'agent.tool.createRecurring',
  update_event: 'agent.tool.updateEvent',
  update_task: 'agent.tool.updateTask',
  complete_task: 'agent.tool.completeTask',
  cancel_event: 'agent.tool.cancelEvent',
  cancel_recurring: 'agent.tool.cancelRecurring',
  move_node: 'agent.tool.moveNode',
  delete_node: 'agent.tool.deleteNode',
  import_timetable: 'agent.tool.importTimetable',
  ask_user: 'agent.tool.askUser',
};

export function toolLabel(name: string): string {
  return TOOL_LABEL_KEYS[name] ?? name;
}

/**
 * One turn's tool use as a disclosure: collapsed to a count so the reply stays
 * readable, expanded to icon + localized name + one-line summary rows. Failed
 * rows carry the danger tint; `runningTool` appends the in-flight row so the
 * reader sees what is happening before the tool returns.
 */
export function ToolSteps({
  steps,
  runningTool = null,
  className,
}: {
  steps: AgentStep[];
  runningTool?: string | null;
  className?: string;
}): ReactElement {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const isRunning = runningTool !== null && runningTool !== undefined && runningTool !== '';
  const classes = ['agent-steps', open ? 'is-open' : '', className ?? ''].filter((name) => name !== '').join(' ');
  const runningRow = (
    <li className="agent-steps__item agent-steps__item--running" data-testid="agent-step-running">
      <Loader size={14} className="agent-steps__icon agent-steps__spinner" />
      <span className="agent-steps__name">{t(toolLabel(runningTool ?? ''))}</span>
      <span className="agent-steps__summary tiny muted">{t('agent.steps.working')}</span>
    </li>
  );

  if (isRunning && steps.length === 0) {
    return (
      <div className={`agent-steps is-open${className === undefined ? '' : ` ${className}`}`}>
        <ul className="agent-steps__list agent-steps__list--solo" aria-label={t('agent.steps.label')}>
          {runningRow}
        </ul>
      </div>
    );
  }

  return (
    <div className={classes}>
      <button
        type="button"
        className="btn btn--xs agent-steps__toggle"
        aria-expanded={open}
        onClick={() => setOpen((wasOpen) => !wasOpen)}
        data-testid="agent-steps-toggle"
      >
        {isRunning && <Loader size={13} className="agent-steps__spinner" />}
        <span>{t('agent.steps.count', { n: steps.length })}</span>
      </button>
      <div className="agent-steps__panel" inert={!open}>
        <ul className="agent-steps__list" aria-label={t('agent.steps.label')}>
          {steps.map((step, index) => {
            const Icon = toolIcon(step.tool);
            return (
              <li
                key={`${step.tool}-${index}`}
                className="agent-steps__item"
                data-ok={step.ok}
                data-testid="agent-step"
              >
                <Icon size={14} className="agent-steps__icon" />
                <span className="agent-steps__name">{t(toolLabel(step.tool))}</span>
                {step.summary !== '' && <span className="agent-steps__summary tiny muted">{step.summary}</span>}
              </li>
            );
          })}
          {isRunning && runningRow}
        </ul>
      </div>
    </div>
  );
}
