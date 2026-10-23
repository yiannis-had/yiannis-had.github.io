/*
 * Shared REPL console.
 *
 * The console owns everything that is the same for every runtime: the output
 * pane and its wrapping, the multi-line input, history, initialisation log and
 * error display.
 *
 * An engine owns everything runtime-specific. It provides:
 *
 *   prompt, continuationPrompt  text shown in front of the input
 *   inputLabel                  accessible name for the textarea
 *   indentAfter                 regex; indent after a line matching it
 *   placeholder                 shown while the runtime initialises
 *   unavailablePlaceholder      shown when initialisation failed
 *   initTitle                   heading of the initialisation log
 *   initErrorMessage            shown next to the retry button
 *   clearNote                   note printed after clearing the console
 *   meta                        footer markup
 *
 *   init(api)                   async; resolves when the runtime is ready
 *   submit(source, api)         async; returns { incomplete?: boolean }
 *                               (api may be unused by some engines)
 *   welcome()                   array of strings or { code } parts
 *
 * The `api` passed to engines is:
 *
 *   write(text, kind)           append runtime output
 *   note(text)                  append a dim informational line
 *   addStep(text)               add a step to the init log and return its handle
 *   addSteps(texts)             add several steps
 *   activate(step)              mark a step as running
 *   complete(step, text)        mark a step as done, optionally relabel it
 *   resetInit()                 clear the init log and start over
 *   resolveLatestNpmVersion(package, label)
 *                              look up the latest jsDelivr release
 */
