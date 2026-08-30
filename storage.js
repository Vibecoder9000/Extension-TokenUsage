/**
 * Token Usage Tracker — storage layer
 *
 * Usage history is persisted in a compact "v2" form to keep settings.json small:
 *
 *   {
 *     v: 2,
 *     session: {...},                       // unchanged runtime shape
 *     allTime: {...},                       // unchanged runtime shape
 *     models: ["vendor/model:variant"...],  // intern table shared by all buckets
 *     days: [                               // sorted by date key
 *       {
 *         d: "2026-08-30",                  // day key
 *         i, o, n,                          // input, output, message count
 *         c, ci, co,                        // optional: API-reported cost, costed in/out
 *         s: [                              // per-model rows:
 *           [modelIdx, in, out, msgCount, cost?, costedIn?, costedOut?]
 *         ]
 *       }
 *     ],
 *     byModel: [                            // all-time per-model aggregates
 *       [modelIdx, in, out, msgCount, cost?, costedIn?, costedOut?]
 *     ]
 *   }
 *
 * The runtime shape is unchanged from v1 (byDay object + byModel object), so all
 * readers keep working; conversion happens only at the persistence boundary.
 * `byModel` is stored (not derived from days) because historical day rows can
 * contain estimates from the v1 numeric-format migration, while byModel holds
 * the authoritative totals.
 */

const V2 = 2;

export function createEmptyRuntime() {
    return {
        session: { input: 0, output: 0, total: 0, messageCount: 0, startTime: null },
        allTime: { input: 0, output: 0, total: 0, messageCount: 0 },
        byDay: {},
        byModel: {},
    };
}

function bucketHasCost(bucket) {
    return Number.isFinite(bucket.cost);
}

/** Deserialize one [modelIdx, in, out, msgCount, cost?, ci?, co?] row */
function rowToBucket(row) {
    const bucket = {
        input: row[1] || 0,
        output: row[2] || 0,
        total: (row[1] || 0) + (row[2] || 0),
        messageCount: row[3] || 0,
    };
    if (Number.isFinite(row[4])) {
        bucket.cost = row[4];
        bucket.costedInput = row[5] || 0;
        bucket.costedOutput = row[6] || 0;
    }
    return bucket;
}

/** Serialize a runtime bucket to [idx, in, out, msgCount, cost?, ci?, co?] */
function bucketToRow(idx, bucket) {
    const row = [idx, bucket.input || 0, bucket.output || 0, bucket.messageCount || 0];
    if (bucketHasCost(bucket)) {
        row.push(bucket.cost, bucket.costedInput || 0, bucket.costedOutput || 0);
    }
    return row;
}

/**
 * Expand compact v2 into the runtime shape.
 * @param {object} compact
 * @returns {object} { session, allTime, byDay, byModel }
 */
export function deserializeUsage(compact) {
    const runtime = createEmptyRuntime();
    if (!compact || compact.v !== V2 || !Array.isArray(compact.days)) {
        return runtime;
    }

    runtime.session = { ...createEmptyRuntime().session, ...(compact.session || {}) };
    runtime.allTime = { ...createEmptyRuntime().allTime, ...(compact.allTime || {}) };

    const models = Array.isArray(compact.models) ? compact.models : [];

    for (const day of compact.days) {
        if (!day || typeof day.d !== 'string') continue;
        const dayData = {
            input: day.i || 0,
            output: day.o || 0,
            total: (day.i || 0) + (day.o || 0),
            messageCount: day.n || 0,
            models: {},
        };
        if (Number.isFinite(day.c)) {
            dayData.cost = day.c;
            dayData.costedInput = day.ci || 0;
            dayData.costedOutput = day.co || 0;
        }

        for (const row of (day.s || [])) {
            const modelId = models[row[0]];
            if (typeof modelId !== 'string') continue;
            dayData.models[modelId] = rowToBucket(row);
        }

        runtime.byDay[day.d] = dayData;
    }

    for (const row of (compact.byModel || [])) {
        const modelId = models[row[0]];
        if (typeof modelId !== 'string') continue;
        runtime.byModel[modelId] = rowToBucket(row);
    }

    return runtime;
}

/**
 * Compact the runtime shape into v2 for persistence.
 * @param {object} runtime { session, allTime, byDay, byModel }
 * @returns {object} compact v2 object (assign this over extension settings)
 */
export function serializeUsage(runtime) {
    const byDay = (runtime && runtime.byDay) || {};
    const dayKeys = Object.keys(byDay).sort();
    const modelIndex = new Map();

    const intern = (modelId) => {
        let idx = modelIndex.get(modelId);
        if (idx === undefined) {
            idx = modelIndex.size;
            modelIndex.set(modelId, idx);
        }
        return idx;
    };

    const days = dayKeys.map((dayKey) => {
        const day = byDay[dayKey];
        const compact = {
            d: dayKey,
            i: day.input || 0,
            o: day.output || 0,
            n: day.messageCount || 0,
        };
        if (bucketHasCost(day)) {
            compact.c = day.cost;
            compact.ci = day.costedInput || 0;
            compact.co = day.costedOutput || 0;
        }

        compact.s = Object.entries(day.models || {}).map(([modelId, modelData]) =>
            bucketToRow(intern(modelId), modelData));
        return compact;
    });

    const byModelRows = Object.entries((runtime && runtime.byModel) || {})
        .map(([modelId, bucket]) => bucketToRow(intern(modelId), bucket));

    return {
        v: V2,
        session: runtime.session || createEmptyRuntime().session,
        allTime: runtime.allTime || createEmptyRuntime().allTime,
        models: Array.from(modelIndex.keys()),
        days,
        byModel: byModelRows,
    };
}

