import { adminProcedure } from '../../trpc/procedures.js';
import { userIdInput } from '../users/schemas.js';
import type { ChannelGrants } from './grants.js';
import type { ModelCatalog } from './models.js';
import {
  channelGrantsInput,
  channelIdInput,
  channelInput,
  fetchChannelModelsInput,
  importModelsInput,
  modelIdInput,
  modelInput,
  setChannelGrantsInput,
  setGrantsInput,
} from './schemas.js';
import type { CatalogService } from './service.js';

export function catalogAdminRoutes(catalog: CatalogService, modelCatalog: ModelCatalog, grants: ChannelGrants) {
  return {
    list: adminProcedure.query(() => catalog.list()),
    fetchChannelModels: adminProcedure
      .input(fetchChannelModelsInput)
      .mutation(({ ctx, input }) => catalog.fetchChannelModels(ctx.principal, input)),
    saveChannel: adminProcedure
      .input(channelInput)
      .mutation(({ ctx, input }) => catalog.saveChannel(ctx.principal, input)),
    deleteChannel: adminProcedure
      .input(channelIdInput)
      .mutation(({ ctx, input }) => catalog.deleteChannel(ctx.principal, input.channelId)),
    saveModel: adminProcedure
      .input(modelInput)
      .mutation(({ ctx, input }) => modelCatalog.saveModel(ctx.principal, input)),
    deleteModel: adminProcedure
      .input(modelIdInput)
      .mutation(({ ctx, input }) => modelCatalog.deleteModel(ctx.principal, input.modelId)),
    importModels: adminProcedure
      .input(importModelsInput)
      .mutation(({ ctx, input }) => modelCatalog.importModels(ctx.principal, input)),
    grants: adminProcedure.input(userIdInput).query(({ input }) => grants.grants(input.userId)),
    channelGrants: adminProcedure
      .input(channelGrantsInput)
      .query(({ input }) => grants.channelGrants(input.channelId, input.page, input.search)),
    setChannelGrants: adminProcedure
      .input(setChannelGrantsInput)
      .mutation(({ ctx, input }) => grants.setChannelGrants(ctx.principal, input.channelId, input.grants)),
    setGrants: adminProcedure
      .input(setGrantsInput)
      .mutation(({ ctx, input }) => grants.setGrants(ctx.principal, input.userId, input.channelIds)),
  };
}
