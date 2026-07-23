#!/usr/bin/env bun
/** Test fixture: writes one env var's value to the file path given as argv[2], so supervisor.test.ts can assert env injection reached a real spawned child without relying on captured stdout (production spawnUnit inherits stdio). */
import { writeFileSync } from "node:fs";

const outPath = process.argv[2];
if (!outPath) throw new Error("usage: echo-env-unit.ts <output-path>");
writeFileSync(outPath, process.env.PROBE_VALUE ?? "");
