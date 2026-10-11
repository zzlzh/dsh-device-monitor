/**
 * Busybox-compatible collectors for embedded-Linux / ARM boards.
 *
 * This module is busybox/embedded-Linux compatible: it only uses `/proc`,
 * `/sys`, `df`, `mount` and `systemctl`, and never shells out by itself — it
 * is a pure planning/parsing module. It is a port of the reference
 * device-manager collector (`dsh-device-manager/server/monitoring/collectors.js`).
 *
 * Everything degrades gracefully: each collector reads /proc or /sys text
 * first (guaranteed on Linux) and only falls back to external commands when
 * needed. External commands are kept to POSIX/busybox-safe forms
 * (`cat`, `awk`, `df -P -k`, `ls`, `sh`), so this works on headless boards
 * with a minimal rootfs.
 */

/**
 * The commands fetched in a single SSH round-trip batch.
 *
 * @param metrics - the device's selected metric keys (already normalized by
 * `normalizeMetrics`). Passing `undefined` means "no recorded choice", which
 * collects EVERY metric: a device added before metric selection existed must
 * still show everything rather than silently lose rows. See DESIGN.md §5.3/D10.
 *
 * Gating is the point of this function: a metric the user did not tick never
 * gets a command AT ALL. It is not "run it and hide the result" — on an ARM
 * board `ps ax` and `/proc/net/dev` cost real CPU, and this runs every poll on
 * up to ten devices. The four context collectors below (`cpuInfo`, `version`,
 * `services`, `rootfs`) are deliberately NOT in the metric vocabulary: they
 * are cheap one-shot reads the existing card UI depends on (model name, kernel
 * line, running services, mount table), and keeping the vocabulary at exactly
 * the reference system's eleven keys is what makes "与 device-manager 保持一致"
 * literally true.
 */
