export const channelTypes = ['api', 'subscription', 'aggregate'] as const;
export type ChannelType = (typeof channelTypes)[number];

// 接通转发适配器后，再开放对应类型的创建和调用。
export const supportedChannelTypes = ['api', 'subscription'] as const satisfies readonly ChannelType[];

export function isSupportedChannelType(type: ChannelType) {
  return supportedChannelTypes.some((supported) => supported === type);
}
