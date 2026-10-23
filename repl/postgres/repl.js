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

    /** Renders a psql-style ASCII table for one result set. */
    function formatTable(fields, rows, options = {}) {
        const maxCellChars = options.maxCellChars ?? 500;
        const names = fields.map((field) => String(field.name ?? ""));
        const values = rows.map((row) =>
            names.map((name, index) =>
                formatCell(
                    Array.isArray(row) ? row[index] : row?.[name],
                    maxCellChars,
                ),
            ),
        );

        const numeric = names.map((name, column) => {
            let seen = false;
            for (const row of rows) {
                const value = Array.isArray(row) ? row[column] : row?.[name];
                if (value === null || value === undefined) {
                    continue;
                }
                seen = true;
                if (typeof value === "number" || typeof value === "bigint") {
                    continue;
                }
                if (typeof value === "string" && NUMERIC_RE.test(value)) {
                    continue;
                }
                return false;
            }
            return seen;
        });

        const widths = names.map((name, column) => {
            let width = displayWidth(name);
            for (const row of values) {
                width = Math.max(width, displayWidth(row[column]));
            }
            return width;
        });

        const pad = (text, width, right) => {
            const fill = " ".repeat(Math.max(0, width - displayWidth(text)));
            return right ? fill + text : text + fill;
        };

        const line = (cells) =>
            cells
                .map(
                    (cell, column) =>
                        ` ${pad(cell, widths[column], numeric[column])} `,
                )
                .join("|")
                .replace(/\s+$/, "");

        const output = [line(names)];
        output.push(widths.map((width) => "-".repeat(width + 2)).join("+"));
        for (const row of values) {
            output.push(line(row));
        }
        output.push(`(${rows.length} ${rows.length === 1 ? "row" : "rows"})`);

        return output.join("\n");
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

    /** Formats a single PGlite result into the text shown in the console. */
    function formatResult(result, options = {}) {
        const fields = Array.isArray(result.fields) ? result.fields : [];
        if (fields.length === 0) {
            return formatCommandTag(result);
        }

        const rows = Array.isArray(result.rows) ? result.rows : [];
        const maxRows = options.maxRows ?? Infinity;
        const shown = rows.length > maxRows ? rows.slice(0, maxRows) : rows;

        let text = formatTable(fields, shown, {
            maxCellChars: options.maxCellChars,
        });
        if (shown.length < rows.length) {
            text += `\n(output truncated: showing ${shown.length} of ${rows.length} rows)`;
        }
        return text;
    }

    /* --------------------------------------------------------------------- */
    /* PGlite runtime                                                        */
    /* --------------------------------------------------------------------- */

    // Known-good fallback. The latest PGlite release is resolved at startup;
    // if it cannot be resolved or loaded, this version is used instead.
    const PINNED_PGLITE_VERSION = "0.5.11";
    const MAX_ROWS = 1000;

    const META_HELP = `
  \\?               show this help
  \\d [name]        list relations (tables, views, sequences), or describe one
  \\dt [pattern]    list tables only
  \\l               list databases
  \\timing [on|off] toggle statement timing`;

    const LIST_TABLES_SQL = `select table_schema as schema,
       table_name as name,
       case table_type
         when 'LOCAL TEMPORARY' then 'temp table'
         else 'table'
       end as type
  from information_schema.tables
 where table_schema not in ('pg_catalog', 'information_schema')
   and table_type in ('BASE TABLE', 'LOCAL TEMPORARY')
   and ($1 = '' or table_schema || '.' || table_name ilike $1 or table_name ilike $1)
 order by 1, 2`;

    const LIST_RELATIONS_SQL = `select n.nspname as schema,
       c.relname as name,
       case c.relkind
         when 'r' then 'table'
         when 'p' then 'partitioned table'
         when 'v' then 'view'
         when 'm' then 'materialized view'
         when 'S' then 'sequence'
         else c.relkind::text
       end as type
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
 where n.nspname not in ('pg_catalog', 'information_schema')
   and c.relkind in ('r', 'p', 'v', 'm', 'S')
   and ($1 = '' or n.nspname || '.' || c.relname ilike $1 or c.relname ilike $1)
 order by 1, 2`;

    const DESCRIBE_SQL = `select a.attname as column,
       format_type(a.atttypid, a.atttypmod) as type,
       case when a.attnotnull then 'not null' else '' end as nullable,
       pg_get_expr(ad.adbin, ad.adrelid) as "default"
  from pg_attribute a
  left join pg_attrdef ad on ad.adrelid = a.attrelid and ad.adnum = a.attnum
 where a.attrelid = to_regclass($1)
   and a.attnum > 0
   and not a.attisdropped
 order by a.attnum`;

    const LIST_DATABASES_SQL = `select datname as name,
       pg_get_userbyid(datdba) as owner,
       pg_encoding_to_char(encoding) as encoding
  from pg_database
 order by datname`;

    let db = null;
    let pgliteVersion = null;
    let serverVersion = null;

    let timing = false;
    let forcePinned = false;
    let triedPinnedFallback = false;
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
            const text = formatResult(result, { maxRows: MAX_ROWS });
            if (text) {
                api.write(`${text}\n`, "stdout");
            }
        }
    }

    /** Runs a query and, when timing is on, prints how long it took. */
    async function timed(api, run) {
        const started = performance.now();
        try {
            return await run();
        } finally {
            if (timing) {
                api.note(
                    `Time: ${(performance.now() - started).toFixed(2)} ms`,
                );
            }
        }
    }

    async function runSQL(sql, api) {
        await timed(api, async () => {
            try {
                writeResults(api, await db.exec(sql, queryOptions(api)));
            } catch (error) {
                api.write(formatError(error), "stderr");
            }
        });
    }

    async function renderQuery(sql, params, api, { emptyNote } = {}) {
        await timed(api, async () => {
            try {
                const result = await db.query(
                    sql,
                    params,
                    queryOptions(api),
                );

                if (
                    emptyNote &&
                    Array.isArray(result.rows) &&
                    result.rows.length === 0
                ) {
                    api.note(emptyNote);
                    return;
                }

                writeResults(api, [result]);
            } catch (error) {
                api.write(formatError(error), "stderr");
            }
        });
    }

    async function listTables(argument, api) {
        const pattern = argument ? argument.replace(/\*/g, "%") : "";
        await renderQuery(LIST_TABLES_SQL, [pattern], api, {
            emptyNote: "Did not find any tables.",
        });
    }

    async function listRelations(argument, api) {
        const pattern = argument ? argument.replace(/\*/g, "%") : "";
        await renderQuery(LIST_RELATIONS_SQL, [pattern], api, {
            emptyNote: "Did not find any relations.",
        });
    }

    async function describeRelation(argument, api) {
        if (!argument) {
            await listRelations("", api);
            return;
        }

        await timed(api, async () => {
            try {
                const result = await db.query(
                    DESCRIBE_SQL,
                    [argument],
                    queryOptions(api),
                );

                if (result.rows.length === 0) {
                    api.note(
                        `Did not find any relation named "${argument}".`,
                    );
                    return;
                }

                writeResults(api, [result]);
            } catch (error) {
                api.write(formatError(error), "stderr");
            }
        });
    }

    async function runMetaCommand(source, api) {
        const match = /^\\([^\s]+)(?:\s+([\s\S]*))?$/.exec(source.trim());
        if (!match) {
            api.write("invalid command. Try \\? for help.\n", "stderr");
            return;
        }

        const name = match[1].replace(/\+$/, "");
        const argument = (match[2] || "").trim();

        switch (name) {
            case "?":
                api.write(`${META_HELP}\n`, "stdout");
                return;
            case "l":
                await renderQuery(LIST_DATABASES_SQL, [], api);
                return;
            case "dt":
                await listTables(argument, api);
                return;
            case "d":
                await describeRelation(argument, api);
                return;
            case "timing": {
                const value = argument.toLowerCase();
                if (value === "on" || value === "true" || value === "1") {
                    timing = true;
                } else if (
                    value === "off" ||
                    value === "false" ||
                    value === "0"
                ) {
                    timing = false;
                } else if (value) {
                    api.write(
                        `\\timing: unrecognized value "${argument}"\n`,
                        "stderr",
                    );
                    return;
                } else {
                    timing = !timing;
                }
                api.write(`Timing is ${timing ? "on" : "off"}.\n`, "stdout");
                return;
            }
            default:
                api.write(
                    `invalid command \\${name}. Try \\? for help.\n`,
                    "stderr",
                );
        }
    }

    async function initRuntime(api, pinned) {
        let version = null;

        const resolveStep = api.addStep("Resolve the latest PGlite release");
        if (pinned) {
            version = PINNED_PGLITE_VERSION;
            api.complete(
                resolveStep,
                `Using pinned PGlite ${version} (latest failed)`,
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
                    "Couldn't resolve the latest PGlite; using the pinned version.",
                    error,
                );
                version = PINNED_PGLITE_VERSION;
                forcePinned = true;
                api.complete(
                    resolveStep,
                    `Using pinned PGlite ${version} (latest lookup failed)`,
                );
            }
        }

        attemptedVersion = version;

        const steps = api.addSteps([
            `Download the PGlite ${version} module from cdn.jsdelivr.net`,
            "Download pglite.wasm, pglite.data and initdb.wasm (~18 MB), then start PostgreSQL (WebAssembly)",
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
            "Downloaded the runtime, started PostgreSQL (WebAssembly)",
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
                await initRuntime(api, forcePinned);
            } catch (error) {
                // If the latest release failed to load, retry once with the
                // pinned, known-good release.
                if (
                    !triedPinnedFallback &&
                    attemptedVersion !== PINNED_PGLITE_VERSION
                ) {
                    triedPinnedFallback = true;
                    forcePinned = true;
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
                { code: "\\?" },
                " for help.",
            ];
        },
    };

    global.createReplConsole(engine);
})(window);