export function commandPlan(metrics, customCommands) {
  const wanted = metrics === undefined ? null : new Set(metrics);
  const on = (key) => wanted === null || wanted.has(key);
  const plan = {};

  // Custom command bodies. `enabled` must be a REAL boolean `true` — a
  // hand-edited `"true"` string in the settings file must not silently arm a
  // path that bypasses the Agent tool command whitelist. The normalizer already
  // enforces this; re-checking here means a caller that hand-builds the object
  // cannot skip the gate.
  const overrides = customCommands?.enabled === true && typeof customCommands.overrides === "object" && customCommands.overrides !== null
    ? customCommands.overrides
    : {};

  // --- context collectors: always on, never user-selectable -----------------
  // Deliberately NOT overridable: they are not in the metric vocabulary, so
  // there is no key to name them by, and `normalizeCustomCommands` rejects any
  // key outside `METRIC_KEYS`.
  plan.cpuInfo = { cmd: "cat /proc/cpuinfo 2>/dev/null | head -40 || true", timeout: 8000 };
  plan.version = { cmd: "uname -a; cat /proc/version 2>/dev/null || true", timeout: 8000 };
  plan.services = { cmd: "systemctl --no-pager --no-legend list-units --type=service --state=running 2>/dev/null | awk '{print $1}' | head -30 || true", timeout: 10000 };
  plan.rootfs = { cmd: "mount | head -20 2>/dev/null || true", timeout: 8000 };

  /**
   * Register one metric collector.
   *
   * Order matters, and it is the whole point of the R3 promise: the SELECTION
   * gate runs FIRST, so an unselected metric gets no entry at all — never an
   * entry that runs the override. An override only ever replaces the body of a
   * collector that was already going to run.
   *
   * `overridden` is carried on the entry so the caller can audit that a
   * custom command actually executed: these bypass the Agent tool command
   * whitelist, so every real execution has to leave a trace.
   */
  const metric = (metricKey, cmd, timeout) => {
    if (!on(metricKey)) return;
    const body = overrides[metricKey];
    const custom = typeof body === "string" && body !== "";
    plan[COMMAND_FOR_METRIC[metricKey]] = custom
      ? { cmd: body, timeout, overridden: true }
      : { cmd, timeout };
  };

  // --- metric collectors: one block per selectable key ----------------------
  metric("uptime", "cat /proc/uptime 2>/dev/null", 8000);
  // Two facts in one command, because separately they are not comparable.
  // `cat /proc/loadavg` gives the three averages; the count of `cpuN` lines in
  // /proc/stat gives the logical-CPU tally that the averages are only
  // meaningful against — 1.0 saturates one core and quarter-fills four, so a
  // bare "0.54" does not say whether the box is busy or nearly idle.
  //
  // The tally rides HERE rather than on the CPU metric because a device that
  // collects load but not CPU still needs it. It used to be `sample.cpu.cores`,
  // produced only when `cpu` was selected, so a load-only device reported its
  // load against a fabricated single core.
  //
  // `cpuN` lines are counted, not /proc/cpuinfo's `processor` lines: older ARM
  // kernels list only one capitalised `Processor` line for the whole SoC, which
  // would count zero.
  metric("load", "cat /proc/loadavg 2>/dev/null; grep -c '^cpu[0-9]' /proc/stat 2>/dev/null || true", 8000);
  metric("cpu", "cat /proc/stat", 8000);
  metric("mem", "cat /proc/meminfo", 8000);
  metric("disk", "LC_ALL=C df -P 2>/dev/null || df -P -k 2>/dev/null || true", 8000);
  metric(
    "temp",
    // Embedded boards almost always expose the millidegree thermal_zone;
    // x86 usually only has hwmon. Read BOTH and defer the millidegree vs
    // degree decision to JS — some drivers do report whole degrees, and a
    // fixed assumption would render 45°C as 0.045°C.
    'for z in /sys/class/thermal/thermal_zone*; do [ -r "$z/temp" ] || continue; n=$(cat "$z/type" 2>/dev/null); v=$(cat "$z/temp" 2>/dev/null); [ -n "$v" ] && echo "${n:-thermal} $v"; done 2>/dev/null || true',
    8000,
  );
  metric("top", "LC_ALL=C ps axo user,pid,pcpu,pmem --sort=-pcpu 2>/dev/null | awk 'NR>1 && NR<=6{print $1, $2, $3, $4}' || true", 10000);
  // /proc/net/dev field positions: $1 is "eth0:"; 8 receive fields $2..$9,
  // 8 transmit fields from $10 on. So rx_bytes=$2 and tx_bytes=$10.
  // `lo` is excluded: loopback traffic is not network throughput.
  // ONE read, not two: this plugin already has a cross-sample baseline
  // (MetricsStore#previous), and the real poll interval is a far better
  // differencing window than the reference's in-script `sleep 0.5`.
  metric("net", "awk 'NR>2 { n=$1; sub(/:$/,\"\",n); if (n != \"lo\") print n, $2, $10 }' /proc/net/dev 2>/dev/null || true", 8000);
  // /proc/diskstats: $3=name $6=sectors_read $10=sectors_written (512B sectors).
  // loop/ram/sr/fd are excluded: not real disk activity.
  metric("diskio", "awk '{ n=$3; if (n !~ /^(loop|ram|sr|fd)/) print n, $6, $10 }' /proc/diskstats 2>/dev/null || true", 8000);
  metric("procs", "ls /proc | grep -c '^[0-9]' 2>/dev/null || echo 0", 8000);
  // BusyBox frequently has no `ss`, and `netstat` is rarer still, so the
  // /proc fallback is mandatory. Test with `command -v` rather than
  // "did it print 0": zero connections is a legitimate result, and
  // treating it as "command unavailable" would pin every idle device to
  // the fallback forever.
  metric("tcp", "if command -v ss >/dev/null 2>&1; then ss -tan 2>/dev/null | awk 'NR>1 { n++ } END { print n+0 }'; else cat /proc/net/tcp /proc/net/tcp6 2>/dev/null | awk 'NR>1 { n++ } END { print n+0 }'; fi", 8000);

  return plan;
}