(function (global) {
    "use strict";

    const MAX_OUTPUT_CHARS = 200_000;
    const HISTORY_LIMIT = 100;
    const NPM_LATEST_URL = "https://data.jsdelivr.com/v1/package/resolve/npm";
    const SEMVER_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

    const STREAM_CLASSES = {
        stdout: "repl-stdout",
        stderr: "repl-stderr",
        notice: "repl-notice",
    };

    const HINTS = {
        coarse: 'tap run to execute <span class="repl-sep" aria-hidden="true">·</span> <kbd>Enter</kbd> adds a line',
        fine: '<kbd>Enter</kbd> to run <span class="repl-sep" aria-hidden="true">·</span> <kbd>Shift</kbd> + <kbd>Enter</kbd> for a new line <span class="repl-sep" aria-hidden="true">·</span> <kbd>↑</kbd> <kbd>↓</kbd> history',
    };

    function createReplConsole(engine) {
        const element = (id) => {
            const node = document.getElementById(id);
            if (!node) {
                throw new Error(`REPL markup is missing #${id}`);
            }
            return node;
        };

        const replEl = element("repl");
        const outputEl = element("repl-output");
        const formEl = element("repl-form");
        const inputEl = element("repl-input");
        const runButton = element("repl-run");
        const wrapButton = element("repl-wrap");
        const clearButton = element("repl-clear");
        const promptEl = element("repl-prompt");
        const hintEl = element("repl-hint");
        const metaEl = element("repl-meta");

        const coarsePointer = global.matchMedia("(pointer: coarse)").matches;

        let ready = false;
        let busy = false;
        let continuation = false;
        let initPromise = null;
        let initLogEl = null;
        let activeInitStep = null;
        let welcomeEl = null;
        let currentRun = null;

        const history = [];
        let historyIndex = 0;
        let draft = "";

        /* ------------------------------------------------------------------ */
        /* Output                                                              */
        /* ------------------------------------------------------------------ */

        function createLine(className) {
            const line = document.createElement("div");
            line.className = `repl-line ${className}`;
            outputEl.appendChild(line);
            return line;
        }

        function scrollToBottom() {
            outputEl.scrollTop = outputEl.scrollHeight;
        }

        function appendNote(text) {
            const line = createLine("repl-note");
            line.textContent = text;
            scrollToBottom();
            return line;
        }

        function appendWelcome() {
            const line = createLine("repl-note");
            for (const part of engine.welcome()) {
                if (typeof part === "string") {
                    line.append(part);
                } else if (part && typeof part.code === "string") {
                    const code = document.createElement("code");
                    code.textContent = part.code;
                    line.append(code);
                }
            }
            scrollToBottom();
            return line;
        }

        function appendEcho(source) {
            const line = createLine("repl-echo");
            const lines = source.split("\n");
            // The blank continuation line that terminates a block is not part
            // of what the user typed; don't echo it.
            if (lines.length > 1 && lines[lines.length - 1].trim() === "") {
                lines.pop();
            }

            lines.forEach((text, index) => {
                const prompt = document.createElement("span");
                prompt.className = "repl-echo-prompt";
                prompt.textContent = `${index === 0 ? engine.prompt : engine.continuationPrompt} `;
                line.append(prompt, document.createTextNode(text));
                if (index < lines.length - 1) {
                    line.append(document.createTextNode("\n"));
                }
            });

            scrollToBottom();
            return line;
        }

        function appendStream(text, kind) {
            if (!text || !currentRun) {
                return;
            }

            if (currentRun.charCount >= MAX_OUTPUT_CHARS) {
                currentRun.truncated = true;
                return;
            }
            if (currentRun.charCount + text.length > MAX_OUTPUT_CHARS) {
                text = text.slice(0, MAX_OUTPUT_CHARS - currentRun.charCount);
                currentRun.truncated = true;
            }
            currentRun.charCount += text.length;

            if (!currentRun.lastEl || currentRun.lastKind !== kind) {
                currentRun.lastEl = createLine(
                    STREAM_CLASSES[kind] || STREAM_CLASSES.stdout,
                );
                currentRun.lastKind = kind;
            }
            currentRun.lastEl.appendChild(document.createTextNode(text));
            scrollToBottom();
        }

        /* ------------------------------------------------------------------ */
        /* Initialisation log                                                  */
        /* ------------------------------------------------------------------ */

        function startInitLog(title) {
            if (initLogEl) {
                initLogEl.remove();
            }

            initLogEl = document.createElement("div");
            initLogEl.className = "repl-init";

            const heading = document.createElement("div");
            heading.className = "repl-init-title";
            heading.textContent = title;
            initLogEl.appendChild(heading);

            outputEl.appendChild(initLogEl);
            activeInitStep = null;
            scrollToBottom();
        }

        function dismissIntro() {
            if (initLogEl) {
                initLogEl.remove();
                initLogEl = null;
                activeInitStep = null;
            }
            if (welcomeEl) {
                welcomeEl.remove();
                welcomeEl = null;
            }
        }

        function addInitSteps(texts) {
            if (!initLogEl) {
                return [];
            }

            return texts.map((text) => {
                const row = document.createElement("div");
                row.className = "repl-init-step";
                row.dataset.state = "pending";

                const mark = document.createElement("span");
                mark.className = "repl-init-mark";
                mark.setAttribute("aria-hidden", "true");
                mark.textContent = "·";

                const label = document.createElement("span");
                label.className = "repl-init-label";
                label.textContent = text;

                row.append(mark, label);
                initLogEl.appendChild(row);
                return { row, mark, label };
            });
        }

        function activateStep(step) {
            if (!step) {
                return;
            }
            step.row.dataset.state = "active";
            step.mark.textContent = "…";
            activeInitStep = step;
            scrollToBottom();
        }

        function completeStep(step, text) {
            if (!step) {
                return;
            }
            step.row.dataset.state = "done";
            step.mark.textContent = "✓";
            if (text) {
                step.label.textContent = text;
            }
            if (activeInitStep === step) {
                activeInitStep = null;
            }
            scrollToBottom();
        }

        function failActiveStep() {
            if (!activeInitStep) {
                return;
            }
            activeInitStep.row.dataset.state = "error";
            activeInitStep.mark.textContent = "✕";
            activeInitStep = null;
            scrollToBottom();
        }

        function addInitError(text, onRetry) {
            if (!initLogEl) {
                return;
            }

            const row = document.createElement("div");
            row.className = "repl-init-error";
            row.append(document.createTextNode(`${text} `));

            const retry = document.createElement("button");
            retry.type = "button";
            retry.className = "repl-retry";
            retry.textContent = "retry";
            retry.addEventListener(
                "click",
                () => {
                    retry.disabled = true;
                    onRetry();
                },
                { once: true },
            );

            row.appendChild(retry);
            initLogEl.appendChild(row);
            scrollToBottom();
        }

        function resetInitLog() {
            if (initLogEl) {
                initLogEl.remove();
                initLogEl = null;
                activeInitStep = null;
            }
            startInitLog(engine.initTitle);
        }

        /* ------------------------------------------------------------------ */
        /* Input                                                               */
        /* ------------------------------------------------------------------ */

        function resizeInput() {
            const maxHeight = 224;
            inputEl.style.height = "auto";
            const next = Math.min(inputEl.scrollHeight, maxHeight);
            inputEl.style.height = `${next}px`;
            inputEl.style.overflowY =
                inputEl.scrollHeight > maxHeight ? "auto" : "hidden";
        }

        function setContinuation(next) {
            continuation = next;
            promptEl.textContent = next
                ? engine.continuationPrompt
                : engine.prompt;
        }

        function insertNewline() {
            const start = inputEl.selectionStart;
            const before = inputEl.value.slice(0, start);
            const lineStart = before.lastIndexOf("\n") + 1;
            const line = before.slice(lineStart);
            const indentMatch = line.match(/^[ \t]*/);
            const indent = indentMatch ? indentMatch[0] : "";

            let insertion = `\n${indent}`;
            // Indent one level after a block opener or an open bracket.
            if (engine.indentAfter.test(line)) {
                insertion += "    ";
            }

            inputEl.setRangeText(insertion, start, inputEl.selectionEnd, "end");
            resizeInput();
        }

        function dedentInput() {
            const value = inputEl.value;
            const start = inputEl.selectionStart;
            const end = inputEl.selectionEnd;
            // Explicitly handle the first line: lastIndexOf(..., -1) is a
            // needlessly subtle edge case.
            const lineStart =
                start === 0 ? 0 : value.lastIndexOf("\n", start - 1) + 1;
            const line = value.slice(lineStart);
            const leading = line.match(/^[ \t]+/);
            const leadingEnd = leading
                ? lineStart + leading[0].length
                : lineStart;
            const collapsed = start === end;

            let removeStart = -1;
            let removeEnd = -1;
            let newStart;
            let newEnd;

            // Remove one indent unit from the start of the line.
            const removeLeading = () => {
                if (!leading) {
                    return false;
                }
                const width =
                    leading[0][0] === "\t"
                        ? 1
                        : Math.min(4, leading[0].length);
                removeStart = lineStart;
                removeEnd = lineStart + width;
                newStart = start >= removeEnd ? start - width : lineStart;
                newEnd = end >= removeEnd ? end - width : lineStart;
                return true;
            };

            // Caret at/inside the leading indentation: one unit from the start.
            if (collapsed && leading && start <= leadingEnd) {
                removeLeading();
            }

            // Caret after text: remove one unit of whitespace immediately
            // before it (the inverse of Tab inserting at the caret). A unit is
            // one tab or up to four spaces.
            if (removeStart === -1 && collapsed) {
                const before = value.slice(lineStart, start);
                if (before.endsWith("\t")) {
                    removeStart = start - 1;
                    removeEnd = start;
                    newStart = newEnd = removeStart;
                } else {
                    const spaces = before.match(/ +$/);
                    if (spaces) {
                        const width = Math.min(4, spaces[0].length);
                        removeStart = start - width;
                        removeEnd = start;
                        newStart = newEnd = removeStart;
                    }
                }
            }

            // Otherwise remove one unit of the line's leading indentation.
            if (removeStart === -1 && !removeLeading()) {
                return;
            }

            const dedented =
                value.slice(0, removeStart) + value.slice(removeEnd);
            try {
                inputEl.setRangeText("", removeStart, removeEnd, "end");
            } catch {
                inputEl.value = dedented;
            }
            // Some browsers don't apply setRangeText at the very start of the
            // value; fall back to writing the value directly.
            if (inputEl.value === value) {
                inputEl.value = dedented;
            }
            inputEl.setSelectionRange(newStart, newEnd);
        }

        function handleTabBackspace() {
            if (inputEl.selectionStart !== inputEl.selectionEnd) {
                return false;
            }

            const start = inputEl.selectionStart;
            const value = inputEl.value;
            if (start < 4) {
                return false;
            }

            const before = value.slice(0, start);
            if (!before.endsWith("    ")) {
                return false;
            }

            // If the caret is inside a whitespace run, let Backspace delete
            // one character normally. Only collapse a complete four-space unit
            // when the caret is at the end of the run.
            const next = value[start] || "";
            if (next === " " || next === "\t") {
                return false;
            }

            const removeStart = start - 4;
            const nextValue = value.slice(0, removeStart) + value.slice(start);
            try {
                inputEl.setRangeText("", removeStart, start, "end");
            } catch {
                inputEl.value = nextValue;
            }
            if (inputEl.value === value) {
                inputEl.value = nextValue;
            }
            inputEl.setSelectionRange(removeStart, removeStart);
            resizeInput();
            return true;
        }

        function handleTabDelete() {
            if (inputEl.selectionStart !== inputEl.selectionEnd) {
                return false;
            }

            const start = inputEl.selectionStart;
            const value = inputEl.value;
            if (value.slice(start, start + 4) !== "    ") {
                return false;
            }

            // Only collapse a unit when the caret is at the start of the run,
            // not in the middle of whitespace.
            const previous = value[start - 1] || "";
            if (previous === " " || previous === "\t") {
                return false;
            }

            const nextValue =
                value.slice(0, start) + value.slice(start + 4);
            try {
                inputEl.setRangeText("", start, start + 4, "start");
            } catch {
                inputEl.value = nextValue;
            }
            if (inputEl.value === value) {
                inputEl.value = nextValue;
            }
            inputEl.setSelectionRange(start, start);
            resizeInput();
            return true;
        }

        function setInputValue(value) {
            inputEl.value = value;
            resizeInput();
            inputEl.setSelectionRange(value.length, value.length);
            setContinuation(false);
        }

        /* ------------------------------------------------------------------ */
        /* History                                                             */
        /* ------------------------------------------------------------------ */

        function pushHistory(source) {
            if (history[history.length - 1] !== source) {
                history.push(source);
                if (history.length > HISTORY_LIMIT) {
                    history.shift();
                }
            }
            historyIndex = history.length;
        }

        function navigateHistory(direction) {
            if (history.length === 0) {
                return;
            }

            if (direction < 0) {
                if (historyIndex === history.length) {
                    draft = inputEl.value;
                }
                if (historyIndex === 0) {
                    return;
                }
                historyIndex -= 1;
                setInputValue(history[historyIndex]);
                return;
            }

            if (historyIndex >= history.length) {
                return;
            }
            historyIndex += 1;
            setInputValue(
                historyIndex === history.length ? draft : history[historyIndex],
            );
        }

        /* ------------------------------------------------------------------ */
        /* Console actions                                                     */
        /* ------------------------------------------------------------------ */

        const api = {
            write(text, kind = "stdout") {
                appendStream(text, kind);
            },
            note(text) {
                appendNote(text);
            },
            addStep(text) {
                return addInitSteps([text])[0] ?? null;
            },
            addSteps(texts) {
                return addInitSteps(texts);
            },
            activate(step) {
                activateStep(step);
            },
            complete(step, text) {
                completeStep(step, text);
            },
            resetInit() {
                resetInitLog();
            },

            // Both runtimes are loaded from jsDelivr; this lookup is shared.
            async resolveLatestNpmVersion(packageName, label = packageName) {
                const controller = new AbortController();
                const timeout = setTimeout(() => controller.abort(), 5000);

                try {
                    const response = await global.fetch(
                        `${NPM_LATEST_URL}/${packageName}@latest`,
                        { cache: "no-store", signal: controller.signal },
                    );
                    if (!response.ok) {
                        throw new Error(
                            `${label} version lookup failed: HTTP ${response.status}`,
                        );
                    }

                    const data = await response.json();
                    if (
                        typeof data.version !== "string" ||
                        !SEMVER_RE.test(data.version)
                    ) {
                        throw new Error(
                            `Unexpected ${label} version: ${String(data.version)}`,
                        );
                    }
                    return data.version;
                } finally {
                    clearTimeout(timeout);
                }
            },
        };

        function clearConsole() {
            if (!ready || busy) {
                return;
            }
            outputEl.replaceChildren();
            initLogEl = null;
            activeInitStep = null;
            welcomeEl = null;
            appendNote(engine.clearNote);
            inputEl.focus();
        }

        async function submit() {
            if (!ready || busy) {
                return;
            }

            const source = inputEl.value;
            if (!source.trim()) {
                inputEl.value = "";
                resizeInput();
                setContinuation(false);
                return;
            }

            busy = true;
            runButton.disabled = true;
            clearButton.disabled = true;

            const echo = appendEcho(source);
            const run = {
                charCount: 0,
                lastEl: null,
                lastKind: null,
                truncated: false,
            };
            currentRun = run;

            let outcome = {};
            try {
                outcome = (await engine.submit(source, api)) || {};
            } catch (error) {
                console.error(error);
                const message = error?.message
                    ? error.message
                    : String(error);
                appendStream(
                    message.endsWith("\n") ? message : `${message}\n`,
                    "stderr",
                );
            }

            currentRun = null;

            if (run.truncated) {
                appendNote("[output truncated]");
            }

            if (outcome.incomplete) {
                // Nothing ran; remove the echo and keep the draft, ready for
                // the next line of the statement.
                echo.remove();
                insertNewline();
                setContinuation(true);
            } else {
                dismissIntro();
                pushHistory(source);
                inputEl.value = "";
                resizeInput();
                setContinuation(false);
                draft = "";
                historyIndex = history.length;
            }

            busy = false;
            runButton.disabled = false;
            clearButton.disabled = false;
            scrollToBottom();
            inputEl.focus();
        }

        function handleCommandError(error) {
            console.error(error);
            currentRun = null;
            busy = false;
            runButton.disabled = false;
            clearButton.disabled = false;
            scrollToBottom();
            inputEl.focus();
        }

        /* ------------------------------------------------------------------ */
        /* Initialisation                                                      */
        /* ------------------------------------------------------------------ */

        function initialise() {
            if (initPromise) {
                return initPromise;
            }

            initPromise = (async () => {
                ready = false;
                inputEl.disabled = true;
                runButton.disabled = true;
                clearButton.disabled = true;
                inputEl.placeholder = engine.placeholder;
                replEl.dataset.state = "initialising";

                startInitLog(engine.initTitle);

                try {
                    await engine.init(api);

                    ready = true;
                    replEl.dataset.state = "ready";
                    welcomeEl = appendWelcome();

                    inputEl.disabled = false;
                    inputEl.placeholder = "";
                    runButton.disabled = false;
                    clearButton.disabled = false;
                    if (!coarsePointer) {
                        inputEl.focus({ preventScroll: true });
                    }
                } catch (error) {
                    console.error(error);

                    replEl.dataset.state = "error";
                    failActiveStep();
                    addInitError(engine.initErrorMessage, () => {
                        initPromise = null;
                        initialise().catch(handleCommandError);
                    });
                    inputEl.placeholder = engine.unavailablePlaceholder;
                    inputEl.disabled = true;
                    runButton.disabled = true;
                    clearButton.disabled = true;
                }
            })();

            return initPromise;
        }

        /* ------------------------------------------------------------------ */
        /* Output wrapping                                                     */
        /* ------------------------------------------------------------------ */

        let wrapEnabled = false;

        function applyWrap() {
            outputEl.classList.toggle("repl-output-nowrap", !wrapEnabled);
            wrapButton.setAttribute("aria-pressed", String(wrapEnabled));
            wrapButton.title = wrapEnabled
                ? "Text wrapping is on — click to turn it off"
                : "Text wrapping is off — click to turn it on";
        }

        wrapButton.addEventListener("click", () => {
            wrapEnabled = !wrapEnabled;
            applyWrap();
        });

        applyWrap();

        /* ------------------------------------------------------------------ */
        /* Wiring                                                              */
        /* ------------------------------------------------------------------ */

        promptEl.textContent = engine.prompt;
        inputEl.setAttribute("aria-label", engine.inputLabel);
        metaEl.innerHTML = engine.meta;
        hintEl.innerHTML = coarsePointer ? HINTS.coarse : HINTS.fine;

        clearButton.addEventListener("click", clearConsole);

        formEl.addEventListener("submit", (event) => {
            event.preventDefault();
            submit().catch(handleCommandError);
        });

        inputEl.addEventListener("keydown", (event) => {
            if (event.isComposing) {
                return;
            }

            if (event.key === "Enter") {
                // On touch keyboards Enter is the only way to add a line
                // break; run via the button there.
                if (event.shiftKey || coarsePointer) {
                    return;
                }
                event.preventDefault();
                submit().catch(handleCommandError);
                return;
            }

            if (event.key === "Backspace") {
                if (
                    !event.metaKey &&
                    !event.ctrlKey &&
                    !event.altKey &&
                    handleTabBackspace()
                ) {
                    event.preventDefault();
                }
                return;
            }

            if (event.key === "Delete") {
                if (
                    !event.metaKey &&
                    !event.ctrlKey &&
                    !event.altKey &&
                    handleTabDelete()
                ) {
                    event.preventDefault();
                }
                return;
            }

            if (
                event.key === "Tab" ||
                event.key === "ISO_Left_Tab" ||
                event.code === "Tab"
            ) {
                event.preventDefault();
                if (event.shiftKey) {
                    dedentInput();
                } else {
                    inputEl.setRangeText(
                        "    ",
                        inputEl.selectionStart,
                        inputEl.selectionEnd,
                        "end",
                    );
                }
                resizeInput();
                return;
            }

            const collapsed =
                inputEl.selectionStart === inputEl.selectionEnd;

            if (
                event.key === "ArrowUp" &&
                collapsed &&
                !event.shiftKey &&
                !event.metaKey &&
                !event.ctrlKey &&
                !event.altKey
            ) {
                // Up recalls history from anywhere on the first line; on later
                // lines it keeps the normal caret movement.
                const beforeCaret = inputEl.value.slice(
                    0,
                    inputEl.selectionStart,
                );
                if (!beforeCaret.includes("\n")) {
                    event.preventDefault();
                    navigateHistory(-1);
                }
                return;
            }

            if (
                event.key === "ArrowDown" &&
                collapsed &&
                !event.shiftKey &&
                !event.metaKey &&
                !event.ctrlKey &&
                !event.altKey
            ) {
                // Down goes forward in history from anywhere on the last line.
                const afterCaret = inputEl.value.slice(inputEl.selectionEnd);
                if (!afterCaret.includes("\n")) {
                    event.preventDefault();
                    navigateHistory(1);
                }
            }
        });

        inputEl.addEventListener("input", () => {
            resizeInput();
            if (continuation && inputEl.value.trim() === "") {
                setContinuation(false);
            }
        });

        global.addEventListener("resize", resizeInput);

        resizeInput();
        initialise().catch(handleCommandError);
    }

    global.createReplConsole = createReplConsole;
})(window);
