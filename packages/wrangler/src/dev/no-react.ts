import assert from "node:assert";
import * as path from "node:path";
import { watch } from "chokidar";
import tmp from "tmp-promise";
import { bundleWorker } from "../bundle";
import { runCustomBuild } from "../entry";
import { logger } from "../logger";

import type { Config } from "../config";
import type { Entry } from "../entry";
import type { DevProps, DirectorySyncResult } from "./dev";
import type { EsbuildBundle } from "./use-esbuild";

import type { WatchMode } from "esbuild";

export function Implementation(
	props: DevProps & {
		local: boolean;
	}
) {
	if (
		!props.isWorkersSite &&
		props.assetPaths &&
		props.entry.format === "service-worker"
	) {
		throw new Error(
			"You cannot use the service-worker format with an `assets` directory yet. For information on how to migrate to the module-worker format, see: https://developers.cloudflare.com/workers/learning/migrating-to-module-workers/"
		);
	}

	if (props.bindings.wasm_modules && props.entry.format === "modules") {
		throw new Error(
			"You cannot configure [wasm_modules] with an ES module worker. Instead, import the .wasm module directly in your code"
		);
	}

	if (props.bindings.text_blobs && props.entry.format === "modules") {
		throw new Error(
			"You cannot configure [text_blobs] with an ES module worker. Instead, import the file directly in your code, and optionally configure `[rules]` in your wrangler.toml"
		);
	}

	if (props.bindings.data_blobs && props.entry.format === "modules") {
		throw new Error(
			"You cannot configure [data_blobs] with an ES module worker. Instead, import the file directly in your code, and optionally configure `[rules]` in your wrangler.toml"
		);
	}
	// implement a react-free version of useCustomBuild
	const watcher = setupCustomBuild(props.entry, props.build);

	//implement a react-free version of useTmpDir
	const directory = setupTempDir();
	if (!directory) {
		throw new Error("Failed to create temporary directory.");
	}
	//implement a react-free version of useEsbuild
	const bundle = runEsbuild({
		entry: props.entry,
		destination: directory.name,
		jsxFactory: props.jsxFactory,
		rules: props.rules,
		jsxFragment: props.jsxFragment,
		serveAssetsFromWorker: Boolean(
			props.assetPaths && !props.isWorkersSite && props.local
		),
		tsconfig: props.tsconfig,
		minify: props.minify,
		nodeCompat: props.nodeCompat,
		define: props.define,
		noBundle: props.noBundle,
	});
}

function setupCustomBuild(
	expectedEntry: Entry,
	build: Config["build"]
): ReturnType<typeof watch> | undefined {
	if (!build.command) return;
	let watcher: ReturnType<typeof watch> | undefined;
	if (build.watch_dir) {
		watcher = watch(build.watch_dir, {
			persistent: true,
			ignoreInitial: true,
		}).on("all", (_event, filePath) => {
			const relativeFile =
				path.relative(expectedEntry.directory, expectedEntry.file) || ".";
			//TODO: we should buffer requests to the proxy until this completes
			logger.log(`The file ${filePath} changed, restarting build...`);
			runCustomBuild(expectedEntry.file, relativeFile, build).catch((err) => {
				logger.error("Custom build failed:", err);
			});
		});
		return watcher;
	}
}

function setupTempDir(): DirectorySyncResult | undefined {
	let dir: DirectorySyncResult | undefined;
	try {
		dir = tmp.dirSync({ unsafeCleanup: true });

		return dir;
	} catch (err) {
		logger.error("Failed to create temporary directory to store built files.");
	}
}

async function runEsbuild({
	entry,
	destination,
	jsxFactory,
	jsxFragment,
	rules,
	serveAssetsFromWorker,
	tsconfig,
	minify,
	nodeCompat,
	define,
	noBundle,
}: {
	entry: Entry;
	destination: string | undefined;
	jsxFactory: string | undefined;
	jsxFragment: string | undefined;
	rules: Config["rules"];
	define: Config["define"];
	serveAssetsFromWorker: boolean;
	tsconfig: string | undefined;
	minify: boolean | undefined;
	nodeCompat: boolean | undefined;
	noBundle: boolean;
}): Promise<EsbuildBundle | undefined> {
	let stopWatching: (() => void) | undefined = undefined;
	let bundle: EsbuildBundle | undefined;
	function setBundle(b: EsbuildBundle) {
		bundle = b;
	}

	function updateBundle() {
		// nothing really changes here, so let's increment the id
		// to change the return object's identity
		const previousBundle = bundle;
		assert(
			previousBundle,
			"Rebuild triggered with no previous build available"
		);
		setBundle({ ...previousBundle, id: previousBundle.id + 1 });
	}

	const watchMode: WatchMode = {
		async onRebuild(error) {
			if (error) logger.error("Watch build failed:", error);
			else {
				updateBundle();
			}
		},
	};

	async function build() {
		if (!destination) return;

		const {
			resolvedEntryPointPath,
			bundleType,
			modules,
			stop,
		}: Awaited<ReturnType<typeof bundleWorker>> = noBundle
			? {
					modules: [],
					resolvedEntryPointPath: entry.file,
					bundleType: entry.format === "modules" ? "esm" : "commonjs",
					stop: undefined,
			  }
			: await bundleWorker(entry, destination, {
					serveAssetsFromWorker,
					jsxFactory,
					jsxFragment,
					rules,
					watch: watchMode,
					tsconfig,
					minify,
					nodeCompat,
					define,
					checkFetch: true,
			  });

		// Capture the `stop()` method to use as the `useEffect()` destructor.
		stopWatching = stop;

		// if "noBundle" is true, then we need to manually watch the entry point and
		// trigger "builds" when it changes
		if (noBundle) {
			const watcher = watch(entry.file, {
				persistent: true,
			}).on("change", async (_event) => {
				updateBundle();
			});

			stopWatching = () => {
				watcher.close();
			};
		}

		setBundle({
			id: 0,
			entry,
			path: resolvedEntryPointPath,
			type: bundleType,
			modules,
		});
	}

	await build().catch((err) => {
		// If esbuild fails on first run, we want to quit the process
		// since we can't recover from here
		// related: https://github.com/evanw/esbuild/issues/1037
		stopWatching?.();
		throw new Error(err);
	});
	return bundle;
}