/** Which command key carries which metric key. Context keys are absent. */
export const COMMAND_FOR_METRIC = {
  uptime: "procUptime",
  load: "loadavg",
  cpu: "procStat",
  mem: "procMem",
  disk: "df",
  temp: "thermal",
  top: "top",
  net: "net",
  diskio: "diskio",
  procs: "procCount",
  tcp: "tcp",
};

function toInt(s) {
  const n = parseInt(String(s).trim(), 10);
  return Number.isFinite(n) ? n : 0;
}

/** Parse /proc/stat aggregated jiffies => [user,nice,system,idle,iowait,irq,softirq,steal]. */
export function parseProcStat(text) {
  for (const line of String(text).split("\n")) {
    if (!line.startsWith("cpu ")) continue;
    const p = line.trim().split(/\s+/).slice(1).map(toInt);
    return {
      user: p[0] || 0,
      nice: p[1] || 0,
      system: p[2] || 0,
      idle: p[3] || 0,
      iowait: p[4] || 0,
      irq: p[5] || 0,
      softirq: p[6] || 0,
      steal: p[7] || 0,
    };
  }
  return { user: 0, nice: 0, system: 0, idle: 0, iowait: 0, irq: 0, softirq: 0, steal: 0 };
}

export function cpuPercent(prev, cur) {
  if (!prev) return 0;
  const prevIdle = prev.idle + prev.iowait;
  const curIdle = cur.idle + cur.iowait;
  const prevTotal =
    prev.user + prev.nice + prev.system + prev.idle + prev.iowait + prev.irq + prev.softirq + prev.steal;
  const curTotal =
    cur.user + cur.nice + cur.system + cur.idle + cur.iowait + cur.irq + cur.softirq + cur.steal;
  const dTotal = curTotal - prevTotal;
  const dIdle = curIdle - prevIdle;
  if (dTotal <= 0) return 0;
  const pct = ((dTotal - dIdle) / dTotal) * 100;
  return Math.max(0, Math.min(100, Math.round(pct * 10) / 10));
}

/** Parse /proc/meminfo into MB values. */
export function parseMeminfo(text) {
  const m = {};
  for (const line of String(text).split("\n")) {
    const mm = line.match(/^(\w+):\s+(\d+)\s*kB/);
    if (mm) m[mm[1]] = toInt(mm[2]);
  }
  const total = m.MemTotal || 0;
  if (!total) return { totalMB: 0, usedMB: 0, freeMB: 0, availableMB: 0, usagePercent: 0, buffersMB: 0, cachedMB: 0 };
  const available = m.MemAvailable || m.MemFree || 0;
  const used = total - available;
  return {
    totalMB: Math.round(total / 1024),
    usedMB: Math.round(used / 1024),
    freeMB: Math.round((m.MemFree || 0) / 1024),
    availableMB: Math.round(available / 1024),
    buffersMB: Math.round((m.Buffers || 0) / 1024),
    cachedMB: Math.round((m.Cached || 0) / 1024),
    usagePercent: Math.round((used / total) * 1000) / 10,
  };
}

/** Parse `df -P -k` (POSIX) lines. */
export function parseDf(text) {
  const rows = [];
  for (let line of String(text).split("\n")) {
    line = line.trim();
    if (!line || line.startsWith("Filesystem") || line.startsWith("Filesystem      ")) continue;
    // Filesystem   1024-blocks     Used Available Capacity Mounted on
    const p = line.split(/\s+/);
    if (p.length < 6) continue;
    const fs = p[0];
    const sizeKB = toInt(p[1]);
    const usedKB = toInt(p[2]);
    const availKB = toInt(p[3]);
    const pct = parseInt(String(p[4]).replace("%", ""), 10) || 0;
    const mount = p.slice(5).join(" ");
    // Ignore pseudo filesystems that usually clutter embedded boards.
    if (/^(tmpfs|devtmpfs|devfs|sysfs|proc|overlay\/|none|shm|rootfs)$/.test(fs)) continue;
    rows.push({
      fs,
      mount,
      sizeMB: Math.round(sizeKB / 1024),
      usedMB: Math.round(usedKB / 1024),
      availableMB: Math.round(availKB / 1024),
      usagePercent: Number.isFinite(pct) ? pct : sizeKB ? Math.round((usedKB / sizeKB) * 100) : 0,
    });
  }
  return rows;
}

