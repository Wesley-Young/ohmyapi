import { serviceToken } from '@fraqjs/kernel';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';

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
      const [duplicate] = await tx
        .select({ id: models.id })
        .from(models)
        .where(and(eq(models.name, input.name), isNull(models.deletedAt)));
      if (duplicate && duplicate.id !== input.id) throw new AppError('conflict', '模型名称已存在');
      const [row] = existing
        ? await tx
            .update(models)
            .set({
              name: input.name,
              enabled: input.enabled,
              inputTokenLimit: input.inputTokenLimit,
              outputTokenLimit: input.outputTokenLimit,
            })
            .where(eq(models.id, existing.id))
            .returning({ id: models.id })
        : await tx
            .insert(models)
            .values({
              name: input.name,
              enabled: input.enabled,
              inputTokenLimit: input.inputTokenLimit,
              outputTokenLimit: input.outputTokenLimit,
            })
            .returning({ id: models.id });
      await auditCatalog(tx, actor.id, 'model.save', row.id, {
        name: input.name,
        enabled: input.enabled,
        inputTokenLimit: input.inputTokenLimit,
        outputTokenLimit: input.outputTokenLimit,
      });
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
        const rules = expandRules(entry.rules);
        try {
          validateRules(rules);
        } catch (error) {
          throw new AppError('bad_request', `${entry.model.name}：${(error as Error).message}`);
        }
        return { ...entry, rules };
      })
      .sort((a, b) => a.model.name.localeCompare(b.model.name));
    return this.auth.authorized(principal, { admin: true }, async (tx, actor) => {
      const imported = await tx
        .insert(models)
        .values(prepared.map((entry) => entry.model))
        .onConflictDoUpdate({
          target: models.name,
          targetWhere: isNull(models.deletedAt),
          set: {
            enabled: sql`excluded.enabled`,
            inputTokenLimit: sql`excluded.input_token_limit`,
            outputTokenLimit: sql`excluded.output_token_limit`,
          },
        })
        .returning({ id: models.id, name: models.name });
      await tx.delete(priceRules).where(
        inArray(
          priceRules.modelId,
          imported.map((model) => model.id),
        ),
      );
      for (const model of imported) {
        const entry = prepared.find((item) => item.model.name === model.name) as (typeof prepared)[number];
        await tx.insert(priceRules).values(entry.rules.map((rule) => ({ ...rule, modelId: model.id })));
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