/**
 * One-time conversion from the v1 layout to compact v2.
 * Drops the dead legacy buckets (byHour/byWeek/byMonth/byChat — never written by
 * current code and never displayed) and folds the legacy numeric models format.
 * @param {object} raw v1 usage object (not modified)
 * @returns {object} compact v2 object
 */
export function migrateUsageV1(raw) {
    const byDay = (raw && raw.byDay) || {};
    const dayKeys = Object.keys(byDay).sort();
    const modelIndex = new Map();

    const intern = (modelId) => {
        let idx = modelIndex.get(modelId);
        if (idx === undefined) {
            idx = modelIndex.size;
            modelIndex.set(modelId, idx);
        }
        return idx;
    };

    const days = dayKeys.map((dayKey) => {
        const day = byDay[dayKey];
        const dayTotal = day.total || 0;
        const compact = {
            d: dayKey,
            i: day.input || 0,
            o: day.output || 0,
            n: day.messageCount || 0,
        };
        if (Number.isFinite(day.cost)) {
            compact.c = day.cost;
            compact.ci = day.costedInput || 0;
            compact.co = day.costedOutput || 0;
        }

        const modelEntries = Object.entries(day.models || {});
        compact.s = modelEntries.map(([modelId, value]) => {
            // Legacy format: models[modelId] = totalTokens (number)
            const bucket = typeof value === 'number'
                ? {
                    input: Math.round((day.input || 0) * (dayTotal ? value / dayTotal : 0)),
                    output: Math.round((day.output || 0) * (dayTotal ? value / dayTotal : 0)),
                    total: value,
                    messageCount: 0,
                }
                : value;
            return bucketToRow(intern(modelId), bucket);
        });
        return compact;
    });

    const byModelRows = Object.entries((raw && raw.byModel) || {})
        .map(([modelId, bucket]) => bucketToRow(intern(modelId), bucket || {}));

    return {
        v: V2,
        session: (raw && raw.session) || createEmptyRuntime().session,
        allTime: (raw && raw.allTime) || createEmptyRuntime().allTime,
        models: Array.from(modelIndex.keys()),
        days,
        byModel: byModelRows,
    };
}

function csvEscape(value) {
    const str = String(value);
    if (/[",\n\r]/.test(str)) {
        return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
}

/**
 * Build a CSV of the full usage history: one row per day x model.
 * @param {object} runtime { byDay }
 * @param {(bucket: object, modelId: string|null) => number} costFn stored-or-estimated cost
 * @returns {string} CSV text
 */
export function buildUsageCsv(runtime, costFn) {
    const byDay = (runtime && runtime.byDay) || {};
    const lines = ['date,model,input_tokens,output_tokens,total_tokens,requests,cost_usd'];

    for (const dayKey of Object.keys(byDay).sort()) {
        const day = byDay[dayKey];
        const modelEntries = Object.entries(day.models || {}).sort(([a], [b]) => a.localeCompare(b));

        let modelInput = 0;
        let modelOutput = 0;
        let modelRequests = 0;
        for (const [modelId, modelData] of modelEntries) {
            modelInput += modelData.input || 0;
            modelOutput += modelData.output || 0;
            modelRequests += modelData.messageCount || 0;
            const cost = Number((costFn ? costFn(modelData, modelId) : 0).toFixed(6));
            lines.push([
                dayKey,
                csvEscape(modelId),
                modelData.input || 0,
                modelData.output || 0,
                modelData.total != null ? modelData.total : (modelData.input || 0) + (modelData.output || 0),
                modelData.messageCount || 0,
                cost,
            ].join(','));
        }

        // Background/quiet generations are recorded without a model ID and only
        // roll into the day totals — surface the remainder as an unattributed row.
        const unattributedInput = (day.input || 0) - modelInput;
        const unattributedOutput = (day.output || 0) - modelOutput;
        const unattributedRequests = (day.messageCount || 0) - modelRequests;
        if (unattributedInput > 0 || unattributedOutput > 0 || unattributedRequests > 0) {
            const cost = Number((costFn ? costFn(day, null) : 0).toFixed(6));
            lines.push([
                dayKey,
                '(unattributed)',
                unattributedInput,
                unattributedOutput,
                unattributedInput + unattributedOutput,
                unattributedRequests,
                cost,
            ].join(','));
        }
    }

    return lines.join('\n') + '\n';
}
