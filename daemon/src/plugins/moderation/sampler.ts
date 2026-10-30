import { serviceToken } from '@fraqjs/kernel';
import { and, count, eq, sql } from 'drizzle-orm';

import type { ModerationConfig } from '../../config.ts';
import { type EventLogger, errorDetails, formatEvent } from '../../core/logging.ts';
import type { CredentialVault } from '../../core/vault.ts';
import type { Database } from '../database/client.ts';
import { type channels, type Endpoint, moderationSessions } from '../database/schema/index.ts';
import {
  contentChars,
  contentFingerprint,
  fitContent,
  type ModerationContent,
  mergeContent,
  OutputCapture,
  requestContent,
} from './capture.ts';

import { createHmac } from 'node:crypto';

type Channel = typeof channels.$inferSelect;
type ChannelPolicy = Pick<
  Channel,
  'id' | 'type' | 'moderationSamplePpm' | 'moderationDailyFloor' | 'moderationIncludeOutput'
>;

export type SampleInput = {
  requestId: string;
  userId: string;
  apiKeyId: string;
  endpoint: Endpoint;
  requestedModel: string;
  /** 协议约定的会话标识；没有时按会话开头的内容识别。 */
  session?: { family: string; value: string };
  userAgent: string | null;
  body: Record<string, unknown>;
  entry: ChannelPolicy;
  execution: ChannelPolicy;
};

/** 抽中请求的采集句柄：转发时观察输出，请求结束时调用 finish。 */
export type ModerationCapture = { output?: OutputCapture; finish(): void };

/** 送审时附带的会话信息，不含用户身份。 */
export type SessionFacts = {
  endpoint: Endpoint;
  model: string;
  channelType: Channel['type'];
  client: string | null;
};

type ActiveSession = {
  key: string;
  userId: string;
  apiKeyId: string;
  sessionHash: string;
  day: string;
  reason: 'rate' | 'floor';
  entryChannelId: string;
  executionChannelId: string;
  facts: SessionFacts;
  includeOutput: boolean;
  content: ModerationContent;
  requestCount: number;
  lastRequestId?: string;
  inflight: number;
  firstSeenAt: Date;
  lastSeenAt: Date;
};

/** 未抽中的会话只记请求数，用于保底抽样；已送审的会话当天不再抽样。 */
type SeenSession = { day: string; requests: number; done: boolean };

const seenCapacity = 100_000;
const today = () => new Date().toISOString().slice(0, 10);

/** User-Agent 中的产品名，用于区分客户端类型。 */
function clientName(userAgent: string | null) {
  const product = userAgent?.trim().split(/[\s/]/, 1)[0];
  return product ? product.slice(0, 64) : null;
}

/**
 * 按用户和 session 抽样：同一会话整段抽中或整段不抽，由服务端密钥、日期、用户和会话的哈希决定，
 * 多个实例和重启后结果一致。用户当天审计数未达到渠道保底数时，抽取请求数达到下限的会话。
 * 抽中会话的内容在内存中合并，空闲后加密写入待审队列。
 */
export class ModerationSampler {
  static readonly token = serviceToken<ModerationSampler>('ohmyapi/moderation-sampler');
  /** 已配置审核渠道和模型；未配置时不采集内容。 */
  ready = false;
  private readonly db: Database;
  private readonly vault: CredentialVault;
  private readonly config: ModerationConfig;
  private readonly logger: EventLogger;
  private readonly secret: Buffer;
  private readonly active = new Map<string, ActiveSession>();
  private readonly seen = new Map<string, SeenSession>();
  /** 用户当天已审计的 session 数：先以本实例的计数为准，再与数据库中的数量取较大值。 */
  private readonly daily = new Map<string, number>();
  constructor(deps: {
    db: Database;
    vault: CredentialVault;
    config: ModerationConfig;
    encryptionKey: string;
    logger: EventLogger;
  }) {
    this.db = deps.db;
    this.vault = deps.vault;
    this.config = deps.config;
    this.logger = deps.logger;
    this.secret = createHmac('sha256', Buffer.from(deps.encryptionKey, 'hex'))
      .update('ohmyapi/moderation-sampling')
      .digest();
  }

  get activeSessions() {
    return this.active.size;
  }

  /** 网关在请求发往上游前调用；未抽中时返回 undefined。不抛出错误，不影响转发。 */
  sample(input: SampleInput): ModerationCapture | undefined {
    try {
      return this.sampleRequest(input);
    } catch (error) {
      this.logger.warn(formatEvent('内容审计采集失败', { requestId: input.requestId, ...errorDetails(error) }));
      return undefined;
    }
  }

