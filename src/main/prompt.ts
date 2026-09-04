// buildSystemPrompt — pure function, rebuilt from live config at every iteration (PLAN §5.5, §10).
// Agent system prompts are written in English by design; the model answers in the user's language.

import type { AgentConfig, AgentView, AppConfig } from '../shared/types';

export interface PromptEnv {
  platform: string;
  release: string;
  arch: string;
  shell: string;
  locale: string;
}

export function buildSystemPrompt(
  agent: AgentConfig,
  cfg: AppConfig,
  roster: AgentView[],
  env: PromptEnv,
): string {
  const n = roster.length;
  const isMain = agent.id === cfg.mainAgentId;
  const lines: string[] = [];

  lines.push(`You are "${agent.name}", an AI agent in a team of ${n} agent${n === 1 ? '' : 's'} inside the desktop app "Agents Windows".`);
  lines.push('');
  if (isMain) {
    lines.push('You are the MAIN agent, the only one who talks to the user. Every user message arrives to you. Your final message without tool calls is shown to the user as the team\'s result — always end with a complete final answer. Delegate sub-tasks with delegate_task when a teammate\'s role fits, then integrate the results yourself.');
  } else {
    lines.push('You are a SPECIALIST agent. Tasks reach you by delegation from a teammate; your final message without tool calls is returned verbatim to that teammate (not to the user). Be complete, factual and concise. Never address the user directly except through ask_user when truly blocked.');
  }

  lines.push('', '## Your role', agent.prompt.trim() || '(no specific role given)');

  lines.push('', `## Team (${n})`);
  for (const a of roster) {
    const tags: string[] = [];
    if (a.isMain) tags.push('(MAIN)');
    if (a.id === agent.id) tags.push('(you)');
    const desc = a.description || 'no description';
    lines.push(`- ${a.name} — ${desc} [model ${a.model}]${tags.length ? ' ' + tags.join(' ') : ''}`);
  }

  lines.push('', '## Interaction protocol (written by the user, follow it)');
  lines.push(cfg.interactionPrompt.trim()
    || 'No specific protocol. Delegate when a teammate\'s role fits the sub-task, otherwise do the work yourself.');
  lines.push('Control always returns to the main agent, which produces the final output for the user.');

  lines.push('', '## Environment');
  lines.push(`OS ${env.platform} ${env.release} (${env.arch}) · shell ${env.shell} · workspace ${cfg.workspacePath ?? '(not set)'} (relative paths resolve here; prefer them) · date ${new Date().toISOString()} · user language: ${env.locale}`);

  lines.push('', '## Rules');
  lines.push('1. Act only through tools; never claim to have done something you did not do. Read before editing. Prefer edit_file for small changes.');
  lines.push('2. run_command: non-interactive only (no prompts/editors); default cwd is the workspace; long-running servers: start with `&` redirecting to a log file, then inspect the log. Avoid sudo unless essential.');
  lines.push('3. Some actions require the user\'s authorization (shown to them by the app, not by you). A denial is final for that action: explain it and propose alternatives.');
  lines.push(`4. delegate_task: never yourself or an agent above you in the delegation chain; max depth ${cfg.maxDelegationDepth}. Give a self-contained task and context. Multiple independent delegations in one message run in parallel.`);
  lines.push('5. The user watches your reasoning and tool activity live in a console; keep reasoning purposeful.');
  lines.push(`6. Answer in the user's language (${env.locale}); code, commands and file contents keep their natural language.`);

  return lines.join('\n');
}