/**
 * Parse the load collector's two-line output.
 *
 *     cat /proc/loadavg; grep -c '^cpuN' /proc/stat
 *     0.15 0.10 0.05 1/128 4321
 *     4
 *
 * The second line is the logical-CPU tally, and it is what makes the averages
 * interpretable: 1.0 is saturation on one core and a quarter-load on four.
 * `cores` is `null` — never 1 — when that line is missing, because "we could
 * not count the cores" and "this is a single-core box" are different facts and
 * only one of them justifies dividing by one. A single-line input (the bare
 * /proc/loadavg text, as the parser tests feed it) therefore yields
 * `cores: null`, not a fabricated 1.
 */
export function parseLoadavg(text) {
  const lines = String(text).trim().split("\n").map((line) => line.trim()).filter(Boolean);
  // The averages line is identified by its running/total field, not by position:
  // if /proc/loadavg is unreadable the core tally is still line 1, and reading
  // it as `load1` would report a 4-core box as having a load of 4.
  const avgLine = lines.find((line) => line.includes("/")) ?? "";
  const p = avgLine.split(/\s+/);
  if (p.length < 4) return null;
  const coreLine = lines.find((line) => line !== avgLine && /^\d+$/.test(line));
  const cores = coreLine === undefined ? null : toInt(coreLine);
  return {
    load1: parseFloat(p[0] || "0"),
    load5: parseFloat(p[1] || "0"),
    load15: parseFloat(p[2] || "0"),
    running: toInt((p[3] || "/").split("/")[0]),
    total: toInt((p[3] || "0/0").split("/")[1]),
    cores: cores === null || cores < 1 ? null : cores,
  };
}

export function parseUptime(text) {
  const [up, idle] = String(text).trim().split(/\s+/);
  const seconds = parseFloat(up) || 0;
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  return {
    seconds,
    text: `${days}d ${hours}h ${mins}m`,
    days,
  };
}

export function parseCpuInfo(text) {
  for (const line of String(text).split("\n")) {
    if (line.toLowerCase().includes("model name")) {
      return line.split(":")[1]?.trim() || "unknown";
    }
    if (line.toLowerCase().includes("hardware")) {
      return line.split(":")[1]?.trim() || "unknown";
    }
  }
  return "unknown";
}

export function parseThermal(text) {
  const entries = [];
  for (const line of String(text).split("\n")) {
    // Accept both the plugin's own `name=value` form (thermal_zone loop) and
    // the reference's space-separated `name value` form (hwmon loop).
    const idx = line.indexOf("=");
    let type;
    let raw;
    if (idx >= 0) {
      type = line.slice(0, idx).trim();
      raw = parseFloat(line.slice(idx + 1).trim());
    } else {
      const p = line.trim().split(/\s+/);
      if (p.length < 2) continue;
      type = p.slice(0, -1).join(" ").trim();
      raw = parseFloat(p[p.length - 1]);
    }
    if (!Number.isFinite(raw)) continue;
    // Board may report milli-degrees (>=1000) or degrees.
    const celsius = raw > 1000 ? raw / 1000 : raw;
    entries.push({ type, celsius: Math.round(celsius * 10) / 10 });
  }
  return entries;
}

/**
 * Parse the `top` collector: one process per line, "user pid pcpu pmem".
 * Malformed rows are dropped rather than zero-filled — a process row with no
 * CPU figure is not a process using 0% CPU.
 */
export function parseTop(text) {
  const rows = [];
  for (const line of String(text).split("\n")) {
    const p = line.trim().split(/\s+/);
    if (p.length < 4) continue;
    const pid = toInt(p[1]);
    const cpu = parseFloat(p[2]);
    const mem = parseFloat(p[3]);
    if (!Number.isFinite(cpu) || !Number.isFinite(mem)) continue;
    if (!pid) continue;
    rows.push({ user: p[0], pid, cpu, mem });
  }
  return rows;
}

