import { isFable, isLegacy, isOpus55, isSonnet5, progressDisplay } from './models.ts';
import { type Data, object, objects } from './tools.ts';

// 对齐 CPA 54946fa3 / claudeCodeCLIBetas，CC 2.1.280。
const claudeTokenCountingBeta = 'token-counting-2024-11-01';
const claudeFastModeBeta = 'fast-mode-2026-02-01';
const claudeOAuthBeta = 'oauth-2025-04-20';
const claudeCodeBeta = 'claude-code-20250219';
const claudeContext1MBeta = 'context-1m-2025-08-07';
const claudeMidConvSystemBeta = 'mid-conversation-system-2026-04-07';
const claudePerTurnControlBeta = 'per-turn-control-2026-07-01';
const claudePerTurnTimingBeta = 'timing-2026-09-09';
const claudeMidConvToolChangesBeta = 'mid-conversation-tool-changes-2026-07-01';
const claudeInlineToolsBeta = 'inline-tools-2026-09-15';
const claudeMidConvSystemClearAtBeta = 'mid-conversation-system-clear-at-2026-08-21';
const claudeDangerousToolUseBeta = 'dangerous-tool-use-2026-09-03';
const claudeAdvisorToolBeta = 'advisor-tool-2026-03-01';
const claudeAdvancedToolUseBeta = 'advanced-tool-use-2025-11-20';
const claudeEffortBeta = 'effort-2025-11-24';
const claudeServerSideFallbackBeta = 'server-side-fallback-2026-06-01';
const claudeFallbackCreditBeta = 'fallback-credit-2026-06-01';
const claudeStructuredOutputsBeta = 'structured-outputs-2025-12-15';
const claudeThinkingDisplayUpdatesBeta = 'thinking-display-updates-2026-08-18';
const claudeThinkingBindingBeta = 'thinking-binding-controls-2026-08-01';
const claudeThinkingResumptionBeta = 'thinking-resumption-2026-07-17';
const claudeExtendedCacheTTLBeta = 'extended-cache-ttl-2025-04-11';
const claudePromptCachingEvictBeta = 'prompt-caching-evict-2026-05-12';
const claudeCacheDiagnosisBeta = 'cache-diagnosis-2026-04-07';
const claudeRedactThinkingBeta = 'redact-thinking-2026-02-12';
const claudeAFKModeBeta = 'afk-mode-2026-01-31';
const constants = [
  'interleaved-thinking-2025-05-14',
  claudeRedactThinkingBeta,
  'thinking-token-count-2026-05-13',
  'context-management-2025-06-27',
  'prompt-caching-scope-2026-01-05',
];
const managed = new Set([
  ...constants,
  claudeTokenCountingBeta,
  claudeFastModeBeta,
  claudeOAuthBeta,
  claudeCodeBeta,
  claudeContext1MBeta,
  claudeMidConvSystemBeta,
  claudePerTurnControlBeta,
  claudePerTurnTimingBeta,
  claudeMidConvToolChangesBeta,
  claudeInlineToolsBeta,
  claudeMidConvSystemClearAtBeta,
  claudeDangerousToolUseBeta,
  claudeAdvisorToolBeta,
  claudeAdvancedToolUseBeta,
  claudeEffortBeta,
  claudeServerSideFallbackBeta,
  claudeFallbackCreditBeta,
  claudeStructuredOutputsBeta,
  claudeThinkingDisplayUpdatesBeta,
  claudeThinkingBindingBeta,
  claudeThinkingResumptionBeta,
  claudeExtendedCacheTTLBeta,
  claudePromptCachingEvictBeta,
  claudeCacheDiagnosisBeta,
  claudeRedactThinkingBeta,
  claudeAFKModeBeta,
]);

