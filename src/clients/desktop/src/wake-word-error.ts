export const wakeWordErrorCode = "unavailable" as const;
export type WakeWordErrorCode = typeof wakeWordErrorCode;

export const wakeWordErrorMessage =
  "本地中文唤醒词检测不可用，请检查模型文件和麦克风权限后重试。";

export function mapWakeWordErrorCode(value: unknown): string {
  const code: WakeWordErrorCode = value === wakeWordErrorCode
    ? value
    : wakeWordErrorCode;
  const messages: Record<WakeWordErrorCode, string> = {
    unavailable: wakeWordErrorMessage
  };
  return messages[code];
}