/**
 * Parse the `net` collector into per-interface cumulative byte counters.
 *
 * The collector's awk has ALREADY done the column selection on the device
 * (`awk 'NR>2 { n=$1; sub(/:$/,"",n); if (n != "lo") print n, $2, $10 }'`), so
 * what arrives here is `name rx tx` — three whitespace-separated fields, no
 * colon. An earlier version of this function only understood the RAW
 * `/proc/net/dev` layout (`eth0:` followed by 16 columns), so it silently
 * returned `[]` for every line production ever sent it: `net.items` and the
 * throughput total were permanently empty while every test passed, because the
 * test fixture fed it the raw shape instead of the emitted one.
 *
 * Both shapes are accepted: the compact emitted form, and the raw file (useful
 * when a custom command override points at `/proc/net/dev` directly). A colon
 * is the discriminator — only the raw form has one.
 */
export function parseNetDev(text) {
  const rows = [];
  for (const line of String(text).split("\n")) {
    // A `|` appears only in the two /proc/net/dev header lines (and never in an
    // interface name), so it is the discriminator for "not data". This is also
    // why there is no separate `Inter-|`/`face` name check: such a check would
    // be dead code behind this guard, and deleting it would change nothing — an
    // equivalent mutant, which reads as an uncaught defect.
    if (line.trim() === "" || line.includes("|")) continue;
    const idx = line.indexOf(":");
    if (idx >= 0) {
      // Raw /proc/net/dev: "eth0:" then 8 receive columns, then 8 transmit.
      const name = line.slice(0, idx).trim();
      if (!name || name === "lo") continue;
      const p = line.slice(idx + 1).trim().split(/\s+/);
      if (p.length < 9) continue;
      rows.push({ name, rxBytes: toInt(p[0]), txBytes: toInt(p[8]) });
      continue;
    }
    // The collector's own output: "name rxBytes txBytes".
    const p = line.trim().split(/\s+/);
    if (p.length < 3) continue;
    const name = p[0];
    if (!name || name === "lo") continue;
    rows.push({ name, rxBytes: toInt(p[1]), txBytes: toInt(p[2]) });
  }
  return rows;
}

/**
 * Parse the `diskio` collector into per-device cumulative 512-byte counters.
 *
 * The collector's awk has ALREADY selected the fields on the device
 * (`awk '{ n=$3; if (n !~ /^(loop|ram|sr|fd)/) print n, $6, $10 }'`), so what
 * arrives here is `name sectorsRead sectorsWritten` — three fields. An earlier
 * version only understood the RAW `/proc/diskstats` layout (14+ columns with
 * the name in `$3`), so it returned `[]` for every line production ever sent it
 * and `diskio` was permanently empty — while the tests passed, because the
 * fixture fed the raw shape rather than the emitted one.
 *
 * Both shapes are accepted; the field count discriminates. The raw form has
 * `$1=major $2=minor $3=name`, the emitted form has the name first.
 */
export function parseDiskstats(text) {
  const rows = [];
  for (const line of String(text).split("\n")) {
    const p = line.trim().split(/\s+/);
    const compact = p.length >= 3 && p.length < 10;
    const raw = p.length >= 10;
    if (!compact && !raw) continue;
    const name = raw ? p[2] : p[0];
    if (!name || /^(loop|ram|sr|fd)/.test(name)) continue;
    const read = raw ? p[5] : p[1];
    const written = raw ? p[9] : p[2];
    rows.push({ name, sectorsRead: toInt(read), sectorsWritten: toInt(written) });
  }
  return rows;
}

