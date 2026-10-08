import { createColoredLogHandler } from '@fraqjs/color-log';
import { Logger } from '@fraqjs/kernel';

export const logHandler = createColoredLogHandler({ minLevel: 'debug' });
export const globalLogger = new Logger(logHandler, 'ohmyapi');