  private sampleRequest(input: SampleInput): ModerationCapture | undefined {
    if (!this.ready) return;
    const { entry, execution } = input;
    const ppm = Math.max(entry.moderationSamplePpm, execution.moderationSamplePpm);
    const floor = Math.max(entry.moderationDailyFloor, execution.moderationDailyFloor);
    if (ppm === 0 && floor === 0) return;
    const content = requestContent(input.endpoint, input.body);
    if (!content) return;
    const day = today();
    const sessionHash = this.hash(
      input.session
        ? `session\0${input.session.family}\0${input.session.value}`
        : `prefix\0${contentFingerprint(content)}`,
    );
    const key = `${input.userId}:${sessionHash}`;
    const includeOutput = entry.moderationIncludeOutput || execution.moderationIncludeOutput;
    let session = this.active.get(key);
    if (!session) {
      const reason = this.decide(key, input.userId, sessionHash, day, ppm, floor);
      if (!reason) return;
      const now = new Date();
      session = {
        key,
        userId: input.userId,
        apiKeyId: input.apiKeyId,
        sessionHash,
        day,
        reason,
        entryChannelId: entry.id,
        executionChannelId: execution.id,
        facts: {
          endpoint: input.endpoint,
          model: input.requestedModel,
          channelType: execution.type,
          client: clientName(input.userAgent),
        },
        includeOutput,
        content: fitContent(content, this.config.maxContentChars, includeOutput),
        requestCount: 0,
        inflight: 0,
        firstSeenAt: now,
        lastSeenAt: now,
      };
      this.active.set(key, session);
      const dailyKey = `${input.userId}:${day}`;
      this.daily.set(dailyKey, (this.daily.get(dailyKey) ?? 0) + 1);
    } else {
      session.content = fitContent(
        mergeContent(session.content, content),
        this.config.maxContentChars,
        session.includeOutput,
      );
      session.executionChannelId = execution.id;
      session.facts.channelType = execution.type;
      session.lastSeenAt = new Date();
    }
    const current = session;
    current.inflight++;
    const output = current.includeOutput ? new OutputCapture() : undefined;
    let finished = false;
    return {
      output,
      finish: () => {
        if (finished) return;
        finished = true;
        current.inflight--;
        current.requestCount++;
        current.lastRequestId = input.requestId;
        current.lastSeenAt = new Date();
        if (output?.output)
          current.content = fitContent(
            { ...current.content, turns: [...current.content.turns, { role: 'assistant', text: output.output }] },
            this.config.maxContentChars,
            true,
          );
      },
    };
  }

  private hash(value: string) {
    return createHmac('sha256', this.secret).update(value).digest('hex');
  }

  /** 决定是否抽中新会话：先按比例，再按保底；受每用户每天上限和内存中的会话上限约束。 */
  private decide(key: string, userId: string, sessionHash: string, day: string, ppm: number, floor: number) {
    let seen = this.seen.get(key);
    if (!seen || seen.day !== day) seen = { day, requests: 0, done: false };
    seen.requests++;
    this.seen.delete(key);
    this.seen.set(key, seen);
    if (this.seen.size > seenCapacity) {
      const oldest = this.seen.keys().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
    if (seen.done || this.active.size >= this.config.maxActiveSessions) return;
    const audited = this.dailyCount(userId, day);
    if (audited >= this.config.userDailyLimit) return;
    const draw = Number.parseInt(this.hash(`draw\0${day}\0${userId}\0${sessionHash}`).slice(0, 8), 16) / 0x1_0000_0000;
    if (draw * 1_000_000 < ppm) return 'rate';
    if (audited < floor && seen.requests >= this.config.floorMinRequests) return 'floor';
  }

  private dailyCount(userId: string, day: string) {
    const dailyKey = `${userId}:${day}`;
    const known = this.daily.get(dailyKey);
    if (known !== undefined) return known;
    this.daily.set(dailyKey, 0);
    // 首次遇到时异步读取数据库中的数量（包括其他实例和重启前送审的会话），读取完成前按 0 计。
    void this.db
      .select({ value: count() })
      .from(moderationSessions)
      .where(and(eq(moderationSessions.userId, userId), eq(moderationSessions.day, day)))
      .then(([row]) => this.daily.set(dailyKey, Math.max(this.daily.get(dailyKey) ?? 0, row?.value ?? 0)))
      .catch(() => {});
    if (this.daily.size > seenCapacity) {
      for (const k of this.daily.keys()) if (!k.endsWith(day)) this.daily.delete(k);
    }
    return 0;
  }

  /** 把空闲的会话写入待审队列；force 时写入全部已结束过请求的会话。 */
  async flush(force = false) {
    const idleBefore = Date.now() - this.config.idleMs;
    for (const session of [...this.active.values()]) {
      if (!session.lastRequestId) {
        // 首个请求仍在进行，或在发出前就失败了。
        if (session.inflight === 0 && session.lastSeenAt.getTime() < idleBefore) this.active.delete(session.key);
        continue;
      }
      if (!force && (session.inflight > 0 || session.lastSeenAt.getTime() >= idleBefore)) continue;
      this.active.delete(session.key);
      const seen = this.seen.get(session.key);
      if (seen && seen.day === session.day) seen.done = true;
      try {
        await this.write(session);
      } catch (error) {
        this.logger.error(
          formatEvent('内容审计入队失败', {
            userId: session.userId,
            requestId: session.lastRequestId,
            ...errorDetails(error),
          }),
        );
      }
    }
  }

  private async write(session: ActiveSession) {
    const content = { ...session.content, facts: session.facts };
    const values = {
      apiKeyId: session.apiKeyId,
      entryChannelId: session.entryChannelId,
      executionChannelId: session.executionChannelId,
      endpoint: session.facts.endpoint,
      requestedModel: session.facts.model,
      requestCount: session.requestCount,
      lastRequestId: session.lastRequestId as string,
      lastSeenAt: session.lastSeenAt,
      contentEncrypted: this.vault.encrypt(JSON.stringify(content)),
      contentChars: contentChars(session.content),
      truncated: session.content.truncated,
      imageCount: session.content.images,
    };
    // 其他实例已写入同一会话且仍在排队时，以请求更多的快照为准；已开始审核的不再修改。
    await this.db
      .insert(moderationSessions)
      .values({
        ...values,
        userId: session.userId,
        sessionHash: session.sessionHash,
        day: session.day,
        reason: session.reason,
        firstSeenAt: session.firstSeenAt,
      })
      .onConflictDoUpdate({
        target: [moderationSessions.userId, moderationSessions.sessionHash, moderationSessions.day],
        set: values,
        setWhere: sql`${moderationSessions.status} = 'pending' and ${moderationSessions.requestCount} <= ${session.requestCount}`,
      });
  }
}

export type StoredContent = ModerationContent & { facts: SessionFacts };