/** Parse the `tcp` collector: a single integer. Missing output => null. */
export function parseTcpCount(text) {
  const trimmed = String(text).trim();
  if (!trimmed) return null;
  const first = trimmed.split("\n")[0].trim();
  const n = parseInt(first, 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * Turn two cumulative counter maps into per-item rates plus a total.
 *
 * These are RATE metrics, so a single sample cannot produce a figure: with no
 * baseline (the first poll, or a counter reset by a reboot) every rate is
 * genuinely unknown and is reported as `null`, not 0. Reporting 0 would draw a
 * flat line at the bottom of the chart and read as "this device's network is
 * idle", which is a different and much more confident claim than "unknown".
 *
 * A counter that DECREASED (reboot, interface flap, counter wraparound) also
 * yields `null` for that item rather than a negative or absurd spike.
 *
 * @param prevRows - previous sample's rows (the cumulative baseline).
 * @param curRows  - this sample's rows.
 * @param readField - which property holds the cumulative read counter.
 * @param writeField - which property holds the cumulative write counter.
 * @param opts.scale - bytes per counter unit (1 for /proc/net/dev, 512 for
 *   /proc/diskstats sectors).
 * @param opts.elapsedMs - time between the two samples. A non-positive or
 *   absurd value yields nulls rather than dividing by ~0 and rendering a
 *   multi-gigabit spike that never happened.
 */
export function rateSince(prevRows, curRows, readField, writeField, opts = {}) {
  const scale = opts.scale ?? 1;
  const elapsedMs = opts.elapsedMs ?? 0;
  const usable = Number.isFinite(elapsedMs) && elapsedMs > 0;
  const seconds = elapsedMs / 1000;
  const prevByName = new Map();
  for (const row of prevRows ?? []) prevByName.set(row.name, row);
  const items = [];
  let rxTotal = 0;
  let txTotal = 0;
  let anyKnown = false;
  for (const row of curRows) {
    const prev = prevByName.get(row.name);
    let rx = null;
    let tx = null;
    if (prev !== undefined && usable) {
      const dRx = row[readField] - prev[readField];
      const dTx = row[writeField] - prev[writeField];
      if (dRx >= 0) rx = Math.round((dRx * scale) / seconds);
      if (dTx >= 0) tx = Math.round((dTx * scale) / seconds);
    }
    if (rx !== null || tx !== null) anyKnown = true;
    items.push({ name: row.name, rx, tx });
    if (rx !== null) rxTotal += rx;
    if (tx !== null) txTotal += tx;
  }
  items.sort((a, b) => (b.rx ?? 0) + (b.tx ?? 0) - ((a.rx ?? 0) + (a.tx ?? 0)));
  return { items, rxTotal: anyKnown ? rxTotal : null, txTotal: anyKnown ? txTotal : null, seconds };
}

/**
 * Aggregate a raw batch of per-collector text into a normalized metric
 * snapshot.
 *
 * @param prev - the previous sample, or undefined on the first poll.
 * @param rawTexts - collector key => stdout text.
 * @param metrics - the device's selected metric keys, or `undefined` to
 *   aggregate everything. A metric that was NOT selected yields `null`, never a
 *   zero: "we did not ask" and "the device reported nothing" must stay
 *   distinguishable all the way to the screen, because only one of them is a
 *   fault worth investigating. See DESIGN.md §5.3/§5.6 and ADR 52.
 *
 * The `procStat` raw object is always retained when CPU was collected, because
 * CPU percentage is a delta between two readings and the NEXT poll needs this
 * baseline.
 */
export function aggregate(prev, rawTexts, metrics) {
  const now = Date.now();
  const wanted = metrics === undefined ? null : new Set(metrics);
  const on = (key) => wanted === null || wanted.has(key);
  const elapsedMs = prev?.ts !== undefined ? now - prev.ts : 0;

  const cpuCur = parseProcStat(rawTexts.procStat);
  const cpu = on("cpu") ? cpuPercent(prev?.procStat, cpuCur) : null;
  const mem = on("mem") ? parseMeminfo(rawTexts.procMem) : null;
  const disks = on("disk") ? parseDf(rawTexts.df) : null;
  const load = on("load") ? parseLoadavg(rawTexts.loadavg) : null;
  const uptime = on("uptime") ? parseUptime(rawTexts.procUptime) : null;
  const thermal = on("temp") ? parseThermal(rawTexts.thermal) : null;
  const processes = on("procs") ? toInt(rawTexts.procCount) : null;
  const top = on("top") ? parseTop(rawTexts.top) : null;
  const tcp = on("tcp") ? parseTcpCount(rawTexts.tcp) : null;

  const netRows = on("net") ? parseNetDev(rawTexts.net) : null;
  const netRates =
    netRows === null
      ? null
      : rateSince(prev?.netRows, netRows, "rxBytes", "txBytes", { scale: 1, elapsedMs });

  const dioRows = on("diskio") ? parseDiskstats(rawTexts.diskio) : null;
  const dioRates =
    dioRows === null
      ? null
      : rateSince(prev?.dioRows, dioRows, "sectorsRead", "sectorsWritten", { scale: 512, elapsedMs });

  const model = parseCpuInfo(rawTexts.cpuInfo);
  const version = (rawTexts.version || "").trim().split("\n")[0] || "";
  const services = Array.isArray(rawTexts.services)
    ? rawTexts.services.map((s) => String(s).trim()).filter(Boolean)
    : (rawTexts.services || "")
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);

  // Core count for the load reading. The load collector carries its own tally;
  // when that line did not come back (an old busybox whose `grep -c` failed, or
  // output truncated at the timeout) fall back to counting /proc/stat, which was
  // read anyway whenever the CPU metric is on. `null` when neither answered:
  // the client must then decline to scale the load rather than assume one core,
  // because a fabricated denominator is a fabricated reading.
  const loadCores = load === null ? null : (load.cores ?? (rawTexts.procStat ? coresOf(rawTexts.procStat) : null));

  const sample = {
    ts: now,
    // The metric selection is echoed onto the sample so every downstream
    // consumer (series columns, tool output, raw-log naming) can tell which
    // nulls mean "not collected" without re-reading the roster.
    metrics: metrics === undefined ? null : [...metrics],
    uptimeMs: uptime === null ? null : uptime.seconds * 1000,
    uptimeText: uptime === null ? null : uptime.text,
    model,
    kernel: version,
    cpu:
      cpu === null
        ? null
        : {
            percent: cpu,
            user: cpuCur.user,
            system: cpuCur.system,
            idle: cpuCur.idle,
            cores: coresOf(rawTexts.procStat),
          },
    load:
      load === null
        ? null
        : { load1: load.load1, load5: load.load5, load15: load.load15, running: load.running, total: load.total, cores: loadCores },
    memory: mem,
    disk: disks,
    thermal: thermal === null ? null : thermal.length ? thermal : null,
    top,
    tcp,
    net: netRates,
    diskio: dioRates,
    processes,
    services: services.slice(0, 20),
    durationMs: 0, // overwritten by the caller, which owns the connection
  };
  // Cumulative baselines for the next poll. Kept OUTSIDE the public sample (see
  // publicSample) so the browser is not shipped a few KB of counter tables it
  // cannot use.
  sample.procStat = cpuCur;
  if (netRows !== null) sample.netRows = netRows;
  if (dioRows !== null) sample.dioRows = dioRows;
  return sample;
}

/**
 * Count the logical CPUs in a /proc/stat body.
 *
 * Returns `null` when no `cpuN` line was found — which is NOT the same as "this
 * is a single-core box", and the distinction is load-bearing. `/proc/stat` is
 * only read when the `cpu` metric is selected, so an empty or missing body is
 * the normal case for a load-only device, not an impossibility. This used to
 * return `Math.max(1, n)`, which turned "we never looked" into a confident
 * "1 core" — the same fabricated-denominator family as the load bar, and it
 * fed `cpu.cores`, the value the load reading used to borrow.
 *
 * Callers that divide by the count must therefore handle `null` rather than
 * lean on a floor here.
 */
function coresOf(procStatText) {
  let n = 0;
  for (const line of String(procStatText).split("\n")) {
    if (/^cpu\d/.test(line.trim())) n++;
  }
  return n < 1 ? null : n;
}
