import { describe, expect, it } from "bun:test";
import { findServicesUsingSecret, type ServiceRecord } from "../src/secrets-backend.ts";

describe("findServicesUsingSecret", () => {
	const services: ServiceRecord[] = [
		{ name: "pipes", backends: ["github", "jenkins-ci"] },
		{ name: "tickets", backends: ["github", "jira"] },
		{ name: "web-spider", backends: ["brave"] },
	];

	it("returns every service whose backends list references the given secret name", () => {
		expect(findServicesUsingSecret(services, "github").map((s) => s.name)).toEqual(["pipes", "tickets"]);
	});

	it("returns [] for a secret no service references", () => {
		expect(findServicesUsingSecret(services, "unused")).toEqual([]);
	});

	it("returns exactly one match for a secret only one service uses", () => {
		expect(findServicesUsingSecret(services, "brave").map((s) => s.name)).toEqual(["web-spider"]);
	});
});
