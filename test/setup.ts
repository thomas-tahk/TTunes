import { afterEach } from "vitest";
import { removeTempDirs } from "./helpers.ts";

afterEach(removeTempDirs);
