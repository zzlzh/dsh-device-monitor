/**
 * The metric vocabulary — the single source of truth for "which metrics can a
 * device be asked to report".
 *
 * This is a faithful port of the reference device-manager's
 * `lib/metrics.js:26-46`. Keeping the key names, the key ORDER and the Chinese
 * labels byte-identical to the reference is what makes the phrase "与本系统
 * 保持一致" true: a user who configured metrics in device-manager sees the same
 * eleven checkboxes, in the same order, with the same names.
 *
 * Three sets, and the distinction between them is load-bearing:
 *
 *   METRIC_KEYS     everything selectable, in fixed display order.
 *   ALWAYS_METRICS  forced on, cannot be unticked (the UI disables the checkbox
 *                   with a "（必采）" suffix).
 *   DEFAULT_METRICS what a device gets when no choice was ever recorded.
 *
 * The subtle case is an explicit empty array. The reference is explicit about
 * it (`lib/metrics.js:217-218`): `[]` means "the user unticked everything they
 * were allowed to untick", NOT "this device is unconfigured". Falling back to
 * the defaults there would silently resurrect seven metrics the user just
 * switched off, and it would do so on every restart. So `[]` legalises to
 * ALWAYS_METRICS and nothing else.
 *
 * The OTHER half of that rule lives at the display layer: a device whose
 * `metrics` field is MISSING (added before this feature existed) must render
 * everything. Those two rules are opposites and both are required — see
 * `hasMetric` in the client half.
 */

/** Every selectable metric key, in fixed display order. */
export const METRIC_KEYS = ["uptime", "load", "cpu", "mem", "disk", "temp", "top", "net", "diskio", "procs", "tcp"];

/** Metrics that are always collected; the user cannot untick these. */
export const ALWAYS_METRICS = ["uptime"];

/** Metrics used when a device has no recorded choice at all. */
export const DEFAULT_METRICS = ["uptime", "load", "cpu", "mem", "disk", "temp", "top"];

/** Human labels, matching the reference word for word. */
export const METRIC_LABELS = {
  uptime: "运行时间",
  load: "系统负载",
  cpu: "CPU 使用率",
  mem: "内存",
  disk: "磁盘容量",
  temp: "温度",
  top: "高占用进程",
  net: "网络吞吐",
  diskio: "磁盘读写 IO",
  procs: "进程数",
  tcp: "TCP 连接数",
};

/** Long-form hints shown beside each checkbox in the settings UI. */
export const METRIC_HINTS = {
  uptime: "开机时长与运行状态",
  load: "1 / 5 / 15 分钟平均负载",
  cpu: "两次 /proc/stat 采样之间的占用率",
  mem: "已用 / 总内存",
  disk: "各挂载点容量占用",
  temp: "热区与 hwmon 传感器温度",
  top: "按 CPU 占用排序的前几个进程",
  net: "/proc/net/dev 各网卡吞吐（排除 lo）",
  diskio: "/proc/diskstats 各磁盘读写速率",
  procs: "进程总数",
  tcp: "TCP 连接数（ss，缺失时回退 /proc/net/tcp）",
};

/**
 * Coerce anything into a legal, ordered metric selection.
 *
 * Rules, in order:
 *   1. Not an array        -> DEFAULT_METRICS. (No information: use defaults.)
 *   2. Non-string members  -> dropped. (A hand-edited config may hold anything.)
 *   3. Unknown keys        -> dropped. (Renaming a key must not smuggle it in.)
 *   4. ALWAYS_METRICS      -> unioned in, even if the input was `[]`.
 *   5. Order               -> always METRIC_KEYS order, never the input order.
 *
 * Step 3 accepting `[]` (and not falling through to defaults) is the whole
 * point of the function; see the module comment.
 *
 * @param {unknown} metrics
 * @returns {string[]}
 */
export function normalizeMetrics(metrics) {
  if (!Array.isArray(metrics)) return [...DEFAULT_METRICS];
  const picked = new Set(metrics.filter((k) => typeof k === "string" && METRIC_KEYS.includes(k)));
  for (const k of ALWAYS_METRICS) picked.add(k);
  return METRIC_KEYS.filter((k) => picked.has(k));
}

/**
 * True when a stored `metrics` value carries an actual user decision.
 * `undefined`/`null` mean "never configured"; `[]` means "configured to
 * nothing selectable". Only the former should fall back to defaults.
 */
export function hasMetricChoice(value) {
  return Array.isArray(value);
}

/** The metric key list and labels as the client needs them, in display order. */
export function metricCatalog() {
  return METRIC_KEYS.map((key) => ({
    key,
    label: METRIC_LABELS[key],
    hint: METRIC_HINTS[key],
    always: ALWAYS_METRICS.includes(key),
  }));
}
