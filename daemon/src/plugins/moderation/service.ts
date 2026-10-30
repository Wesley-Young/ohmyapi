import { type Disposable, serviceToken } from '@fraqjs/kernel';
import { and, asc, count, desc, eq, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';

import type { ModerationConfig } from '../../config.ts';
import { AppError } from '../../core/errors.ts';
import { type EventLogger, errorDetails, formatEvent, safeErrorMessage } from '../../core/logging.ts';
import { toPage } from '../../core/pagination.ts';
import type { CredentialVault } from '../../core/vault.ts';
import { recordAudit } from '../auth/audit.ts';
import type { AuthService, Principal } from '../auth/service.ts';
import type { Database } from '../database/client.ts';
import { paginate } from '../database/query.ts';
import { channelEndpoints, channels, moderationSessions, moderationSettings, users } from '../database/schema/index.ts';
import type { OutboundHttp } from '../outbound/index.ts';
import { defaultRules, type JudgeSettings, ModerationJudge } from './judge.ts';
import type { ModerationSampler, StoredContent } from './sampler.ts';
import type { ModerationListInput, ModerationSettingsInput } from './schemas.ts';

type SessionRow = typeof moderationSessions.$inferSelect;

/** 审核失败的重试次数上限，超过后标记为失败。 */
const maxAttempts = 3;
const purgeIntervalMs = 3_600_000;
const alertVerdicts = ['suspect', 'violation'] as const;
const alerts = () => and(inArray(moderationSessions.verdict, alertVerdicts), isNull(moderationSessions.acknowledgedAt));

/**
 * 内容审计：定时把空闲的抽样会话写入队列，领取待审会话调用审核接口，到期清除内容。
 * 审计只产生预警，不对用户、Key 或渠道采取操作。多个实例通过行锁和租约分担队列。
 */
export class ModerationService implements Disposable {
  static readonly token = serviceToken<ModerationService>('ohmyapi/moderation');
  private readonly db: Database;
  private readonly auth: AuthService;
  private readonly vault: CredentialVault;
  private readonly sampler: ModerationSampler;
  private readonly judge: ModerationJudge;
  private readonly config: ModerationConfig;
  private readonly logger: EventLogger;
  private settings?: JudgeSettings;
  private ticking?: Promise<void>;
  private purgedAt = 0;
  private stopped = false;
  constructor(deps: {
    db: Database;
    auth: AuthService;
    vault: CredentialVault;
    outbound: OutboundHttp;
    sampler: ModerationSampler;
    config: ModerationConfig;
    logger: EventLogger;
  }) {
    this.db = deps.db;
    this.auth = deps.auth;
    this.vault = deps.vault;
    this.sampler = deps.sampler;
    this.config = deps.config;
    this.logger = deps.logger;
    this.judge = new ModerationJudge({ db: deps.db, vault: deps.vault, outbound: deps.outbound, config: deps.config });
  }

  async start() {
    await this.loadSettings();
  }

  /** 定时任务：前一轮未结束时不重复执行。 */
  tick() {
    if (this.stopped) return;
    this.ticking ??= this.run().finally(() => {
      this.ticking = undefined;
    });
    return this.ticking;
  }

  /** 等待进行中的一轮结束，再把内存中的会话写入队列。 */
  async dispose() {
    this.stopped = true;
    await this.ticking;
    await this.sampler.flush(true);
  }

  private async run() {
    try {
      await this.loadSettings();
      await this.sampler.flush();
      if (this.settings) await this.review(this.settings);
      if (Date.now() - this.purgedAt >= purgeIntervalMs) {
        await this.purge();
        this.purgedAt = Date.now();
      }
    } catch (error) {
      this.logger.error(
        formatEvent('内容审计任务失败', { activeSessions: this.sampler.activeSessions, ...errorDetails(error) }),
      );
    }
  }

  private async loadSettings() {
    const [row] = await this.db.select().from(moderationSettings).where(eq(moderationSettings.id, 1));
    this.settings =
      row?.channelId && row.model ? { channelId: row.channelId, model: row.model, rules: row.rules } : undefined;
    this.sampler.ready = Boolean(this.settings);
  }

  /** 领取一批待审会话；运行中但租约过期的会话（实例中断）重新领取。 */
  private async review(settings: JudgeSettings) {
    const leaseMs = this.config.timeoutMs * 2;
    const claimed = await this.db.transaction(async (tx) => {
      const rows = await tx
        .select({ id: moderationSessions.id })
        .from(moderationSessions)
        .where(
          and(
            inArray(moderationSessions.status, ['pending', 'running']),
            or(isNull(moderationSessions.lockedUntil), lt(moderationSessions.lockedUntil, sql`now()`)),
          ),
        )
        .orderBy(asc(moderationSessions.lastSeenAt))
        .limit(this.config.concurrency)
        .for('update', { skipLocked: true });
      if (!rows.length) return [];
      return tx
        .update(moderationSessions)
        .set({
          status: 'running',
          attempts: sql`${moderationSessions.attempts} + 1`,
          lockedUntil: sql`now() + ${leaseMs} * interval '1 millisecond'`,
        })
        .where(
          inArray(
            moderationSessions.id,
            rows.map((row) => row.id),
          ),
        )
        .returning();
    });
    await Promise.allSettled(claimed.map((row) => this.reviewSession(settings, row)));
  }

  private async reviewSession(settings: JudgeSettings, row: SessionRow) {
    const running = and(eq(moderationSessions.id, row.id), eq(moderationSessions.status, 'running'));
    try {
      if (!row.contentEncrypted) throw new Error('内容已清除');
      const content = JSON.parse(this.vault.decrypt(row.contentEncrypted)) as StoredContent;
      const result = await this.judge.judge(settings, content, row.requestCount);
      await this.db
        .update(moderationSessions)
        .set({
          status: 'done',
          verdict: result.verdict,
          category: result.category,
          severity: result.severity,
          violationScore: result.violationScore,
          answers: result.answers,
          auditModel: result.model,
          decidedAt: new Date(),
          lockedUntil: null,
          lastError: null,
        })
        .where(running);
      if (result.verdict !== 'pass')
        this.logger.warn(
          formatEvent('内容审计预警', {
            moderationId: row.id,
            userId: row.userId,
            channelId: row.entryChannelId,
            verdict: result.verdict,
            category: result.category,
            severity: result.severity,
            violationScore: result.violationScore,
          }),
        );
    } catch (error) {
      const failed = row.attempts >= maxAttempts;
      const message = (safeErrorMessage(error) ?? '审核失败').slice(0, 500);
      await this.db
        .update(moderationSessions)
        .set({
          status: failed ? 'failed' : 'pending',
          lastError: message,
          // 重试间隔随次数增加。
          lockedUntil: failed ? null : new Date(Date.now() + row.attempts * 60_000),
        })
        .where(running)
        .catch(() => {});
      this.logger.warn(
        formatEvent('内容审计失败', {
          moderationId: row.id,
          attempt: row.attempts,
          nextAction: failed ? 'give_up' : 'retry',
          ...errorDetails(error),
        }),
      );
    }
  }

  /** 清除到期的内容：通过的和失败的按 retentionDays，已确认的预警按 alertRetentionDays；判定结果保留。 */
  private async purge() {
    const day = 86_400_000;
    const passedBefore = new Date(Date.now() - this.config.retentionDays * day);
    const alertsBefore = new Date(Date.now() - this.config.alertRetentionDays * day);
    const rows = await this.db
      .update(moderationSessions)
      .set({ contentEncrypted: null, contentPurgedAt: new Date() })
      .where(
        and(
          isNotNull(moderationSessions.contentEncrypted),
          or(
            and(eq(moderationSessions.verdict, 'pass'), lt(moderationSessions.decidedAt, passedBefore)),
            and(eq(moderationSessions.status, 'failed'), lt(moderationSessions.lastSeenAt, passedBefore)),
            and(
              inArray(moderationSessions.verdict, alertVerdicts),
              lt(moderationSessions.acknowledgedAt, alertsBefore),
            ),
          ),
        ),
      )
      .returning({ id: moderationSessions.id });
    if (rows.length) this.logger.info(formatEvent('内容审计清除过期内容', { count: rows.length }));
  }

  async list(input: ModerationListInput) {
    const entry = alias(channels, 'entry_channel');
    const execution = alias(channels, 'execution_channel');
    const rows = await paginate(
      this.db
        .select({
          session: moderationSessions,
          username: users.username,
          entryChannel: entry.name,
          executionChannel: execution.name,
        })
        .from(moderationSessions)
        .innerJoin(users, eq(users.id, moderationSessions.userId))
        .innerJoin(entry, eq(entry.id, moderationSessions.entryChannelId))
        .innerJoin(execution, eq(execution.id, moderationSessions.executionChannelId))
        .where(input.filter === 'alerts' ? alerts() : undefined)
        .orderBy(desc(moderationSessions.createdAt), desc(moderationSessions.id))
        .$dynamic(),
      input.page,
    );
    return toPage(
      rows.map(({ session: s, username, entryChannel, executionChannel }) => ({
        id: s.id,
        user: { id: s.userId, username },
        entryChannel,
        executionChannel: s.executionChannelId === s.entryChannelId ? null : executionChannel,
        endpoint: s.endpoint,
        requestedModel: s.requestedModel,
        reason: s.reason,
        requestCount: s.requestCount,
        lastRequestId: s.lastRequestId,
        firstSeenAt: s.firstSeenAt.toISOString(),
        lastSeenAt: s.lastSeenAt.toISOString(),
        status: s.status,
        verdict: s.verdict,
        category: s.category,
        severity: s.severity,
        violationScore: s.violationScore,
        lastError: s.lastError,
        decidedAt: s.decidedAt?.toISOString() ?? null,
        acknowledgedAt: s.acknowledgedAt?.toISOString() ?? null,
        contentAvailable: s.contentEncrypted !== null,
        truncated: s.truncated,
        imageCount: s.imageCount,
      })),
    );
  }

  async alertCount() {
    const [row] = await this.db.select({ value: count() }).from(moderationSessions).where(alerts());
    return row?.value ?? 0;
  }

  /** 解密送审内容；每次查看都记录审计日志。 */
  async content(principal: Principal, id: string) {
    return this.auth.authorized(principal, { admin: true }, async (tx, actor) => {
      const [row] = await tx.select().from(moderationSessions).where(eq(moderationSessions.id, id));
      if (!row) throw new AppError('not_found', '审计记录不存在');
      if (!row.contentEncrypted) throw new AppError('not_found', '内容已超过保留期并清除');
      await recordAudit(tx, {
        actorId: actor.id,
        action: 'moderation.view_content',
        targetType: 'moderation_session',
        targetId: row.id,
        metadata: { userId: row.userId },
      });
      const content = JSON.parse(this.vault.decrypt(row.contentEncrypted)) as StoredContent;
      return { content, answers: row.answers };
    });
  }

  async acknowledge(principal: Principal, ids: string[]) {
    return this.auth.authorized(principal, { admin: true }, async (tx, actor) => {
      const rows = await tx
        .update(moderationSessions)
        .set({ acknowledgedAt: new Date(), acknowledgedBy: actor.id })
        .where(and(inArray(moderationSessions.id, ids), alerts()))
        .returning({ id: moderationSessions.id, userId: moderationSessions.userId });
      for (const row of rows)
        await recordAudit(tx, {
          actorId: actor.id,
          action: 'moderation.acknowledge',
          targetType: 'moderation_session',
          targetId: row.id,
          metadata: { userId: row.userId },
        });
      return { count: rows.length };
    });
  }

  /** 审核设置，以及可选的审核渠道：未删除、支持 System One 端点的 API 渠道。 */
  async getSettings() {
    const [[row], candidates] = await Promise.all([
      this.db.select().from(moderationSettings).where(eq(moderationSettings.id, 1)),
      this.db
        .select({ id: channels.id, name: channels.name, enabled: channels.enabled })
        .from(channels)
        .innerJoin(
          channelEndpoints,
          and(eq(channelEndpoints.channelId, channels.id), eq(channelEndpoints.endpoint, '/v1/systemone')),
        )
        .where(and(eq(channels.type, 'api'), isNull(channels.deletedAt)))
        .orderBy(asc(channels.name)),
    ]);
    return {
      channelId: row?.channelId ?? null,
      model: row?.model ?? null,
      rules: row?.rules ?? '',
      defaultRules,
      channels: candidates,
    };
  }

  async saveSettings(principal: Principal, input: ModerationSettingsInput) {
    const values = {
      channelId: input.channelId,
      model: input.channelId ? input.model : null,
      rules: input.rules,
    };
    await this.auth.authorized(principal, { admin: true }, async (tx, actor) => {
      if (input.channelId) {
        const [channel] = await tx
          .select({ id: channels.id })
          .from(channels)
          .innerJoin(
            channelEndpoints,
            and(eq(channelEndpoints.channelId, channels.id), eq(channelEndpoints.endpoint, '/v1/systemone')),
          )
          .where(and(eq(channels.id, input.channelId), eq(channels.type, 'api'), isNull(channels.deletedAt)))
          .for('share', { of: channels });
        if (!channel) throw new AppError('bad_request', '审核渠道需为支持 /v1/systemone 的 API 渠道');
      }
      await tx
        .insert(moderationSettings)
        .values({ id: 1, ...values, updatedBy: actor.id })
        .onConflictDoUpdate({
          target: moderationSettings.id,
          set: { ...values, updatedBy: actor.id, updatedAt: new Date() },
        });
      await recordAudit(tx, {
        actorId: actor.id,
        action: 'moderation.settings',
        // 设置只有一行，以操作人作为审计目标。
        targetType: 'moderation_settings',
        targetId: actor.id,
        metadata: { channelId: values.channelId, model: values.model, rulesChars: values.rules.length },
      });
    });
    await this.loadSettings();
    return { success: true };
  }
}
