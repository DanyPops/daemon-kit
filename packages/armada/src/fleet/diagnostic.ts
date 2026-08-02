export type DiagnosticSeverity = "error" | "warning" | "info";

export interface Diagnostic {
	readonly code: string;
	readonly severity: DiagnosticSeverity;
	readonly path: string;
	readonly message: string;
}

export function diagnostic(code: string, severity: DiagnosticSeverity, path: string, message: string): Diagnostic {
	return Object.freeze({ code, severity, path, message: message.slice(0, 2_000) });
}
