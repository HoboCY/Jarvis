export const desktopIpcEnvelopeBrand = "jarvis.desktop.ipc" as const;
export const desktopActionFailureBrand = "jarvis.desktop.action-failure" as const;
export const desktopIpcProtocolVersion = 1 as const;

export type DesktopActionFailureKind = "retryable" | "terminal";

export type DesktopActionFailureCode =
  | "invalid_input"
  | "not_found"
  | "not_pending"
  | "forbidden"
  | "unauthorized"
  | "conflict"
  | "expired"
  | "cancelled"
  | "already_completed"
  | "unsupported"
  | "not_configured"
  | "network_unavailable"
  | "timeout"
  | "backend_unavailable"
  | "persistence_unavailable"
  | "wake_unavailable"
  | "unknown";

export type DesktopActionFailureProjection = Readonly<{
  brand: typeof desktopActionFailureBrand;
  version: typeof desktopIpcProtocolVersion;
  kind: DesktopActionFailureKind;
  code: DesktopActionFailureCode;
}>;

export type DesktopIpcSuccess<T> = Readonly<{
  brand: typeof desktopIpcEnvelopeBrand;
  version: typeof desktopIpcProtocolVersion;
  ok: true;
  value: T;
}>;

export type DesktopIpcFailure = Readonly<{
  brand: typeof desktopIpcEnvelopeBrand;
  version: typeof desktopIpcProtocolVersion;
  ok: false;
  failure: DesktopActionFailureProjection;
}>;

export type DesktopIpcResult<T> = DesktopIpcSuccess<T> | DesktopIpcFailure;

export type DesktopIpcHandler =
  (event: unknown, ...args: unknown[]) => unknown | Promise<unknown>;

const failureKinds = new Set<DesktopActionFailureKind>(["retryable", "terminal"]);
const failureCodes = new Set<DesktopActionFailureCode>([
  "invalid_input",
  "not_found",
  "not_pending",
  "forbidden",
  "unauthorized",
  "conflict",
  "expired",
  "cancelled",
  "already_completed",
  "unsupported",
  "not_configured",
  "network_unavailable",
  "timeout",
  "backend_unavailable",
  "persistence_unavailable",
  "wake_unavailable",
  "unknown"
]);

const publicFailureMessages: Record<DesktopActionFailureCode, string> = {
  invalid_input: "输入无效，请检查后重试。",
  not_found: "目标已不存在。",
  not_pending: "目标已不再待处理。",
  forbidden: "当前账号无权执行此操作。",
  unauthorized: "登录状态已失效，请重新连接。",
  conflict: "操作状态已变化，请刷新后重试。",
  expired: "操作已过期。",
  cancelled: "操作已取消。",
  already_completed: "操作已完成。",
  unsupported: "当前环境不支持此操作。",
  not_configured: "功能尚未配置。",
  network_unavailable: "网络暂时不可用，请稍后重试。",
  timeout: "请求超时，请稍后重试。",
  backend_unavailable: "Backend 暂时不可用，请稍后重试。",
  persistence_unavailable: "消息暂未保存，请稍后重试。",
  wake_unavailable: "唤醒检测暂时不可用，请稍后重试。",
  unknown: "操作失败，请稍后重试。"
};

const safeFailureMessage = "Desktop action failed.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFailureKind(value: unknown): value is DesktopActionFailureKind {
  return typeof value === "string" && failureKinds.has(value as DesktopActionFailureKind);
}

function isFailureCode(value: unknown): value is DesktopActionFailureCode {
  return typeof value === "string" && failureCodes.has(value as DesktopActionFailureCode);
}

export function createDesktopActionFailureProjection(
  kind: DesktopActionFailureKind,
  code: DesktopActionFailureCode
): DesktopActionFailureProjection {
  return Object.freeze({
    brand: desktopActionFailureBrand,
    version: desktopIpcProtocolVersion,
    kind,
    code
  });
}

export function isDesktopActionFailureProjection(value: unknown): value is DesktopActionFailureProjection {
  return isRecord(value)
    && value.brand === desktopActionFailureBrand
    && value.version === desktopIpcProtocolVersion
    && isFailureKind(value.kind)
    && isFailureCode(value.code);
}

export function createDesktopActionFailureError(
  kind: DesktopActionFailureKind,
  code: DesktopActionFailureCode
): Error {
  return createDesktopActionFailureErrorFromProjection(createDesktopActionFailureProjection(kind, code));
}

export function createDesktopActionFailureErrorFromProjection(
  projection: DesktopActionFailureProjection
): Error {
  const error = new Error(safeFailureMessage);
  error.name = "DesktopActionFailure";
  Object.defineProperty(error, "failure", {
    configurable: false,
    enumerable: true,
    value: projection,
    writable: false
  });
  return error;
}

export function projectDesktopActionFailure(reason: unknown): DesktopActionFailureProjection {
  if (isDesktopActionFailureProjection(reason)) {
    return reason;
  }
  if (isRecord(reason)) {
    if (isDesktopActionFailureProjection(reason.failure)
      && reason.failure !== undefined) {
      return reason.failure;
    }
    if (isDesktopActionFailureProjection(reason.projection)
      && reason.projection !== undefined) {
      return reason.projection;
    }
  }
  return createDesktopActionFailureProjection("retryable", "unknown");
}

export function createDesktopIpcSuccess<T>(value: T): DesktopIpcSuccess<T> {
  return {
    brand: desktopIpcEnvelopeBrand,
    version: desktopIpcProtocolVersion,
    ok: true,
    value
  };
}

export function createDesktopIpcFailure(
  failure: DesktopActionFailureProjection
): DesktopIpcFailure {
  return {
    brand: desktopIpcEnvelopeBrand,
    version: desktopIpcProtocolVersion,
    ok: false,
    failure
  };
}

export function isDesktopIpcResult(value: unknown): value is DesktopIpcResult<unknown> {
  if (!isRecord(value)
    || value.brand !== desktopIpcEnvelopeBrand
    || value.version !== desktopIpcProtocolVersion
    || typeof value.ok !== "boolean") {
    return false;
  }
  if (value.ok) {
    return Object.prototype.hasOwnProperty.call(value, "value");
  }
  return isDesktopActionFailureProjection(value.failure);
}

export function unwrapDesktopIpcResult<T>(value: unknown): T {
  if (!isDesktopIpcResult(value)) {
    throw createDesktopActionFailureProjection("retryable", "unknown");
  }
  if (!value.ok) {
    throw value.failure;
  }
  return value.value as T;
}

export function normalizeDesktopActionFailure(reason: unknown): DesktopActionFailureProjection {
  return projectDesktopActionFailure(reason);
}

export function desktopActionFailureMessage(code: DesktopActionFailureCode): string {
  return publicFailureMessages[code];
}