export function claudeBetas(body: Data, requested: string[]) {
  const wants = new Set(requested);
  const betas = [claudeCodeBeta, claudeOAuthBeta];
  const add = (beta: string, condition: boolean) => {
    if (condition) betas.push(beta);
  };
  const model = String(body.model);
  const thinking = object(body.thinking);
  const output = object(body.output_config);
  const messages = objects(body.messages);
  const tools = objects(body.tools);
  add(claudeContext1MBeta, wants.has(claudeContext1MBeta));
  betas.push(
    ...constants.filter(
      (beta) =>
        beta !== claudeRedactThinkingBeta || !(typeof thinking?.display === 'string' && thinking.display.trim()),
    ),
  );
  add(claudeMidConvSystemBeta, !isLegacy(model));
  add(claudePerTurnControlBeta, wants.has(claudePerTurnControlBeta) || isOpus55(model) || isFable(model));
  add(
    claudePerTurnTimingBeta,
    wants.has(claudePerTurnTimingBeta) ||
      ((isOpus55(model) || isFable(model) || model.includes('mythos-5-1')) &&
        (output?.timing !== undefined || messages.some((m) => object(m.output_config)?.timing !== undefined))),
  );
  add(claudeMidConvToolChangesBeta, !isLegacy(model) && !isSonnet5(model));
  add(
    claudeInlineToolsBeta,
    !isLegacy(model) &&
      (wants.has(claudeInlineToolsBeta) ||
        messages.some((m) => objects(m.content).some((b) => b.type === 'tool_addition' && object(b.tool)?.definition))),
  );
  add(
    claudeAdvisorToolBeta,
    wants.has(claudeAdvisorToolBeta) || tools.some((t) => String(t.type).startsWith('advisor_')),
  );
  add(
    claudeAdvancedToolUseBeta,
    wants.has(claudeAdvancedToolUseBeta) ||
      tools.some(
        (t) =>
          String(t.type).startsWith('tool_search_tool_') ||
          t.defer_loading === true ||
          t.input_examples !== undefined ||
          t.allowed_callers !== undefined,
      ),
  );
  add(
    claudeMidConvSystemClearAtBeta,
    !isLegacy(model) &&
      (wants.has(claudeMidConvSystemClearAtBeta) ||
        progressDisplay(model) ||
        messages.some((m) => m.clear_at !== undefined)),
  );
  add(claudeDangerousToolUseBeta, wants.has(claudeDangerousToolUseBeta) || body.safeguards !== undefined);
  add(claudeEffortBeta, !model.includes('haiku') && thinking?.type !== 'disabled');
  add(claudeServerSideFallbackBeta, wants.has(claudeServerSideFallbackBeta) || body.fallbacks !== undefined);
  add(
    claudeFallbackCreditBeta,
    wants.has(claudeFallbackCreditBeta) || body.fallbacks !== undefined || body.fallback_credit_token !== undefined,
  );
  add(claudeStructuredOutputsBeta, wants.has(claudeStructuredOutputsBeta) || output?.format !== undefined);
  add(
    claudeThinkingBindingBeta,
    wants.has(claudeThinkingBindingBeta) ||
      thinking?.block_binding !== undefined ||
      (progressDisplay(model) && thinking?.type === 'adaptive'),
  );
  add(
    claudeThinkingDisplayUpdatesBeta,
    thinking?.type !== 'disabled' && (wants.has(claudeThinkingDisplayUpdatesBeta) || thinking?.display === 'updates'),
  );
  add(claudeThinkingResumptionBeta, wants.has(claudeThinkingResumptionBeta));
  add(claudeFastModeBeta, body.speed === 'fast');
  add(claudeAFKModeBeta, wants.has(claudeAFKModeBeta));
  betas.push(claudeExtendedCacheTTLBeta);
  add(
    claudePromptCachingEvictBeta,
    wants.has(claudePromptCachingEvictBeta) || JSON.stringify(body).includes('"evict_on_complete"'),
  );
  add(claudeCacheDiagnosisBeta, !!object(body.diagnostics));
  // CPA 保留未知 beta，已管理的 beta 只能由模型能力和最终请求体决定。
  for (const beta of requested) if (!managed.has(beta) && !betas.includes(beta)) betas.push(beta);
  return betas.join(',');
}
