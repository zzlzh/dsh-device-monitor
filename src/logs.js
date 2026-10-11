/**
 * The audit trail: who changed what, when.
 *
 * Ported from the reference device-manager's `lib/audit.js`. This plugin has no
 * multi-user concept (the HTTP layer is loopback-only), so "who" is always the
 * local user. The value is in the OTHER two questions: *when* did this change,
 * and *what* was it before — the questions asked after a device silently stops
 * being monitored.
 *
 * HARD RULE: only field NAMES are recorded, never values. A settings change
 * audit that includes values will eventually include a credential — the
 * reference makes the same choice for the same reason (`server.js:1132`).
 *
 * Kept in a separate file from the raw device logs because raw volume is
 * hundreds of times larger: sharing one file would flush the audit history
 * within hours, which is exactly when it is needed.
 */
import { createJsonlLog } from "./jsonl-log.js";

const log = createJsonlLog({ name: "log/audit.log", warnPrefix: "⚠️  写入审计日志失败" });

/**
 * Record one audit event.
 * Never throws and never blocks the caller.
 *
 * @param event - a short machine-readable kind, e.g. `device.create`.
 * @param detail - structured context. NEVER put credentials or setting VALUES
 *   here; pass field NAMES only.
 */
export function audit(event, detail = {}) {
	try {
		return log.append({ at: new Date().toISOString(), event, ...detail });
	} catch (error) {
		console.warn(`⚠️  写入审计日志失败: ${error instanceof Error ? error.message : String(error)}`);
		return false;
	}
}

/** Read the most recent audit records, newest first. */
export function readAudit(limit = 100) {
	return log.read(limit);
}

/** The audit log's absolute path. */
export function auditPath() {
	return log.file();
}

/** The exception (incident) log, sharing the JSONL layer. */
const incidentLog = createJsonlLog({ name: "log/incidents.log", warnPrefix: "⚠️  写入异常日志失败" });

/** Durable exception record. Written by IncidentTracker's onRecord hook. */
export function recordIncident(record) {
	try {
		return incidentLog.append(record);
	} catch (error) {
		console.warn(`⚠️  写入异常日志失败: ${error instanceof Error ? error.message : String(error)}`);
		return false;
	}
}

/** Read recent exception records, newest first. */
export function readIncidents(limit = 100) {
	return incidentLog.read(limit);
}

/** The exception log's absolute path. */
export function incidentPath() {
	return incidentLog.file();
}
