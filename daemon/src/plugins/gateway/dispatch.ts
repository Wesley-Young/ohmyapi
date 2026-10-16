/**
 * 这些错误发生在请求送达上游之前：解析地址、建立连接、TLS 握手、代理隧道或出站配置失败，上游不会执行请求。
 * 连接重置、套接字关闭等可能发生在发送之后的错误不在此列。
 */
const notSentCodes = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EAI_FAIL',
  'EAI_NONAME',
  'EHOSTUNREACH',
  'EHOSTDOWN',
  'ENETUNREACH',
  'ENETDOWN',
  'EADDRNOTAVAIL',
  'UND_ERR_CONNECT_TIMEOUT',
  'ERR_INVALID_URL',
  'ERR_OUTBOUND_SETUP',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'CERT_REVOKED',
  'CERT_UNTRUSTED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
]);

/** 代理拒绝建立隧道时 undici 报告的错误，CONNECT 之后才会发送请求。 */
const proxyTunnelRejected = /^Proxy response \(\d+\) !== 200 when HTTP Tunneling$/;

/** 沿 cause 链判断上游请求是否在送达前失败。 */
export function requestNotSent(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 5 && current && typeof current === 'object'; depth++) {
    const { code, message, cause } = current as { code?: unknown; message?: unknown; cause?: unknown };
    if (typeof code === 'string') {
      if (notSentCodes.has(code) || code.startsWith('ERR_TLS_') || code.startsWith('ERR_SSL_')) return true;
      if (code === 'UND_ERR_ABORTED' && typeof message === 'string' && proxyTunnelRejected.test(message)) return true;
    }
    current = cause;
  }
  return false;
}
