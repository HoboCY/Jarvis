import type { ReactNode } from "react";
import {
  projectRealtimeRetryControls,
  type DesktopActionState,
  type DesktopRealtimeRetryProjectionInput
} from "./control-panel.js";
import type { DesktopRealtimeStatus } from "./realtime.js";

export type DesktopRealtimeRetryControlsProps = DesktopRealtimeRetryProjectionInput & {
  onRetryPersistence: () => void;
  onRetryWake: () => void;
};

export type DesktopRealtimeRetryButton = Readonly<{
  key: "realtime-retry-persistence" | "realtime-retry-wake";
  label: string;
  ariaLabel: string;
  disabled: boolean;
  busy: boolean;
  onClick: () => void;
}>;

export type DesktopRealtimeConnectionControlProps = Readonly<{
  status: DesktopRealtimeStatus;
  connectAction?: DesktopActionState;
  disconnectAction?: DesktopActionState;
  onConnect: () => void;
  onDisconnect: () => void;
}>;

export type DesktopRealtimeConnectionButton = Readonly<{
  intent: "connect" | "disconnect";
  label: string;
  disabled: boolean;
  busy: boolean;
  onClick: () => void;
}>;

function actionButtonLabel(
  state: DesktopActionState | undefined,
  initial: string,
  retry: string
): string {
  if (state?.status === "pending") {
    return "处理中…";
  }
  if (state?.status === "retryable") {
    return retry;
  }
  if (state?.status === "succeeded") {
    return "已完成";
  }
  if (state?.status === "terminal") {
    return "不可用";
  }
  return initial;
}

function actionUnavailable(state: DesktopActionState | undefined): boolean {
  return state?.status === "pending"
    || state?.status === "succeeded"
    || state?.status === "terminal";
}

function realtimeStatusLabel(status: DesktopRealtimeStatus): string {
  switch (status) {
    case "connected": return "语音在线";
    case "connecting": return "正在连接";
    case "degraded": return "需要处理";
    default: return "连接语音";
  }
}

export function projectDesktopRealtimeConnectionButton(
  input: DesktopRealtimeConnectionControlProps
): DesktopRealtimeConnectionButton {
  const disconnecting = input.status === "connected";
  const state = disconnecting ? input.disconnectAction : input.connectAction;
  return {
    intent: disconnecting ? "disconnect" : "connect",
    label: disconnecting
      ? actionButtonLabel(state, "断开语音", "重试断开")
      : actionButtonLabel(state, realtimeStatusLabel(input.status), "重试连接"),
    disabled: input.status === "connecting" || actionUnavailable(state),
    busy: state?.status === "pending",
    onClick: disconnecting ? input.onDisconnect : input.onConnect
  };
}

export function projectDesktopRealtimeRetryButtons(
  input: DesktopRealtimeRetryControlsProps
): readonly DesktopRealtimeRetryButton[] {
  const projection = projectRealtimeRetryControls(input);
  const buttons: DesktopRealtimeRetryButton[] = [];

  if (projection.persistence) {
    const state = input.persistenceAction;
    buttons.push({
      key: "realtime-retry-persistence",
      label: actionButtonLabel(state, "重试保存", "重试保存"),
      ariaLabel: "重试保存",
      disabled: actionUnavailable(state),
      busy: state?.status === "pending",
      onClick: input.onRetryPersistence
    });
  }

  if (projection.wake) {
    const state = input.wakeAction;
    buttons.push({
      key: "realtime-retry-wake",
      label: actionButtonLabel(state, "重试唤醒", "重试唤醒"),
      ariaLabel: "重试唤醒",
      disabled: actionUnavailable(state),
      busy: state?.status === "pending",
      onClick: input.onRetryWake
    });
  }

  return buttons;
}

export function DesktopRealtimeRetryControls(
  input: DesktopRealtimeRetryControlsProps
): ReactNode {
  return (
    <>
      {projectDesktopRealtimeRetryButtons(input).map(button => (
        <button
          aria-busy={button.busy}
          aria-label={button.ariaLabel}
          className="quiet-button"
          data-realtime-recovery={button.key}
          disabled={button.disabled}
          key={button.key}
          type="button"
          onClick={button.onClick}
        >
          {button.label}
        </button>
      ))}
    </>
  );
}

export function DesktopRealtimeConnectionControl(
  input: DesktopRealtimeConnectionControlProps
): ReactNode {
  const button = projectDesktopRealtimeConnectionButton(input);
  return (
    <button
      aria-busy={button.busy}
      className={`connection-button is-${input.status}`}
      data-realtime-connection={button.intent}
      disabled={button.disabled}
      type="button"
      onClick={button.onClick}
    >
      <span className="status-dot" />
      {button.label}
    </button>
  );
}
