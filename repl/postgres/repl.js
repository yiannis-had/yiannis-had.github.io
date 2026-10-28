/*
 * Postgres REPL engine (PostgreSQL in WebAssembly, loaded through PGlite).
 *
 * The shared console is loaded first and exposes createReplConsole(); this
 * file describes the Postgres runtime and starts the console.
 */
(function (global) {
    "use strict";

    /* --------------------------------------------------------------------- */
    /* SQL input                                                             */
    /* --------------------------------------------------------------------- */

    /*
     * A semicolon is optional. Enter runs the buffer as soon as it looks
     * finished; it asks for another line only when something is still open or
     * the last token clearly expects more input.
     *
     * `update` is intentionally absent: it also ends a complete
     * `select ... for update`.
     */
    const CONTINUATION_KEYWORDS = new Set([
        "select", "from", "where", "group", "order", "by", "having", "limit",
        "offset", "and", "or", "not", "join", "inner", "left", "right",
        "full", "cross", "on", "using", "as", "is", "in", "like", "ilike",
        "between", "case", "when", "then", "else", "union", "intersect",
        "except", "into", "values", "set", "returning", "with", "insert",
        "delete", "merge", "create", "alter", "drop", "truncate", "explain",
        "distinct", "table", "do", "call", "copy", "grant", "revoke",
        "comment", "lock", "listen", "unlisten", "notify", "savepoint",
        "release", "prepare", "show", "reset", "discard", "references",
        "constraint", "primary", "foreign", "for", "fetch", "conflict",
        "nulls", "matched",
    ]);

    const CONTINUATION_CHARS = new Set([
        ",", ".", "+", "-", "*", "/", "%", "=", "<", ">", "|", "&", "^", "~",
        "!", "@", "#", "?", ":",
    ]);

    /**
     * Scans SQL without executing it.
     *
     * Returns whether every quote/comment/paren/bracket is closed, the last
     * significant character, and the last word (used to spot trailing
     * keywords). Quoted values are treated as complete operands, so
     * `select 'hi'` is finished.
     */
    function scanSQL(source) {
        let state = "normal";
        let blockDepth = 0;
        let dollarTag = null;
        let escapeString = false;
        let parens = 0;
        let brackets = 0;
        let lastChar = "";
        let token = "";
        let inWord = false;

        const endWord = () => {
            inWord = false;
        };

        for (let i = 0; i < source.length; i += 1) {
            const char = source[i];
            const next = source[i + 1];

            if (state === "line") {
                if (char === "\n") {
                    state = "normal";
                }
                continue;
            }

            if (state === "block") {
                if (char === "/" && next === "*") {
                    blockDepth += 1;
                    i += 1;
                } else if (char === "*" && next === "/") {
                    blockDepth -= 1;
                    i += 1;
                    if (blockDepth === 0) {
                        state = "normal";
                    }
                }
                continue;
            }

            if (state === "single") {
                if (escapeString && char === "\\") {
                    i += 1;
                } else if (char === "'") {
                    if (next === "'") {
                        i += 1;
                    } else {
                        state = "normal";
                    }
                }
                continue;
            }

            if (state === "double") {
                if (char === '"' && next === '"') {
                    i += 1;
                } else if (char === '"') {
                    state = "normal";
                }
                continue;
            }

            if (state === "dollar") {
                if (source.startsWith(dollarTag, i)) {
                    i += dollarTag.length - 1;
                    state = "normal";
                    token = "";
                    inWord = false;
                }
                continue;
            }

            if (char === "-" && next === "-") {
                state = "line";
                i += 1;
                endWord();
                continue;
            }

            if (char === "/" && next === "*") {
                state = "block";
                blockDepth = 1;
                i += 1;
                endWord();
                continue;
            }

            if (char === "'") {
                // E'...' strings honour backslash escapes; standard strings
                // do not.
                escapeString =
                    /[eE]/.test(source[i - 1] || "") &&
                    !/[A-Za-z0-9_$]/.test(source[i - 2] || "");
                state = "single";
                lastChar = char;
                token = "";
                inWord = false;
                continue;
            }

            if (char === '"') {
                state = "double";
                lastChar = char;
                token = "";
                inWord = false;
                continue;
            }

            if (char === "$") {
                const match = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(
                    source.slice(i),
                );
                if (match) {
                    dollarTag = match[0];
                    state = "dollar";
                    i += dollarTag.length - 1;
                    lastChar = char;
                    token = "";
                    inWord = false;
                    continue;
                }
            }

            if (char === "(") {
                parens += 1;
            } else if (char === ")") {
                parens = Math.max(0, parens - 1);
            } else if (char === "[") {
                brackets += 1;
            } else if (char === "]") {
                brackets = Math.max(0, brackets - 1);
            }

            if (/\s/.test(char)) {
                inWord = false;
                continue;
            }

            lastChar = char;

            if (/[A-Za-z_]/.test(char)) {
                token = inWord ? token + char : char;
                inWord = true;
            } else {
                token = "";
                inWord = false;
            }
        }

        // A line comment is closed by the end of the buffer; block comments
        // and quoted strings are not.
        if (state === "line") {
            state = "normal";
        }

        return {
            balanced: state === "normal" && parens === 0 && brackets === 0,
            lastChar,
            lastToken: token.toLowerCase(),
        };
    }

    function needsMoreInput(source) {
        const { balanced, lastChar, lastToken } = scanSQL(source);

        if (!balanced) {
            return true;
        }
        if (!lastChar || lastChar === ";") {
            return false;
        }
        if (CONTINUATION_CHARS.has(lastChar)) {
            return true;
        }
        return CONTINUATION_KEYWORDS.has(lastToken);
    }

    /* --------------------------------------------------------------------- */
    /* SQL results                                                           */
    /* --------------------------------------------------------------------- */

    const NUMERIC_RE = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

    /** Width used for alignment; counted in code points, not UTF-16 units. */
    function displayWidth(text) {
        return [...text].length;
    }

    /** True for Date objects from any realm (page, worker, iframe). */
    function isDate(value) {
        return Object.prototype.toString.call(value) === "[object Date]";
    }

    function formatCell(value, maxCellChars) {
        let text;

        if (value === null || value === undefined) {
            return "";
        }

        if (typeof value === "boolean") {
            return value ? "t" : "f";
        }

        if (typeof value === "bigint") {
            text = value.toString();
        } else if (typeof value === "number") {
            text = String(value);
        } else if (isDate(value)) {
            text = value
                .toISOString()
                .replace("T", " ")
                .replace(/\.000Z$/, "+00")
                .replace(/Z$/, "+00");
        } else if (value instanceof Uint8Array) {
            text = `\\x${Array.from(value, (byte) =>
                byte.toString(16).padStart(2, "0"),
            ).join("")}`;
        } else if (Array.isArray(value)) {
            text = `{${value
                .map((item) => formatCell(item, maxCellChars))
                .join(",")}}`;
        } else if (typeof value === "object") {
            text = JSON.stringify(value);
        } else {
            text = String(value);
        }

        text = text
            .replace(/\r\n/g, "\\n")
            .replace(/\n/g, "\\n")
            .replace(/\r/g, "\\r")
            .replace(/\t/g, "\\t");

        if (displayWidth(text) > maxCellChars) {
            text = `${[...text].slice(0, maxCellChars).join("")}…`;
        }

        return text;
    }

    /**
     * Renders a psql-style ASCII table for one result set, stopping once the
     * rendered table would exceed maxChars. Returns the text and whether rows
     * were omitted.
     */
    function formatTable(fields, rows, maxChars = Infinity) {
        const maxCellChars = 500;
        const names = fields.map((field) => String(field.name ?? ""));
        const widths = names.map((name) => displayWidth(name));
        const numeric = names.map(() => true);
        const seen = names.map(() => false);
        const values = [];
        let truncated = false;

        const rowLabel = (count) =>
            `(${count} ${count === 1 ? "row" : "rows"})`;
        const lineWidth = (columnWidths) =>
            columnWidths.reduce((total, width) => total + width, 0) +
            columnWidths.length * 3;

        for (const row of rows) {
            const raw = names.map((name, index) =>
                Array.isArray(row) ? row[index] : row?.[name],
            );
            const cells = raw.map((value) => formatCell(value, maxCellChars));
            const nextWidths = cells.map((cell, column) =>
                Math.max(widths[column], displayWidth(cell)),
            );
            const nextCount = values.length + 1;

            // Header + separator + rows, plus the footer and newlines.
            const nextTotal =
                (2 + nextCount) * lineWidth(nextWidths) +
                displayWidth(rowLabel(nextCount)) +
                (nextCount + 2);

            if (values.length > 0 && nextTotal > maxChars) {
                truncated = true;
                break;
            }

            values.push(cells);
            nextWidths.forEach((width, column) => {
                widths[column] = width;
            });

            raw.forEach((value, column) => {
                if (value === null || value === undefined) {
                    return;
                }
                seen[column] = true;
                if (typeof value === "number" || typeof value === "bigint") {
                    return;
                }
                if (typeof value === "string" && NUMERIC_RE.test(value)) {
                    return;
                }
                numeric[column] = false;
            });
        }

        const rightAligned = numeric.map(
            (isNumeric, column) => isNumeric && seen[column],
        );
        const pad = (text, width, right) => {
            const fill = " ".repeat(Math.max(0, width - displayWidth(text)));
            return right ? fill + text : text + fill;
        };
        const line = (cells) =>
            cells
                .map(
                    (cell, column) =>
                        ` ${pad(cell, widths[column], rightAligned[column])} `,
                )
                .join("|")
                .replace(/\s+$/, "");

        const output = [line(names)];
        output.push(widths.map((width) => "-".repeat(width + 2)).join("+"));
        for (const row of values) {
            output.push(line(row));
        }
        output.push(rowLabel(values.length));

        return { text: output.join("\n"), truncated };
    }

    /** psql-style command tag for statements that do not return rows. */
    function formatCommandTag(result) {
        const command =
            typeof result.command === "string"
                ? result.command.toUpperCase()
                : "";
        if (!command) {
            return "";
        }

        let count = 0;
        if (Number.isFinite(result.rowCount)) {
            count = result.rowCount;
        } else if (Number.isFinite(result.affectedRows)) {
            count = result.affectedRows;
        }

        if (command === "INSERT") {
            return `INSERT 0 ${count}`;
        }
        if (
            command === "UPDATE" ||
            command === "DELETE" ||
            command === "MERGE" ||
            command === "COPY"
        ) {
            return `${command} ${count}`;
        }
        return command;
    }

    /** Formats a single PGlite result, staying within the console's budget. */
    function formatResult(result, maxChars = Infinity) {
        const fields = Array.isArray(result.fields) ? result.fields : [];
        if (fields.length === 0) {
            return { text: formatCommandTag(result), truncated: false };
        }

        const rows = Array.isArray(result.rows) ? result.rows : [];
        return formatTable(fields, rows, maxChars);
    }

    /* --------------------------------------------------------------------- */
    /* PGlite runtime                                                        */
    /* --------------------------------------------------------------------- */

    // Known-good fallback. The latest PGlite release is resolved at startup;
    // if it cannot be resolved or loaded, this version is used instead.
    const FALLBACK_PGLITE_VERSION = "0.5.11";

    const LIST_DATABASES_SQL = `select datname as name,
       pg_get_userbyid(datdba) as owner,
       pg_encoding_to_char(encoding) as encoding
  from pg_database
 order by datname`;

    let db = null;
    let pgliteVersion = null;
    let serverVersion = null;

    let forceFallback = false;
    let triedFallback = false;
    let attemptedVersion = null;
    let importAttempt = 0;

    function formatError(error) {
        const message =
            error && error.message ? error.message : String(error);
        const lines = [
            /^error\b/i.test(message) ? message : `ERROR:  ${message}`,
        ];

        if (error && error.detail && !message.includes(error.detail)) {
            lines.push(`DETAIL:  ${error.detail}`);
        }
        if (error && error.hint && !message.includes(error.hint)) {
            lines.push(`HINT:  ${error.hint}`);
        }

        return `${lines.join("\n")}\n`;
    }

    function formatNotice(notice) {
        const severity = (notice.severity || "NOTICE").toUpperCase();
        return `${severity}:  ${notice.message || ""}\n`;
    }

    function shortServerVersion() {
        return (
            (serverVersion || "").match(/^PostgreSQL\s+(\S+)/)?.[1] ||
            serverVersion ||
            "PostgreSQL"
        );
    }

    function streamNotice(api, notice) {
        api.write(formatNotice(notice), "notice");
    }

    /** Options shared by every PGlite call that renders rows. */
    function queryOptions(api) {
        return {
            rowMode: "array",
            onNotice: (notice) => streamNotice(api, notice),
        };
    }

    /** Writes each result set as a psql-style block. */
    function writeResults(api, results) {
        for (const result of results) {
            const budget = api.remainingOutput();
            if (budget <= 0) {
                api.markTruncated();
                return;
            }

            const { text, truncated } = formatResult(result, budget);
            if (text) {
                api.write(`${text}\n`, "stdout");
            }
            if (truncated) {
                api.markTruncated();
                return;
            }
        }
    }

    async function runSQL(sql, api) {
        try {
            writeResults(api, await db.exec(sql, queryOptions(api)));
        } catch (error) {
            api.write(formatError(error), "stderr");
        }
    }

    async function renderQuery(sql, params, api) {
        try {
            const result = await db.query(sql, params, queryOptions(api));
            writeResults(api, [result]);
        } catch (error) {
            api.write(formatError(error), "stderr");
        }
    }

    async function runMetaCommand(source, api) {
        const match = /^\\([^\s]+)/.exec(source.trim());
        if (!match) {
            api.write(
                "invalid command. Use \\l to list databases.\n",
                "stderr",
            );
            return;
        }

        const name = match[1].replace(/\+$/, "");
        if (name === "l") {
            await renderQuery(LIST_DATABASES_SQL, [], api);
            return;
        }

        api.write(
            `invalid command \\${name}. Use \\l to list databases.\n`,
            "stderr",
        );
    }

    async function initRuntime(api, fallback) {
        let version = null;

        const resolveStep = api.addStep("Resolve the latest PGlite release");
        if (fallback) {
            version = FALLBACK_PGLITE_VERSION;
            api.complete(
                resolveStep,
                `Using PGlite ${version} (latest failed)`,
            );
        } else {
            api.activate(resolveStep);
            try {
                version = await api.resolveLatestNpmVersion(
                    "@electric-sql/pglite",
                    "PGlite",
                );
                api.complete(resolveStep, `Resolved PGlite ${version} (latest)`);
            } catch (error) {
                console.warn(
                    `Couldn't resolve the latest PGlite; using ${FALLBACK_PGLITE_VERSION}.`,
                    error,
                );
                version = FALLBACK_PGLITE_VERSION;
                forceFallback = true;
                api.complete(
                    resolveStep,
                    `Using PGlite ${version} (latest lookup failed)`,
                );
            }
        }

        attemptedVersion = version;

        const steps = api.addSteps([
            `Download the PGlite ${version} module from cdn.jsdelivr.net`,
            "Download pglite.wasm, pglite.data, and initdb.wasm (~18 MB), then start PostgreSQL",
            "Verify the PostgreSQL server",
        ]);

        api.activate(steps[0]);
        const moduleUrl = `https://cdn.jsdelivr.net/npm/@electric-sql/pglite@${version}/dist/index.js`;
        // A failed dynamic import is cached in the module map, so retries use
        // a distinct URL. The relative wasm/data URLs still resolve normally.
        const specifier =
            importAttempt === 0 ? moduleUrl : `${moduleUrl}?retry=${importAttempt}`;
        importAttempt += 1;

        const module = await import(specifier);
        api.complete(steps[0], `Downloaded the PGlite ${version} module`);

        api.activate(steps[1]);
        let instance;
        if (typeof module.PGlite.create === "function") {
            instance = await module.PGlite.create();
        } else {
            instance = new module.PGlite();
            await instance.waitReady;
        }
        api.complete(
            steps[1],
            "Downloaded the runtime, started PostgreSQL",
        );

        api.activate(steps[2]);
        const result = await instance.query(
            "select version() as version, current_database() as database",
        );

        // A second, trivial round-trip before declaring the REPL ready.
        await instance.query("select 1");

        db = instance;
        pgliteVersion = version;
        serverVersion = result.rows[0].version;
        api.complete(steps[2], `Verified PostgreSQL ${shortServerVersion()}`);
    }

    /* --------------------------------------------------------------------- */
    /* Engine                                                                */
    /* --------------------------------------------------------------------- */

    const engine = {
        prompt: "postgres=#",
        continuationPrompt: "postgres-#",
        inputLabel: "SQL statement",
        indentAfter: /[([{][ \t]*$/,
        placeholder: "Initialising Postgres…",
        unavailablePlaceholder: "Postgres unavailable",
        initTitle: "PGlite initialisation",
        initErrorMessage:
            "Couldn't start PGlite. Check your connection and try again.",
        clearNote:
            "Console cleared. Tables and data from this session are still defined.",
        meta: 'built with <a href="https://pglite.dev/" target="_blank" rel="noopener noreferrer">PGlite</a> <span class="repl-sep" aria-hidden="true">·</span> runtime from <a href="https://www.jsdelivr.com/" target="_blank" rel="noopener noreferrer">jsDelivr</a>',

        async init(api) {
            try {
                await initRuntime(api, forceFallback);
            } catch (error) {
                // If the latest release failed to load, retry once with the
                // known-good fallback release.
                if (
                    !triedFallback &&
                    attemptedVersion !== FALLBACK_PGLITE_VERSION
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

        async submit(source, api) {
            const trimmed = source.trim();
            if (!trimmed) {
                return {};
            }

            if (!db) {
                throw new Error("Postgres is not ready.");
            }

            if (trimmed.startsWith("\\")) {
                // Accept the psql habit of ending meta-commands with a
                // semicolon, even though psql itself does not need one.
                await runMetaCommand(trimmed.replace(/;\s*$/, ""), api);
                return {};
            }

            if (needsMoreInput(source)) {
                return { incomplete: true };
            }

            await runSQL(source, api);
            return {};
        },

        welcome() {
            return [
                `PGlite ${pgliteVersion} · PostgreSQL ${shortServerVersion()} ready. Use `,
                { code: "\\l" },
                " to list databases.",
            ];
        },
    };

    global.createReplConsole(engine);
})(window);
