import type { AgentRightPanelMode } from "../../store/atoms/workstreamState";
import type { WindowTopBarPanelOption } from "../WindowTopBar/WindowTopBar";
import { t } from "@nimbalyst/runtime/i18n";

// labelKey is resolved on every call so the labels follow the UI language.
const modes: Array<{ id: AgentRightPanelMode; labelKey: string; icon: string }> = [
  { id: "edited-files", labelKey: "agent:rightPanel.editedFiles", icon: "description" },
  { id: "review", labelKey: "agent:rightPanel.review", icon: "rate_review" },
  { id: "session-chat", labelKey: "agent:rightPanel.sessionChat", icon: "forum" },
  { id: "file-viewer", labelKey: "agent:rightPanel.fileViewer", icon: "tab" },
];

export function agentRightPanelOptions(
  selected: AgentRightPanelMode,
  onSelect: (mode: AgentRightPanelMode) => void
): WindowTopBarPanelOption[] {
  return modes.map(({ labelKey, ...mode }) => ({
    ...mode,
    label: t(labelKey),
    selected: mode.id === selected,
    onSelect: () => onSelect(mode.id),
  }));
}
