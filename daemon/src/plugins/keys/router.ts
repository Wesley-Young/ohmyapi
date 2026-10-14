import { paginationInput } from '../../core/pagination.js';
import { protectedProcedure } from '../../trpc/procedures.js';
import { bindChannelInput, createKeyInput, keyIdInput, updateKeyInput } from './schemas.js';
import type { KeyService } from './service.js';

export function keyRoutes(keys: KeyService) {
  return {
    playgroundOptions: protectedProcedure.query(({ ctx }) => keys.playgroundOptions(ctx.principal)),
    list: protectedProcedure.input(paginationInput).query(({ ctx, input }) => keys.list(ctx.principal, input.page)),
    channels: protectedProcedure.query(({ ctx }) => keys.availableChannels(ctx.principal)),
    bindChannel: protectedProcedure
      .input(bindChannelInput)
      .mutation(({ ctx, input }) => keys.bindChannel(ctx.principal, input.keyId, input.channelId)),
    models: protectedProcedure.query(({ ctx }) => keys.availableModels(ctx.principal)),
    create: protectedProcedure.input(createKeyInput).mutation(({ ctx, input }) => keys.create(ctx.principal, input)),
    update: protectedProcedure.input(updateKeyInput).mutation(({ ctx, input }) => keys.update(ctx.principal, input)),
    delete: protectedProcedure.input(keyIdInput).mutation(({ ctx, input }) => keys.delete(ctx.principal, input.keyId)),
  };
}
