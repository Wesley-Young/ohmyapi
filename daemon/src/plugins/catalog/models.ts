import { serviceToken } from '@fraqjs/kernel';
import { and, eq, isNull, sql } from 'drizzle-orm';

import { AppError } from '../../core/errors.ts';
import type { AuthService, Principal } from '../auth/service.ts';
import { models, priceRules } from '../database/schema/index.ts';
import { expandRules, validateRules } from '../pricing/rules.ts';
import { auditCatalog } from './audit.ts';
import type { ImportModelsInput, ModelInput } from './schemas.ts';

/** 模型目录：维护模型及其上下文上限，导入时同时写入价格规则。 */
export class ModelCatalog {
  static readonly token = serviceToken<ModelCatalog>('ohmyapi/model-catalog');
  private readonly auth: AuthService;
  constructor(deps: { auth: AuthService }) {
    this.auth = deps.auth;
  }

  async saveModel(principal: Principal, input: ModelInput) {
    return this.auth.authorized(principal, { admin: true }, async (tx, actor) => {
      const [existing] = input.id
        ? await tx
            .select()
            .from(models)
            .where(and(eq(models.id, input.id), isNull(models.deletedAt)))
            .for('update')
        : [];
      if (input.id && !existing) throw new AppError('not_found', '模型不存在');
      const outputKind = input.outputKind ?? existing?.outputKind ?? 'text';
      if (existing && outputKind !== existing.outputKind) {
        const [rule] = await tx
          .select({ id: priceRules.id })
          .from(priceRules)
          .where(eq(priceRules.modelId, existing.id))
          .limit(1);
        if (rule) throw new AppError('conflict', '请先清除原类型的价格规则，再修改模型类型');
      }
      const values = {
        name: input.name,
        enabled: input.enabled,
        outputKind,
        inputTokenLimit: outputKind === 'text' ? input.inputTokenLimit : null,
        outputTokenLimit: outputKind === 'text' ? input.outputTokenLimit : null,
      };
      const [duplicate] = await tx
        .select({ id: models.id })
        .from(models)
        .where(and(eq(models.name, input.name), isNull(models.deletedAt)));
      if (duplicate && duplicate.id !== input.id) throw new AppError('conflict', '模型名称已存在');
      const [row] = existing
        ? await tx.update(models).set(values).where(eq(models.id, existing.id)).returning({ id: models.id })
        : await tx.insert(models).values(values).returning({ id: models.id });
      await auditCatalog(tx, actor.id, 'model.save', row.id, values);
      return row;
    });
  }

  async deleteModel(principal: Principal, modelId: string) {
    return this.auth.authorized(principal, { admin: true }, async (tx, actor) => {
      const [model] = await tx
        .update(models)
        .set({ deletedAt: new Date(), enabled: false })
        .where(and(eq(models.id, modelId), isNull(models.deletedAt)))
        .returning({ id: models.id, name: models.name });
      if (!model) throw new AppError('not_found', '模型不存在或已删除');
      await auditCatalog(tx, actor.id, 'model.delete', model.id, { name: model.name });
      return { success: true };
    });
  }

  async importModels(principal: Principal, input: ImportModelsInput) {
    const prepared = input.models
      .map((entry) => {
        const outputKind = entry.model.outputKind ?? 'text';
        if (outputKind === 'image' && entry.preset !== 'none')
          throw new AppError('bad_request', '图像模型使用按张定价');
        const rules = expandRules(entry.rules, outputKind);
        try {
          if (rules.length || outputKind !== 'image') validateRules(rules);
        } catch (error) {
          throw new AppError('bad_request', `${entry.model.name}：${(error as Error).message}`);
        }
        return {
          ...entry,
          model: {
            ...entry.model,
            outputKind,
            inputTokenLimit: outputKind === 'image' ? null : entry.model.inputTokenLimit,
            outputTokenLimit: outputKind === 'image' ? null : entry.model.outputTokenLimit,
          },
          rules,
        };
      })
      .sort((a, b) => a.model.name.localeCompare(b.model.name));
    return this.auth.authorized(principal, { admin: true }, async (tx, actor) => {
      const imported = await tx
        .insert(models)
        .values(prepared.map((entry) => entry.model))
        .onConflictDoUpdate({
          target: models.name,
          targetWhere: isNull(models.deletedAt),
          setWhere: sql`${models.outputKind} = excluded.output_kind or not exists (select 1 from ${priceRules} where ${priceRules.modelId} = ${models.id})`,
          set: {
            outputKind: sql`excluded.output_kind`,
            enabled: sql`excluded.enabled`,
            inputTokenLimit: sql`excluded.input_token_limit`,
            outputTokenLimit: sql`excluded.output_token_limit`,
          },
        })
        .returning({ id: models.id, name: models.name });
      if (imported.length !== prepared.length)
        throw new AppError('conflict', '已定价模型的类型与导入来源不一致，请先核对原定价');
      for (const model of imported) {
        const entry = prepared.find((item) => item.model.name === model.name) as (typeof prepared)[number];
        if (entry.rules.length) {
          await tx.delete(priceRules).where(eq(priceRules.modelId, model.id));
          await tx.insert(priceRules).values(entry.rules.map((rule) => ({ ...rule, modelId: model.id })));
        }
        await auditCatalog(tx, actor.id, 'model.import', model.id, {
          source: 'models.dev',
          providerId: entry.providerId,
          preset: entry.preset,
          model: entry.model,
          rules: input.models.find((item) => item.model.name === model.name)?.rules,
        });
      }
      return { imported };
    });
  }
}
