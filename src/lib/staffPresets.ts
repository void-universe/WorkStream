// Market「员工」区的内置岗位模板：这里只有结构，文案全在字典里（*Key）。
// 模板本身不带凭据：建档目标由页面顶部的 server 选择器给，演示端点那一档不需要 Key。
import type { MsgKey } from "./i18n";

export type StaffPreset = {
  id: string;
  nameKey: MsgKey;
  roleKey: MsgKey;
  summaryKey: MsgKey;
  systemKey: MsgKey;
};

export const STAFF_PRESETS: StaffPreset[] = [
  {
    id: "reviewer",
    nameKey: "staff.reviewer.name",
    roleKey: "staff.reviewer.role",
    summaryKey: "staff.reviewer.summary",
    systemKey: "staff.reviewer.system",
  },
  {
    id: "analyst",
    nameKey: "staff.analyst.name",
    roleKey: "staff.analyst.role",
    summaryKey: "staff.analyst.summary",
    systemKey: "staff.analyst.system",
  },
  {
    id: "scribe",
    nameKey: "staff.scribe.name",
    roleKey: "staff.scribe.role",
    summaryKey: "staff.scribe.summary",
    systemKey: "staff.scribe.system",
  },
  {
    id: "coordinator",
    nameKey: "staff.coordinator.name",
    roleKey: "staff.coordinator.role",
    summaryKey: "staff.coordinator.summary",
    systemKey: "staff.coordinator.system",
  },
];
