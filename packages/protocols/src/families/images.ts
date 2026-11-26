import { GatewayError } from '../errors.ts';
import type { ApiProtocol, Data, UsageReader } from '../types.ts';
import { bodyTarget, count, object, versionedUrl, withBodyModel } from '../util.ts';
import { bearerHeaders, openAIErrorBody } from './openai-shared.ts';

const path = '/v1/images';
const editsPath = `${path}/edits`;
const generationsPath = `${path}/generations`;
const hasPayload = (value: unknown) => typeof value === 'string' && value.trim().length > 0;

// multipart 中只读取路由、校验和计费需要的字段，其余字段随原表单转发。
function editFormBody(form: FormData): Data {
  const body: Data = { images: [...form.getAll('image'), ...form.getAll('image[]')] };
  for (const field of ['model', 'prompt', 'n', 'stream', 'size', 'quality']) {
    const values = form.getAll(field);
    if (!values.length) continue;
    const [value] = values;
    if (values.length > 1 || typeof value !== 'string')
      throw new GatewayError(400, 'invalid_request', `Expected one text value for ${field}`);
    if (field === 'n') body.n = /^\d+$/.test(value) ? Number(value) : NaN;
    else if (field === 'stream') body.stream = value === 'true' ? true : value === 'false' ? false : value;
    else body[field] = value;
  }
  return body;
}

function hasSourceImage(value: unknown): boolean {
  if (value instanceof File) return value.size > 0;
  const ref = object(value);
  return hasPayload(value) || hasPayload(ref?.image_url) || hasPayload(ref?.file_id) || hasPayload(ref?.url);
}

function imageUsageReader(): UsageReader {
  let requested = 1;
  return {
    inputKey: 'input_tokens',
    outputKey: 'output_tokens',
    configure(body) {
      requested = Number(body.n ?? 1);
    },
    envelope: (data) => data,
    usage(data) {
      if (data.error || data.type === 'error' || !Array.isArray(data.data)) return undefined;
      let images = 0;
      for (const item of data.data) {
        const entry = object(item);
        if (hasPayload(entry?.url) || hasPayload(entry?.b64_json)) images++;
      }
      return { ...object(data.usage), generated_images: images };
    },
    terminal: () => false,
    finalizes: () => false,
    completesOnDone: true,
    merge: (_previous, next) => next,
    normalize(raw) {
      const images = count(raw.generated_images);
      if (!images || images > requested) return { valid: false, unknownCosts: false };
      // 部分上游只返回图片。报告了 Token 时一并保留，便于核对。
      const input = count(raw.input_tokens) ?? 0n;
      const details = object(raw.input_tokens_details);
      const cached = count(details?.cached_tokens) ?? 0n;
      return {
        valid: true,
        unknownCosts: false,
        input,
        output: count(raw.output_tokens) ?? 0n,
        read: cached <= input ? cached : 0n,
        write: 0n,
        image: 0n,
        generatedImages: images,
        inputIncludesCache: true,
      };
    },
  };
}

export const imagesProtocol: ApiProtocol = {
  endpoint: path,
  family: 'images',
  routes: [generationsPath, editsPath],
  multipart: { path: editsPath, parse: editFormBody },
  apiKeyHeaders: [],
  target(request, body) {
    const operation = new URL(request.url).pathname === editsPath ? 'edits' : 'generations';
    const target = bodyTarget(body);
    if (target.streaming) throw new GatewayError(400, 'invalid_request', 'Image streaming is not supported');
    if (!target.model.trim() || typeof body.prompt !== 'string' || !body.prompt.trim())
      throw new GatewayError(400, 'invalid_request', 'A model and a non-empty prompt are required');
    if (body.n !== undefined && (typeof body.n !== 'number' || !Number.isInteger(body.n) || body.n < 1 || body.n > 10))
      throw new GatewayError(400, 'invalid_request', 'n must be an integer between 1 and 10');
    if (operation === 'edits') {
      const source = body.images ?? body.image;
      const images = Array.isArray(source) ? source : [source];
      if (!images.length || !images.every(hasSourceImage))
        throw new GatewayError(400, 'invalid_request', 'Image edits require a source image');
    }
    return { ...target, operation };
  },
  withModel: withBodyModel,
  reasoningEffort: () => undefined,
  withReasoningEffort: () => undefined,
  errorBody: openAIErrorBody,
  request: {
    outputLimit: { fields: [], required: false, minimum: 1 },
    imageType: 'image',
    messages: () => [],
    contentRoots: () => [],
    toolKind: () => undefined,
    search: {},
  },
  upstream: {
    url: (baseUrl, target) => versionedUrl(baseUrl, target.operation === 'edits' ? editsPath : generationsPath),
    headers: (_request, credential) => bearerHeaders(credential),
  },
  responseFeatures: { searchOutputItems: false, serverTools: false },
  observeOutput: () => {},
  createUsageReader: imageUsageReader,
  cacheReadTokens: (raw) => object(raw.input_tokens_details)?.cached_tokens ?? 0,
  reasoningTokens: () => undefined,
};
