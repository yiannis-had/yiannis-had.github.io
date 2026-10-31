/*
 * Python REPL engine (CPython in WebAssembly, loaded through Pyodide).
 *
 * The shared console is loaded first and exposes createReplConsole(); this
 * file describes the Python runtime and starts the console.
 */
(function (global) {
    "use strict";

    // Known-good fallback. The latest Pyodide release is resolved at startup;
    // if it cannot be resolved or loaded, this version is used instead.
    const FALLBACK_RUNTIME_VERSION = "314.0.7";

    /*
     * The helper is deliberately small. `codeop` tells us whether the input is
     * complete (the textarea allows blocks and multiple statements), the final
     * expression is wrapped in a displayhook call so values are echoed like the
     * interactive interpreter, and the code is compiled with top-level await
     * enabled so `await ...` works at the prompt.
     */
    const HELPER_SOURCE = String.raw`
def _make_repl():
    import ast
    import codeop
    import inspect
    import re
    import sys
    import traceback

    ws_only_tail = re.compile(r"\n[ \t]+$")

    # Python 3.14's codeop handles incomplete input with a dedicated flag.
    # Mirror its compiler so top-level await is accepted as well.
    def compiler(source, filename, symbol, incomplete_input=True, *, flags=0):
        if incomplete_input:
            flags |= codeop.PyCF_ALLOW_INCOMPLETE_INPUT
            flags |= codeop.PyCF_DONT_IMPLY_DEDENT
        flags |= ast.PyCF_ALLOW_TOP_LEVEL_AWAIT
        return compile(source, filename, symbol, flags)

    def display(value):
        sys.displayhook(value)

    async def run(source):
        incomplete = False
        try:
            # A trailing whitespace-only line is how the textarea represents
            # "I pressed Enter on a blank continuation line". Ignore it when
            # checking completeness, otherwise a finished block never compiles.
            candidate = ws_only_tail.sub("\n", source)
            try:
                complete = codeop._maybe_compile(
                    compiler, candidate, "<stdin>", "exec", 0
                )
            except (OverflowError, SyntaxError, ValueError) as exc:
                traceback.print_exception(type(exc), exc, None, file=sys.stderr)
            else:
                if complete is None:
                    incomplete = True
                else:
                    try:
                        tree = compile(
                            candidate,
                            "<stdin>",
                            "exec",
                            ast.PyCF_ONLY_AST | ast.PyCF_ALLOW_TOP_LEVEL_AWAIT,
                        )
                        if tree.body and isinstance(tree.body[-1], ast.Expr):
                            last = tree.body[-1]
                            call = ast.Call(
                                func=ast.Name(id="__repl_display__", ctx=ast.Load()),
                                args=[last.value],
                                keywords=[],
                            )
                            ast.copy_location(call, last.value)
                            wrapper = ast.Expr(value=call)
                            ast.copy_location(wrapper, last)
                            tree.body[-1] = wrapper
                            ast.fix_missing_locations(tree)
                        code = compile(
                            tree, "<stdin>", "exec", ast.PyCF_ALLOW_TOP_LEVEL_AWAIT
                        )
                        result = eval(code, globals())
                        if inspect.isawaitable(result):
                            await result
                    except SystemExit as exc:
                        print("SystemExit: %r" % (exc.code,), file=sys.stderr)
                    except BaseException:
                        etype, value, tb = sys.exc_info()
                        traceback.print_exception(
                            etype,
                            value,
                            tb.tb_next if tb is not None else None,
                            file=sys.stderr,
                        )
        finally:
            try:
                sys.stdout.flush()
                sys.stderr.flush()
            except Exception:
                pass
        return incomplete

    return run, display


__repl_run, __repl_display__ = _make_repl()
del _make_repl
`;

    /* --------------------------------------------------------------------- */
    /* Python runtime                                                        */
    /* --------------------------------------------------------------------- */

    let runtime = null;
    let runtimeVersion = null;
    let platformVersion = null;

    let forceFallback = false;
    let triedFallback = false;
    let attemptedVersion = null;

    function loadScript(url) {
        return new Promise((resolve, reject) => {
            const script = document.createElement("script");
            script.src = url;
            script.onload = () => resolve();
            script.onerror = () => reject(new Error(`Failed to load ${url}`));
            document.head.appendChild(script);
        });
    }

    function makeWriter(api, kind) {
        const decoder = new TextDecoder("utf-8");
        return {
            isatty: false,
            write(buffer) {
                // Stop decoding once the console's output budget is exhausted.
                if (api.remainingOutput() <= 0) {
                    api.markTruncated();
                    return buffer.length;
                }

                const text = decoder.decode(buffer, { stream: true });
                if (text) {
                    api.write(text, kind);
                }
                return buffer.length;
            },
            fsync() {},
        };
    }

    function installHooks(api, instance) {
        instance.setStdout(makeWriter(api, "stdout"));
        instance.setStderr(makeWriter(api, "stderr"));
        instance.setStdin({
            stdin: () => {
                const answer = global.prompt("Python input()");
                return answer === null ? null : `${answer}\n`;
            },
            autoEOF: false,
        });
        instance.runPython(HELPER_SOURCE);
    }

    function parsePipInstall(source) {
        // %pip is the IPython/Jupyter magic form and is the documented
        // spelling. Bare pip/pip3 are accepted as quiet convenience aliases.
        const match = /^(?:%pip3?|pip3?)[ \t]+install[ \t]+(.+)$/i.exec(
            source.trim(),
        );
        if (!match) {
            return null;
        }
        const packages = match[1].trim().split(/[ \t]+/).filter(Boolean);
        return packages.length > 0 ? packages : null;
    }

    async function installPackages(packages) {
        if (!runtime) {
            throw new Error("Python is not ready.");
        }

        const target = packages.length === 1 ? packages[0] : packages;
        const label = packages.join(" ");
        const code = [
            "import micropip",
            `print("Installing " + ${JSON.stringify(label)} + "...")`,
            `await micropip.install(${JSON.stringify(target)})`,
            'print("Installed.")',
        ].join("\n");

        // micropip ships with Pyodide but is not loaded by default.
        await runtime.loadPackage("micropip");
        await runtime.runPythonAsync(code);
    }

    async function initRuntime(api, fallback) {
        let version = null;

        const resolveStep = api.addStep("Resolve the latest Pyodide release");
        if (fallback) {
            version = FALLBACK_RUNTIME_VERSION;
            api.complete(
                resolveStep,
                `Using Pyodide ${version} (latest failed)`,
            );
        } else {
            api.activate(resolveStep);
            try {
                version = await api.resolveLatestNpmVersion(
                    "pyodide",
                    "Pyodide",
                );
                api.complete(resolveStep, `Resolved Pyodide ${version} (latest)`);
            } catch (error) {
                console.warn(
                    `Couldn't resolve the latest Pyodide; using ${FALLBACK_RUNTIME_VERSION}.`,
                    error,
                );
                version = FALLBACK_RUNTIME_VERSION;
                forceFallback = true;
                api.complete(
                    resolveStep,
                    `Using Pyodide ${version} (latest lookup failed)`,
                );
            }
        }

        attemptedVersion = version;

        const baseUrl = `https://cdn.jsdelivr.net/pyodide/v${version}/full/`;
        const steps = api.addSteps([
            `Download the Pyodide ${version} loader from cdn.jsdelivr.net`,
            "Download pyodide.asm.wasm and python_stdlib.zip (~12 MB), then start CPython",
            "Install the stdin/stdout/stderr hooks and the REPL execution helper",
            "Verify the CPython interpreter",
        ]);

        api.activate(steps[0]);
        const loaderUrl = `${baseUrl}pyodide.js`;
        await loadScript(loaderUrl);
        api.complete(steps[0], `Downloaded the Pyodide ${version} loader`);

        api.activate(steps[1]);
        const instance = await global.loadPyodide({ indexURL: baseUrl });
        api.complete(
            steps[1],
            "Downloaded the runtime and standard library, started CPython",
        );

        api.activate(steps[2]);
        installHooks(api, instance);
        api.complete(
            steps[2],
            "Installed the stdin/stdout/stderr hooks and execution helper",
        );

        api.activate(steps[3]);
        const detectedVersion = instance.runPython(
            "import sys; sys.version.split()[0]",
        );

        // Self-test completeness detection and top-level await before
        // declaring the REPL ready.
        await instance.runPythonAsync('await __repl_run("None")');
        const incomplete = await instance.runPythonAsync(
            'await __repl_run("if True:")',
        );
        if (incomplete !== true) {
            throw new Error("REPL completeness self-test failed");
        }
        await instance.runPythonAsync(
            `await __repl_run(${JSON.stringify("await __import__('asyncio').sleep(0)")})`,
        );

        runtime = instance;
        runtimeVersion = version;
        platformVersion = detectedVersion;
        api.complete(steps[3], `Verified CPython ${platformVersion}`);
    }

    /* --------------------------------------------------------------------- */
    /* Engine                                                                */
    /* --------------------------------------------------------------------- */

    const engine = {
        prompt: ">>>",
        continuationPrompt: "...",
        inputLabel: "Python code",
        indentAfter: /[:([{][ \t]*(?:#.*)?$/,
        placeholder: "Initialising Python…",
        unavailablePlaceholder: "Python unavailable",
        initTitle: "Pyodide initialisation",
        initErrorMessage:
            "Couldn't start Pyodide. Check your connection and try again.",
        clearNote:
            "Console cleared. Variables from this session are still defined.",
        meta: 'built with <a href="https://pyodide.org/" target="_blank" rel="noopener noreferrer">Pyodide</a> <span class="repl-sep" aria-hidden="true">·</span> runtime from <a href="https://www.jsdelivr.com/" target="_blank" rel="noopener noreferrer">jsDelivr</a>',

        async init(api) {
            try {
                await initRuntime(api, forceFallback);
            } catch (error) {
                // If the latest release failed to load, retry once with the
                // known-good fallback release.
                if (
                    !triedFallback &&
                    attemptedVersion !== FALLBACK_RUNTIME_VERSION
                ) {
                    triedFallback = true;
                    forceFallback = true;
                    api.resetInit();
                    await initRuntime(api, true);
                    return;
                }
                throw error;
            }
        },

        async submit(source) {
            if (!runtime) {
                throw new Error("Python is not ready.");
            }

            const packages = parsePipInstall(source);
            if (packages) {
                await installPackages(packages);
                return {};
            }

            const incomplete = await runtime.runPythonAsync(
                `await __repl_run(${JSON.stringify(source)})`,
            );
            if (incomplete) {
                return { incomplete: true };
            }
            return {};
        },

        welcome() {
            return [
                `Pyodide ${runtimeVersion} · CPython ${platformVersion} ready. Use `,
                { code: "%pip install <package>" },
                " for PyPI packages.",
            ];
        },
    };

    global.createReplConsole(engine);
})(window);
