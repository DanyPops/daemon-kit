/**
 * Structured, credential-safe logging for daemons. Backed by pino (mature,
 * fast, Bun-compatible -- verified directly) rather than reimplementing
 * level ordering/filtering/child-scoping by hand, which is what three of
 * the four daemons this kit replaces had each done independently (one not
 * at all, one minimally, one fully -- pi-packed's log.ts was the most
 * complete and is the shape this module preserves).
 *
 * Output keeps the pre-existing convention of a string `level` field
 * ("info", not pino's numeric 30) so log consumers (journalctl greps,
 * dashboards) built against the old hand-rolled loggers keep working
 * unchanged.
 */
import pino from "pino";

export type LogLevel = "debug" | "info" | "warn" | "error";
export interface LogFields {
	[key: string]: unknown;
}

export interface Logger {
	debug(msg: string, fields?: LogFields): void;
	info(msg: string, fields?: LogFields): void;
	warn(msg: string, fields?: LogFields): void;
	error(msg: string, fields?: LogFields): void;
}

const LEVELS: ReadonlySet<string> = new Set(["debug", "info", "warn", "error"]);

export interface CreateLoggerOptions {
	/** Env var read for the minimum level, e.g. "PI_PACKED_LOG_LEVEL". Defaults to "info" when unset or unrecognized. */
	levelEnvVar?: string;
	/** Explicit level override, takes precedence over levelEnvVar. */
	level?: LogLevel;
	/** Injectable sink for tests; defaults to stderr (stdout is reserved for CLI output). */
	destination?: NodeJS.WritableStream | pino.DestinationStream;
	env?: Record<string, string | undefined>;
}

function resolveLevel(options: CreateLoggerOptions): LogLevel {
	if (options.level) return options.level;
	const env = options.env ?? process.env;
	const raw = options.levelEnvVar ? env[options.levelEnvVar] : undefined;
	return raw && LEVELS.has(raw) ? (raw as LogLevel) : "info";
}

/** One logger per module/component, matching every prior daemon's convention. */
export function createLogger(component: string, options: CreateLoggerOptions = {}): Logger {
	const level = resolveLevel(options);
	const destination = options.destination ?? pino.destination(2); // stderr
	const instance = pino(
		{
			level,
			base: undefined, // omit pid/hostname -- daemons already log pid via the handle file
			formatters: { level: (label) => ({ level: label }) },
			timestamp: () => `,"timestamp":"${new Date().toISOString()}"`,
		},
		destination,
	).child({ component });

	return {
		debug: (msg, fields) => instance.debug(fields ?? {}, msg),
		info: (msg, fields) => instance.info(fields ?? {}, msg),
		warn: (msg, fields) => instance.warn(fields ?? {}, msg),
		error: (msg, fields) => instance.error(fields ?? {}, msg),
	};
}
